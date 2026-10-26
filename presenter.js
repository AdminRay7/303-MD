/**
 * presenter.js
 * Auto-loads commands from ./commands/*.js and auto modules from ./commands/auto/*.js
 * Hot-reloads when files change.
 *
 * Command module shape:
 *   { name, aliases?, category?, description?, ownerOnly?, allowInPrivate?,
 *     execute: async (conn, msg, args, ctx) => any }
 *
 * Auto module shape:
 *   { name?, execute: async (conn, msg, ctx) => boolean|void,
 *     onGroupUpdate?, onCall? }
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { fancy } = require("./lib/font");
const { SessionSettings } = require("./database/models");

const COMMANDS_DIR = path.join(__dirname, "commands");

const commandCache = new Map();
const aliasCache = new Map();
const autoCache = new Map();

// ============================================
//   Loader
// ============================================
function loadCommands() {
    commandCache.clear();
    aliasCache.clear();
    autoCache.clear();

    if (!fs.existsSync(COMMANDS_DIR)) {
        console.warn("⚠️  commands/ folder not found");
        return;
    }

    for (const file of fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"))) {
        try {
            const full = path.join(COMMANDS_DIR, file);
            delete require.cache[require.resolve(full)];
            const mod = require(full);
            if (!mod?.name || typeof mod.execute !== "function") {
                console.warn(`⚠️  skip ${file}: missing name or execute()`);
                continue;
            }
            const name = String(mod.name).toLowerCase();
            commandCache.set(name, mod);
            for (const a of (mod.aliases || [])) {
                aliasCache.set(String(a).toLowerCase(), name);
            }
        } catch (e) {
            console.error(`❌ load ${file}:`, e.message);
        }
    }

    const autoDir = path.join(COMMANDS_DIR, "auto");
    if (fs.existsSync(autoDir)) {
        for (const file of fs.readdirSync(autoDir).filter(f => f.endsWith(".js"))) {
            try {
                const full = path.join(autoDir, file);
                delete require.cache[require.resolve(full)];
                const mod = require(full);
                if (typeof mod.execute !== "function") {
                    console.warn(`⚠️  skip auto/${file}: missing execute()`);
                    continue;
                }
                const name = String(mod.name || file.replace(/\.js$/, "")).toLowerCase();
                autoCache.set(name, mod);
            } catch (e) {
                console.error(`❌ load auto/${file}:`, e.message);
            }
        }
    }

    console.log(fancy(
        `📦 Loaded ${commandCache.size} commands (${aliasCache.size} aliases) + ${autoCache.size} auto modules`
    ));
}

loadCommands();

let reloadTimer = null;
function scheduleReload() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
        reloadTimer = null;
        console.log("🔄 Reloading commands...");
        loadCommands();
    }, 500);
}

if (fs.existsSync(COMMANDS_DIR)) {
    try {
        fs.watch(COMMANDS_DIR, { recursive: true }, scheduleReload);
        console.log("👁️  Watching commands/ for changes");
    } catch (e) {
        console.warn("fs.watch unavailable:", e.message);
    }
}

// ============================================
//   Settings (SessionSettings overrides config defaults)
// ============================================
const _settingsCache = new Map();
const SETTINGS_TTL = 30_000;

async function getSettings(sessionId) {
    const cached = _settingsCache.get(sessionId);
    if (cached && Date.now() - cached.ts < SETTINGS_TTL) return cached.data;

    let s = null;
    try {
        s = await SessionSettings.findOne({ sessionId }).lean();
    } catch {}

    const data = {
        prefix:     s?.prefix     ?? config.prefix,
        botName:    s?.botName    ?? config.botName,
        footer:     s?.footer     ?? config.footer,
        workMode:   s?.workMode   ?? config.workMode,
        autoRead:   s?.autoRead   ?? config.autoRead,
        autoReact:  s?.autoReact  ?? config.autoReact,
        autoTyping: s?.autoTyping ?? config.autoTyping,
        antilink:   s?.antilink   ?? config.antilink,
        antispam:   s?.antispam   ?? config.antispam,
        antidelete: s?.antidelete ?? config.antidelete,
        anticall:   s?.anticall   ?? config.anticall,
        antimedia:  s?.antimedia  ?? config.antimedia
    };
    _settingsCache.set(sessionId, { data, ts: Date.now() });
    return data;
}

// ============================================
//   Message helpers
// ============================================
function getBody(msg) {
    let inner = msg.message || {};
    let guard = 0;
    while (guard++ < 5) {
        if (inner.ephemeralMessage?.message)             { inner = inner.ephemeralMessage.message; continue; }
        if (inner.viewOnceMessage?.message)              { inner = inner.viewOnceMessage.message; continue; }
        if (inner.viewOnceMessageV2?.message)            { inner = inner.viewOnceMessageV2.message; continue; }
        if (inner.viewOnceMessageV2Extension?.message)   { inner = inner.viewOnceMessageV2Extension.message; continue; }
        if (inner.editedMessage?.message)                { inner = inner.editedMessage.message; continue; }
        if (inner.documentWithCaptionMessage?.message)   { inner = inner.documentWithCaptionMessage.message; continue; }
        break;
    }
    return (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.buttonsResponseMessage?.selectedButtonId ||
        inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
        inner.templateButtonReplyMessage?.selectedId ||
        ""
    );
}

function isOwnerJid(msg) {
    const owners = String(config.ownerNumber || "")
        .split(",").map(n => n.replace(/\D/g, "")).filter(Boolean);
    if (!owners.length) return false;
    const sender = (msg.key?.participant || msg.key?.remoteJid || "")
        .split("@")[0].split(":")[0].replace(/\D/g, "");
    return owners.includes(sender);
}

function getSender(msg) {
    const from = msg.key.remoteJid;
    return from.endsWith("@g.us") ? (msg.key.participant || msg.participant || from) : from;
}

// ============================================
//   Main dispatcher
// ============================================
module.exports = async function presenter(conn, m, sessionId) {
    try {
        const messages = Array.isArray(m.messages) ? m.messages : [];
        const type = m.type;

        for (const msg of messages) {
            try {
                if (!msg?.message) continue;
                if (type && type !== "notify") continue;
                if (msg.key?.fromMe) continue;

                const from = msg.key?.remoteJid;
                if (!from) continue;
                if (from === "status@broadcast") continue;
                if (from.endsWith("@newsletter")) continue;

                const settings = await getSettings(sessionId);
                const body = getBody(msg);
                const pushName = msg.pushName || "";
                const sender = getSender(msg);
                const isGroup = from.endsWith("@g.us");
                const senderIsOwner = isOwnerJid(msg);

                if (settings.autoRead) {
                    try { await conn.readMessages([msg.key]); } catch {}
                }

                if (settings.autoReact) {
                    try {
                        await conn.sendMessage(from, { react: { text: "❤️", key: msg.key } });
                    } catch {}
                }

                // ---- Auto modules (no prefix) ----
                const autoCtx = {
                    from, sender, pushName, body, isGroup,
                    sessionId, settings, config, fancy,
                    isOwner: senderIsOwner,
                    conn, msg,
                    reply: (text, opts = {}) => conn.sendMessage(from, { text }, { quoted: msg, ...opts })
                };
                for (const [name, mod] of autoCache) {
                    try {
                        const handled = await mod.execute(conn, msg, autoCtx);
                        if (handled === true) break;
                    } catch (e) {
                        console.error(`[auto:${name}]`, e.message);
                    }
                }

                // ---- Command dispatch ----
                const prefix = settings.prefix;
                if (!body.startsWith(prefix)) continue;

                const spaceIdx = body.indexOf(" ");
                const cmdRaw = spaceIdx === -1
                    ? body.slice(prefix.length)
                    : body.slice(prefix.length, spaceIdx);
                const commandName = cmdRaw.toLowerCase().trim();
                if (!commandName) continue;

                const argsText = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
                const args = argsText ? argsText.split(/\s+/) : [];

                const resolved = aliasCache.get(commandName) || commandName;
                const mod = commandCache.get(resolved);
                if (!mod) continue;

                if (mod.ownerOnly && !senderIsOwner) {
                    await conn.sendMessage(from, { text: "🔒 Owner only." }, { quoted: msg });
                    continue;
                }

                if (settings.workMode === "private" && !senderIsOwner && mod.allowInPrivate !== true) {
                    continue;
                }

                if (settings.autoTyping) {
                    try { await conn.sendPresenceUpdate("composing", from); } catch {}
                }

                const ctx = {
                    from, sender, pushName, body,
                    command: commandName, args, argsText, prefix,
                    isGroup, isOwner: senderIsOwner,
                    sessionId, settings, config, fancy,
                    conn, msg,
                    reply: (text, opts = {}) => conn.sendMessage(from, { text }, { quoted: msg, ...opts }),
                    replyMedia: (content, opts = {}) => conn.sendMessage(from, content, { quoted: msg, ...opts })
                };

                try {
                    await mod.execute(conn, msg, args, ctx);
                } catch (e) {
                    console.error(`[cmd:${resolved}]`, e.message);
                    try {
                        await conn.sendMessage(from, {
                            text: `❌ Command error: ${e.message}`
                        }, { quoted: msg });
                    } catch {}
                }
            } catch (inner) {
                console.error(`[presenter:${sessionId}] msg:`, inner.message);
            }
        }
    } catch (err) {
        console.error(`[presenter:${sessionId || "?"}] fatal:`, err.message);
    }
};

// ============================================
//   Group update / call fan-out
// ============================================
module.exports.handleGroupUpdate = async function (conn, update) {
    try {
        if (!update?.id || !Array.isArray(update.participants)) return;
        for (const [name, mod] of autoCache) {
            if (typeof mod.onGroupUpdate !== "function") continue;
            try { await mod.onGroupUpdate(conn, update); }
            catch (e) { console.error(`[auto:${name}:group]`, e.message); }
        }
    } catch (e) {
        console.error("presenter.handleGroupUpdate:", e.message);
    }
};

module.exports.handleCallEvent = async function (conn, calls) {
    try {
        if (!Array.isArray(calls)) return;
        for (const call of calls) {
            if (config.anticall && call.status === "offer") {
                try { await conn.rejectCall(call.id, call.from); } catch {}
            }
            for (const [name, mod] of autoCache) {
                if (typeof mod.onCall !== "function") continue;
                try { await mod.onCall(conn, call); }
                catch (e) { console.error(`[auto:${name}:call]`, e.message); }
            }
        }
    } catch (e) {
        console.error("presenter.handleCallEvent:", e.message);
    }
};

// ============================================
//   Public API
// ============================================
module.exports.getCommandCache = () => commandCache;
module.exports.getAutoCache    = () => autoCache;
module.exports.reload          = loadCommands;