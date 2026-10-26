require("dotenv").config();

// ============================================
//   Silence Baileys' known log spam
// ============================================
const _origErr  = console.error.bind(console);
const _origWarn = console.warn.bind(console);
const _origLog  = console.log.bind(console);

const _SILENCED = [
    'Bad MAC', 'Bad RSA', 'doDecryptWhisperMessage', 'decryptWithSessions',
    'verifyMAC', 'Session error:Error: Bad MAC',
    'Failed to decrypt message with any known session',
    'unpadRandomMax16', 'Closing session',
    'Closing open session in favor of incoming preKey bundle',
    'Session already closed', 'Removing old closed session'
];
const _silence = (args) => {
    const f = args[0];
    if (typeof f !== 'string') return false;
    return _SILENCED.some(p => f.includes(p)) &&
        (f.includes('baileys') || f.includes('@whiskeysockets') || f.includes('Error:'));
};
console.error = (...a) => { if (!_silence(a)) _origErr(...a); };
console.warn  = (...a) => { if (!_silence(a)) _origWarn(...a); };

global._logBuffer = [];
const _MAX_LOG = 500;
console.log = (...a) => {
    try {
        const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x))
                      .join(" ").slice(0, 500);
        global._logBuffer.push({ t: Date.now(), msg: line });
        if (global._logBuffer.length > _MAX_LOG) global._logBuffer.shift();
    } catch {}
    _origLog(...a);
};

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

// ============================================
//   Middleware
// ============================================
try { app.set("trust proxy", 1); } catch {}
try { app.use(require("helmet")({ contentSecurityPolicy: false })); } catch {}
try { app.use(require("compression")()); } catch {}
try {
    const rateLimit = require("express-rate-limit");
    app.use("/api/pair", rateLimit({ windowMs: 60_000, max: 5 }));
} catch {}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ============================================
//   DB
// ============================================
if (config.mongodb) {
    mongoose.connect(config.mongodb, { dbName: "xmd303" })
        .then(() => console.log(fancy("✅ Database connected.")))
        .catch(err => console.error("DB Error:", err.message));
}

// ============================================
//   Global state
// ============================================
global.sessions = new Map();
global.mongoClient = null;
global.__waVersionCache = null;
global.__bootLocks = new Map();
global.__pairCooldown = new Map();

const MAX_SESSIONS = 12;
const PAIR_COOLDOWN_MS = 30_000;
const PAIR_CODE_TIMEOUT_MS = 20_000;
const SOCKET_READY_TIMEOUT_MS = 30_000;

// ============================================
//   Helpers
// ============================================
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
    } catch (e) { console.error("waVersion:", e.message); }
    return { version: [2, 3000, 1035194821] };
}

// ============================================
//   Pair queue
// ============================================
let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
}

// ============================================
//   GC for cooldowns
// ============================================
setInterval(() => {
    const now = Date.now();
    for (const [k, t] of global.__pairCooldown) {
        if (now - t > PAIR_COOLDOWN_MS * 4) global.__pairCooldown.delete(k);
    }
}, 60_000).unref?.();

// ============================================
//   Mongo
// ============================================
async function initMongo() {
    if (!config.mongodb) throw new Error("MONGODB_URI is not set");
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(config.mongodb);
        await global.mongoClient.connect();
        console.log(fancy("✅ MongoDB session store connected"));
    }
}

// ============================================
//   Boot
// ============================================
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
    console.log(fancy(`[${sessionId}] WA version ${JSON.stringify(version)}`));

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 60_000,
        retryRequestDelayMs: 2_000,
        fireInitQueries: false,
        emitOwnEvents: false
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
            console.log(fancy(`✅ [${sessionId}] connected as ${conn.user?.id}`));

            try {
                await collection.updateOne(
                    { _id: `${sessionId}:meta` },
                    { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } },
                    { upsert: true }
                );
            } catch {}

            // Subscribe to newsletter if configured
            if (config.autoSubscribeChannel && config.newsletterJid) {
                try {
                    await conn.subscribeNewsletterUpdates(config.newsletterJid);
                    console.log(fancy(`📰 [${sessionId}] subscribed to ${config.newsletterJid}`));
                } catch (e) {
                    console.log(`Newsletter subscribe skipped: ${e.message}`);
                }
            }

            // Send owner notification once per fresh pairing
            if (!session.welcomed && config.ownerNumber) {
                session.welcomed = true;
                try {
                    const ownerJid = config.ownerNumber.replace(/\D/g, "") + "@s.whatsapp.net";
                    await conn.sendMessage(ownerJid, {
                        text:
                            `╭─── • 🔑 • ───╮\n` +
                            `   ${config.botName} ᴠ${config.version}\n` +
                            `╰─── • 🔑 • ───╯\n\n` +
                            `✅ New session linked!\n` +
                            `Session: ${sessionId}\n` +
                            `Owner: ${config.ownerName}\n\n` +
                            `${fancy(config.footer)}`
                    });
                } catch {}
            }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairingReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(fancy(`❌ [${sessionId}] closed (${code})`));

            if (code === 401 || code === DisconnectReason.loggedOut) {
                await logoutSession(sessionId);
                return;
            }
            if (session._paused) return;
            if (code === 440) { global.sessions.delete(sessionId); return; }

            global.__bootLocks.delete(sessionId);
            setTimeout(() => {
                if (!global.sessions.has(sessionId) || session._paused) return;
                bootSocket(sessionId, session).catch(e =>
                    console.error(`Reconnect ${sessionId}:`, e.message)
                );
            }, 5000);
        }
    });

    // Presenter wires commands + auto modules
    const presenter = require("./presenter");
    conn.ev.on("messages.upsert", async (m) => {
        try { await presenter(conn, m, sessionId); }
        catch (e) { console.error(`[${sessionId}] presenter:`, e.message); }
    });
    conn.ev.on("group-participants.update", async (u) => {
        try { await presenter.handleGroupUpdate(conn, u); } catch {}
    });
    conn.ev.on("call", async (calls) => {
        try { await presenter.handleCallEvent(conn, calls); } catch {}
    });

    // Status updates (view + like + optional reply)
    conn.ev.on("messages.upsert", async (m) => {
        try {
            if (m.type !== "notify") return;
            if (!Array.isArray(m.messages)) return;
            for (const msg of m.messages) {
                if (msg.key?.remoteJid !== "status@broadcast") continue;
                if (msg.key?.fromMe) continue;
                if (config.autoStatus.view) {
                    try { await conn.readMessages([msg.key]); } catch {}
                }
                if (config.autoStatus.like) {
                    try {
                        const emoji = config.channelEmojis[Math.floor(Math.random() * config.channelEmojis.length)];
                        await conn.sendMessage("status@broadcast", {
                            react: { text: emoji, key: msg.key }
                        }, { statusJidList: [msg.key.participant || msg.key.remoteJid] });
                    } catch {}
                }
                if (config.autoStatus.reply && config.statusReplyText) {
                    try {
                        const from = msg.key.participant || msg.key.remoteJid;
                        if (from && from !== "status@broadcast") {
                            await conn.sendMessage(from, { text: config.statusReplyText });
                        }
                    } catch {}
                }
            }
        } catch (e) {
            console.error(`[${sessionId}] status handler:`, e.message);
        }
    });

    return conn;
}

// ============================================
//   Pairing
// ============================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        let session = global.sessions.get(sessionId);

        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= MAX_SESSIONS)
                throw new Error(`Server at capacity (${MAX_SESSIONS})`);
            session = {
                conn: null, socketReady: false, pairing: null,
                pairingNumber: null, startedAt: Date.now(),
                welcomed: false, pairingReady: false, socketFailed: false
            };
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
        if (!session.pairingReady && !session.socketReady) {
            throw new Error("Socket not ready after 30s");
        }

        let code;
        try {
            code = await Promise.race([
                session.conn.requestPairingCode(phoneNumber),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("Pairing request timed out")), PAIR_CODE_TIMEOUT_MS)
                )
            ]);
        } catch (first) {
            console.log(`[${sessionId}] retry: ${first.message}`);
            await new Promise(r => setTimeout(r, 2000));
            code = await Promise.race([
                session.conn.requestPairingCode(phoneNumber),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("Pairing retry timed out")), PAIR_CODE_TIMEOUT_MS)
                )
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

async function resumeAllSessions() {
    if (!config.mongodb) return;
    try {
        await initMongo();
        const c = global.mongoClient.db("xmd303").collection("authState");
        const metas = await c.find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(fancy(`🔄 Resuming ${metas.length} session(s)...`));

        const CONCURRENCY = 3;
        const ids = metas.map(m => String(m._id).replace(/:meta$/, ""))
                         .filter(id => !global.sessions.has(id));

        for (let i = 0; i < ids.length; i += CONCURRENCY) {
            const chunk = ids.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (sessionId) => {
                if (global.sessions.size >= MAX_SESSIONS) return;
                const session = {
                    conn: null, socketReady: false, pairing: null,
                    pairingNumber: null, startedAt: Date.now(),
                    welcomed: true, pairingReady: false, socketFailed: false
                };
                global.sessions.set(sessionId, session);
                try {
                    await Promise.race([
                        bootSocket(sessionId, session),
                        new Promise((_, rej) =>
                            setTimeout(() => rej(new Error("boot timeout")), 75_000)
                        )
                    ]);
                } catch (e) {
                    console.error(`Resume ${sessionId}:`, e.message);
                    global.sessions.delete(sessionId);
                }
            }));
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) { console.error("Resume:", e.message); }
}

// ============================================
//   ROUTES
// ============================================
app.get("/",       (req, res) => servePage(res, "pair.html"));
app.get("/pair",   (req, res) => servePage(res, "pair.html"));
app.get("/status", (req, res) => servePage(res, "pair.html"));

app.post("/api/pair", async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const num = String(req.body?.num || "").replace(/\D/g, "");

    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(sessionId))
        return res.status(400).json({ error: "Invalid sessionId (3-40 alphanumeric/_/-)" });
    if (num.length < 10 || num.length > 15)
        return res.status(400).json({ error: "Phone must be 10-15 digits" });

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

app.get("/api/sessions", (req, res) => {
    const list = [];
    for (const [id, s] of global.sessions) {
        list.push({
            sessionId: id,
            connected: !!s.conn?.user,
            ready: !!s.socketReady,
            pairing: s.pairing || null,
            jid: s.conn?.user?.id || null
        });
    }
    res.json({ success: true, total: list.length, max: MAX_SESSIONS, sessions: list });
});

app.post("/api/reload-commands", (req, res) => {
    try {
        const presenter = require("./presenter");
        presenter.reload();
        res.json({
            success: true,
            commands: presenter.getCommandCache().size,
            auto: presenter.getAutoCache().size
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
//   Shutdown
// ============================================
async function shutdown(sig) {
    console.log(fancy(`\n🛑 ${sig} — shutting down...`));
    try {
        const closes = [];
        for (const [, s] of global.sessions) {
            if (s.conn) {
                closes.push(new Promise(resolve => {
                    try { s.conn.ev.removeAllListeners(); s.conn.ws.close(); } catch {}
                    setTimeout(resolve, 1000);
                }));
            }
        }
        await Promise.all(closes);
        if (global.mongoClient) await global.mongoClient.close();
        if (mongoose.connection.readyState === 1) await mongoose.connection.close();
    } catch {}
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", r => console.error("Unhandled:", r));

// ============================================
//   Boot
// ============================================
(async () => {
    console.log(fancy(`🚀 Starting ${config.botName} v${config.version} (pairing + commands)...`));
    app.listen(PORT, () => {
        console.log(fancy(`🌐 Dashboard: http://localhost:${PORT}`));
    });
    resumeAllSessions().catch(e => console.error("resumeAllSessions:", e.message));
})();