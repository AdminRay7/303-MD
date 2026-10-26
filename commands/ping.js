module.exports = {
    name: "ping",
    aliases: ["p"],
    category: "general",
    description: "Check if the bot is alive",
    async execute(conn, msg, args, ctx) {
        const start = Date.now();
        await ctx.reply(`🏓 *Pong!*\nLatency: \`${Date.now() - start}ms\``);
    }
};