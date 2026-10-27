const axios = require("axios");
const config = require("../config");

module.exports = {
    name: 'play',
    category: 'downloader',
    aliases: ['song', 'mp3'],
    description: 'Download a song from YouTube as MP3',
    async execute(conn, msg, args, ctx) {
        const { from, reply } = ctx;
        const query = args.join(" ");

        if (!query) {
            return reply("❌ Please provide a song name.\nExample: `.play Faded Alan Walker`");
        }

        // 1. Send a loading message
        const loadingMsg = await conn.sendMessage(from, { text: `🔍 Searching for "${query}"...` }, { quoted: msg });

        try {
            // 2. Search YouTube using your SEARCH_API_HOST from .env
            const searchOptions = {
                method: 'GET',
                url: `https://${config.searchApiHost}/search`,
                params: { q: query, part: 'id,snippet', maxResults: '1', type: 'video' },
                headers: {
                    'X-RapidAPI-Key': config.rapidApiKey,
                    'X-RapidAPI-Host': config.searchApiHost
                }
            };

            const searchRes = await axios.request(searchOptions);
            const video = searchRes.data.items?.[0];

            if (!video) {
                await conn.sendMessage(from, { text: "❌ No results found on YouTube.", edit: loadingMsg.key });
                return;
            }

            const videoId = video.id.videoId;
            const title = video.snippet.title;

            // 3. Update message: Converting
            await conn.sendMessage(from, { text: `🎵 Found: *${title}*\n⏳ Converting to MP3...`, edit: loadingMsg.key });

            // 4. Convert using YouTube MP3 (RapidAPI) from .env
            const mp3Options = {
                method: 'GET',
                url: `https://${config.rapidApiHost}/dl`,
                params: { id: videoId },
                headers: {
                    'X-RapidAPI-Key': config.rapidApiKey,
                    'X-RapidAPI-Host': config.rapidApiHost
                }
            };

            const mp3Res = await axios.request(mp3Options);
            const data = mp3Res.data;

            // Handle "processing" status (API needs time to convert)
            if (data.status === 'processing') {
                await conn.sendMessage(from, { text: `⏳ Still processing... this may take a moment.`, edit: loadingMsg.key });
                // Wait 3 seconds and retry
                await new Promise(r => setTimeout(r, 3000));
                const retryRes = await axios.request(mp3Options);
                if (retryRes.data.status === 'ok') {
                    return sendAudio(conn, from, msg, retryRes.data, loadingMsg.key);
                } else {
                    throw new Error("Conversion timed out. Try again.");
                }
            }

            if (data.status === 'ok') {
                return sendAudio(conn, from, msg, data, loadingMsg.key);
            } else {
                throw new Error(data.msg || "Conversion failed");
            }

        } catch (e) {
            console.error("Play error:", e.message);
            await conn.sendMessage(from, { text: `❌ Error: ${e.message}`, edit: loadingMsg.key });
        }
    }
};

// Helper function to send the audio file
async function sendAudio(conn, from, msg, data, loadingKey) {
    const { link, title, filesize } = data;
    
    // Check file size (WhatsApp limit is usually 16MB for audio)
    if (filesize && filesize > 16 * 1024 * 1024) {
        return conn.sendMessage(from, { 
            text: `⚠️ File is too large (${(filesize / 1024 / 1024).toFixed(2)} MB). WhatsApp limit is 16MB.`, 
            edit: loadingKey 
        });
    }

    try {
        // Download the audio buffer
        const audioRes = await axios.get(link, { responseType: 'arraybuffer' });
        
        await conn.sendMessage(from, {
            audio: Buffer.from(audioRes.data),
            mimetype: 'audio/mp4',
            fileName: `${title}.mp3`,
            caption: `🎵 *${title}*`
        }, { quoted: msg });

        // Delete the "Converting..." message to keep chat clean
        await conn.sendMessage(from, { delete: loadingKey });
    } catch (e) {
        console.error("Send audio error:", e.message);
        await conn.sendMessage(from, { text: `❌ Failed to send audio: ${e.message}`, edit: loadingKey });
    }
}