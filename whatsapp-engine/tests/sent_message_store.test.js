const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { proto } = require('@whiskeysockets/baileys');
const { SentMessageStore } = require('../lib/sent_message_store');
const { getSocketConfig } = require('../lib/connection');

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'whatsappc-sent-store-'));
}

function videoMessage() {
    return proto.Message.fromObject({
        videoMessage: {
            url: 'https://mmg.whatsapp.net/v/t62/abc',
            mimetype: 'video/mp4',
            mediaKey: Buffer.from('0123456789abcdef0123456789abcdef'),
            fileLength: 12345678,
            mediaKeyTimestamp: 1761660000,
            caption: 'Merhaba'
        }
    });
}

test('sent message store survives a new instance on the same directory', async () => {
    const dir = await tempDir();
    const first = new SentMessageStore({ dir });
    await first.set('MSG1', videoMessage());

    const second = new SentMessageStore({ dir });
    const loaded = await second.get('MSG1');

    assert.ok(loaded instanceof proto.Message);
    assert.equal(loaded.videoMessage.caption, 'Merhaba');
    assert.deepEqual(Buffer.from(loaded.videoMessage.mediaKey), Buffer.from('0123456789abcdef0123456789abcdef'));
    assert.equal(Number(loaded.videoMessage.fileLength), 12345678);
});

test('sent message store expires entries and prunes them from disk', async () => {
    const dir = await tempDir();
    let now = 1000;
    const store = new SentMessageStore({ dir, ttlMs: 100, now: () => now });
    await store.set('OLD', videoMessage());

    now = 1100;
    assert.equal(await new SentMessageStore({ dir, ttlMs: 100, now: () => now }).get('OLD'), undefined);

    await store.set('NEW', videoMessage());
    now = 1150;
    await store.prune();
    assert.deepEqual(await fs.readdir(dir), [store.fileName('NEW')]);
});

test('sent message store ignores unsafe or unknown ids', async () => {
    const store = new SentMessageStore({ dir: await tempDir() });
    assert.equal(await store.get('../../etc/passwd'), undefined);
    assert.equal(await store.get('MISSING'), undefined);
});

test('socket config answers retry lookups with messages it sent', async () => {
    const authPath = await tempDir();
    let socketOptions;
    const config = await getSocketConfig(authPath, {
        useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
        makeWASocket: options => {
            socketOptions = options;
            return {
                ev: new EventEmitter(),
                sendMessage: async (jid) => ({ key: { id: 'SENT1', remoteJid: jid, fromMe: true }, message: videoMessage() })
            };
        }
    });

    assert.ok(socketOptions.msgRetryCounterCache);
    assert.equal(await socketOptions.getMessage({ id: 'SENT1' }), undefined);

    const result = await config.sock.sendMessage('905551112233@s.whatsapp.net', { text: 'x' });
    assert.equal(result.key.id, 'SENT1');

    // Retry receipts may carry a LID jid, so lookup must work by id alone.
    const resent = await socketOptions.getMessage({ remoteJid: '123@lid', id: 'SENT1', fromMe: true });
    assert.equal(resent.videoMessage.caption, 'Merhaba');
});

test('retry counter cache is shared across reconnects of the same session', async () => {
    const authPath = await tempDir();
    const caches = [];
    const options = {
        useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
        makeWASocket: socketOptions => {
            caches.push(socketOptions.msgRetryCounterCache);
            return { ev: new EventEmitter() };
        }
    };
    await getSocketConfig(authPath, options);
    await getSocketConfig(authPath, options);

    assert.equal(caches[0], caches[1]);
});
