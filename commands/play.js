const axios = require("axios");
const config = require("../config");

module.exports = {
    name: 'play',
    category: 'downloader',
    aliases: ['song', 'mp3'],
    description: 'Download a song using Toosii Tech API',
    async execute(conn, msg, args, ctx) {
        const { from, reply } = ctx;
        const query = args.join(" ");

        if (!query) {
            return reply("❌ Please provide a song name.\nExample: `.play yatapita`");
        }

        const loadingMsg = await conn.sendMessage(from, { text: `🔍 Searching Toosii for "${query}"...` }, { quoted: msg });

        try {
            // We are using the exact Toosii base URL from your email.
            // If the endpoint is '/play' or '/download', we will try it here.
            const TOOSII_URL = 'https://toosiitechdevelopertools.zone.id/api/v1/play'; 

            const response = await axios.get(TOOSII_URL, {
                params: {
                    query: query,
                    q: query // sending both just in case their API expects 'q'
                },
                headers: {
                    'Authorization': `Bearer ${process.env.TOOSII_API_KEY}`,
                    'x-api-key': process.env.TOOSII_API_KEY
                }
            });

            const data = response.data;

            // Check if the API returned a valid audio link
            const audioUrl = data.url || data.link || data.download || data.data?.url;
            const title = data.title || data.data?.title || query;

            if (!audioUrl) {
                console.log("Toosii Response:", data); // Log this so you can see what it actually returned
                throw new Error("API responded, but no audio link was found. Check logs.");
            }

            // Send the audio file
            await conn.sendMessage(from, {
                audio: { url: audioUrl },
                mimetype: 'audio/mp4',
                fileName: `${title}.mp3`,
                caption: `🎵 *${title}*`
            }, { quoted: msg });

            // Delete the loading message
            await conn.sendMessage(from, { delete: loadingMsg.key });

        } catch (e) {
            console.error("Toosii Play error:", e.message);
            
            // If 'play' fails, try the '/download' endpoint as a fallback
            try {
                const fallbackRes = await axios.get('https://toosiitechdevelopertools.zone.id/api/v1/download', {
                    params: { url: query },
                    headers: { 'Authorization': `Bearer ${process.env.TOOSII_API_KEY}` }
                });
                
                const fallbackUrl = fallbackRes.data.url || fallbackRes.data.link;
                if (fallbackUrl) {
                    await conn.sendMessage(from, {
                        audio: { url: fallbackUrl },
                        mimetype: 'audio/mp4',
                        fileName: `audio.mp3`
                    }, { quoted: msg });
                    await conn.sendMessage(from, { delete: loadingMsg.key });
                    return;
                }
            } catch (err) {
                // Both failed
            }

            await conn.sendMessage(from, { 
                text: `❌ Error: ${e.message}`, 
                edit: loadingMsg.key 
            });
        }
    }
};