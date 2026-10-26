module.exports = {
    name: "help",
    aliases: ["h", "menu"],
    category: "general",
    description: "Show all commands",
    async execute(conn, msg, args, ctx) {
        const presenter = require("../presenter");
        const cache = presenter.getCommandCache();

        const byCat = {};
        for (const [, mod] of cache) {
            const cat = (mod.category || "misc").toLowerCase();
            (byCat[cat] ||= []).push(mod.name);
        }

        let out =
            `╭─── • 🤖 • ───╮\n` +
            `   *${ctx.settings.botName.toUpperCase()} MENU*\n` +
            `╰─── • 🤖 • ───╯\n\n`;
        for (const cat of Object.keys(byCat).sort()) {
            out += `*${cat.toUpperCase()}*\n`;
            for (const c of byCat[cat].sort()) out += `  ${ctx.prefix}${c}\n`;
            out += `\n`;
        }
        out += `_Prefix:_ *${ctx.prefix}*\n_Total:_ *${cache.size}* commands\n\n${ctx.config.footer}`;
        await ctx.reply(out);
    }
};