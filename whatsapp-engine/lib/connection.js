const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { componentLogger } = require('./logger');
const { mediaUploadCache, MediaUploadCache } = require('./media_upload_cache');
const { SentMessageStore } = require('./sent_message_store');

const connectionLogger = componentLogger('connection');

// Reconnect'lerde retry sayaçları ve gönderilen mesajlar kaybolmasın diye oturum başına tutulur.
const sessionStores = new Map();

// Oturum sıfırlanınca (elle veya 401/440) session klasörü silinir; alıcıların yeniden
// gönderim istekleri sonra da gelebildiği için gönderilen mesajlar klasörün dışında tutulur.
function sentMessagesDir(authPath) {
    const dir = path.join(path.dirname(authPath), 'sent-messages');
    const legacyDir = path.join(authPath, 'sent-messages');
    try {
        const names = fs.readdirSync(legacyDir);
        fs.mkdirSync(dir, { recursive: true });
        for (const name of names) {
            if (!fs.existsSync(path.join(dir, name))) fs.renameSync(path.join(legacyDir, name), path.join(dir, name));
        }
        fs.rmSync(legacyDir, { recursive: true, force: true });
    } catch (err) {
        if (err.code !== 'ENOENT') connectionLogger.warn({ err }, 'sent_message_store_migration_failed');
    }
    return dir;
}

function getSessionStores(authPath) {
    if (!sessionStores.has(authPath)) {
        sessionStores.set(authPath, {
            sentMessages: new SentMessageStore({ dir: sentMessagesDir(authPath) }),
            msgRetryCounterCache: new MediaUploadCache({ ttlMs: 60 * 60 * 1000, maxEntries: 10000 })
        });
    }
    return sessionStores.get(authPath);
}

async function getSocketConfig(authPath = path.join(__dirname, '../auth/session'), options = {}) {
    const getAuthState = options.useMultiFileAuthState || useMultiFileAuthState;
    const getLatestVersion = options.fetchLatestBaileysVersion || fetchLatestBaileysVersion;
    const createSocket = options.makeWASocket || makeWASocket;
    const mediaCache = options.mediaCache || mediaUploadCache;
    const { sentMessages, msgRetryCounterCache } = getSessionStores(authPath);
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
        msgRetryCounterCache,
        // Retry receipt LID jid ile gelebilir; mesaj id'si tek başına benzersiz.
        getMessage: async (key) => {
            const message = await sentMessages.get(key?.id);
            if (!message) connectionLogger.warn({ id: key?.id }, 'retry_message_not_found');
            return message;
        },
        browser: ["Windows", "Chrome", "123.0.0.0"]
    });

    if (typeof sock.sendMessage === 'function') {
        const sendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (...args) => {
            const result = await sendMessage(...args);
            if (result?.key?.id && result.message) {
                await sentMessages.set(result.key.id, result.message).catch(err => {
                    connectionLogger.warn({ err, id: result.key.id }, 'sent_message_store_failed');
                });
            }
            return result;
        };
    }

    return {
        sock,
        state,
        saveCreds,
        ev: sock.ev
    };
}

module.exports = { getSocketConfig };
