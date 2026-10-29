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
    const emitted = [];
    const runtime = new WhatsAppRuntime({
        io: { to: () => ({ emit(event, payload) { emitted.push({ event, payload }); } }) },
        baseDir: tempDir,
        tenantId: 'runtime_test',
        getSocketConfig: async () => {
            const ev = new EventEmitter();
            const sock = { ev, ended: false, end() { this.ended = true; } };
            sockets.push(sock);
            return { sock, ev, saveCreds() {} };
        }
    });
    return { runtime, sockets, emitted };
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

test('closing after a QR is generated clears the stored QR', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();

    sockets[0].ev.emit('connection.update', { qr: 'expired-qr' });
    assert.equal(runtime.getLastQR(), 'expired-qr');

    runtime.scheduleInit = () => {};
    closeWith(sockets[0], 408);

    assert.equal(runtime.getLastQR(), null);
});

test('reconnect limit pauses the runtime and emits the paused status', async () => {
    const { runtime, sockets, emitted } = createRuntime();
    await runtime.init();
    runtime.retryCount = runtime.maxAutoRetries;

    closeWith(sockets[0], 408);

    assert.equal(runtime.getStatus().whatsapp, 'paused');
    assert.ok(emitted.some(({ event, payload }) => event === 'status' && payload === 'paused'));
});

test('wake restarts a paused runtime without resetting its session', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();
    const credentialsPath = path.join(runtime.sessionPath(), 'creds.json');
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, '{}');
    runtime.status.whatsapp = 'paused';
    runtime.retryCount = runtime.maxAutoRetries;
    runtime.initLock = false;

    assert.equal(runtime.wake(), true);
    assert.equal(runtime.retryCount, 0);
    await wait(250);
    assert.equal(sockets.length, 2);
    assert.equal(fs.existsSync(credentialsPath), true);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
});

test('wake does not restart connected or QR runtimes', async () => {
    const { runtime, sockets } = createRuntime();
    await runtime.init();

    runtime.status.whatsapp = 'connected';
    runtime.isConnected = true;
    assert.equal(runtime.wake(), false);

    runtime.status.whatsapp = 'qr';
    runtime.isConnected = false;
    assert.equal(runtime.wake(), false);
    assert.equal(sockets.length, 1);
});
