const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const { componentLogger } = require('./logger');
const { mediaUploadCache } = require('./media_upload_cache');

const connectionLogger = componentLogger('connection');

async function getSocketConfig(authPath = path.join(__dirname, '../auth/session'), options = {}) {
    const getAuthState = options.useMultiFileAuthState || useMultiFileAuthState;
    const getLatestVersion = options.fetchLatestBaileysVersion || fetchLatestBaileysVersion;
    const createSocket = options.makeWASocket || makeWASocket;
    const mediaCache = options.mediaCache || mediaUploadCache;
    const { state, saveCreds } = await getAuthState(authPath);
    const { version, isLatest, error } = await getLatestVersion({ timeout: 1500 });
    if (!isLatest && error) {
        connectionLogger.warn({ err: error }, 'baileys_version_fetch_failed');
    }

    const sock = createSocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Artık terminale basmıyoruz, web'e gönderiyoruz
        auth: state,
        mediaCache,
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
