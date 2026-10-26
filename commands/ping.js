// commands/ping.js
module.exports = {
    name: 'ping',
    category: 'general',
    aliases: ['p', 'speed'],
    description: 'Check bot speed',
    async execute(conn, msg, args, ctx) {
        const { from } = ctx;
        const t0 = Date.now();

        const sent = await conn.sendMessage(from, { text: '𝐏𝐢𝐧𝐠𝐢𝐧𝐠...' }, { quoted: msg });
        const latency = Date.now() - t0;

        try {
            await conn.sendMessage(from, { 
                // Pong in your exact font, speed in stylized small caps
                text: `𝐏𝛐𝛈𝐠! ⚡ 𝐬𝐩𝐞𝐞𝐝: ${latency} ms`, 
                edit: sent.key 
            });
        } catch (e) {
            await conn.sendMessage(from, { text: `𝐏𝛐𝛈𝐠! ⚡ 𝐬𝐩𝐞𝐞𝐝: ${latency} ms` }, { quoted: msg });
        }
    }
};