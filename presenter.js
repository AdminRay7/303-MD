const fs = require("fs");
const path = require("path");
const config = require("./config");
const { fancy } = require("./lib/font");
const { SessionSettings } = require("./database/models");

const COMMANDS_DIR = path.join(__dirname, "commands");
const commandCache = new Map();
const aliasCache = new Map();
const autoCache = new Map();

function loadCommands() {
    commandCache.clear();
    aliasCache.clear();
    autoCache.clear();
    if (!fs.existsSync(COMMANDS_DIR)) return;

    for (const file of fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"))) {
        try {
            const full = path.join(COMMANDS_DIR, file);
            delete require.cache[require.resolve(full)];
            const mod = require(full);
            if (!mod?.name || typeof mod.execute !== "function") continue;
            const name = String(mod.name).toLowerCase();
            commandCache.set(name, mod);
            for (const a of (mod.aliases || [])) aliasCache.set(String(a).toLowerCase(), name);
        } catch (e) { console.error(`❌ load ${file}:`, e.message); }
    }

    const autoDir = path.join(COMMANDS_DIR, "auto");
    if (fs.existsSync(autoDir)) {
        for (const file of fs.readdirSync(autoDir).filter(f => f.endsWith(".js"))) {
            try {
                const full = path.join(autoDir, file);
                delete require.cache[require.resolve(full)];
                const mod = require(full);
                if (typeof mod.execute !== "function") continue;
                const name = String(mod.name || file.replace(/\.js$/, "")).toLowerCase();
                autoCache.set(name, mod);
            } catch (e) { console.error(`❌ load auto/${file}:`, e.message); }
        }
    }
    console.log(fancy(`📦 Loaded ${commandCache.size} commands + ${autoCache.size} auto modules`));
}

loadCommands();

let reloadTimer = null;
if (fs.existsSync(COMMANDS_DIR)) {
    try { fs.watch(COMMANDS_DIR, { recursive: true }, () => {
        if (reloadTimer) return;
        reloadTimer = setTimeout(() => { reloadTimer = null; loadCommands(); }, 500);
    }); } catch (e) {}
}

const _settingsCache = new Map();
async function getSettings(sessionId) {
    const cached = _settingsCache.get(sessionId);
    if (cached && Date.now() - cached.ts < 30_000) return cached.data;
    let s = null;
    try { s = await SessionSettings.findOne({ sessionId }).lean(); } catch {}
    const data = {
        prefix: s?.prefix ?? config.prefix,
        botName: s?.botName ?? config.botName,
        footer: s?.footer ?? config.footer,
        workMode: s?.workMode ?? config.workMode, // Uses your .env WORK_MODE
        autoRead: s?.autoRead ?? config.autoRead,
        autoReact: s?.autoReact ?? config.autoReact,
        autoTyping: s?.autoTyping ?? config.autoTyping,
        antilink: s?.antilink ?? config.antilink,
        antispam: s?.antispam ?? config.antispam,
        antidelete: s?.antidelete ?? config.antidelete,
        anticall: s?.anticall ?? config.anticall
    };
    _settingsCache.set(sessionId, { data, ts: Date.now() });
    return data;
}

function getBody(msg) {
    let inner = msg.message || {};
    let guard = 0;
    while (guard++ < 5) {
        if (inner.ephemeralMessage?.message) { inner = inner.ephemeralMessage.message; continue; }
        if (inner.viewOnceMessage?.message) { inner = inner.viewOnceMessage.message; continue; }
        if (inner.viewOnceMessageV2?.message) { inner = inner.viewOnceMessageV2.message; continue; }
        if (inner.viewOnceMessageV2Extension?.message) { inner = inner.viewOnceMessageV2Extension.message; continue; }
        if (inner.editedMessage?.message) { inner = inner.editedMessage.message; continue; }
        if (inner.documentWithCaptionMessage?.message) { inner = inner.documentWithCaptionMessage.message; continue; }
        break;
    }
    return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || "";
}

function isOwnerJid(msg) {
    const owners = String(config.ownerNumber || "").split(",").map(n => n.replace(/\D/g, "")).filter(Boolean);
    if (!owners.length) return false;
    const sender = (msg.key?.participant || msg.key?.remoteJid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
    return owners.includes(sender);
}

function getSender(msg) {
    const from = msg.key.remoteJid;
    return from.endsWith("@g.us") ? (msg.key.participant || msg.participant || from) : from;
}

module.exports = async function presenter(conn, m, sessionId) {
    try {
        const messages = Array.isArray(m.messages) ? m.messages : [];
        if (m.type && m.type !== "notify") return;

        for (const msg of messages) {
            try {
                if (!msg?.message) continue;
                const from = msg.key?.remoteJid;
                if (!from || from === "status@broadcast" || from.endsWith("@newsletter")) continue;

                const settings = await getSettings(sessionId);
                const body = getBody(msg);
                const sender = getSender(msg);
                const isGroup = from.endsWith("@g.us");
                const senderIsOwner = isOwnerJid(msg);

                // Only ignore the bot's own messages (not the owner's)
                if (msg.key?.fromMe && !senderIsOwner) continue;

                if (settings.autoRead && !msg.key.fromMe) { try { await conn.readMessages([msg.key]); } catch {} }
                if (settings.autoReact && !msg.key.fromMe) { try { await conn.sendMessage(from, { react: { text: "❤️", key: msg.key } }); } catch {} }

                const autoCtx = { from, sender, body, isGroup, sessionId, settings, config, fancy, isOwner: senderIsOwner, conn, msg, reply: (text, opts = {}) => conn.sendMessage(from, { text }, { quoted: msg, ...opts }) };
                for (const [name, mod] of autoCache) {
                    try { if (await mod.execute(conn, msg, autoCtx) === true) break; } catch (e) {}
                }

                const prefix = settings.prefix;
                if (!body.startsWith(prefix)) continue;

                const spaceIdx = body.indexOf(" ");
                const cmdRaw = spaceIdx === -1 ? body.slice(prefix.length) : body.slice(prefix.length, spaceIdx);
                const commandName = cmdRaw.toLowerCase().trim();
                if (!commandName) continue;

                const argsText = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
                const args = argsText ? argsText.split(/\s+/) : [];

                const resolved = aliasCache.get(commandName) || commandName;
                const mod = commandCache.get(resolved);
                if (!mod) continue;

                // 1. Check if the command is strictly for the Owner
                if (mod.ownerOnly && !senderIsOwner) {
                    await conn.sendMessage(from, { text: "🔒 This command is for the bot owner only." }, { quoted: msg });
                    continue;
                }

                // 2. Check WORK_MODE. If private, block non-owners. If public, allow everyone.
                if (settings.workMode === "private" && !senderIsOwner && mod.allowInPrivate !== true) {
                    continue;
                }

                if (settings.autoTyping && !msg.key.fromMe) { try { await conn.sendPresenceUpdate("composing", from); } catch {} }

                const ctx = { from, sender, body, command: commandName, args, argsText, prefix, isGroup, isOwner: senderIsOwner, sessionId, settings, config, fancy, conn, msg, reply: (text, opts = {}) => conn.sendMessage(from, { text }, { quoted: msg, ...opts }) };

                try { await mod.execute(conn, msg, args, ctx); } 
                catch (e) {
                    console.error(`[cmd:${resolved}]`, e.message);
                    try { await conn.sendMessage(from, { text: `❌ Command error: ${e.message}` }, { quoted: msg }); } catch {}
                }
            } catch (inner) {}
        }
    } catch (err) {}
};

module.exports.handleGroupUpdate = async function (conn, update) {
    try {
        if (!update?.id || !Array.isArray(update.participants)) return;
        for (const [name, mod] of autoCache) {
            if (typeof mod.onGroupUpdate === "function") { try { await mod.onGroupUpdate(conn, update); } catch (e) {} }
        }
    } catch (e) {}
};

module.exports.handleCallEvent = async function (conn, calls) {
    try {
        if (!Array.isArray(calls)) return;
        for (const call of calls) {
            if (config.anticall && call.status === "offer") { try { await conn.rejectCall(call.id, call.from); } catch {} }
            for (const [name, mod] of autoCache) {
                if (typeof mod.onCall === "function") { try { await mod.onCall(conn, call); } catch (e) {} }
            }
        }
    } catch (e) {}
};

module.exports.getCommandCache = () => commandCache;
module.exports.getAutoCache = () => autoCache;
module.exports.reload = loadCommands;