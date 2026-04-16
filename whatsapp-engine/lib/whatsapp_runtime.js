const path = require('path');
const fs = require('fs-extra');
const { getSocketConfig } = require('./connection');

class WhatsAppRuntime {
    constructor(options = {}) {
        this.io = options.io;
        this.baseDir = options.baseDir;
        this.maxAutoRetries = Number.parseInt(options.maxAutoRetries || '3', 10);
        this.sock = null;
        this.isConnected = false;
        this.lastQR = null;
        this.initLock = false;
        this.reconnectTimer = null;
        this.retryCount = 0;
        this.status = {
            startedAt: new Date().toISOString(),
            http: 'starting',
            whatsapp: 'idle',
            lastError: null
        };
    }

    getStatus() {
        return this.status;
    }

    setHttpStatus(value, error = null) {
        this.status.http = value;
        if (error) this.status.lastError = error.message || String(error);
    }

    getSocket() {
        return this.sock;
    }

    connected() {
        return this.isConnected;
    }

    getLastQR() {
        return this.lastQR;
    }

    sessionPath() {
        return path.join(this.baseDir, 'auth/session');
    }

    async resetSession() {
        console.log('🔄 Oturum sıfırlama isteği alındı...');
        this.isConnected = false;
        this.lastQR = null;
        if (this.sock) {
            this.sock.ev.removeAllListeners();
            this.sock.end();
            this.sock = null;
        }
        const sessionPath = this.sessionPath();
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        this.retryCount = 0;
        this.scheduleInit(1000);
    }

    async init() {
        if (this.initLock) return;
        this.initLock = true;
        this.reconnectTimer = null;
        this.status.whatsapp = 'starting';
        this.status.lastError = null;
        console.log('🚀 WhatsApp motoru başlatılıyor...');

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end();
            } catch (_) {}
        }

        try {
            const config = await getSocketConfig();
            this.sock = config.sock;
            config.ev.on('creds.update', config.saveCreds);
            config.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
        } catch (err) {
            console.log('🚨 Başlatma hatası:', err.message);
            this.status.whatsapp = 'error';
            this.status.lastError = err.message;
            this.initLock = false;
            this.scheduleReconnect();
        }
    }

    handleConnectionUpdate(update) {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            this.status.whatsapp = 'qr';
            this.lastQR = qr;
            this.io.emit('qr', qr);
        }

        if (connection === 'open') {
            console.log('✅ Bağlantı BAŞARILI!');
            this.retryCount = 0;
            const initialWait = Math.floor(Math.random() * 5000) + 2000;
            setTimeout(() => {
                this.isConnected = true;
                this.status.whatsapp = 'connected';
                this.lastQR = null;
                this.io.emit('status', 'connected');
            }, initialWait);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ Bağlantı Kesildi. Kod:', reason);
            this.isConnected = false;
            this.status.whatsapp = 'disconnected';
            this.status.lastError = reason ? `WhatsApp bağlantısı kapandı. Kod: ${reason}` : 'WhatsApp bağlantısı kapandı.';
            this.io.emit('status', 'disconnected');
            this.initLock = false;

            if (reason === 401 || reason === 440) {
                console.log('⚠️ Oturum bozulmuş. Otomatik temizleniyor...');
                const sessionPath = this.sessionPath();
                if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                this.scheduleInit(5000);
            } else if (reason !== 428) {
                this.scheduleReconnect();
            }
        }
    }

    scheduleInit(delayMs = 1500) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.status.whatsapp = 'scheduled';
        this.reconnectTimer = setTimeout(() => {
            this.init().catch((err) => {
                this.status.whatsapp = 'error';
                this.status.lastError = err.message;
                console.error('WhatsApp init beklenmeyen hata:', err);
            });
        }, delayMs);
    }

    scheduleReconnect() {
        if (this.retryCount >= this.maxAutoRetries) {
            this.status.whatsapp = 'paused';
            this.status.lastError = `WhatsApp bağlantısı kurulamadı. Otomatik deneme ${this.maxAutoRetries} denemeden sonra durduruldu.`;
            console.log(`⏸️ ${this.status.lastError}`);
            return;
        }

        this.retryCount++;
        const reconnectDelay = Math.min(60000, 10000 * this.retryCount);
        console.log(`⏳ ${reconnectDelay / 1000}sn sonra yeniden bağlanılacak... (${this.retryCount}/${this.maxAutoRetries})`);
        this.scheduleInit(reconnectDelay);
    }
}

module.exports = { WhatsAppRuntime };

