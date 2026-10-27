// commands/owner.js
// Send owner as a clickable WhatsApp contact card.
// Usage: .owner

const { fancy } = require('../lib/font');
const config = require('../config');

module.exports = {
    name: 'owner',
    category: 'general',
    aliases: ['dev', 'creator'],
    description: 'Send the bot owner as a contact card',
    async execute(conn, msg, args, ctx) {
        const { from } = ctx;

        const ownerNumber = String(config.ownerNumber || '').replace(/\D/g, '') || '254794376595';
        const ownerName   = config.ownerName || 'Mr Presenter';

        // vCard format — this is what makes WhatsApp render the contact card
        const vcard =
`BEGIN:VCARD
VERSION:3.0
N:;${ownerName};;;
FN:${ownerName}
TEL;type=CELL;type=VOICE;waid=${ownerNumber}:+${ownerNumber}
END:VCARD`;

        try {
            await conn.sendMessage(from, {
                contacts: {
                    displayName: ownerName,
                    contacts: [{ vcard }]
                }
            }, { quoted: msg });
        } catch (e) {
            console.error('[owner] contact send failed:', e.message);
            // fallback: plain text with wa.me link
            await conn.sendMessage(from, {
                text: fancy(`👤 Owner: ${ownerName}\n📞 wa.me/${ownerNumber}`)
            }, { quoted: msg });
        }
    }
};