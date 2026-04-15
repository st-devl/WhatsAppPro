const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');

async function getSocketConfig() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '../auth/session'));
    const { version, isLatest, error } = await fetchLatestBaileysVersion({ timeout: 5000 });
    if (!isLatest && error) {
        console.warn('Baileys sürüm bilgisi güncel alınamadı, paket içi varsayılan sürüm kullanılacak:', error.message);
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
