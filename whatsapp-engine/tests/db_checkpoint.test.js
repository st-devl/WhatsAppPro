const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-db-checkpoint-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.LOG_LEVEL = 'silent';

const db = require('../lib/db');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sql.js async checkpoints serialize writes and avoid temp file collisions', {
    skip: process.env.DB_DRIVER === 'sqljs' ? false : 'sql.js checkpoint serialization is covered by test:sqljs'
}, async () => {
    const database = await db.getDb();
    const originalWriteFile = fs.writeFile;
    const tempFiles = [];
    let firstWriteCallback = null;
    let writeCount = 0;

    fs.writeFile = function patchedWriteFile(file, data, callback) {
        if (String(file).includes('.tmp-')) tempFiles.push(String(file));
        writeCount += 1;

        if (writeCount === 1) {
            return originalWriteFile.call(fs, file, data, (err) => {
                firstWriteCallback = () => callback(err);
            });
        }

        return originalWriteFile.call(fs, file, data, callback);
    };

    try {
        database.run('CREATE TABLE IF NOT EXISTS checkpoint_probe (id INTEGER PRIMARY KEY, value TEXT)');
        database.run('INSERT INTO checkpoint_probe (value) VALUES (?)', ['first']);
        database.checkpoint();
        await delay(200);
        assert.equal(writeCount, 1);

        database.run('INSERT INTO checkpoint_probe (value) VALUES (?)', ['second']);
        database.checkpoint();
        await delay(200);
        assert.equal(writeCount, 1, 'second checkpoint must wait for the first write to finish');

        assert.equal(typeof firstWriteCallback, 'function');
        firstWriteCallback();
        await delay(300);

        assert.ok(writeCount >= 2, 'pending checkpoint should flush after the first write finishes');
        assert.equal(new Set(tempFiles).size, tempFiles.length, 'checkpoint temp file names must be unique');
    } finally {
        fs.writeFile = originalWriteFile;
    }
});

test('node sqlite writes are durable and checkpoint truncates the WAL', {
    skip: process.env.DB_DRIVER === 'sqljs' ? 'node:sqlite durability is covered by the default driver' : false
}, async () => {
    const database = await db.getDb();
    assert.equal(database.driver, 'node');
    database.run('CREATE TABLE IF NOT EXISTS checkpoint_probe (id INTEGER PRIMARY KEY, value TEXT)');
    database.run('INSERT INTO checkpoint_probe (value) VALUES (?)', ['durable']);
    database.checkpoint();

    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(path.join(tempDir, 'database.sqlite'));
    try {
        assert.equal(reader.prepare("SELECT value FROM checkpoint_probe WHERE value = 'durable'").get().value, 'durable');
    } finally {
        reader.close();
    }

    database.checkpointSync();
    const walFile = path.join(tempDir, 'database.sqlite-wal');
    assert.ok(!fs.existsSync(walFile) || fs.statSync(walFile).size === 0);
});
