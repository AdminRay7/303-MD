require("dotenv").config();

// ============================================
//   Silence Baileys' known log spam
// ============================================
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
const _SILENCED_PATTERNS = ['Bad MAC', 'Bad RSA', 'doDecryptWhisperMessage', 'decryptWithSessions', 'verifyMAC', 'Session error:Error: Bad MAC', 'Failed to decrypt message with any known session', 'unpadRandomMax16', 'Closing session', 'Closing open session in favor of incoming preKey bundle', 'Session already closed', 'Removing old closed session', 'MessageCounterError'];
function _shouldSilence(args) { const first = args[0]; return typeof first === 'string' && _SILENCED_PATTERNS.some(p => first.includes(p)); }
console.error = (...args) => { if (!_shouldSilence(args)) _origConsoleError(...args); };
console.warn  = (...args) => { if (!_shouldSilence(args)) _origConsoleWarn(...args); };

const { 
    default: makeWASocket, 
    DisconnectReason, 
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongoAuthState");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
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

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function initMongo() {
    if (!config.mongodb) throw new Error("MONGODB_URI missing");
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(config.mongodb);
        await global.mongoClient.connect();
    }
}

async function getWaVersion() {
    try {
        const v = await fetchLatestWaWebVersion();
        if (v?.version) return v.version;
    } catch (e) {}
    return [2, 3000, 1042466098]; 
}

// ============================================
//   WhatsApp Socket Boot (For restoring sessions)
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
    const version = await getWaVersion();

    const conn = makeWASocket({
        version: version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        logger: pino({ level: "silent" }),
        // Use Ubuntu/Chrome string which is safest for Heroku
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 300000,
        connectTimeoutMs: 300000
    });

    session.conn = conn;
    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "open") {
            console.log(fancy(`✅ [${sessionId}] connected successfully`));
            try {
                await collection.updateOne({ _id: `${sessionId}:meta` }, { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } }, { upsert: true });
            } catch {}

            // Startup Message
            if (config.ownerNumber) {
                try {
                    const cleanOwner = String(config.ownerNumber).replace(/\D/g, "");
                    await conn.sendMessage(cleanOwner + "@s.whatsapp.net", {
                        text: `╭─── • 🔑 • ───╮\n   ${config.botName} ᴠ${config.version}\n╰─── • 🔑 • ───╯\n\n✅ Bot is online!\nSession: ${sessionId}`
                    });
                } catch (e) {}
            }
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            // 401 Logout Fix
            if (code === 401 || code === DisconnectReason.loggedOut) {
                console.log(fancy(`🚪 [${sessionId}] Logged out (401). Purging.`));
                const s = global.sessions.get(sessionId);
                if (s) { try { s.conn?.ev.removeAllListeners(); s.conn?.ws?.close(); } catch {} global.sessions.delete(sessionId); }
                try { await collection.deleteMany({ _id: { $regex: `^${escapeRegex(sessionId)}:` } }); } catch {}
                return;
            }

            global.__bootLocks.delete(sessionId);
            setTimeout(() => {
                if (global.sessions.has(sessionId)) bootSocket(sessionId, session).catch(() => {});
            }, 5000);
        }
    });

    const presenter = require("./presenter");
    conn.ev.on("messages.upsert", async (m) => { try { await presenter(conn, m, sessionId); } catch (e) {} });
    
    return conn;
}

// ============================================
//   Session Restore
// ============================================
async function resumeAllSessions() {
    if (!config.mongodb) return;
    try {
        await initMongo();
        const metas = await global.mongoClient.db("xmd303").collection("authState").find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(fancy(`🔄 Restoring ${metas.length} session(s)...`));

        for (const meta of metas) {
            const sessionId = String(meta._id).replace(/:meta$/, "");
            if (!global.sessions.has(sessionId)) {
                const session = { conn: null, socketReady: false };
                global.sessions.set(sessionId, session);
                bootSocket(sessionId, session).catch(e => console.error(`Restore ${sessionId}:`, e.message));
            }
        }
    } catch (e) { console.error("Restore error:", e.message); }
}

// ============================================
//   Express API Server
// ============================================
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

app.post("/api/pair", async (req, res) => {
    const { sessionId, num } = req.body;
    
    if (!sessionId || !num) return res.status(400).json({ error: "Missing sessionId or number" });

    try {
        await initMongo();
        const collection = global.mongoClient.db("xmd303").collection("authState");
        const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);
        
        const version = await getWaVersion();

        const conn = makeWASocket({
            version: version,
            auth: { creds: state.creds, keys: state.keys },
            logger: pino({ level: "silent" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            printQRInTerminal: false,
            // 60 seconds is enough. If it takes longer, WhatsApp will reject the code anyway.
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });

        // Wait strictly for the 'qr' event before requesting the code
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Socket timeout waiting for QR")), 20000);
            conn.ev.on("connection.update", (update) => {
                if (update.qr) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        const code = await conn.requestPairingCode(num);
        await saveCreds();
        
        // Add to global sessions and attach connection listeners
        if (!global.sessions.has(sessionId)) {
            const session = { conn: conn, socketReady: true }; 
            global.sessions.set(sessionId, session);
            
            conn.ev.on("connection.update", async (update) => {
                if (update.connection === "open") {
                    console.log(fancy(`✅ [${sessionId}] connected successfully after pairing`));
                    try {
                        await collection.updateOne({ _id: `${sessionId}:meta` }, { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } }, { upsert: true });
                    } catch {}
                    
                    if (config.ownerNumber) {
                        try {
                            const cleanOwner = String(config.ownerNumber).replace(/\D/g, "");
                            await conn.sendMessage(cleanOwner + "@s.whatsapp.net", {
                                text: `╭─── • 🔑 • ───╮\n   ${config.botName} ᴠ${config.version}\n╰─── • 🔑 • ───╯\n\n✅ Bot is online!\nSession: ${sessionId}`
                            });
                        } catch (e) {}
                    }
                }
            });
            
            const presenter = require("./presenter");
            conn.ev.on("messages.upsert", async (m) => { try { await presenter(conn, m, sessionId); } catch (e) {} });
        }

        res.json({ success: true, code: code.match(/.{1,4}/g)?.join("-") || code });

    } catch (error) {
        console.error("Pairing Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/pair/status", (req, res) => {
    const sessionId = String(req.query.sessionId || "").trim();
    const s = global.sessions.get(sessionId);
    if (!s) return res.json({ connected: false, exists: false });
    
    res.json({
        connected: !!s.conn?.user,
        exists: true,
        jid: s.conn?.user?.id || null
    });
});

app.get("/", (req, res) => res.json({ status: "Bot API is running" }));

// ============================================
//   Start Everything
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(fancy(`🌐 Bot API listening on port ${PORT}`));
    resumeAllSessions().catch(e => console.error("resumeAllSessions:", e.message));
});