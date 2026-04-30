const { WhatsAppRuntime } = require('./whatsapp_runtime');
const { componentLogger } = require('./logger');

class WhatsAppRegistry {
    constructor(options = {}) {
        this.options = options;
        this.runtimes = new Map();
        this.logger = options.logger || componentLogger('whatsapp_registry');
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

    isTenantSupported(tenantId) {
        return !!tenantId;
    }

    getStatus(tenantId) {
        if (!tenantId) return { whatsapp: 'unconfigured' };
        // QR ekranına vs girdiği an lazy-init tetiklenmesi için getOrCreate kullanıyoruz
        const r = this.getOrCreate(tenantId);
        return r ? r.getStatus() : { whatsapp: 'unconfigured' };
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
}

module.exports = { WhatsAppRegistry };
