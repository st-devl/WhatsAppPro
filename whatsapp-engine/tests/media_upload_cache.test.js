const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');
const {
    DEFAULT_MEDIA_UPLOAD_CACHE_MAX_ENTRIES,
    DEFAULT_MEDIA_UPLOAD_CACHE_TTL_MS,
    MediaUploadCache,
    mediaUploadCache,
    invalidateMediaUploadCache
} = require('../lib/media_upload_cache');
const { getSocketConfig } = require('../lib/connection');

test('media upload cache expires entries using its injected clock', () => {
    let now = 100;
    const cache = new MediaUploadCache({ ttlMs: 50, now: () => now });
    cache.set('image:/tmp/photo.jpg', Buffer.from('cached'));

    now = 149;
    assert.deepEqual(cache.get('image:/tmp/photo.jpg'), Buffer.from('cached'));

    now = 150;
    assert.equal(cache.get('image:/tmp/photo.jpg'), undefined);
});

test('media upload cache falls back to defaults for invalid limits', () => {
    const cache = new MediaUploadCache({ ttlMs: 0, maxEntries: 'invalid' });

    assert.equal(cache.ttlMs, DEFAULT_MEDIA_UPLOAD_CACHE_TTL_MS);
    assert.equal(cache.maxEntries, DEFAULT_MEDIA_UPLOAD_CACHE_MAX_ENTRIES);
});

test('media upload cache evicts the least recently used entry', () => {
    const cache = new MediaUploadCache({ maxEntries: 2 });
    cache.set('first', 1);
    cache.set('second', 2);
    assert.equal(cache.get('first'), 1);
    cache.set('third', 3);

    assert.equal(cache.get('first'), 1);
    assert.equal(cache.get('second'), undefined);
    assert.equal(cache.get('third'), 3);
});

test('media upload cache deletes individual entries and flushes all entries', () => {
    const cache = new MediaUploadCache();
    cache.set('first', 1);
    cache.set('second', 2);
    cache.del('first');
    assert.equal(cache.get('first'), undefined);
    assert.equal(cache.get('second'), 2);

    cache.flushAll();
    assert.equal(cache.get('second'), undefined);
});

test('media upload cache invalidates both media types for a deleted path', () => {
    const cache = new MediaUploadCache();
    const filePath = path.join(os.tmpdir(), 'whatsappc-media-cache-delete.jpg');
    cache.set(`image:${filePath}`, Buffer.from('image'));
    cache.set(`video:${filePath}`, Buffer.from('video'));

    invalidateMediaUploadCache(filePath, cache);

    assert.equal(cache.get(`image:${filePath}`), undefined);
    assert.equal(cache.get(`video:${filePath}`), undefined);
});

test('Baileys reuses cached local document media without uploading again', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsappc-media-cache-'));
    const filePath = path.join(directory, 'campaign.pdf');
    const cache = new MediaUploadCache();
    let uploadCalls = 0;

    try {
        await fs.writeFile(filePath, Buffer.from('campaign media'));
        const options = {
            mediaCache: cache,
            upload: async () => {
                uploadCalls++;
                return {
                    mediaUrl: 'https://upload.example.test/media',
                    directPath: '/v/t62.7118-24/example'
                };
            }
        };
        const message = {
            document: { url: filePath },
            mimetype: 'application/pdf',
            fileName: 'campaign.pdf'
        };

        const first = await prepareWAMessageMedia(message, options);
        const second = await prepareWAMessageMedia(message, options);

        assert.equal(uploadCalls, 1);
        assert.equal(second.documentMessage.url, first.documentMessage.url);
        assert.equal(second.documentMessage.directPath, first.documentMessage.directPath);
        assert.deepEqual(second.documentMessage.mediaKey, first.documentMessage.mediaKey);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('Baileys cache hit clears a prior caption when the next payload has no caption', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsappc-media-cache-caption-'));
    const filePath = path.join(directory, 'campaign.pdf');
    const cache = new MediaUploadCache();

    try {
        await fs.writeFile(filePath, Buffer.from('campaign media'));
        const options = {
            mediaCache: cache,
            upload: async () => ({
                mediaUrl: 'https://upload.example.test/media',
                directPath: '/v/t62.7118-24/example'
            })
        };
        const document = { url: filePath };
        const first = await prepareWAMessageMedia({
            document,
            mimetype: 'application/pdf',
            fileName: 'campaign.pdf',
            caption: 'A'
        }, options);
        const second = await prepareWAMessageMedia({
            document,
            mimetype: 'application/pdf',
            fileName: 'campaign.pdf',
            caption: undefined
        }, options);

        assert.equal(first.documentMessage.caption, 'A');
        assert.equal(second.documentMessage.caption, undefined);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('socket configuration passes the process-wide media upload cache to Baileys', async () => {
    let socketOptions;
    const eventEmitter = { on() {} };
    const config = await getSocketConfig('/tmp/whatsappc-media-cache-auth', {
        useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
        makeWASocket: options => {
            socketOptions = options;
            return { ev: eventEmitter };
        }
    });

    assert.equal(config.ev, eventEmitter);
    assert.equal(socketOptions.mediaCache, mediaUploadCache);
});
