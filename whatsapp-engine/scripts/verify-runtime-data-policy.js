const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const engineDir = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        ...options
    });

    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout.trim();
}

function assertNotTracked(paths) {
    const tracked = run('git', ['ls-files', ...paths]);
    assert.equal(tracked, '', `Runtime data must not be tracked by Git: ${tracked}`);
}

function assertPersistentDataDirSurvivesRestart() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-runtime-data-'));
    const dbFile = path.join(tempDir, 'database.sqlite');

    try {
        const createScript = `
            process.env.WHASAPPC_DATA_DIR = ${JSON.stringify(tempDir)};
            const { randomUUID } = require('node:crypto');
            const db = require(${JSON.stringify(path.join(engineDir, 'lib/db'))});
            (async () => {
                await db.createGroup(randomUUID(), 'Runtime Persistence Smoke');
                const groups = await db.getGroups();
                if (groups.length !== 1) throw new Error('Group was not persisted on first boot');
            })().catch(err => { console.error(err); process.exit(1); });
        `;

        const readScript = `
            process.env.WHASAPPC_DATA_DIR = ${JSON.stringify(tempDir)};
            const db = require(${JSON.stringify(path.join(engineDir, 'lib/db'))});
            (async () => {
                const groups = await db.getGroups();
                if (groups.length !== 1 || groups[0].name !== 'Runtime Persistence Smoke') {
                    throw new Error('Persistent DB was not reused after restart');
                }
            })().catch(err => { console.error(err); process.exit(1); });
        `;

        run(process.execPath, ['-e', createScript]);
        assert.ok(fs.existsSync(dbFile), 'Database file was not created in persistent data dir');
        run(process.execPath, ['-e', readScript]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

assertNotTracked([
    'whatsapp-engine/.env',
    'whatsapp-engine/data/database.sqlite',
    'whatsapp-engine/data/contacts.json',
    'whatsapp-engine/data/templates.json.migrated',
    'whatsapp-engine/data/daily_stats.json',
    'whatsapp-engine/data/recipient_history.json'
]);
assertPersistentDataDirSurvivesRestart();

console.log(JSON.stringify({
    ok: true,
    runtimeDataTracked: false,
    persistentDataDirRespected: true
}, null, 2));
