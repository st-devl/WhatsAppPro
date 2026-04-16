const path = require('path');
const fs = require('fs-extra');
const { getSocketConfig } = require('./connection');
const { componentLogger } = require('./logger');

function safeTenantSegment(tenantId = 'default') {
    return String(tenantId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

class WhatsAppRuntime {
    constructor(options = {}) {
        this.io = options.io;
        this.baseDir = options.baseDir;
        this.defaultTenantId = options.defaultTenantId || 'default';
        this.maxAutoRetries = Number.parseInt(options.maxAutoRetries || '3', 10);
        this.logger = options.logger || componentLogger('whatsapp_runtime');
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

    tenantRoom(tenantId = this.defaultTenantId) {
        return `tenant:${String(tenantId || this.defaultTenantId).trim() || this.defaultTenantId}`;
    }

    isTenantSupported(tenantId = this.defaultTenantId) {
        return (String(tenantId || this.defaultTenantId).trim() || this.defaultTenantId) === this.defaultTenantId;
    }

    emitToTenant(event, payload, tenantId = this.defaultTenantId) {
        this.io.to(this.tenantRoom(tenantId)).emit(event, payload);
    }

    getStatus(tenantId = this.defaultTenantId) {
        if (!this.isTenantSupported(tenantId)) {
            return {
                ...this.status,
                whatsapp: 'unconfigured',
                lastError: 'Bu tenant icin WhatsApp hesabi yapilandirilmadi.'
            };
        }
        return this.status;
    }

    setHttpStatus(value, error = null) {
        this.status.http = value;
        if (error) this.status.lastError = error.message || String(error);
    }

    getSocket(tenantId = this.defaultTenantId) {
        if (!this.isTenantSupported(tenantId)) return null;
        return this.sock;
    }

    connected(tenantId = this.defaultTenantId) {
        if (!this.isTenantSupported(tenantId)) return false;
        return this.isConnected;
    }

    getLastQR() {
        return this.lastQR;
    }

    sessionPath(tenantId = this.defaultTenantId) {
        if (this.isTenantSupported(tenantId)) {
            return path.join(this.baseDir, 'auth/session');
        }
        return path.join(this.baseDir, 'auth/tenants', safeTenantSegment(tenantId), 'session');
    }

    sessionPathForConfiguredTenant() {
        return path.join(this.baseDir, 'auth/session');
    }

    async resetSession() {
        this.logger.warn({ tenantId: this.defaultTenantId }, 'whatsapp_session_reset_requested');
        this.isConnected = false;
        this.lastQR = null;
        if (this.sock) {
            this.sock.ev.removeAllListeners();
            this.sock.end();
            this.sock = null;
        }
        const sessionPath = this.sessionPathForConfiguredTenant();
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
        this.logger.info({ tenantId: this.defaultTenantId }, 'whatsapp_runtime_starting');

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end();
            } catch (_) {}
        }

        try {
            const config = await getSocketConfig(this.sessionPathForConfiguredTenant());
            this.sock = config.sock;
            config.ev.on('creds.update', config.saveCreds);
            config.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
        } catch (err) {
            this.logger.error({ err, tenantId: this.defaultTenantId }, 'whatsapp_runtime_start_failed');
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
            this.emitToTenant('qr', qr);
        }

        if (connection === 'open') {
            this.logger.info({ tenantId: this.defaultTenantId }, 'whatsapp_connection_open');
            this.retryCount = 0;
            const initialWait = Math.floor(Math.random() * 5000) + 2000;
            setTimeout(() => {
                this.isConnected = true;
                this.status.whatsapp = 'connected';
                this.lastQR = null;
                this.emitToTenant('status', 'connected');
            }, initialWait);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            this.logger.warn({ tenantId: this.defaultTenantId, reason }, 'whatsapp_connection_closed');
            this.isConnected = false;
            this.status.whatsapp = 'disconnected';
            this.status.lastError = reason ? `WhatsApp bağlantısı kapandı. Kod: ${reason}` : 'WhatsApp bağlantısı kapandı.';
            this.emitToTenant('status', 'disconnected');
            this.initLock = false;

            if (reason === 401 || reason === 440) {
                this.logger.warn({ tenantId: this.defaultTenantId, reason }, 'whatsapp_session_invalid_resetting');
                const sessionPath = this.sessionPathForConfiguredTenant();
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
                this.logger.error({ err, tenantId: this.defaultTenantId }, 'whatsapp_init_unexpected_failed');
            });
        }, delayMs);
    }

    scheduleReconnect() {
        if (this.retryCount >= this.maxAutoRetries) {
            this.status.whatsapp = 'paused';
            this.status.lastError = `WhatsApp bağlantısı kurulamadı. Otomatik deneme ${this.maxAutoRetries} denemeden sonra durduruldu.`;
            this.logger.error({ tenantId: this.defaultTenantId, maxAutoRetries: this.maxAutoRetries }, 'whatsapp_reconnect_paused');
            return;
        }

        this.retryCount++;
        const reconnectDelay = Math.min(60000, 10000 * this.retryCount);
        this.logger.info({
            tenantId: this.defaultTenantId,
            reconnectDelayMs: reconnectDelay,
            retryCount: this.retryCount,
            maxAutoRetries: this.maxAutoRetries
        }, 'whatsapp_reconnect_scheduled');
        this.scheduleInit(reconnectDelay);
    }
}

module.exports = { WhatsAppRuntime };
