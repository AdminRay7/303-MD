require("dotenv").config();

// ============================================
//   Silence Baileys' known log spam
// ============================================
const _origErr  = console.error.bind(console);
const _origWarn = console.warn.bind(console);
const _origLog  = console.log.bind(console);
const _SILENCED = ['Bad MAC', 'Bad RSA', 'decrypt', 'Closing session', 'Removing old closed', 'unpadRandom'];
const _silence = (args) => typeof args[0] === 'string' && _SILENCED.some(p => args[0].includes(p));
console.error = (...a) => { if (!_silence(a)) _origErr(...a); };
console.warn  = (...a) => { if (!_silence(a)) _origWarn(...a); };

const {
    default: makeWASocket,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongoAuthState");
const pino = require("pino");
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const { fancy } = require("./lib/font");

const app = express();
const PORT = config.port;

// Middleware
app.use(require("helmet")({ contentSecurityPolicy: false }));
app.use(require("compression")());
app.use("/api/pair", require("express-rate-limit")({ windowMs: 60_000, max: 15, skipSuccessfulRequests: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// DB
if (config.mongodb) {
    mongoose.connect(config.mongodb, { dbName: "xmd303" })
        .then(() => console.log(fancy("✅ Database connected.")))
        .catch(err => console.error("DB Error:", err.message));
}

// Global state
global.sessions = new Map();
global.mongoClient = null;
global.__waVersionCache = null;
global.__bootLocks = new Map();
global.__pairCooldown = new Map();

const MAX_SESSIONS = 15;
const PAIR_COOLDOWN_MS = 15_000;
const PAIR_CODE_TIMEOUT_MS = 20_000;
const SOCKET_READY_TIMEOUT_MS = 45_000;

// Helpers
function servePage(res, filename) {
    const p = path.join(__dirname, "public", filename);
    if (!fs.existsSync(p)) return res.status(404).send(`${filename} missing`);
    res.sendFile(p);
}
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function getCachedWaVersion() {
    if (global.__waVersionCache) return global.__waVersionCache;
    try {
        if (typeof fetchLatestWaWebVersion === "function") {
            const v = await fetchLatestWaWebVersion();
            if (v?.version) { global.__waVersionCache = v; return v; }
        }
    } catch {}
    return { version: [2, 3000, 1035194821] };
}

let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, t] of global.__pairCooldown) {
        if (now - t > PAIR_COOLDOWN_MS * 4) global.__pairCooldown.delete(k);
    }
}, 60_000).unref?.();

async function initMongo() {
    if (!config.mongodb) throw new Error("MONGODB_URI missing");
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(config.mongodb);
        await global.mongoClient.connect();
    }
}

// Socket boot
function bootSocket(sessionId, session) {
    if (global.__bootLocks.has(sessionId)) return global.__bootLocks.get(sessionId);
    const p = _bootSocketImpl(sessionId, session).finally(() => {
        global.__bootLocks.delete(sessionId);
    });
    global.__bootLocks.set(sessionId, p);
    return p;
}

async function _bootSocketImpl(sessionId, session) {
    session.id = sessionId;
    await initMongo();

    const collection = global.mongoClient.db("xmd303").collection("authState");
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    const { version } = await getCachedWaVersion();

    const conn = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    session.conn = conn;
    session.socketFailed = false;
    session.pairingReady = false;

    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) { session.pairingReady = true; session.socketReady = true; }
        if (connection === "connecting") session.socketReady = true;

        if (connection === "open") {
            session.socketReady = true;
            session.pairing = null;
            session.pairingNumber = null;
            console.log(fancy(`✅ [${sessionId}] connected successfully`));

            try {
                await collection.updateOne({ _id: `${sessionId}:meta` }, { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } }, { upsert: true });
            } catch {}

            // Send Welcome Message if not sent yet
            if (!session.welcomed && config.ownerNumber) {
                session.welcomed = true;
                try {
                    const ownerJid = config.ownerNumber.replace(/\D/g, "") + "@s.whatsapp.net";
                    await conn.sendMessage(ownerJid, {
                        text: `╭─── • 🔑 • ───╮\n   ${config.botName} ᴠ${config.version}\n╰─── • 🔑 • ───╯\n\n✅ New session linked!\nSession: ${sessionId}\nOwner: ${config.ownerName}\n\n${fancy(config.footer)}`
                    });
                } catch (e) { console.error("Welcome msg failed:", e.message); }
            }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairingReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || "";
            console.log(fancy(`❌ [${sessionId}] closed (${code})`));

            if (code === 401 || code === DisconnectReason.loggedOut) {
                await logoutSession(sessionId);
                return;
            }
            
            if (session._paused || code === 440) {
                global.sessions.delete(sessionId);
                return;
            }

            global.__bootLocks.delete(sessionId);
            
            // FIXED: 515 (Restart Required) and 428 (Connection Closed) should reconnect instantly
            const isRestart = code === 515 || code === 428 || errorMsg.includes("Stream Errored");
            const delay = isRestart ? 1000 : 10000; // 1 second if pairing just finished, otherwise 10s

            setTimeout(() => {
                if (!global.sessions.has(sessionId) || session._paused) return;
                console.log(fancy(`🔄 Reconnecting [${sessionId}]...`));
                bootSocket(sessionId, session).catch(() => {});
            }, delay);
        }
    });

    const presenter = require("./presenter");
    conn.ev.on("messages.upsert", async (m) => {
        try { await presenter(conn, m, sessionId); } catch (e) {}
    });
    conn.ev.on("group-participants.update", async (u) => {
        try { await presenter.handleGroupUpdate(conn, u); } catch (e) {}
    });
    conn.ev.on("call", async (calls) => {
        try { await presenter.handleCallEvent(conn, calls); } catch (e) {}
    });

    return conn;
}

// Pairing
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        let session = global.sessions.get(sessionId);

        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= MAX_SESSIONS) throw new Error(`Server at capacity (${MAX_SESSIONS})`);
            session = { conn: null, socketReady: false, pairing: null, pairingNumber: null, startedAt: Date.now(), pairingReady: false, socketFailed: false };
            global.sessions.set(sessionId, session);
        }

        if (!session.conn) {
            try { await bootSocket(sessionId, session); }
            catch (e) {
                global.sessions.delete(sessionId);
                throw new Error(`Socket boot failed: ${e.message}`);
            }
        }

        const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
        while (!session.pairingReady && Date.now() < deadline) {
            if (session.socketFailed) throw new Error("Socket failed");
            await new Promise(r => setTimeout(r, 250));
        }
        if (!session.pairingReady && !session.socketReady) throw new Error("Socket not ready. Please try again.");

        let code;
        try {
            code = await Promise.race([
                session.conn.requestPairingCode(phoneNumber),
                new Promise((_, rej) => setTimeout(() => rej(new Error("Pairing timed out")), PAIR_CODE_TIMEOUT_MS))
            ]);
        } catch (first) {
            await new Promise(r => setTimeout(r, 2000));
            code = await Promise.race([
                session.conn.requestPairingCode(phoneNumber),
                new Promise((_, rej) => setTimeout(() => rej(new Error("Pairing retry timed out")), PAIR_CODE_TIMEOUT_MS))
            ]);
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        console.log(fancy(`✅ [${sessionId}] pairing code: ${formatted}`));
        return formatted;
    });
}

async function logoutSession(sessionId) {
    const s = global.sessions.get(sessionId);
    if (s) {
        try { s.conn?.ev.removeAllListeners(); s.conn?.ws?.close(); } catch {}
        global.sessions.delete(sessionId);
    }
    try {
        await initMongo();
        const c = global.mongoClient.db("xmd303").collection("authState");
        const safe = escapeRegex(sessionId);
        await c.deleteMany({ _id: { $regex: `^${safe}:` } });
    } catch (e) { console.error(`logout ${sessionId}:`, e.message); }
}

// RESTORE SESSIONS ON BOOT
async function resumeAllSessions() {
    if (!config.mongodb) return;
    try {
        await initMongo();
        const c = global.mongoClient.db("xmd303").collection("authState");
        const metas = await c.find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(fancy(`🔄 Restoring ${metas.length} session(s)...`));

        const ids = metas.map(m => String(m._id).replace(/:meta$/, "")).filter(id => !global.sessions.has(id));

        for (const sessionId of ids) {
            if (global.sessions.size >= MAX_SESSIONS) break;
            const session = { conn: null, socketReady: false, pairing: null, pairingNumber: null, startedAt: Date.now(), welcomed: true, pairingReady: false, socketFailed: false };
            global.sessions.set(sessionId, session);
            try {
                await Promise.race([
                    bootSocket(sessionId, session),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("boot timeout")), 75_000))
                ]);
            } catch (e) {
                console.error(`Restore ${sessionId}:`, e.message);
                global.sessions.delete(sessionId);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) { console.error("Restore error:", e.message); }
}

// Routes
app.get("/", (req, res) => servePage(res, "pair.html"));
app.get("/pair", (req, res) => servePage(res, "pair.html"));
app.get("/status", (req, res) => servePage(res, "pair.html"));

app.post("/api/pair", async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const num = String(req.body?.num || "").replace(/\D/g, "");

    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(sessionId)) return res.status(400).json({ error: "Invalid sessionId" });
    if (num.length < 10 || num.length > 15) return res.status(400).json({ error: "Invalid phone number" });

    const last = global.__pairCooldown.get(sessionId) || 0;
    if (Date.now() - last < PAIR_COOLDOWN_MS) {
        const wait = Math.ceil((PAIR_COOLDOWN_MS - (Date.now() - last)) / 1000);
        return res.status(429).json({ error: `Wait ${wait}s before retry` });
    }
    global.__pairCooldown.set(sessionId, Date.now());

    try {
        const live = global.sessions.get(sessionId);
        if (live?.conn?.user) return res.status(400).json({ error: "Already paired" });

        const code = await requestPairingCodeForSession(sessionId, num);
        res.json({ success: true, sessionId, code });
    } catch (e) {
        console.error("Pair:", e.message);
        res.status(500).json({ error: e.message || "Pairing failed" });
    }
});

app.get("/api/pair/status", (req, res) => {
    const sessionId = String(req.query.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const s = global.sessions.get(sessionId);
    if (!s) return res.json({ connected: false, ready: false, pairing: null, exists: false });
    res.json({
        connected: !!s.conn?.user,
        ready: !!s.socketReady,
        pairing: s.pairing || null,
        exists: true,
        jid: s.conn?.user?.id || null
    });
});

app.post("/api/unpair", async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    try {
        await logoutSession(sessionId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Boot
(async () => {
    console.log(fancy(`🚀 Starting ${config.botName} v${config.version}...`));
    app.listen(PORT, () => {
        console.log(fancy(`🌐 Dashboard: http://localhost:${PORT}`));
    });
    // RESTORE SESSIONS ON STARTUP
    resumeAllSessions().catch(e => console.error("resumeAllSessions:", e.message));
})();