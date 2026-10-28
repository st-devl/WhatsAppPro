const fs = require('fs/promises');
const path = require('path');
const { proto, BufferJSON } = require('@whiskeysockets/baileys');

// Alıcı cihaz mesajı çözemezse retry receipt gönderir; Baileys mesajı yeniden
// şifrelemek için getMessage ile orijinalini ister. Telefon günlerce çevrimdışı
// kalabileceği ve deploy süreci yeniden başlattığı için mesajları diskte tutuyoruz.
const DEFAULT_SENT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

class SentMessageStore {
    constructor(options = {}) {
        this.dir = options.dir;
        this.ttlMs = options.ttlMs || DEFAULT_SENT_MESSAGE_TTL_MS;
        this.now = options.now || Date.now;
        this.pruned = false;
    }

    fileName(id) {
        return `${id}.json`;
    }

    async set(id, message) {
        if (!SAFE_ID.test(String(id || '')) || !message) return;
        if (!this.pruned) {
            this.pruned = true;
            this.prune().catch(() => {});
        }
        const entry = {
            expiresAt: this.now() + this.ttlMs,
            message: proto.Message.toObject(proto.Message.fromObject(message), { bytes: Buffer })
        };
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(path.join(this.dir, this.fileName(id)), JSON.stringify(entry, BufferJSON.replacer));
    }

    async get(id) {
        if (!SAFE_ID.test(String(id || ''))) return undefined;
        let entry;
        try {
            const raw = await fs.readFile(path.join(this.dir, this.fileName(id)), 'utf8');
            entry = JSON.parse(raw, BufferJSON.reviver);
        } catch (_) {
            return undefined;
        }
        if (!entry?.message || this.now() >= entry.expiresAt) return undefined;
        return proto.Message.fromObject(entry.message);
    }

    async prune() {
        let names;
        try {
            names = await fs.readdir(this.dir);
        } catch (_) {
            return;
        }
        const nowMs = this.now();
        for (const name of names) {
            const filePath = path.join(this.dir, name);
            try {
                const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
                if (!(nowMs < entry.expiresAt)) await fs.unlink(filePath);
            } catch (_) {
                await fs.unlink(filePath).catch(() => {});
            }
        }
    }
}

module.exports = {
    DEFAULT_SENT_MESSAGE_TTL_MS,
    SentMessageStore
};
