const path = require('path');

const DEFAULT_MEDIA_UPLOAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEDIA_UPLOAD_CACHE_MAX_ENTRIES = 200;

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class MediaUploadCache {
    constructor(options = {}) {
        this.ttlMs = parsePositiveInteger(
            options.ttlMs === undefined ? process.env.MEDIA_UPLOAD_CACHE_TTL_MS : options.ttlMs,
            DEFAULT_MEDIA_UPLOAD_CACHE_TTL_MS
        );
        this.maxEntries = parsePositiveInteger(
            options.maxEntries === undefined ? process.env.MEDIA_UPLOAD_CACHE_MAX_ENTRIES : options.maxEntries,
            DEFAULT_MEDIA_UPLOAD_CACHE_MAX_ENTRIES
        );
        this.now = options.now || Date.now;
        this.entries = new Map();
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;

        if (this.now() >= entry.expiresAt) {
            this.entries.delete(key);
            return undefined;
        }

        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        this.removeExpired();
        this.entries.delete(key);
        this.entries.set(key, {
            value,
            expiresAt: this.now() + this.ttlMs
        });

        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    del(key) {
        this.entries.delete(key);
    }

    flushAll() {
        this.entries.clear();
    }

    removeExpired() {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (now >= entry.expiresAt) this.entries.delete(key);
        }
    }
}

const mediaUploadCache = new MediaUploadCache();

function invalidateMediaUploadCache(absolutePath, cache = mediaUploadCache) {
    if (!absolutePath) return;

    const normalizedPath = path.resolve(absolutePath);
    cache.del(`image:${normalizedPath}`);
    cache.del(`video:${normalizedPath}`);
}

module.exports = {
    DEFAULT_MEDIA_UPLOAD_CACHE_TTL_MS,
    DEFAULT_MEDIA_UPLOAD_CACHE_MAX_ENTRIES,
    MediaUploadCache,
    mediaUploadCache,
    invalidateMediaUploadCache
};
