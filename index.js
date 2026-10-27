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
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongoAuthState");
const pino = require("pino");
const mongoose = require("mongoose");
const config = require("./config");
const { fancy } = require("./lib/font");

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
global.__bootLocks = new Map();

// ============================================
//   Helpers
// ============================================
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function initMongo() {
    if (!config.mongodb) throw new Error("MONGODB_URI missing");
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(config.mongodb);
        await global.mongoClient.connect();
    }
}

// ============================================
//   Socket Boot
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

    const conn = makeWASocket({
        version: [2, 3000, 1042466098], // Stable version
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

            // Welcome Message on Startup/Restart
            if (config.ownerNumber) {
                try {
                    const cleanOwner = String(config.ownerNumber).replace(/\D/g, "");
                    await conn.sendMessage(cleanOwner + "@s.whatsapp.net", {
                        text: `╭─── • 🔑 • ───╮\n   ${config.botName} ᴠ${config.version}\n╰─── • 🔑 • ───╯\n\n✅ Bot is online!\nSession: ${sessionId}\nStatus: Connected\n\n${fancy(config.footer)}`
                    });
                    console.log(fancy(`📩 Startup message sent to owner`));
                } catch (e) {}
            }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairingReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;

            // ORIGINAL 401 LOGOUT FIX
            if (code === 401 || code === DisconnectReason.loggedOut) {
                console.log(fancy(`🚪 [${sessionId}] Logged out (401). Purging session.`));
                const s = global.sessions.get(sessionId);
                if (s) { try { s.conn?.ev.removeAllListeners(); s.conn?.ws?.close(); } catch {} global.sessions.delete(sessionId); }
                try {
                    await collection.deleteMany({ _id: { $regex: `^${escapeRegex(sessionId)}:` } });
                } catch {}
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

    // Load Presenter (Commands Engine)
    const presenter = require("./presenter");
    conn.ev.on("messages.upsert", async (m) => { try { await presenter(conn, m, sessionId); } catch (e) {} });
    conn.ev.on("group-participants.update", async (u) => { try { await presenter.handleGroupUpdate(conn, u); } catch (e) {} });
    conn.ev.on("call", async (calls) => { try { await presenter.handleCallEvent(conn, calls); } catch (e) {} });

    return conn;
}

// ============================================
//   Restore Sessions
// ============================================
async function resumeAllSessions() {
    if (!config.mongodb) return;
    try {
        await initMongo();
        const c = global.mongoClient.db("xmd303").collection("authState");
        const metas = await c.find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(fancy(`🔄 Restoring ${metas.length} session(s)...`));

        const ids = metas.map(m => String(m._id).replace(/:meta$/, "")).filter(id => !global.sessions.has(id));

        for (const sessionId of ids) {
            const session = { conn: null, socketReady: false, pairing: null, pairingNumber: null, startedAt: Date.now(), welcomed: true, pairingReady: false, socketFailed: false };
            global.sessions.set(sessionId, session);
            try {
                await Promise.race([
                    bootSocket(sessionId, session),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("boot timeout")), 75000))
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
//   Start Bot Engine
// ============================================
(async () => {
    console.log(fancy(`🚀 Starting Bot Core (Worker)...`));
    // No app.listen() here! This is a background worker.
    resumeAllSessions().catch(e => console.error("resumeAllSessions:", e.message));
})();