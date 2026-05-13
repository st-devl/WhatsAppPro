const path = require('path');
const fs = require('fs-extra');
const { getSocketConfig } = require('./connection');
const { componentLogger } = require('./logger');
const db = require('./db');

const SESSION_INVALID_WINDOW_MS = 10 * 60 * 1000;
const SESSION_INVALID_THRESHOLD = 2;

const BAILEYS_STATUS_MAP = {
    2: 'server_ack',
    3: 'delivered',
    4: 'read'
};

function safeTenantSegment(tenantId = 'default') {
    return String(tenantId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

class WhatsAppRuntime {
    constructor(options = {}) {
        this.io = options.io;
        this.baseDir = options.baseDir;
        this.tenantId = options.tenantId || 'default';
        this.maxAutoRetries = Number.parseInt(options.maxAutoRetries || '3', 10);
        this.logger = options.logger || componentLogger('whatsapp_runtime');
        this.onSessionInvalidLoop = options.onSessionInvalidLoop || null;
        this.sock = null;
        this.isConnected = false;
        this.lastQR = null;
        this.initLock = false;
        this.reconnectTimer = null;
        this.retryCount = 0;
        this.sessionInvalidTimestamps = [];
        this.status = {
            startedAt: new Date().toISOString(),
            http: 'starting',
            whatsapp: 'idle',
            lastError: null
        };
    }

    tenantRoom() {
        return `tenant:${this.tenantId}`;
    }

    emitToTenant(event, payload) {
        this.io.to(this.tenantRoom()).emit(event, payload);
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

    storageBaseDir() {
        return process.env.WHASAPPC_DATA_DIR
            ? path.resolve(process.env.WHASAPPC_DATA_DIR)
            : this.baseDir;
    }

    getLastQR() {
        return this.lastQR;
    }

    sessionPath() {
        return path.join(this.storageBaseDir(), 'auth/tenants', safeTenantSegment(this.tenantId), 'session');
    }

    async resetSession() {
        this.logger.warn({ tenantId: this.tenantId }, 'whatsapp_session_reset_requested');
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
        this.logger.info({ tenantId: this.tenantId }, 'whatsapp_runtime_starting');

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end();
            } catch (_) {}
        }

        try {
            const config = await getSocketConfig(this.sessionPath());
            this.sock = config.sock;
            config.ev.on('creds.update', config.saveCreds);
            config.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
            config.ev.on('messages.update', (updates) => this.handleMessagesUpdate(updates));
        } catch (err) {
            this.logger.error({ err, tenantId: this.tenantId }, 'whatsapp_runtime_start_failed');
            this.status.whatsapp = 'error';
            this.status.lastError = err.message;
            this.initLock = false;
            this.scheduleReconnect();
        }
    }

    handleMessagesUpdate(updates) {
        if (!Array.isArray(updates)) return;

        for (const update of updates) {
            const messageId = update?.key?.id;
            const statusCode = update?.update?.status;
            if (!messageId || statusCode === undefined) continue;

            const deliveryStatus = BAILEYS_STATUS_MAP[statusCode];
            if (!deliveryStatus) continue;

            db.updateDeliveryStatus(messageId, deliveryStatus)
                .catch(err => this.logger.warn(
                    { err, messageId, deliveryStatus, tenantId: this.tenantId },
                    'delivery_status_update_failed'
                ));
        }
    }

    handleConnectionUpdate(update) {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            this.status.whatsapp = 'qr';
            this.lastQR = qr;
            this.emitToTenant('qr', qr);
            db.addSystemEvent(this.tenantId, 'qr_generated', 'info', 'QR kodu oluşturuldu, tarama bekleniyor.', {})
                .catch(() => {});
        }

        if (connection === 'open') {
            this.logger.info({ tenantId: this.tenantId }, 'whatsapp_connection_open');
            this.retryCount = 0;
            const initialWait = Math.floor(Math.random() * 5000) + 2000;
            setTimeout(() => {
                this.isConnected = true;
                this.status.whatsapp = 'connected';
                this.lastQR = null;
                this.emitToTenant('status', 'connected');
            }, initialWait);
            db.addSystemEvent(this.tenantId, 'whatsapp_connected', 'info', 'WhatsApp bağlantısı kuruldu.', {})
                .catch(() => {});
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            this.logger.warn({ tenantId: this.tenantId, reason }, 'whatsapp_connection_closed');
            this.isConnected = false;
            this.status.whatsapp = 'disconnected';
            this.status.lastError = reason ? `WhatsApp bağlantısı kapandı. Kod: ${reason}` : 'WhatsApp bağlantısı kapandı.';
            this.emitToTenant('status', 'disconnected');
            this.initLock = false;
            db.addSystemEvent(this.tenantId, 'whatsapp_disconnected', 'warn',
                reason ? `WhatsApp bağlantısı kapandı. Kod: ${reason}` : 'WhatsApp bağlantısı kapandı.',
                { reason_code: reason || null })
                .catch(() => {});

            if (reason === 401 || reason === 440) {
                this.logger.warn({ tenantId: this.tenantId, reason }, 'whatsapp_session_invalid_resetting');

                const now = Date.now();
                this.sessionInvalidTimestamps.push(now);
                this.sessionInvalidTimestamps = this.sessionInvalidTimestamps.filter(
                    ts => now - ts < SESSION_INVALID_WINDOW_MS
                );

                if (this.sessionInvalidTimestamps.length >= SESSION_INVALID_THRESHOLD && this.onSessionInvalidLoop) {
                    this.logger.error({
                        tenantId: this.tenantId,
                        reason,
                        invalidCount: this.sessionInvalidTimestamps.length,
                        windowMinutes: SESSION_INVALID_WINDOW_MS / 60000
                    }, 'whatsapp_session_invalid_loop_detected');
                    db.addSystemEvent(this.tenantId, 'session_invalid_loop', 'error',
                        `Oturum geçersizlik döngüsü tespit edildi (${this.sessionInvalidTimestamps.length} kez ${SESSION_INVALID_WINDOW_MS / 60000} dk içinde). Kampanyalar durduruldu.`,
                        { reason_code: reason, invalid_count: this.sessionInvalidTimestamps.length })
                        .catch(() => {});
                    try {
                        this.onSessionInvalidLoop(this.tenantId);
                    } catch (err) {
                        this.logger.error({ err, tenantId: this.tenantId }, 'session_invalid_loop_callback_failed');
                    }
                }

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
                this.logger.error({ err, tenantId: this.tenantId }, 'whatsapp_init_unexpected_failed');
            });
        }, delayMs);
    }

    scheduleReconnect() {
        if (this.retryCount >= this.maxAutoRetries) {
            this.status.whatsapp = 'paused';
            this.status.lastError = `WhatsApp bağlantısı kurulamadı. Otomatik deneme ${this.maxAutoRetries} denemeden sonra durduruldu.`;
            this.logger.error({ tenantId: this.tenantId, maxAutoRetries: this.maxAutoRetries }, 'whatsapp_reconnect_paused');
            db.addSystemEvent(this.tenantId, 'reconnect_paused', 'warn',
                `Otomatik yeniden bağlanma ${this.maxAutoRetries} denemeden sonra durduruldu. Manuel müdahale gerekli.`,
                { max_auto_retries: this.maxAutoRetries })
                .catch(() => {});
            return;
        }

        this.retryCount++;
        const reconnectDelay = Math.min(60000, 10000 * this.retryCount);
        this.logger.info({
            tenantId: this.tenantId,
            reconnectDelayMs: reconnectDelay,
            retryCount: this.retryCount,
            maxAutoRetries: this.maxAutoRetries
        }, 'whatsapp_reconnect_scheduled');
        this.scheduleInit(reconnectDelay);
    }
}

module.exports = { WhatsAppRuntime };
