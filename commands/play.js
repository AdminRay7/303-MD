const axios = require("axios");

module.exports = {
    name: 'play',
    category: 'downloader',
    aliases: ['song', 'mp3', 'audio'],
    description: 'Download a song from YouTube',
    async execute(conn, msg, args, ctx) {
        const { from, reply } = ctx;
        const query = args.join(" ");
        if (!query) return reply("❌ Provide a song name.");

        const loadingMsg = await conn.sendMessage(from, { text: `🔍 Searching YouTube for "${query}"...` }, { quoted: msg });

        try {
            // 1. Search YouTube via RapidAPI
            const searchRes = await axios.get(`https://${process.env.SEARCH_API_HOST}/search`, {
                params: { q: query, part: 'id,snippet', maxResults: '1', type: 'video' },
                headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': process.env.SEARCH_API_HOST }
            });

            const video = searchRes.data.items?.[0];
            if (!video) throw new Error("No results found.");

            const videoId = video.id.videoId;
            const title = video.snippet.title;

            await conn.sendMessage(from, { text: `🎵 Found: *${title}*\n⏳ Converting...`, edit: loadingMsg.key });

            // 2. Download MP3 via RapidAPI
            const mp3Res = await axios.get(`https://${process.env.RAPIDAPI_HOST}/dl`, {
                params: { id: videoId },
                headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': process.env.RAPIDAPI_HOST }
            });

            let data = mp3Res.data;
            
            // Sometimes the API takes a few seconds to process
            if (data.status === 'processing') {
                await conn.sendMessage(from, { text: `⏳ Processing audio...`, edit: loadingMsg.key });
                await new Promise(r => setTimeout(r, 4000));
                const retryRes = await axios.get(`https://${process.env.RAPIDAPI_HOST}/dl`, {
                    params: { id: videoId },
                    headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': process.env.RAPIDAPI_HOST }
                });
                data = retryRes.data;
            }

            if (data.status !== 'ok' || !data.link) {
                throw new Error(data.msg || "Conversion failed.");
            }

            // 3. Send Audio
            await conn.sendMessage(from, {
                audio: { url: data.link },
                mimetype: 'audio/mp4',
                fileName: `${title}.mp3`,
                caption: `🎵 *${title}*`
            }, { quoted: msg });

            await conn.sendMessage(from, { delete: loadingMsg.key });

        } catch (e) {
            console.error("Play Error:", e.message);
            await conn.sendMessage(from, { text: `❌ Error: ${e.message}`, edit: loadingMsg.key });
        }
    }
};