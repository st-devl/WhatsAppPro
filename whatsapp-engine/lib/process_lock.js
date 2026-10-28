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
            started_at: parsed.started_at || null,
            heartbeat_at: parsed.heartbeat_at || null
        };
    } catch {
        return { pid: null, started_at: null, heartbeat_at: null };
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

function envMs(name, fallback, { min = 0 } = {}) {
    const raw = Number.parseInt(process.env[name] || String(fallback), 10);
    if (!Number.isFinite(raw) || raw < min) return fallback;
    return raw;
}

function lockHeartbeatIntervalMs() {
    return envMs('PROCESS_LOCK_HEARTBEAT_INTERVAL_MS', 15000, { min: 1000 });
}

function lockHeartbeatStaleMs() {
    return envMs('PROCESS_LOCK_HEARTBEAT_STALE_MS', 120000, { min: 30000 });
}

function staleTerminateWaitMs() {
    return envMs('PROCESS_LOCK_STALE_TERMINATE_WAIT_MS', 10000, { min: 1000 });
}

function lockTimestampMs(lock) {
    const heartbeat = Date.parse(lock?.heartbeat_at || '');
    if (Number.isFinite(heartbeat)) return heartbeat;
    const started = Date.parse(lock?.started_at || '');
    if (Number.isFinite(started)) return started;
    return null;
}

function isLockHeartbeatStale(lock, referenceMs = Date.now()) {
    const timestamp = lockTimestampMs(lock);
    if (!timestamp) return true;
    return referenceMs - timestamp > lockHeartbeatStaleMs();
}

function buildLockPayload() {
    const current = new Date().toISOString();
    return {
        pid: process.pid,
        started_at: current,
        heartbeat_at: current
    };
}

function writeLockPayload(lockPath, payload) {
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const tempPath = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, text);
    fs.renameSync(tempPath, lockPath);
}

function waitForPidExit(pid, waitMs) {
    const started = Date.now();
    while (Date.now() - started < waitMs) {
        if (!isPidRunning(pid)) return true;
        sleepSync(250);
    }
    return !isPidRunning(pid);
}

function terminateStaleProcess(pid, lockPath) {
    if (!isPidRunning(pid)) return true;
    lockLogger.warn({ pid, lockPath }, 'stale_process_lock_terminating_owner');
    try {
        process.kill(pid, 'SIGTERM');
    } catch (err) {
        if (err.code !== 'ESRCH') throw err;
    }
    if (waitForPidExit(pid, staleTerminateWaitMs())) return true;
    lockLogger.warn({ pid, lockPath }, 'stale_process_lock_force_killing_owner');
    try {
        process.kill(pid, 'SIGKILL');
    } catch (err) {
        if (err.code !== 'ESRCH') throw err;
    }
    if (waitForPidExit(pid, 3000)) return true;
    lockLogger.warn({ pid, lockPath }, 'stale_process_lock_owner_still_visible_after_sigkill');
    return true;
}

function acquireProcessLock(baseDir, options = {}) {
    if (String(process.env.DISABLE_PROCESS_LOCK || '').toLowerCase() === 'true') {
        if (process.env.NODE_ENV === 'production') {
            lockLogger.warn('DISABLE_PROCESS_LOCK is ignored in production environment for safety reasons.');
        } else {
            return null;
        }
    }
    const lockPath = options.lockPath || path.join(storageBaseDir(baseDir), 'runtime/app.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const payload = buildLockPayload();

    const tryAcquire = () => {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
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
            const latest = parseLockFile(lockPath);
            if (isPidRunning(latest.pid)) {
                if (!isLockHeartbeatStale(latest)) {
                    throw new Error(`Ayni data dizini icin baska WhasAppC process'i calisiyor. pid=${latest.pid} lock=${lockPath}`);
                }
                const terminated = terminateStaleProcess(latest.pid, lockPath);
                if (!terminated) {
                    throw new Error(`Bayat WhasAppC process lock sahibi durdurulamadi. pid=${latest.pid} lock=${lockPath}`);
                }
            }
        }
        const removable = parseLockFile(lockPath);
        lockLogger.warn({
            lockPath,
            pid: removable.pid,
            startedAt: removable.started_at,
            heartbeatAt: removable.heartbeat_at
        }, 'stale_process_lock_removed');
        fs.rmSync(lockPath, { force: true });
        tryAcquire();
    }

    const heartbeatTimer = setInterval(() => {
        const existing = parseLockFile(lockPath);
        if (existing.pid !== process.pid) {
            clearInterval(heartbeatTimer);
            return;
        }
        try {
            writeLockPayload(lockPath, {
                ...payload,
                heartbeat_at: new Date().toISOString()
            });
        } catch (err) {
            lockLogger.warn({ err, lockPath }, 'process_lock_heartbeat_failed');
        }
    }, lockHeartbeatIntervalMs());
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    const release = () => {
        clearInterval(heartbeatTimer);
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

module.exports = { acquireProcessLock, isPidRunning, isLockHeartbeatStale };
