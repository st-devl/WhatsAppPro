class MediaStore {
    constructor() {
        this.filesByTenant = new Map();
    }

    key(tenantId = 'default') {
        return String(tenantId || 'default').trim() || 'default';
    }

    list(tenantId = 'default') {
        return [...(this.filesByTenant.get(this.key(tenantId)) || [])];
    }

    replace(files, tenantId = 'default') {
        this.filesByTenant.set(this.key(tenantId), [...files]);
        return this.list(tenantId);
    }

    remove(mediaPath, tenantId = 'default') {
        const key = this.key(tenantId);
        this.filesByTenant.set(key, this.list(key).filter(item => item.path !== mediaPath));
        return this.list(key);
    }

    clear(tenantId = 'default') {
        this.filesByTenant.set(this.key(tenantId), []);
    }
}

module.exports = { MediaStore };
