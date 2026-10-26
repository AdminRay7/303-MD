// commands/menu.js
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const { fancy } = require('../lib/font');

// Resolve /Assets folder at project root
const ASSETS_DIR = path.join(__dirname, '..', 'Assets');
const COMMANDS_DIR = path.join(__dirname, '..', 'commands');

// ============================================================
//   FIND MENU IMAGE
// ============================================================
function findMenuImage() {
    if (!fs.existsSync(ASSETS_DIR)) return null;
    const files = fs.readdirSync(ASSETS_DIR);
    const img = files.find(f => /^menu\.(png|jpe?g|webp|gif)$/i.test(f));
    return img ? path.join(ASSETS_DIR, img) : null;
}

// ============================================================
//   SCAN COMMANDS FOLDER
//   Reads every .js recursively. Picks up:
//   - module.name
//   - module.category (defaults to "general")
//   - module.description (optional)
//   - module.aliases (optional, not shown in menu)
// ============================================================
function scanCommands() {
    if (!fs.existsSync(COMMANDS_DIR)) return [];
    const seen = new Set();
    const list = [];

    const walk = (dir) => {
        for (const item of fs.readdirSync(dir)) {
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
                walk(itemPath);
            } else if (item.endsWith('.js')) {
                try {
                    delete require.cache[require.resolve(itemPath)];
                    const mod = require(itemPath);
                    if (!mod || typeof mod.execute !== 'function') continue;
                    if (seen.has(mod)) continue;
                    seen.add(mod);

                    const name = (mod.name || path.basename(itemPath, '.js')).toLowerCase();
                    const category = (mod.category || 'general').toLowerCase();

                    list.push({ name, category });
                } catch (e) {
                    console.error(`menu scan: ${itemPath}:`, e.message);
                }
            }
        }
    };

    walk(COMMANDS_DIR);
    return list;
}

// ============================================================
//   BUILD MENU TEXT
//   Groups by category. Shows only the primary command name.
//   No aliases in the menu — clean look.
// ============================================================
function buildMenuText(cmds, ctx) {
    const groups = {};
    for (const c of cmds) {
        if (!groups[c.category]) groups[c.category] = [];
        groups[c.category].push(c.name);
    }

    // Sort: "general" first, then alphabetical
    const catOrder = Object.keys(groups).sort((a, b) => {
        if (a === 'general') return -1;
        if (b === 'general') return 1;
        return a.localeCompare(b);
    });

    const username = ctx?.pushname || 'User';

    let text =
        `╭─〔 🔑 ${config.botName} 〕\n` +
        `│\n` +
        `│ 👤 USER   : ${username}\n` +
        `│ 🎯 PREFIX : ${config.prefix}\n` +
        `│\n` +
        `╰──────────────────────\n\n`;

    for (const cat of catOrder) {
        const names = groups[cat].sort();
        text += `╭─〔 📌 ${cat.toUpperCase()} 〕\n`;
        text += `│\n`;
        for (const n of names) {
            text += `│ ◇ ${config.prefix}${n}\n`;
        }
        text += `│\n`;
        text += `╰──────────────────────\n\n`;
    }

    text += `_${fancy(config.footer)}_`;
    return text;
}

// ============================================================
//   EXPORT
// ============================================================
module.exports = {
    name: 'menu',
    category: 'general',
    aliases: ['help', 'commands', 'cmds'],
    description: 'Show all available commands grouped by category',

    async execute(conn, msg, args, ctx) {
        const { from } = ctx;
        const cmds = scanCommands();

        if (!cmds.length) {
            return conn.sendMessage(from, { text: 'No commands found.' }, { quoted: msg });
        }

        const text = buildMenuText(cmds, ctx);
        const imgPath = findMenuImage();

        if (imgPath) {
            try {
                const buffer = await fs.readFile(imgPath);
                return conn.sendMessage(from, {
                    image: buffer,
                    caption: text
                }, { quoted: msg });
            } catch (e) {
                console.error('Menu image send failed:', e.message);
            }
        }

        await conn.sendMessage(from, { text }, { quoted: msg });
    }
};