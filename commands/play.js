const axios = require("axios");
const config = require("../config");

const TOOSII_BASE = "https://toosiitechdevelopertools.zone.id/api/v1";
const TOOSII_TOKEN = process.env.TOOSII_API_KEY || config.toosiiKey;

module.exports = {
    name: 'play',
    category: 'downloader',
    aliases: ['song', 'mp3', 'audio'],
    description: 'Download a song using Toosii Tech API',
    async execute(conn, msg, args, ctx) {
        const { from, reply } = ctx;
        const query = args.join(" ");

        if (!query) {
            return reply("❌ Please provide a song name.\nExample: `.play yatapita`");
        }

        const loadingMsg = await conn.sendMessage(from, { text: `🔍 Searching for "${query}"...` }, { quoted: msg });

        try {
            // 1. Search YouTube using your granted /search/youtube scope
            const searchRes = await axios.get(`${TOOSII_BASE}/search/youtube`, {
                params: { q: query },
                headers: { 
                    'Authorization': `Bearer ${TOOSII_TOKEN}`,
                    'x-api-key': TOOSII_TOKEN
                }
            });

            // Adjust this based on exactly how their search results are formatted
            const results = searchRes.data.results || searchRes.data.data || [];
            const video = results[0];

            if (!video) {
                throw new Error("No results found on YouTube.");
            }

            const videoUrl = video.url || video.link || `https://youtube.com/watch?v=${video.videoId}`;
            const title = video.title || query;

            await conn.sendMessage(from, { text: `🎵 Found: *${title}*\n⏳ Downloading audio...`, edit: loadingMsg.key });

            // 2. Download Audio using your granted /download/audio scope
            const downloadRes = await axios.get(`${TOOSII_BASE}/download/audio`, {
                params: { url: videoUrl }, // Most APIs require the full YouTube URL here
                headers: { 
                    'Authorization': `Bearer ${TOOSII_TOKEN}`,
                    'x-api-key': TOOSII_TOKEN
                }
            });

            const audioUrl = downloadRes.data.url || downloadRes.data.link || downloadRes.data.download;
            
            if (!audioUrl) {
                throw new Error("Could not extract audio link from the download API.");
            }

            // 3. Send the audio to WhatsApp
            await conn.sendMessage(from, {
                audio: { url: audioUrl },
                mimetype: 'audio/mp4',
                fileName: `${title}.mp3`,
                caption: `🎵 *${title}*`
            }, { quoted: msg });

            // Clean up the loading message
            await conn.sendMessage(from, { delete: loadingMsg.key });

        } catch (e) {
            console.error("Toosii Play error:", e.message);
            await conn.sendMessage(from, { 
                text: `❌ Error: ${e.message}`, 
                edit: loadingMsg.key 
            });
        }
    }
};