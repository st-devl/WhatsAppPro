const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbModulePath = require.resolve('../lib/db');

function rememberEnv(name) {
    return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function createTestContext() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-db-backup-'));
    const previousDataDir = rememberEnv('WHASAPPC_DATA_DIR');
    const previousDbFile = rememberEnv('WHASAPPC_DB_FILE');
    const previousInterval = rememberEnv('BACKUP_MIN_INTERVAL_MS');

    process.env.WHASAPPC_DATA_DIR = dataDir;
    process.env.WHASAPPC_DB_FILE = path.join(dataDir, 'database.sqlite');
    delete require.cache[dbModulePath];

    return {
        dataDir,
        db: require('../lib/db'),
        previousDataDir,
        previousDbFile,
        previousInterval
    };
}

async function destroyTestContext(context) {
    const database = await context.db.getDb();
    database.close();
    delete require.cache[dbModulePath];
    restoreEnv('WHASAPPC_DATA_DIR', context.previousDataDir);
    restoreEnv('WHASAPPC_DB_FILE', context.previousDbFile);
    restoreEnv('BACKUP_MIN_INTERVAL_MS', context.previousInterval);
    fs.rmSync(context.dataDir, { recursive: true, force: true });
}

async function prepareDatabase(context) {
    const database = await context.db.getDb();
    database.checkpointSync();
    database.close();
    fs.rmSync(path.join(context.dataDir, 'backups'), { recursive: true, force: true });
    delete require.cache[dbModulePath];
    context.db = require('../lib/db');
}

async function reloadDatabase(context) {
    const database = await context.db.getDb();
    database.close();
    delete require.cache[dbModulePath];
    context.db = require('../lib/db');
}

function getBackupFiles(dataDir) {
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir).filter(file => file.endsWith('.sqlite'));
}

async function checkpoint(db) {
    const database = await db.getDb();
    database.checkpointSync();
    return database;
}

test('routine writes backup olusturmaz', async () => {
    const context = await createTestContext();

    try {
        await prepareDatabase(context);
        await context.db.createGroup('routine-group-1', 'Routine Grup 1');
        const contact = await context.db.createContact('routine-group-1', { phone: '05320000001', name: 'Ali' });
        await context.db.updateContact('routine-group-1', contact.id, { phone: '05320000001', name: 'Veli' });
        await context.db.createGroup('routine-group-2', 'Routine Grup 2');

        assert.deepEqual(getBackupFiles(context.dataDir), []);
    } finally {
        await destroyTestContext(context);
    }
});

test('destructive writes backup intervaline uyar ve sifir intervalde her seferinde yedek alir', async () => {
    const context = await createTestContext();

    try {
        await prepareDatabase(context);
        process.env.BACKUP_MIN_INTERVAL_MS = '600000';
        await context.db.createGroup('throttle-group-1', 'Throttle Grup 1');
        await context.db.createGroup('throttle-group-2', 'Throttle Grup 2');
        const contact = await context.db.createContact('throttle-group-2', { phone: '05320000002', name: 'Ayse' });
        await checkpoint(context.db);

        await context.db.deleteGroup('throttle-group-1');
        assert.equal(getBackupFiles(context.dataDir).length, 1);

        await reloadDatabase(context);
        await context.db.deleteContact('throttle-group-2', contact.id);
        assert.equal(getBackupFiles(context.dataDir).length, 1);

        process.env.BACKUP_MIN_INTERVAL_MS = '0';
        await context.db.createGroup('unthrottled-group-1', 'Unthrottled Grup 1');
        await context.db.createGroup('unthrottled-group-2', 'Unthrottled Grup 2');
        const nextContact = await context.db.createContact('unthrottled-group-2', { phone: '05320000003', name: 'Can' });

        await context.db.deleteGroup('unthrottled-group-1');
        assert.equal(getBackupFiles(context.dataDir).length, 2);

        await context.db.deleteContact('unthrottled-group-2', nextContact.id);
        assert.equal(getBackupFiles(context.dataDir).length, 3);
    } finally {
        await destroyTestContext(context);
    }
});

test('migration backups throttle uygulanmadan olusturulur', async () => {
    const context = await createTestContext();

    try {
        await prepareDatabase(context);
        process.env.BACKUP_MIN_INTERVAL_MS = '600000';
        await context.db.createGroup('migration-group', 'Migration Grup');
        const database = await checkpoint(context.db);
        context.db.createBackup('recent-manual');
        assert.equal(getBackupFiles(context.dataDir).length, 1);

        database.run("DELETE FROM schema_migrations WHERE id = '023_campaign_finished_state'");
        database.checkpointSync();
        database.close();
        delete require.cache[dbModulePath];
        context.db = require('../lib/db');

        await context.db.getDb();
        assert.equal(getBackupFiles(context.dataDir).length, 2);
    } finally {
        await destroyTestContext(context);
    }
});

test('backup cleanup orphan sidecar dosyalarini siler ve eslesmis dosyalari korur', async () => {
    const context = await createTestContext();

    try {
        await prepareDatabase(context);
        await context.db.createGroup('cleanup-group', 'Cleanup Grup');
        await checkpoint(context.db);
        const pairedBackup = context.db.createBackup('paired');
        const backupDir = path.join(context.dataDir, 'backups');
        const orphanBase = path.join(backupDir, 'orphan.sqlite');
        const pairedShm = `${pairedBackup}-shm`;
        const pairedWal = `${pairedBackup}-wal`;

        fs.writeFileSync(`${orphanBase}-shm`, 'orphan-shm');
        fs.writeFileSync(`${orphanBase}-wal`, 'orphan-wal');
        fs.writeFileSync(pairedShm, 'paired-shm');
        fs.writeFileSync(pairedWal, 'paired-wal');

        context.db.createBackup('cleanup-trigger');

        assert.equal(fs.existsSync(`${orphanBase}-shm`), false);
        assert.equal(fs.existsSync(`${orphanBase}-wal`), false);
        assert.equal(fs.existsSync(pairedShm), true);
        assert.equal(fs.existsSync(pairedWal), true);
    } finally {
        await destroyTestContext(context);
    }
});
