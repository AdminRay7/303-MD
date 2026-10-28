const { makeWASocket, Browsers } = require("@whiskeysockets/baileys");
const { useMongoDBAuthState } = require("./lib/mongoAuthState");
const { MongoClient } = require("mongodb");
const pino = require("pino");
const config = require("./config");

module.exports = function(app) {
    // The Web Panel (Repo 2) will send a POST request here
    app.post("/api/pair", async (req, res) => {
        const { sessionId, num } = req.body;
        
        if (!sessionId || !num) {
            return res.status(400).json({ error: "Missing sessionId or number" });
        }

        try {
            const client = new MongoClient(config.mongodb);
            await client.connect();
            const collection = client.db("xmd303").collection("authState");
            const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

            const conn = makeWASocket({
                version: [2, 3000, 1042466098],
                auth: { creds: state.creds, keys: state.keys },
                logger: pino({ level: "silent" }),
                browser: Browsers.ubuntu("Chrome"),
                printQRInTerminal: false
            });

            // Wait for socket to be ready
            await new Promise((resolve) => {
                conn.ev.on("connection.update", (update) => {
                    if (update.qr || update.connection === "connecting") resolve();
                });
            });

            // Generate the code
            const code = await conn.requestPairingCode(num);
            
            // Save credentials to DB so the main Bot loop picks it up
            await saveCreds();
            
            // Close the temporary socket
            conn.ws.close();

            // Send code back to Repo 2
            res.json({ success: true, code: code.match(/.{1,4}/g)?.join("-") || code });

        } catch (error) {
            console.error("Pairing Error:", error);
            res.status(500).json({ error: error.message });
        }
    });
};