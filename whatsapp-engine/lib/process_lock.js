const fs = require('fs');
const path = require('path');
const { componentLogger } = require('./logger');

const lockLogger = componentLogger('process_lock');

function storageBaseDir(baseDir) {
    return process.env.WHASAPPC_DATA_DIR
        ? path.resolve(process.env.WHASAPPC_DATA_DIR)
        : baseDir;
}

function isPidRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function parseLockFile(lockPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        return {
            pid: Number.parseInt(parsed.pid, 10),
            started_at: parsed.started_at || null
        };
    } catch {
        return { pid: null, started_at: null };
    }
}

function lockWaitMs() {
    const raw = Number.parseInt(process.env.PROCESS_LOCK_WAIT_MS || '15000', 10);
    if (!Number.isFinite(raw) || raw < 0) return 15000;
    return raw;
}

function sleepSync(ms) {
    if (ms <= 0) return;
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
}

function acquireProcessLock(baseDir, options = {}) {
    if (String(process.env.DISABLE_PROCESS_LOCK || '').toLowerCase() === 'true') return null;
    const lockPath = options.lockPath || path.join(storageBaseDir(baseDir), 'runtime/app.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const payload = JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString()
    }, null, 2);

    const tryAcquire = () => {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, payload);
        fs.closeSync(fd);
    };

    try {
        tryAcquire();
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const existing = parseLockFile(lockPath);
        if (isPidRunning(existing.pid)) {
            const started = Date.now();
            const maxWaitMs = lockWaitMs();
            while (Date.now() - started < maxWaitMs && isPidRunning(existing.pid)) {
                sleepSync(250);
            }
            if (isPidRunning(existing.pid)) {
                throw new Error(`Ayni data dizini icin baska WhasAppC process'i calisiyor. pid=${existing.pid} lock=${lockPath}`);
            }
        }
        lockLogger.warn({ lockPath, pid: existing.pid, startedAt: existing.started_at }, 'stale_process_lock_removed');
        fs.rmSync(lockPath, { force: true });
        tryAcquire();
    }

    const release = () => {
        const existing = parseLockFile(lockPath);
        if (existing.pid === process.pid) fs.rmSync(lockPath, { force: true });
    };

    process.once('exit', release);
    process.once('SIGINT', () => {
        release();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        release();
        process.exit(143);
    });

    return { lockPath, release };
}

module.exports = { acquireProcessLock, isPidRunning };
