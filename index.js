require("dotenv").config();

// ============================================
//   Silence Baileys' known log spam
// ============================================
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
const _SILENCED_PATTERNS = [
    'Bad MAC', 'Bad RSA', 'doDecryptWhisperMessage', 'decryptWithSessions',
    'verifyMAC', 'Session error:Error: Bad MAC',
    'Failed to decrypt message with any known session',
    'unpadRandomMax16', 'Closing session',
    'Closing open session in favor of incoming preKey bundle',
    'Session already closed', 'Removing old closed session', 'MessageCounterError'
];
function _shouldSilence(args) {
    const first = args[0];
    if (typeof first !== 'string') return false;
    return _SILENCED_PATTERNS.some(p => first.includes(p));
}
console.error = (...args) => { if (!_shouldSilence(args)) _origConsoleError(...args); };
console.warn  = (...args) => { if (!_shouldSilence(args)) _origConsoleWarn(...args); };

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
const config = require("./config");
const { fancy } = require("./lib/font");
const cors = require("cors"); // Ensure you have run: npm install cors

const app = express();
const PORT = config.port;

// ============================================
//   Middleware (API Only)
// ============================================
app.use(cors({ origin: "*" })); // Allows your separate frontend (Render/Vercel) to connect
app.use(require("helmet")({ contentSecurityPolicy: false }));
app.use(require("compression")());
app.use("/api/pair", require("express-rate-limit")({ windowMs: 60_000, max: 15, skipSuccessfulRequests: true }));
app.use(express.json());

// ============================================
//   Database & Global State
// ============================================
if (config.mongodb) {
    mongoose.connect(config.mongodb, { dbName: "xmd303" })
        .then(() => console.log(fancy("✅ Database connected.")))
        .catch(err => console.error("DB Error:", err.message));
}

global.sessions = new Map();
global.mongoClient = null;
global.__waVersionCache = null;
global.__bootLocks = new Map();
global.__pairCooldown = new Map();

const MAX_SESSIONS = 50; // High limit for multi-user deployment
const PAIR_COOLDOWN_MS = 15_000;
const PAIR_CODE_TIMEOUT_MS = 20_000;
const SOCKET_READY_TIMEOUT_MS = 45_000;

// ============================================
//   Helpers
// ============================================
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function getCachedWaVersion() { return { version: [2, 3000, 1042466098] }; } // Stable hardcoded version

let pairingQueue = Promise.resolve();
function enqueuePairing(fn) { const next = pairingQueue.then(fn, fn); pairingQueue = next.catch(() => {}); return next; }

async function initMongo() {
    if (!config.mongodb) throw new Error("MONGODB_URI missing");
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(config.mongodb);
        await global.mongoClient.connect();
    }
}

// ============================================
//   Boot Socket
// ============================================
function bootSocket(sessionId, session) {
    if (global.__bootLocks.has(sessionId)) return global.__bootLocks.get(sessionId);
    const p = _bootSocketImpl(sessionId, session).finally(() => { global.__bootLocks.delete(sessionId); });
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

            // ==========================================
            // FORCED STARTUP WELCOME MESSAGE (Sends on every restart)
            // ==========================================
            if (config.ownerNumber) {
                try {
                    const cleanOwner = String(config.ownerNumber).replace(/\D/g, "");
                    await conn.sendMessage(cleanOwner + "@s.whatsapp.net", {
                        text: `╭─── • 🔑 • ───╮\n   ${config.botName} ᴠ${config.version}\n╰─── • 🔑 • ───╯\n\n✅ Bot is online!\nSession: ${sessionId}\nStatus: Connected\n\n${fancy(config.footer)}`
                    });
                    console.log(fancy(`📩 Startup message sent to owner`));
                } catch (e) {
                    console.error("Failed to send startup message:", e.message);
                }
            }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairingReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;

            // ==========================================
            // ORIGINAL 401 LOGOUT FIX
            // ==========================================
            if (code === 401 || code === DisconnectReason.loggedOut) {
                console.log(fancy(`🚪 [${sessionId}] Logged out (401). Purging session.`));
                await logoutSession(sessionId);
                return;
            }
            
            if (session._paused || code === 440) {
                global.sessions.delete(sessionId);
                return;
            }

            global.__bootLocks.delete(sessionId);
            
            const isRestart = code === 515 || code === 428;
            const delay = isRestart ? 1000 : 10000;

            setTimeout(() => {
                if (!global.sessions.has(sessionId) || session._paused) return;
                console.log(fancy(`🔄 Reconnecting [${sessionId}]...`));
                bootSocket(sessionId, session).catch(() => {});
            }, delay);
        }
    });

    const presenter = require("./presenter");
    conn.ev.on("messages.upsert", async (m) => { try { await presenter(conn, m, sessionId); } catch (e) {} });
    conn.ev.on("group-participants.update", async (u) => { try { await presenter.handleGroupUpdate(conn, u); } catch (e) {} });
    conn.ev.on("call", async (calls) => { try { await presenter.handleCallEvent(conn, calls); } catch (e) {} });

    return conn;
}

// ============================================
//   Pairing Functions
// ============================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        let session = global.sessions.get(sessionId);

        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= MAX_SESSIONS) throw new Error(`Server at capacity`);
            session = { conn: null, socketReady: false, pairing: null, pairingNumber: null, startedAt: Date.now(), pairingReady: false, socketFailed: false };
            global.sessions.set(sessionId, session);
        }

        if (!session.conn) {
            try { await bootSocket(sessionId, session); } catch (e) { global.sessions.delete(sessionId); throw new Error(`Boot failed: ${e.message}`); }
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
        console.log(fancy(`🧹 [${sessionId}] credentials purged from DB`));
    } catch (e) { console.error(`logout ${sessionId}:`, e.message); }
}

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

// ============================================
//   API ROUTES (For Frontend Web Panel)
// ============================================
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

// Health check route for the bot API
app.get("/", (req, res) => res.json({ status: "Bot API is running perfectly." }));

// ============================================
//   Boot
// ============================================
(async () => {
    console.log(fancy(`🚀 Starting Bot API...`));
    app.listen(PORT, () => {
        console.log(fancy(`🌐 Bot API listening on port ${PORT}`));
    });
    resumeAllSessions().catch(e => console.error("resumeAllSessions:", e.message));
})();