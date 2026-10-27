const axios = require("axios");

// HARDCODED CREDENTIALS
const RAPIDAPI_KEY = "eae3a83c15msh69a6323638e111fp1cfb10jsna8bbd4863ac0";
const SEARCH_HOST = "youtube-v31.p.rapidapi.com";
const MP3_HOST = "youtube-mp36.p.rapidapi.com";

module.exports = {
    name: 'play',
    category: 'downloader',
    aliases: ['song', 'mp3', 'audio'],
    description: 'Download a song from YouTube',
    async execute(conn, msg, args, ctx) {
        const { from, reply } = ctx;
        const query = args.join(" ");
        
        if (!query) {
            return reply("❌ Please provide a song name.\nExample: `.play yatapita`");
        }

        const loadingMsg = await conn.sendMessage(from, { text: `🔍 Searching for "${query}"...` }, { quoted: msg });

        try {
            // 1. Search YouTube using youtube-v31
            const searchRes = await axios.get(`https://${SEARCH_HOST}/search`, {
                params: { 
                    q: query, 
                    part: 'id,snippet', 
                    maxResults: '1', 
                    type: 'video' 
                },
                headers: { 
                    'X-RapidAPI-Key': RAPIDAPI_KEY, 
                    'X-RapidAPI-Host': SEARCH_HOST 
                }
            });

            const video = searchRes.data.items?.[0];
            if (!video) {
                throw new Error("No results found on YouTube.");
            }

            const videoId = video.id.videoId;
            const title = video.snippet.title;

            await conn.sendMessage(from, { text: `🎵 Found: *${title}*\n⏳ Converting to MP3...`, edit: loadingMsg.key });

            // 2. Download MP3 using youtube-mp36
            let audioData = null;
            let attempts = 0;
            const maxAttempts = 5;

            while (attempts < maxAttempts) {
                const mp3Res = await axios.get(`https://${MP3_HOST}/dl`, {
                    params: { id: videoId },
                    headers: { 
                        'X-RapidAPI-Key': RAPIDAPI_KEY, 
                        'X-RapidAPI-Host': MP3_HOST 
                    }
                });

                audioData = mp3Res.data;

                // If the API says "processing", wait 3 seconds and try again
                if (audioData.status === 'processing') {
                    attempts++;
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                // If it says "ok", break the loop and send
                if (audioData.status === 'ok' && audioData.link) {
                    break;
                }

                // If it fails for another reason
                throw new Error(audioData.msg || "Conversion failed on API side.");
            }

            if (!audioData || audioData.status !== 'ok' || !audioData.link) {
                throw new Error("API took too long to process the song. Try again.");
            }

            // 3. Send the audio to WhatsApp
            await conn.sendMessage(from, {
                audio: { url: audioData.link },
                mimetype: 'audio/mp4',
                fileName: `${title}.mp3`,
                caption: `🎵 *${title}*`
            }, { quoted: msg });

            // Clean up the loading message
            await conn.sendMessage(from, { delete: loadingMsg.key });

        } catch (e) {
            console.error("Play Error:", e.message);
            await conn.sendMessage(from, { 
                text: `❌ Error: ${e.message}`, 
                edit: loadingMsg.key 
            });
        }
    }
};