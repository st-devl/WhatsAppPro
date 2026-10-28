const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-runtime-test-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.LOG_LEVEL = 'silent';

const db = require('../lib/db');
const { WhatsAppRuntime } = require('../lib/whatsapp_runtime');

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function createRuntime() {
    const sockets = [];
    const runtime = new WhatsAppRuntime({
        io: { to: () => ({ emit() {} }) },
        baseDir: tempDir,
        tenantId: 'runtime_test',
        getSocketConfig: async () => {
            const ev = new EventEmitter();
            const sock = { ev, ended: false, end() { this.ended = true; } };
            sockets.push(sock);
            return { sock, ev, saveCreds() {} };
        }
    });
    return { runtime, sockets };
}

function closeWith(sock, statusCode) {
    sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode } } }
    });
}

test('reset while waiting for a QR scan starts a new socket', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();
    assert.equal(sockets.length, 1);

    await runtime.resetSession();
    await wait(400);

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].ended, true);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
});

test('connection closed (428) reconnects', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();
    let scheduled = null;
    runtime.scheduleInit = delayMs => { scheduled = delayMs; };

    closeWith(sockets[0], 428);

    assert.notEqual(scheduled, null);
});

test('restart required (515) after QR scan reconnects at once without using a retry', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();
    let scheduled = null;
    runtime.scheduleInit = delayMs => { scheduled = delayMs; };

    closeWith(sockets[0], 515);

    assert.ok(scheduled <= 1000);
    assert.equal(runtime.retryCount, 0);
});
