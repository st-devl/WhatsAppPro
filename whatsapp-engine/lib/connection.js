const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const { componentLogger } = require('./logger');

const connectionLogger = componentLogger('connection');

async function getSocketConfig(authPath = path.join(__dirname, '../auth/session')) {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version, isLatest, error } = await fetchLatestBaileysVersion({ timeout: 5000 });
    if (!isLatest && error) {
        connectionLogger.warn({ err: error }, 'baileys_version_fetch_failed');
    }

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Artık terminale basmıyoruz, web'e gönderiyoruz
        auth: state,
        browser: ["Windows", "Chrome", "123.0.0.0"]
    });

    return {
        sock,
        state,
        saveCreds,
        ev: sock.ev
    };
}

module.exports = { getSocketConfig };
