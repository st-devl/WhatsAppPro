const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbModulePath = require.resolve('../lib/db');

function hasNodeSqlite() {
    try {
        return typeof require('node:sqlite').DatabaseSync === 'function';
    } catch {
        return false;
    }
}

function loadDatabase(dataDir, driver) {
    delete require.cache[dbModulePath];
    process.env.WHASAPPC_DATA_DIR = dataDir;
    process.env.WHASAPPC_DB_FILE = path.join(dataDir, 'database.sqlite');
    process.env.DB_DRIVER = driver;
    return require('../lib/db');
}

async function closeDatabase(database) {
    const adapter = await database.getDb();
    adapter.close();
    delete require.cache[dbModulePath];
}

function temporaryDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-db-driver-'));
}

function restoreEnvironment(saved) {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

test('sql.js database node:sqlite ile veriler korunarak acilir', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();

    try {
        const sqljs = loadDatabase(dataDir, 'sqljs');
        await sqljs.createGroup('sqljs-group', 'SQL.js Grup');
        await closeDatabase(sqljs);

        const node = loadDatabase(dataDir, 'node');
        assert.ok((await node.getGroups()).some(group => group.id === 'sqljs-group' && group.name === 'SQL.js Grup'));
        await closeDatabase(node);
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('node:sqlite database checkpoint sonrasi sql.js ile acilir', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();

    try {
        const node = loadDatabase(dataDir, 'node');
        await node.createGroup('node-group', 'Node Grup');
        const adapter = await node.getDb();
        adapter.checkpointSync();
        await closeDatabase(node);

        const sqljs = loadDatabase(dataDir, 'sqljs');
        assert.ok((await sqljs.getGroups()).some(group => group.id === 'node-group' && group.name === 'Node Grup'));
        await closeDatabase(sqljs);
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('node:sqlite yedegi VACUUM INTO ile acilabilir DB olusturur', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();

    try {
        const database = loadDatabase(dataDir, 'node');
        await database.createGroup('backup-group', 'Yedek Grup');
        const backupFile = database.createBackup('vacuum-test');
        assert.ok(fs.existsSync(backupFile));

        const { DatabaseSync } = require('node:sqlite');
        const backup = new DatabaseSync(backupFile);
        try {
            assert.equal(backup.prepare("SELECT name FROM groups WHERE id = 'backup-group'").get().name, 'Yedek Grup');
        } finally {
            backup.close();
        }
        await closeDatabase(database);
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('node:sqlite parametrelerinde boolean ve undefined degerleri normalize eder', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();

    try {
        const database = loadDatabase(dataDir, 'node');
        const adapter = await database.getDb();
        adapter.run('CREATE TABLE parameter_probe (enabled INTEGER, optional TEXT)');
        adapter.run('INSERT INTO parameter_probe (enabled, optional) VALUES (?, ?)', [true, undefined]);
        assert.deepEqual(adapter.get('SELECT enabled, optional FROM parameter_probe'), { enabled: 1, optional: null });
        await closeDatabase(database);
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('node:sqlite exec columns olmadan satirdan kolon adlarini alir', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();

    try {
        const database = loadDatabase(dataDir, 'node');
        const adapter = await database.getDb();
        const raw = adapter.raw;
        adapter.raw = {
            prepare: () => ({
                all: () => [{ id: 1, name: 'fallback' }]
            })
        };
        try {
            assert.deepEqual(adapter.exec('SELECT id, name FROM fallback_probe'), [{
                columns: ['id', 'name'],
                values: [[1, 'fallback']]
            }]);
        } finally {
            adapter.raw = raw;
        }
        await closeDatabase(database);
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('sql.js non-empty WAL dosyasini node:sqlite ile checkpoint ederek guvenle acar', { skip: hasNodeSqlite() ? false : 'node:sqlite bu Node surumunde kullanilamiyor' }, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();
    const dbFile = path.join(dataDir, 'database.sqlite');
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(dbFile);

    try {
        writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE wal_probe (value TEXT); INSERT INTO wal_probe VALUES (\'checkpointed\')');
        assert.ok(fs.statSync(`${dbFile}-wal`).size > 0);

        const sqljs = loadDatabase(dataDir, 'sqljs');
        const adapter = await sqljs.getDb();
        assert.equal(adapter.get('SELECT value FROM wal_probe').value, 'checkpointed');
        await closeDatabase(sqljs);
    } finally {
        writer.close();
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('node:sqlite olmadiginda sql.js non-empty WAL ile veri kaybi riskinde baslamayi reddeder', { skip: hasNodeSqlite() ? false : 'WAL fixture node:sqlite olmadan olusturulamiyor' }, () => {
    const dataDir = temporaryDataDir();
    const dbFile = path.join(dataDir, 'database.sqlite');
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(dbFile);

    try {
        writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE wal_guard_probe (value TEXT); INSERT INTO wal_guard_probe VALUES (\'guard\')');
        const script = `
            const Module = require('node:module');
            const originalLoad = Module._load;
            Module._load = function(request, parent, isMain) {
                if (request === 'node:sqlite') throw new Error('node:sqlite unavailable for WAL guard test');
                return originalLoad.call(this, request, parent, isMain);
            };
            process.env.WHASAPPC_DATA_DIR = ${JSON.stringify(dataDir)};
            process.env.WHASAPPC_DB_FILE = ${JSON.stringify(dbFile)};
            process.env.DB_DRIVER = 'sqljs';
            require(${JSON.stringify(dbModulePath)}).getDb()
                .then(() => process.exit(1))
                .catch(err => {
                    if (!/veri kaybi/i.test(err.message) || !/cannot safely open/i.test(err.message)) process.exit(2);
                });
        `;
        const result = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        writer.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('DB_DRIVER=node hata yolu node:sqlite mevcut oldugu icin atlanir', {
    skip: hasNodeSqlite() ? 'node:sqlite mevcut; zorla kullanilamaz hale getirmek gercek surucu secimini test etmez' : false
}, async () => {
    const saved = Object.fromEntries(['WHASAPPC_DATA_DIR', 'WHASAPPC_DB_FILE', 'DB_DRIVER'].map(name => [name, process.env[name]]));
    const dataDir = temporaryDataDir();
    try {
        const database = loadDatabase(dataDir, 'node');
        await assert.rejects(database.getDb(), /DB_DRIVER=node/);
    } finally {
        delete require.cache[dbModulePath];
        restoreEnvironment(saved);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
