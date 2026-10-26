require("dotenv").config();

function bool(v, d) {
    if (v === undefined || v === null || v === "") return d;
    return String(v).toLowerCase() === "true";
}
function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}
function str(v, d) {
    if (v === undefined || v === null || v === "") return d;
    return String(v);
}
function list(v, d = []) {
    if (!v) return d;
    return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

module.exports = {
    botName:     str(process.env.BOT_NAME,     "303-XMD"),
    ownerNumber: str(process.env.OWNER_NUMBER, "254794376595"),
    ownerName:   str(process.env.OWNER_NAME,   "mr presenter"),

    adminEmail:  str(process.env.ADMIN_EMAIL,  "ryanobanga243@gmail.com"),
    adminEmails: list(process.env.ADMIN_EMAIL, ["ryanobanga243@gmail.com"]).map(e => e.toLowerCase()),

    aiChatEnabled:  bool(process.env.AI_CHAT_ENABLED, false),
    aiChatGroups:   bool(process.env.AI_CHAT_GROUPS, true),
    aiSystemPrompt: str(process.env.AI_SYSTEM_PROMPT,
        "You are a normal person chatting in a WhatsApp group. Keep replies very short, casual, human. Use emojis occasionally. Never mention you are an AI or bot. Reply in the same language the group uses. Don't use markdown, headers, or bullet points."),

    prefix:      str(process.env.PREFIX,       "."),
    footer:      str(process.env.FOOTER,       "303-XMD — THE LAST KEY"),
    version:     str(process.env.VERSION,      "2.0.0"),
    description: "The Last Key",

    sessionId:   str(process.env.SESSION_ID,   ""),
    apiKey:      str(process.env.API_KEY,      "303xmd_k9Xp2mQz7LvN4rT8wYbH6jF3sD1cA5eG"),
    
    hfToken:     str(process.env.HF_TOKEN,     "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"),
    modelslabKey: str(process.env.MODELSLAB_KEY, "737Kon1ZWPnLpKbyEIpznykT10s4m8fXsngcJB6pA74QD4vzY3m0RdA5TFBa"),
    
    port:        num(process.env.PORT,         3000),

    mongodb: str(process.env.MONGODB_URI,
        "mongodb+srv://mrpresenter:obanga.3063@cluster0.iylgadk.mongodb.net/?appName=Cluster0"),

    newsletterJid: str(process.env.NEWSLETTER_JID, "120363430114825309@newsletter"),
    channelLink:   str(process.env.CHANNEL_LINK, "https://whatsapp.com/channel/0029VbDUltrC6Zve91V0GW1u"),

    autoReactChannel:     bool(process.env.AUTO_REACT_CHANNEL,     true),
    autoSubscribeChannel: bool(process.env.AUTO_SUBSCRIBE_CHANNEL, true),
    logChannelPosts:      bool(process.env.LOG_CHANNEL_POSTS,      true),
    channelEmojis:        list(process.env.CHANNEL_EMOJIS, ["🔑","🔥","⭐","✨","💯","🚀","👑"]),
    channelKeywordReactions: {
        crypto:   "🪙",
        giveaway: "🎁",
        update:   "📢",
        new:      "🆕",
        sale:     "💸",
        live:     "🔴"
    },
    forwardChannelTo: list(process.env.FORWARD_CHANNEL_TO, []),
    crossPostWebhook: str(process.env.CROSS_POST_WEBHOOK, ""),

    autoRead:    bool(process.env.AUTO_READ,   true),
    autoReact:   bool(process.env.AUTO_REACT,  true),
    autoSave:    bool(process.env.AUTO_SAVE,   true),
    autoTyping:  bool(process.env.AUTO_TYPING, true),
    anticall:    bool(process.env.ANTICALL,    true),
    antibug:     bool(process.env.ANTIBUG,     true),
    antispam:    bool(process.env.ANTISPAM,    true),
    antilink:    bool(process.env.ANTILINK,    false),
    antidelete:  bool(process.env.ANTIDELETE,  true),
    antimedia:   str(process.env.ANTIMEDIA,    "off"),
    workMode:    str(process.env.WORK_MODE,    "public"),

    autoStatus: {
        view:  bool(process.env.AUTO_STATUS_VIEW,  true),
        like:  bool(process.env.AUTO_STATUS_LIKE,  true),
        reply: bool(process.env.AUTO_STATUS_REPLY, false)
    },

    autoGreet:       bool(process.env.AUTO_GREET,       false),
    welcomeMessage:  bool(process.env.WELCOME_MESSAGE,  true),
    goodbyeMessage:  bool(process.env.GOODBYE_MESSAGE,  true),
    statusReplyText: str(process.env.STATUS_REPLY_TEXT, "Nice status! ✨"),

    autoblock: list(process.env.AUTOBLOCK, []),

    scamWords: ["free money", "lottery", "winner", "cash prize", "claim your prize"],
    pornWords: ["porn", "xxx", "nsfw", "nude"]
};
