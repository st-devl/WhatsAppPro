function parseDurationMs(value, fallback, options = {}) {
    const min = options.min ?? 100;
    const max = options.max ?? 10000;
    const parsed = Number.parseInt(value ?? fallback, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${label} health check timed out after ${timeoutMs}ms`);
            err.code = 'HEALTH_CHECK_TIMEOUT';
            reject(err);
        }, timeoutMs);
    });

    return Promise.race([Promise.resolve(promise), timeout])
        .finally(() => {
            if (timer) clearTimeout(timer);
        });
}

function getRuntimeHttpStatus(runtime) {
    if (runtime && typeof runtime.getHttpStatus === 'function') {
        return runtime.getHttpStatus();
    }
    if (runtime && typeof runtime.getStatusSnapshot === 'function') {
        return runtime.getStatusSnapshot()?.http || 'unknown';
    }
    return 'unknown';
}

function getRuntimeSnapshot(runtime, tenantId) {
    if (!runtime) {
        return { http: 'unknown', whatsapp: 'unconfigured', initialized: false };
    }
    if (typeof runtime.getStatusSnapshot === 'function') {
        return runtime.getStatusSnapshot(tenantId);
    }
    if (typeof runtime.getStatus === 'function') {
        return runtime.getStatus(tenantId, { createIfMissing: false });
    }
    return {
        http: getRuntimeHttpStatus(runtime),
        whatsapp: 'unknown',
        initialized: false
    };
}

function formatDependencyError(err) {
    if (err?.code === 'HEALTH_CHECK_TIMEOUT') return 'timeout';
    return 'error';
}

async function checkDatabase(database, timeoutMs) {
    if (!database || typeof database.getDb !== 'function') {
        throw new Error('database adapter is not configured');
    }

    const d = await withTimeout(database.getDb(), timeoutMs, 'database');
    return {
        status: 'ok',
        driver: d.driver || null,
        journal_mode: typeof d.pragma === 'function' ? d.pragma('journal_mode', { simple: true }) : null
    };
}

function buildLivenessPayload({ runtime, tenantId = 'default' } = {}) {
    const snapshot = getRuntimeSnapshot(runtime, tenantId);
    return {
        ok: true,
        status: {
            http: getRuntimeHttpStatus(runtime),
            uptime_seconds: Math.round(process.uptime()),
            whatsapp: {
                status: snapshot.whatsapp || 'unknown',
                initialized: snapshot.initialized === true,
                required: false
            }
        }
    };
}

async function buildReadinessPayload({
    db,
    runtime,
    tenantId = 'default',
    timeoutMs = parseDurationMs(process.env.READINESS_CHECK_TIMEOUT_MS, 2000)
} = {}) {
    const http = getRuntimeHttpStatus(runtime);
    const checks = { http };
    const failures = [];
    let ok = http === 'listening';

    try {
        checks.database = await checkDatabase(db, timeoutMs);
    } catch (err) {
        ok = false;
        failures.push({ check: 'database', err });
        checks.database = {
            status: formatDependencyError(err)
        };
    }

    const whatsapp = getRuntimeSnapshot(runtime, tenantId);
    checks.whatsapp = {
        status: whatsapp.whatsapp || 'unknown',
        initialized: whatsapp.initialized === true,
        required: false
    };
    if (whatsapp.lastError) checks.whatsapp.last_error = whatsapp.lastError;

    return { ok, checks, failures };
}

module.exports = {
    parseDurationMs,
    buildLivenessPayload,
    buildReadinessPayload,
    getRuntimeSnapshot
};
