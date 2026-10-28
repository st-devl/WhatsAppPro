const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'silent';

const { buildLivenessPayload, buildReadinessPayload } = require('../lib/health_checks');
const { WhatsAppRegistry } = require('../lib/whatsapp_registry');
const { WhatsAppRuntime } = require('../lib/whatsapp_runtime');

function fakeDb(journalMode = 'delete') {
    return {
        getDb: async () => ({
            driver: 'node',
            pragma: () => journalMode
        })
    };
}

test('health checks do not initialize WhatsApp runtime', async () => {
    const runtime = new WhatsAppRegistry();
    runtime.setHttpStatus('listening');

    const live = buildLivenessPayload({ runtime, tenantId: 'default' });
    assert.equal(live.ok, true);
    assert.equal(live.status.whatsapp.required, false);
    assert.equal(runtime.runtimes.size, 0);

    const ready = await buildReadinessPayload({
        db: fakeDb(),
        runtime,
        tenantId: 'default',
        timeoutMs: 50
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.checks.database.status, 'ok');
    assert.equal(ready.checks.database.driver, 'node');
    assert.equal(ready.checks.whatsapp.required, false);
    assert.equal(ready.checks.whatsapp.initialized, false);
    assert.equal(runtime.runtimes.size, 0);
});

test('readiness fails fast when database check exceeds timeout', async () => {
    const runtime = new WhatsAppRegistry();
    runtime.setHttpStatus('listening');
    const db = { getDb: () => new Promise(() => {}) };

    const ready = await buildReadinessPayload({
        db,
        runtime,
        tenantId: 'default',
        timeoutMs: 10
    });

    assert.equal(ready.ok, false);
    assert.equal(ready.checks.http, 'listening');
    assert.equal(ready.checks.database.status, 'timeout');
    assert.equal(runtime.runtimes.size, 0);
});

test('runtime status snapshots cannot mutate internal runtime state', () => {
    const runtime = new WhatsAppRuntime();
    const status = runtime.getStatus();
    status.whatsapp = 'changed-by-caller';

    assert.equal(runtime.getStatus().whatsapp, 'idle');
});
