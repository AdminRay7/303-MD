const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema({
    email:      { type: String, required: true, unique: true, index: true },
    password:   { type: String, required: true },
    name:       { type: String, default: "" },
    credits:    { type: Number, default: 0 },
    maxSessions:{ type: Number, default: 3 },
    isAdmin:    { type: Boolean, default: false },
    isBanned:   { type: Boolean, default: false },
    lastLogin:  { type: Date, default: null }
}, { timestamps: true });

const SessionSettingsSchema = new mongoose.Schema({
    sessionId:      { type: String, required: true, unique: true, index: true },
    ownerAccountId: { type: String, default: null, index: true },
    phoneNumber:    { type: String, default: null },
    prefix:         { type: String, default: null },
    botName:        { type: String, default: null },
    footer:         { type: String, default: null },
    workMode:       { type: String, enum: ["public", "private", null], default: null },
    autoRead:       { type: Boolean, default: null },
    autoReact:      { type: Boolean, default: null },
    autoTyping:     { type: Boolean, default: null },
    antibug:        { type: Boolean, default: null },
    antispam:       { type: Boolean, default: null },
    antilink:       { type: Boolean, default: null },
    antidelete:     { type: Boolean, default: null },
    anticall:       { type: Boolean, default: null },
    antimedia:      { type: String, default: null }
}, { timestamps: true });

const MessageLogSchema = new mongoose.Schema({
    accountId:   { type: String, default: null, index: true },
    sessionId:   { type: String, index: true },
    chatJid:     { type: String, index: true },
    chatName:    { type: String, default: "" },
    chatType:    { type: String, default: "dm" },
    isGroup:     { type: Boolean, default: false },
    senderJid:   { type: String, default: null },
    senderName:  { type: String, default: "" },
    senderPhone: { type: String, default: null },
    fromMe:      { type: Boolean, default: false },
    body:        { type: String, default: "" },
    messageType: { type: String, default: "conversation" },
    timestamp:   { type: Date, default: Date.now, index: true }
});

const AutoReplySchema = new mongoose.Schema({
    accountId:    { type: String, index: true },
    sessionId:    { type: String, index: true },
    name:         { type: String, default: "" },
    matchType:    { type: String, enum: ["contains","exact","starts","regex"], default: "contains" },
    pattern:      { type: String, required: true },
    reply:        { type: String, required: true },
    isGroup:      { type: Boolean, default: false },
    caseSensitive:{ type: Boolean, default: false },
    enabled:      { type: Boolean, default: true }
}, { timestamps: true });

const KeywordTriggerSchema = new mongoose.Schema({
    accountId: { type: String, index: true },
    sessionId: { type: String, index: true },
    keyword:   { type: String, required: true },
    reply:     { type: String, required: true },
    mediaUrl:  { type: String, default: "" },
    mediaType: { type: String, default: "" },
    enabled:   { type: Boolean, default: true }
}, { timestamps: true });

module.exports = {
    Account:        mongoose.model("Account", AccountSchema),
    SessionSettings:mongoose.model("SessionSettings", SessionSettingsSchema),
    MessageLog:     mongoose.model("MessageLog", MessageLogSchema),
    AutoReply:      mongoose.model("AutoReply", AutoReplySchema),
    KeywordTrigger: mongoose.model("KeywordTrigger", KeywordTriggerSchema)
};