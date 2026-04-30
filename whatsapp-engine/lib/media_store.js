const path = require('path');
const fs = require('fs-extra');

function defaultStorePath() {
    const dataDir = process.env.WHASAPPC_DATA_DIR
        ? path.resolve(process.env.WHASAPPC_DATA_DIR)
        : path.join(__dirname, '../data');
    return path.join(dataDir, 'media-store.json');
}

class MediaStore {
    constructor(options = {}) {
        this.filesByTenant = new Map();
        this.filePath = options.filePath || defaultStorePath();
        this.load();
    }

    key(tenantId = 'default') {
        return String(tenantId || 'default').trim() || 'default';
    }

    load() {
        if (!this.filePath || !fs.existsSync(this.filePath)) return;
        const parsed = fs.readJsonSync(this.filePath, { throws: false });
        if (!parsed || typeof parsed !== 'object') return;
        Object.entries(parsed).forEach(([tenantId, files]) => {
            if (Array.isArray(files)) this.filesByTenant.set(this.key(tenantId), files);
        });
    }

    persist() {
        if (!this.filePath) return;
        const payload = {};
        this.filesByTenant.forEach((files, tenantId) => {
            payload[tenantId] = files;
        });
        fs.ensureDirSync(path.dirname(this.filePath));
        const tempFile = `${this.filePath}.tmp-${process.pid}`;
        fs.writeJsonSync(tempFile, payload, { spaces: 2 });
        fs.renameSync(tempFile, this.filePath);
    }

    list(tenantId = 'default') {
        return [...(this.filesByTenant.get(this.key(tenantId)) || [])];
    }

    replace(files, tenantId = 'default') {
        this.filesByTenant.set(this.key(tenantId), [...files]);
        this.persist();
        return this.list(tenantId);
    }

    remove(mediaPath, tenantId = 'default') {
        const key = this.key(tenantId);
        this.filesByTenant.set(key, this.list(key).filter(item => item.path !== mediaPath));
        this.persist();
        return this.list(key);
    }

    clear(tenantId = 'default') {
        this.filesByTenant.set(this.key(tenantId), []);
        this.persist();
    }
}

module.exports = { MediaStore };
