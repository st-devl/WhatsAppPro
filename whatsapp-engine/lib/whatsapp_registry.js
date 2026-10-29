const { WhatsAppRuntime } = require('./whatsapp_runtime');
const { componentLogger } = require('./logger');

class WhatsAppRegistry {
    constructor(options = {}) {
        this.options = options;
        this.runtimes = new Map();
        this.logger = options.logger || componentLogger('whatsapp_registry');
        this.httpStatus = 'starting';
    }

    getOrCreate(tenantId) {
        if (!tenantId) return null;
        const id = String(tenantId);
        
        if (!this.runtimes.has(id)) {
            this.logger.info({ tenantId: id }, 'creating_new_whatsapp_runtime');
            const runtime = new WhatsAppRuntime({ 
                ...this.options, 
                tenantId: id 
            });
            // Lazy init, hemen başlat
            runtime.scheduleInit(500);
            this.runtimes.set(id, runtime);
        }
        
        return this.runtimes.get(id);
    }

    get(tenantId) {
        if (!tenantId) return null;
        return this.runtimes.get(String(tenantId)) || null;
    }

    destroy(tenantId) {
        if (!tenantId) return;
        const id = String(tenantId);
        const runtime = this.runtimes.get(id);
        
        if (runtime) {
            this.logger.info({ tenantId: id }, 'destroying_whatsapp_runtime');
            runtime.resetSession();
            this.runtimes.delete(id);
        }
    }
    
    // Eski WhatsAppRuntime API'sine uyumluluk (Proxy metodları)
    // Diğer servisler (campaign vs) registry'i runtime gibi kullanabilsin diye
    
    tenantRoom(tenantId) {
        return `tenant:${String(tenantId)}`;
    }

    emitToTenant(event, payload, tenantId) {
        if (!this.options.io || !tenantId) return;
        this.options.io.to(this.tenantRoom(tenantId)).emit(event, payload);
    }

    isTenantSupported(tenantId) {
        return !!tenantId;
    }

    getStatus(tenantId, options = {}) {
        if (!tenantId) return { whatsapp: 'unconfigured', http: this.httpStatus, initialized: false };
        const createIfMissing = options.createIfMissing !== false;
        const r = createIfMissing ? this.getOrCreate(tenantId) : this.get(tenantId);
        const status = r ? r.getStatus() : { whatsapp: 'idle', initialized: false };
        return {
            ...status,
            http: this.httpStatus,
            initialized: !!r
        };
    }

    getStatusSnapshot(tenantId) {
        return this.getStatus(tenantId, { createIfMissing: false });
    }

    getHttpStatus() {
        return this.httpStatus;
    }

    setHttpStatus(status, error = null) {
        this.httpStatus = status;
        if (error) {
            this.logger.error({ err: error }, 'http_server_error');
        }
    }

    scheduleInit() {
        // Multi-tenant mimaride tenant bazlı lazy-init olduğu için
        // global scheduleInit no-op (boş) olarak bırakıldı veya 
        // default tenant init'i tetiklenebilir.
    }

    getSocket(tenantId) {
        const r = this.get(tenantId);
        return r ? r.getSocket() : null;
    }

    connected(tenantId) {
        const r = this.get(tenantId);
        return r ? r.connected() : false;
    }

    getLastQR(tenantId) {
        const r = this.get(tenantId);
        return r ? r.getLastQR() : null;
    }

    resetSession(tenantId) {
        const r = this.get(tenantId);
        if (r) r.resetSession();
    }

    wake(tenantId) {
        const r = this.get(tenantId);
        return r ? r.wake() : false;
    }
}

module.exports = { WhatsAppRegistry };
