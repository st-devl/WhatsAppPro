const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

const {
    acquireProcessLock,
    isLockHeartbeatStale
} = require('../lib/process_lock');

function withEnv(overrides, fn) {
    const snapshot = { ...process.env };
    Object.assign(process.env, overrides);
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
    }

    try {
        return fn();
    } finally {
        for (const key of Object.keys(process.env)) {
            if (!(key in snapshot)) delete process.env[key];
        }
        Object.assign(process.env, snapshot);
    }
}

function tempLockPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-process-lock-'));
    return {
        dir,
        lockPath: path.join(dir, 'runtime/app.lock')
    };
}

test('process lock writes heartbeat and releases its own lock', () => {
    const { dir, lockPath } = tempLockPath();
    try {
        const lock = acquireProcessLock(dir, { lockPath });
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(payload.pid, process.pid);
        assert.ok(payload.started_at);
        assert.ok(payload.heartbeat_at);

        lock.release();
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('stale lock file is recoverable and heartbeat freshness is detected', () => {
    const { dir, lockPath } = tempLockPath();
    let lock = null;

    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const staleLock = {
            pid: 99999999,
            started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            heartbeat_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
        };
        assert.equal(isLockHeartbeatStale(staleLock), true);

        fs.writeFileSync(lockPath, JSON.stringify({
            ...staleLock
        }, null, 2));

        withEnv({
            PROCESS_LOCK_WAIT_MS: '0',
            PROCESS_LOCK_HEARTBEAT_STALE_MS: '30000'
        }, () => {
            lock = acquireProcessLock(dir, { lockPath });
        });

        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(payload.pid, process.pid);
        assert.equal(isLockHeartbeatStale(payload), false);
    } finally {
        if (lock) lock.release();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
