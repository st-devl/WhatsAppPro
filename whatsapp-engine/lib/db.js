const path = require('path');
const fs = require('fs-extra');
const initSqlJs = require('sql.js');
const { estimateRemainingSeconds, estimateRemainingMinutes } = require('./campaign_estimate');
const { componentLogger } = require('./logger');

const dataDir = process.env.WHASAPPC_DATA_DIR
    ? path.resolve(process.env.WHASAPPC_DATA_DIR)
    : path.join(__dirname, '../data');
const backupDir = path.join(dataDir, 'backups');
fs.ensureDirSync(dataDir);
fs.ensureDirSync(backupDir);

const dbFile = process.env.WHASAPPC_DB_FILE
    ? path.resolve(process.env.WHASAPPC_DB_FILE)
    : path.join(dataDir, 'database.sqlite');
const DEFAULT_TENANT_ID = 'default';
const ACTIVE_CAMPAIGN_STATUSES = ['queued', 'running', 'paused'];
const DEFAULT_RECIPIENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STATUS_NOT_ON_WHATSAPP = 'not_on_whatsapp';
const STATUS_SUPPRESSED = 'suppressed';
const STATUS_CAMPAIGN_FINISHED = 'finished';
const SKIPPED_RETRY_STATUSES = ['skipped', 'skipped_cooldown'];
const TEMPORARY_RETRY_STATUSES = ['failed', 'validation_unknown'];
const DEFAULT_BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;
const dbLogger = componentLogger('database');
let db = null;
let sqlModulePromise = null;
let lastSuccessfulBackupAtMs = null;
let backupTimeInitialized = false;
let writeTransactionCountForTests = 0;
let selectedDriverLogged = false;

function resolveDriverRequest() {
    const requested = String(process.env.DB_DRIVER || 'auto').trim().toLowerCase();
    if (['auto', 'node', 'sqljs'].includes(requested)) return requested;
    throw new Error(`Gecersiz DB_DRIVER degeri: ${requested}. Gecerli degerler: auto, node, sqljs.`);
}

function loadNodeSqlite() {
    try {
        const sqlite = require('node:sqlite');
        if (typeof sqlite.DatabaseSync !== 'function') throw new Error('DatabaseSync kullanilamiyor');
        return sqlite;
    } catch (err) {
        return { error: err };
    }
}

function selectDatabaseDriver() {
    const requested = resolveDriverRequest();
    const nodeSqlite = requested === 'sqljs' ? null : loadNodeSqlite();

    if (requested === 'node') {
        if (nodeSqlite?.DatabaseSync) return { driver: 'node', nodeSqlite };
        throw new Error(`DB_DRIVER=node istendi ancak node:sqlite kullanilamiyor. Node.js'i node:sqlite destegiyle calistirin veya DB_DRIVER=sqljs ayarlayin. Sebep: ${nodeSqlite?.error?.message || 'bilinmiyor'}`);
    }
    if (requested === 'auto' && nodeSqlite?.DatabaseSync) return { driver: 'node', nodeSqlite };
    return { driver: 'sqljs', nodeSqlite: requested === 'auto' ? nodeSqlite : loadNodeSqlite() };
}

function logSelectedDriver(driver) {
    if (selectedDriverLogged) return;
    selectedDriverLogged = true;
    dbLogger.info({ driver }, 'database_driver_selected');
}

function normalizeSqlParameters(params = []) {
    const normalize = value => {
        if (value === undefined) return null;
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value;
    };
    if (Array.isArray(params)) return params.map(normalize);
    if (params && typeof params === 'object') {
        return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, normalize(value)]));
    }
    return [normalize(params)];
}

function statementArguments(params) {
    const normalized = normalizeSqlParameters(params);
    return Array.isArray(normalized) ? normalized : [normalized];
}

function getSqlModule() {
    if (!sqlModulePromise) sqlModulePromise = initSqlJs();
    return sqlModulePromise;
}

class SqliteDatabaseAdapter {
    constructor(SQL, filePath) {
        this.filePath = filePath;
        const data = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
        this.raw = data ? new SQL.Database(data) : new SQL.Database();
        this.closed = false;
        this.writeTimer = null;
        this.writeInFlight = false;
        this.writePending = false;
        this.writeSeq = 0;
        this.writeGeneration = 0;
        this.raw.run('PRAGMA foreign_keys = ON');
    }

    static async open(filePath) {
        const SQL = await getSqlModule();
        return new SqliteDatabaseAdapter(SQL, filePath);
    }

    run(sql, params = []) {
        this.raw.run(sql, params);
        return { changes: this.raw.getRowsModified() };
    }

    all(sql, params = []) {
        const stmt = this.raw.prepare(sql);
        try {
            stmt.bind(params);
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
        } finally {
            stmt.free();
        }
    }

    get(sql, params = []) {
        return this.all(sql, params)[0] || null;
    }

    prepare(sql) {
        return this.raw.prepare(sql);
    }

    exec(sql) {
        return this.raw.exec(sql);
    }

    pragma(sql, options = undefined) {
        const result = this.raw.exec(`PRAGMA ${sql}`);
        if (options?.simple) return result[0]?.values?.[0]?.[0];
        return result;
    }

    checkpointSync() {
        if (this.closed) return;
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        this.writePending = false;
        this.writeGeneration++;
        fs.ensureDirSync(path.dirname(this.filePath));
        const tempFile = `${this.filePath}.tmp-${process.pid}`;
        fs.writeFileSync(tempFile, Buffer.from(this.raw.export()));
        fs.renameSync(tempFile, this.filePath);
        this.raw.run('PRAGMA foreign_keys = ON');
    }

    checkpoint() {
        if (this.closed) return;
        this.writePending = true;
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flushCheckpoint();
        }, 150);
    }

    flushCheckpoint() {
        if (this.closed) return;
        if (this.writeInFlight) return;
        if (!this.writePending) return;

        this.writePending = false;
        this.writeInFlight = true;
        const generation = ++this.writeGeneration;

        let tempFile = null;
        const finish = () => {
            this.writeInFlight = false;
            if (this.writePending && !this.closed) this.checkpoint();
        };

        try {
            fs.ensureDirSync(path.dirname(this.filePath));
            this.writeSeq += 1;
            tempFile = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${this.writeSeq}`;
            const dataBuffer = Buffer.from(this.raw.export());
            fs.writeFile(tempFile, dataBuffer, (err) => {
                if (err) {
                    console.error('DB write error:', err);
                    finish();
                    return;
                }
                if (generation !== this.writeGeneration || this.closed) {
                    fs.rm(tempFile, { force: true }, () => finish());
                    return;
                }
                fs.rename(tempFile, this.filePath, (err2) => {
                    if (err2) console.error('DB rename error:', err2);
                    finish();
                });
            });
        } catch (e) {
            console.error('DB export error:', e);
            if (tempFile) fs.rm(tempFile, { force: true }, () => {});
            finish();
        }
    }

    close() {
        if (this.closed) return;
        this.checkpointSync();
        this.raw.close();
        this.closed = true;
    }
}

class NodeSqliteStatementAdapter {
    constructor(adapter, sql) {
        this.adapter = adapter;
        this.sql = sql;
        this.rows = [];
        this.index = -1;
    }

    bind(params = []) {
        this.rows = this.adapter.all(this.sql, params);
        this.index = -1;
    }

    step() {
        this.index += 1;
        return this.index < this.rows.length;
    }

    getAsObject() {
        return this.rows[this.index] || {};
    }

    free() {}
}

class NodeSqliteDatabaseAdapter {
    constructor(DatabaseSync, filePath) {
        this.filePath = filePath;
        this.driver = 'node';
        fs.ensureDirSync(path.dirname(filePath));
        this.raw = new DatabaseSync(filePath);
        this.closed = false;
        this.raw.exec('PRAGMA journal_mode = WAL');
        this.raw.exec('PRAGMA synchronous = NORMAL');
        this.raw.exec('PRAGMA foreign_keys = ON');
        this.raw.exec('PRAGMA busy_timeout = 5000');
    }

    static open(filePath, nodeSqlite) {
        return new NodeSqliteDatabaseAdapter(nodeSqlite.DatabaseSync, filePath);
    }

    run(sql, params = []) {
        const result = this.raw.prepare(sql).run(...statementArguments(params));
        return { changes: Number(result.changes || 0) };
    }

    all(sql, params = []) {
        return this.raw.prepare(sql).all(...statementArguments(params)).map(row => ({ ...row }));
    }

    get(sql, params = []) {
        const row = this.raw.prepare(sql).get(...statementArguments(params));
        return row ? { ...row } : null;
    }

    prepare(sql) {
        return new NodeSqliteStatementAdapter(this, sql);
    }

    exec(sql) {
        if (!/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) {
            this.raw.exec(sql);
            return [];
        }
        const statement = this.raw.prepare(sql);
        const rows = statement.all();
        const values = rows.map(row => Object.values(row));
        const columns = typeof statement.columns === 'function'
            ? statement.columns().map(column => column.name || column.column)
            : rows[0] ? Object.keys(rows[0]) : [];
        return [{ columns, values }];
    }

    pragma(sql, options = undefined) {
        const result = this.exec(`PRAGMA ${sql}`);
        if (options?.simple) return result[0]?.values?.[0]?.[0];
        return result;
    }

    checkpoint() {}

    checkpointSync() {
        if (!this.closed) this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }

    vacuumInto(backupFile) {
        this.raw.exec(`VACUUM INTO '${String(backupFile).replace(/'/g, "''")}'`);
    }

    close() {
        if (this.closed) return;
        this.checkpointSync();
        this.raw.close();
        this.closed = true;
    }
}

function hasNonEmptyWal(filePath) {
    const walFile = `${filePath}-wal`;
    try {
        return fs.statSync(walFile).size > 0;
    } catch {
        return false;
    }
}

function checkpointWalForSqlJs(filePath, nodeSqlite) {
    if (!nodeSqlite?.DatabaseSync) return false;
    const walDb = NodeSqliteDatabaseAdapter.open(filePath, nodeSqlite);
    try {
        walDb.checkpointSync();
    } finally {
        walDb.close();
    }
    return true;
}

async function openDatabaseAdapter(filePath) {
    const selection = selectDatabaseDriver();
    let adapter;

    if (selection.driver === 'node') {
        adapter = NodeSqliteDatabaseAdapter.open(filePath, selection.nodeSqlite);
    } else {
        if (hasNonEmptyWal(filePath) && !checkpointWalForSqlJs(filePath, selection.nodeSqlite)) {
            throw new Error(`SQL.js veritabani ${filePath} icin checkpoint edilmemis WAL dosyasini okuyamaz; veri kaybi riski nedeniyle baslatma durduruldu. sql.js cannot safely open a database with a non-empty WAL file because uncheckpointed data would be lost.`);
        }
        adapter = await SqliteDatabaseAdapter.open(filePath);
        adapter.driver = 'sqljs';
    }

    logSelectedDriver(adapter.driver);
    return adapter;
}

class DbError extends Error {
    constructor(message, status = 500, code = 'DB_ERROR') {
        super(message);
        this.name = 'DbError';
        this.status = status;
        this.code = code;
    }
}

const now = () => new Date().toISOString();

function isFutureTimestamp(value, asOf = now()) {
    const timestamp = Date.parse(value || '');
    const reference = Date.parse(asOf || '');
    return Number.isFinite(timestamp) && Number.isFinite(reference) && timestamp > reference;
}

function shouldPreserveTimedPause(row, asOf = now()) {
    return ['batch_pause', 'long_pause', 'night_pause'].includes(row?.pause_reason) && isFutureTimestamp(row.pause_until, asOf);
}

function resolveAsOfIso(options = {}) {
    if (options.asOf instanceof Date) return options.asOf.toISOString();
    const parsedMs = Number.parseInt(options.asOfMs, 10);
    if (Number.isFinite(parsedMs)) return new Date(parsedMs).toISOString();
    if (options.asOf) {
        const parsed = Date.parse(options.asOf);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return now();
}

function isRetryDue(row, asOfMs) {
    const nextRetryAt = Date.parse(row?.next_retry_at || '');
    return !Number.isFinite(nextRetryAt) || nextRetryAt <= asOfMs;
}

function hasUnattemptedPendingRecipientsWithDb(d, campaignId, tenantId = DEFAULT_TENANT_ID) {
    const row = queryOne(d, `
        SELECT id
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND status = 'pending'
          AND attempt_count = 0
        LIMIT 1
    `, [campaignId, resolveTenantId(tenantId)]);
    return !!row;
}

function normalizeGroupName(value) {
    return cleanText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[ıİ]/g, 'i')
        .toLowerCase();
}

function cleanText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function resolveTenantId(tenantId = DEFAULT_TENANT_ID) {
    return cleanText(tenantId) || DEFAULT_TENANT_ID;
}

function normalizePhone(value) {
    let raw = String(value || '').trim();
    if (/[eE][+-]?\d+/.test(raw)) return '';
    raw = raw.replace(/\.0+$/, '');
    let digits = raw.replace(/[^\d]/g, '');
    if (digits.startsWith('0090')) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith('5')) digits = `90${digits}`;
    if (digits.length === 11 && digits.startsWith('05')) digits = `90${digits.slice(1)}`;
    return digits;
}

function isValidPhone(phone) {
    return /^\d{10,15}$/.test(phone);
}

function normalizeContact(item = {}) {
    const phone = normalizePhone(item.phone);
    if (!isValidPhone(phone)) return null;

    const contact = {
        name: cleanText(item.name),
        surname: cleanText(item.surname),
        phone,
        normalized_phone: phone
    };

    if (item.id !== undefined && item.id !== null && item.id !== '') contact.id = item.id;
    if (item.group_id) contact.group_id = item.group_id;
    if (item.created_at) contact.created_at = item.created_at;
    if (item.updated_at) contact.updated_at = item.updated_at;

    return contact;
}

function normalizeContactsDetailed(list) {
    const seen = new Set();
    const contacts = [];
    let invalidCount = 0;
    let duplicateCount = 0;

    for (const item of Array.isArray(list) ? list : []) {
        const contact = normalizeContact(item);
        if (!contact) {
            invalidCount++;
            continue;
        }
        if (seen.has(contact.normalized_phone)) {
            duplicateCount++;
            continue;
        }
        seen.add(contact.normalized_phone);
        contacts.push(contact);
    }

    return {
        contacts,
        summary: {
            total: Array.isArray(list) ? list.length : 0,
            valid: contacts.length,
            invalid: invalidCount,
            duplicate: duplicateCount
        }
    };
}

function toSqlJson(value) {
    return JSON.stringify(value || {});
}

function sanitizeBackupReason(reason) {
    return String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'manual';
}

function timestampForFile() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveBackupRetentionCount(value = process.env.BACKUP_RETENTION_COUNT) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 30;
    return Math.min(parsed, 1000);
}

function resolveBackupMinIntervalMs(value = process.env.BACKUP_MIN_INTERVAL_MS) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BACKUP_MIN_INTERVAL_MS;
    return parsed;
}

function getLastSuccessfulBackupAtMs() {
    if (backupTimeInitialized) return lastSuccessfulBackupAtMs;

    backupTimeInitialized = true;
    if (!fs.existsSync(backupDir)) return lastSuccessfulBackupAtMs;

    fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sqlite'))
        .forEach(file => {
            const mtimeMs = fs.statSync(path.join(backupDir, file)).mtimeMs;
            if (lastSuccessfulBackupAtMs === null || mtimeMs > lastSuccessfulBackupAtMs) {
                lastSuccessfulBackupAtMs = mtimeMs;
            }
        });

    return lastSuccessfulBackupAtMs;
}

function cleanupBackups(keep = resolveBackupRetentionCount()) {
    const backups = fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sqlite'))
        .map(file => ({ file, fullPath: path.join(backupDir, file), stat: fs.statSync(path.join(backupDir, file)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    backups.slice(keep).forEach(item => fs.removeSync(item.fullPath));

    fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sqlite-shm') || file.endsWith('.sqlite-wal'))
        .forEach(file => {
            const baseFile = file.replace(/-(?:shm|wal)$/, '');
            if (!fs.existsSync(path.join(backupDir, baseFile))) {
                fs.removeSync(path.join(backupDir, file));
            }
        });
}

function createBackup(reason = 'manual') {
    fs.ensureDirSync(backupDir);
    if (db) db.checkpointSync();
    if (!fs.existsSync(dbFile)) return null;
    const backupFile = path.join(backupDir, `database-${timestampForFile()}-${sanitizeBackupReason(reason)}.sqlite`);
    if (db?.driver === 'node') db.vacuumInto(backupFile);
    else fs.copyFileSync(dbFile, backupFile);
    lastSuccessfulBackupAtMs = fs.statSync(backupFile).mtimeMs;
    backupTimeInitialized = true;
    cleanupBackups();
    return backupFile;
}

function requireSuccessfulBackup(reason) {
    const backupFile = createBackup(reason);
    if (!backupFile && fs.existsSync(dbFile)) {
        throw new DbError('Yazma işleminden önce veritabanı yedeği alınamadı', 500, 'DB_BACKUP_REQUIRED');
    }
    return backupFile;
}

function requireTransactionBackup(reason) {
    const isMigrationBackup = String(reason || '').startsWith('before-');
    const minIntervalMs = resolveBackupMinIntervalMs();
    const lastBackupAtMs = getLastSuccessfulBackupAtMs();

    if (!isMigrationBackup && minIntervalMs > 0 && lastBackupAtMs !== null && Date.now() - lastBackupAtMs < minIntervalMs) {
        return null;
    }

    return requireSuccessfulBackup(reason);
}

function save() {
    if (db) db.checkpoint();
}

function queryAll(d, sql, params = []) {
    return d.all(sql, params);
}

function queryOne(d, sql, params = []) {
    return d.get(sql, params);
}

function tableColumns(d, table) {
    return queryAll(d, `PRAGMA table_info(${table})`).map(row => row.name);
}

function ensureColumn(d, table, column, ddl) {
    const columns = tableColumns(d, table);
    if (!columns.includes(column)) d.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function ensureBaseTables(d) {
    d.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT,
        applied_at TEXT NOT NULL
    )`);

    d.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_normalized TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
    )`);

    d.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        name TEXT,
        surname TEXT,
        phone TEXT NOT NULL,
        normalized_phone TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT,
        FOREIGN KEY(group_id) REFERENCES groups(id)
    )`);

    d.run(`CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT,
        text TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    d.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
    )`);
}

function hasMigration(d, id) {
    return !!queryOne(d, 'SELECT id FROM schema_migrations WHERE id = ?', [id]);
}

function recordMigration(d, id, description) {
    d.run('INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)', [id, description, now()]);
}

function runInSqlTransaction(d, fn) {
    d.run('BEGIN TRANSACTION');
    try {
        const result = fn();
        d.run('COMMIT');
        enableForeignKeys(d);
        return result;
    } catch (err) {
        try { d.run('ROLLBACK'); } catch (_) {}
        try { enableForeignKeys(d); } catch (_) {}
        throw err;
    }
}

function applyMigration(d, id, description, fn) {
    if (hasMigration(d, id)) return false;
    runInSqlTransaction(d, () => {
        fn();
        recordMigration(d, id, description);
    });
    return true;
}

function assertNoDuplicateRows(d, sql, message, code) {
    const duplicates = queryAll(d, sql);
    if (duplicates.length > 0) {
        throw new DbError(message, 409, code);
    }
}

function assertNoNormalizedGroupNameConflicts(d) {
    const activeGroups = queryAll(d, 'SELECT id, name FROM groups WHERE deleted_at IS NULL');
    const seen = new Map();

    for (const group of activeGroups) {
        const normalized = normalizeGroupName(group.name);
        if (!normalized) continue;
        const existing = seen.get(normalized);
        if (existing && existing !== group.id) {
            throw new DbError('Aktif grup adlarında normalize edilmiş duplicate veri var. Unique index kurulmadan önce veri temizlenmeli.', 409, 'DUPLICATE_ACTIVE_GROUP_NAMES');
        }
        seen.set(normalized, group.id);
    }
}

function enableForeignKeys(d) {
    d.pragma('foreign_keys = ON');
}

function buildMigrations(d) {
    return [
        {
            id: '001_professional_columns',
            description: 'Add normalized, timestamp, and soft delete columns',
            run: () => {
                ensureColumn(d, 'groups', 'name_normalized', 'name_normalized TEXT');
                ensureColumn(d, 'groups', 'updated_at', 'updated_at TEXT');
                ensureColumn(d, 'groups', 'deleted_at', 'deleted_at TEXT');
                ensureColumn(d, 'contacts', 'normalized_phone', 'normalized_phone TEXT');
                ensureColumn(d, 'contacts', 'created_at', 'created_at TEXT');
                ensureColumn(d, 'contacts', 'updated_at', 'updated_at TEXT');
                ensureColumn(d, 'contacts', 'deleted_at', 'deleted_at TEXT');
            }
        },
        {
            id: '002_backfill_normalized_values',
            description: 'Backfill normalized group names and contact phones',
            run: () => {
                const groupRows = queryAll(d, 'SELECT id, name FROM groups');
                groupRows.forEach(group => {
                    const current = now();
                    d.run('UPDATE groups SET name = ?, name_normalized = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?', [
                        cleanText(group.name),
                        normalizeGroupName(group.name),
                        current,
                        group.id
                    ]);
                });

                const contactRows = queryAll(d, 'SELECT id, phone, name, surname FROM contacts');
                contactRows.forEach(contact => {
                    const phone = normalizePhone(contact.phone);
                    const current = now();
                    d.run('UPDATE contacts SET name = ?, surname = ?, phone = ?, normalized_phone = ?, created_at = COALESCE(created_at, ?), updated_at = COALESCE(updated_at, ?) WHERE id = ?', [
                        cleanText(contact.name),
                        cleanText(contact.surname),
                        phone,
                        phone,
                        current,
                        current,
                        contact.id
                    ]);
                });
            }
        },
        {
            id: '003_indexes',
            description: 'Add indexes for active list and phone lookups',
            run: () => {
                d.run('CREATE INDEX IF NOT EXISTS idx_groups_deleted_at ON groups(deleted_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_groups_name_normalized ON groups(name_normalized)');
                d.run('CREATE INDEX IF NOT EXISTS idx_contacts_group_id ON contacts(group_id)');
                d.run('CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON contacts(deleted_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_contacts_normalized_phone ON contacts(normalized_phone)');
                d.run('CREATE INDEX IF NOT EXISTS idx_contacts_group_phone ON contacts(group_id, normalized_phone)');
            }
        },
        {
            id: '004_integrity_constraints',
            description: 'Add active uniqueness constraints and enforce relational integrity',
            run: () => {
                assertNoNormalizedGroupNameConflicts(d);
                assertNoDuplicateRows(d, `
                    SELECT name_normalized, COUNT(*) AS duplicate_count
                    FROM groups
                    WHERE deleted_at IS NULL AND name_normalized IS NOT NULL
                    GROUP BY name_normalized
                    HAVING COUNT(*) > 1
                `, 'Aktif grup adlarında duplicate veri var. Unique index kurulmadan önce veri temizlenmeli.', 'DUPLICATE_ACTIVE_GROUP_NAMES');

                assertNoDuplicateRows(d, `
                    SELECT group_id, normalized_phone, COUNT(*) AS duplicate_count
                    FROM contacts
                    WHERE deleted_at IS NULL AND normalized_phone IS NOT NULL
                    GROUP BY group_id, normalized_phone
                    HAVING COUNT(*) > 1
                `, 'Aktif grup kişilerinde duplicate telefon verisi var. Unique index kurulmadan önce veri temizlenmeli.', 'DUPLICATE_ACTIVE_CONTACT_PHONES');

                d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_active_name_unique
                    ON groups(name_normalized)
                    WHERE deleted_at IS NULL AND name_normalized IS NOT NULL`);
                d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_active_group_phone_unique
                    ON contacts(group_id, normalized_phone)
                    WHERE deleted_at IS NULL AND normalized_phone IS NOT NULL`);
            }
        },
        {
            id: '005_campaign_state_tables',
            description: 'Add durable campaign run and recipient state tables',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS campaign_runs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    template_id TEXT,
                    group_id TEXT,
                    message TEXT,
                    total_count INTEGER NOT NULL DEFAULT 0,
                    sent_count INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0,
                    daily_limit INTEGER,
                    delay_min_ms INTEGER,
                    delay_max_ms INTEGER,
                    started_at TEXT,
                    stopped_at TEXT,
                    completed_at TEXT,
                    error TEXT,
                    metadata TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(group_id) REFERENCES groups(id),
                    FOREIGN KEY(template_id) REFERENCES templates(id)
                )`);

                d.run(`CREATE TABLE IF NOT EXISTS campaign_recipients (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    campaign_run_id TEXT NOT NULL,
                    contact_id INTEGER,
                    phone TEXT NOT NULL,
                    normalized_phone TEXT NOT NULL,
                    name TEXT,
                    surname TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    sent_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(campaign_run_id) REFERENCES campaign_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY(contact_id) REFERENCES contacts(id)
                )`);

                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_status ON campaign_runs(status)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_group_id ON campaign_runs(group_id)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_run_id ON campaign_recipients(campaign_run_id)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status)');
                d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_recipients_run_phone_unique
                    ON campaign_recipients(campaign_run_id, normalized_phone)`);
            }
        },
        {
            id: '006_locale_safe_group_name_normalization',
            description: 'Normalize active group names with locale-safe comparable keys',
            run: () => {
                assertNoNormalizedGroupNameConflicts(d);
                const groups = queryAll(d, 'SELECT id, name FROM groups');
                groups.forEach(group => {
                    d.run('UPDATE groups SET name_normalized = ? WHERE id = ?', [normalizeGroupName(group.name), group.id]);
                });
            }
        },
        {
            id: '007_campaign_logs',
            description: 'Add durable campaign log table',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS campaign_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    campaign_run_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    progress REAL,
                    metadata TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(campaign_run_id) REFERENCES campaign_runs(id) ON DELETE CASCADE
                )`);
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_logs_run_id ON campaign_logs(campaign_run_id)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_logs_created_at ON campaign_logs(created_at)');
            }
        },
        {
            id: '008_campaign_owner_scope',
            description: 'Scope campaign runs to authenticated owners',
            run: () => {
                ensureColumn(d, 'campaign_runs', 'owner_email', 'owner_email TEXT');
                const legacyOwner = cleanText(process.env.ADMIN_EMAIL || 'legacy-owner');
                d.run('UPDATE campaign_runs SET owner_email = ? WHERE owner_email IS NULL OR owner_email = ?', [legacyOwner, '']);
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_owner_status ON campaign_runs(owner_email, status, updated_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_owner_updated ON campaign_runs(owner_email, updated_at)');
            }
        },
        {
            id: '009_multi_tenant_core',
            description: 'Add tenant, user and tenant-scoped business data model',
            run: () => {
                const current = now();
                const adminEmail = cleanText(process.env.ADMIN_EMAIL || 'admin@example.com');

                d.run(`CREATE TABLE IF NOT EXISTS tenants (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )`);

                d.run(`CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    role TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);

                d.run(`CREATE TABLE IF NOT EXISTS whatsapp_accounts (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    owner_email TEXT NOT NULL,
                    label TEXT,
                    session_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);

                d.run('INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
                    DEFAULT_TENANT_ID,
                    'Default Tenant',
                    'active',
                    current,
                    current
                ]);
                d.run('INSERT OR IGNORE INTO users (id, tenant_id, email, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
                    `${DEFAULT_TENANT_ID}:admin`,
                    DEFAULT_TENANT_ID,
                    adminEmail,
                    'owner',
                    'active',
                    current,
                    current
                ]);
                d.run('INSERT OR IGNORE INTO whatsapp_accounts (id, tenant_id, owner_email, label, session_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
                    `${DEFAULT_TENANT_ID}:default`,
                    DEFAULT_TENANT_ID,
                    adminEmail,
                    'Default WhatsApp',
                    'auth/session',
                    'active',
                    current,
                    current
                ]);

                ensureColumn(d, 'groups', 'tenant_id', 'tenant_id TEXT');
                ensureColumn(d, 'contacts', 'tenant_id', 'tenant_id TEXT');
                ensureColumn(d, 'templates', 'tenant_id', 'tenant_id TEXT');
                ensureColumn(d, 'campaign_runs', 'tenant_id', 'tenant_id TEXT');
                ensureColumn(d, 'audit_logs', 'tenant_id', 'tenant_id TEXT');

                d.run('UPDATE groups SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ?', [DEFAULT_TENANT_ID, '']);
                d.run(`
                    UPDATE contacts
                    SET tenant_id = COALESCE((SELECT tenant_id FROM groups WHERE groups.id = contacts.group_id), ?)
                    WHERE tenant_id IS NULL OR tenant_id = ?
                `, [DEFAULT_TENANT_ID, '']);
                d.run('UPDATE templates SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ?', [DEFAULT_TENANT_ID, '']);
                d.run('UPDATE campaign_runs SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ?', [DEFAULT_TENANT_ID, '']);
                d.run('UPDATE audit_logs SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ?', [DEFAULT_TENANT_ID, '']);

                d.run('DROP INDEX IF EXISTS idx_groups_active_name_unique');
                d.run('DROP INDEX IF EXISTS idx_contacts_active_group_phone_unique');
                d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_active_tenant_name_unique
                    ON groups(tenant_id, name_normalized)
                    WHERE deleted_at IS NULL AND name_normalized IS NOT NULL`);
                d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_active_tenant_group_phone_unique
                    ON contacts(tenant_id, group_id, normalized_phone)
                    WHERE deleted_at IS NULL AND normalized_phone IS NOT NULL`);
                d.run('CREATE INDEX IF NOT EXISTS idx_groups_tenant_deleted ON groups(tenant_id, deleted_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_contacts_tenant_group_deleted ON contacts(tenant_id, group_id, deleted_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_templates_tenant_created ON templates(tenant_id, created_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_tenant_owner_status ON campaign_runs(tenant_id, owner_email, status, updated_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at)');
                d.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_unique ON users(tenant_id, email)');
                d.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_tenant_status ON whatsapp_accounts(tenant_id, status)');
            }
        },
        {
            id: '010_campaign_child_tenant_scope',
            description: 'Backfill tenant scope to campaign recipient and log tables',
            run: () => {
                ensureColumn(d, 'campaign_recipients', 'tenant_id', 'tenant_id TEXT');
                ensureColumn(d, 'campaign_logs', 'tenant_id', 'tenant_id TEXT');
                d.run(`
                    UPDATE campaign_recipients
                    SET tenant_id = COALESCE((SELECT tenant_id FROM campaign_runs WHERE campaign_runs.id = campaign_recipients.campaign_run_id), ?)
                    WHERE tenant_id IS NULL OR tenant_id = ?
                `, [DEFAULT_TENANT_ID, '']);
                d.run(`
                    UPDATE campaign_logs
                    SET tenant_id = COALESCE((SELECT tenant_id FROM campaign_runs WHERE campaign_runs.id = campaign_logs.campaign_run_id), ?)
                    WHERE tenant_id IS NULL OR tenant_id = ?
                `, [DEFAULT_TENANT_ID, '']);
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_tenant_run_status ON campaign_recipients(tenant_id, campaign_run_id, status)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_logs_tenant_run_created ON campaign_logs(tenant_id, campaign_run_id, created_at)');
            }
        },
        {
            id: '011_audit_log_indexes',
            description: 'Add audit log query indexes',
            run: () => {
                d.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action_created ON audit_logs(tenant_id, action, created_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity_created ON audit_logs(tenant_id, entity_type, entity_id, created_at)');
            }
        },
        {
            id: '012_recipient_runtime_state',
            description: 'Move recipient cooldown and daily send stats to SQLite',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS recipient_history (
                    tenant_id TEXT NOT NULL,
                    normalized_phone TEXT NOT NULL,
                    last_sent_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, normalized_phone),
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);

                d.run(`CREATE TABLE IF NOT EXISTS daily_send_stats (
                    tenant_id TEXT NOT NULL,
                    send_date TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, send_date),
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);

                d.run('CREATE INDEX IF NOT EXISTS idx_recipient_history_tenant_last_sent ON recipient_history(tenant_id, last_sent_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_daily_send_stats_tenant_date ON daily_send_stats(tenant_id, send_date)');
            }
        },
        {
            id: '013_session_store',
            description: 'Move HTTP sessions to SQLite',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS app_sessions (
                    sid TEXT PRIMARY KEY,
                    session_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )`);

                d.run('CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at ON app_sessions(expires_at)');
            }
        },
        {
            id: '014_user_authentication',
            description: 'Add password hash and authentication fields to users',
            run: () => {
                ensureColumn(d, 'users', 'password_hash', 'password_hash TEXT');
                ensureColumn(d, 'users', 'display_name', 'display_name TEXT');
                ensureColumn(d, 'users', 'last_login_at', 'last_login_at TEXT');

                // Migrate the existing admin user using env vars
                const adminEmail = cleanText(process.env.ADMIN_EMAIL || 'admin@example.com');
                const adminPassHash = process.env.ADMIN_PASS_HASH || '';

                d.run('UPDATE users SET password_hash = ?, display_name = ? WHERE email = ? AND tenant_id = ?', [
                    adminPassHash,
                    'Super Admin',
                    adminEmail,
                    DEFAULT_TENANT_ID
                ]);
            }
        },
        {
            id: '015_delivery_receipt_tracking',
            description: 'Add message ID and delivery status tracking to campaign recipients',
            run: () => {
                ensureColumn(d, 'campaign_recipients', 'message_id', 'message_id TEXT');
                ensureColumn(d, 'campaign_recipients', 'delivery_status', 'delivery_status TEXT');
                ensureColumn(d, 'campaign_recipients', 'delivered_at', 'delivered_at TEXT');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_message_id ON campaign_recipients(message_id)');
            }
        },
        {
            id: '016_recipient_message_hash',
            description: 'Track last sent message hash per recipient for smart cooldown confirmation',
            run: () => {
                ensureColumn(d, 'recipient_history', 'last_message_hash', 'last_message_hash TEXT');
            }
        },
        {
            id: '017_system_events',
            description: 'System event log table for WhatsApp runtime and campaign error diagnostics',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS system_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant_id TEXT NOT NULL DEFAULT 'default',
                    event_type TEXT NOT NULL,
                    severity TEXT NOT NULL DEFAULT 'info',
                    message TEXT NOT NULL,
                    metadata TEXT,
                    created_at TEXT NOT NULL
                )`);
                d.run('CREATE INDEX IF NOT EXISTS idx_system_events_tenant_created ON system_events(tenant_id, created_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_system_events_type ON system_events(event_type)');
            }
        },
        {
            id: '018_campaign_runtime_state',
            description: 'Track durable campaign timers and recipient display state',
            run: () => {
                ensureColumn(d, 'campaign_runs', 'pause_until', 'pause_until TEXT');
                ensureColumn(d, 'campaign_runs', 'pause_reason', 'pause_reason TEXT');
                ensureColumn(d, 'campaign_runs', 'wait_until', 'wait_until TEXT');
                ensureColumn(d, 'campaign_runs', 'current_recipient_name', 'current_recipient_name TEXT');
                ensureColumn(d, 'campaign_runs', 'current_recipient_phone', 'current_recipient_phone TEXT');
                ensureColumn(d, 'campaign_runs', 'last_recipient_name', 'last_recipient_name TEXT');
                ensureColumn(d, 'campaign_runs', 'last_recipient_phone', 'last_recipient_phone TEXT');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_pause_due ON campaign_runs(status, pause_until)');
            }
        },
        {
            id: '019_unavailable_whatsapp_recipients',
            description: 'Keep confirmed non-WhatsApp recipients out of future campaign queues',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS unavailable_whatsapp_recipients (
                    tenant_id TEXT NOT NULL,
                    normalized_phone TEXT NOT NULL,
                    display_phone TEXT,
                    name TEXT,
                    surname TEXT,
                    reason TEXT,
                    source_campaign_id TEXT,
                    first_detected_at TEXT NOT NULL,
                    last_detected_at TEXT NOT NULL,
                    detection_count INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, normalized_phone),
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);
                d.run('CREATE INDEX IF NOT EXISTS idx_unavailable_whatsapp_tenant_detected ON unavailable_whatsapp_recipients(tenant_id, last_detected_at)');
            }
        },
        {
            id: '020_campaign_recipient_retry_window',
            description: 'Track recipient retry windows so resumes continue past recently attempted recipients',
            run: () => {
                ensureColumn(d, 'campaign_recipients', 'last_attempted_at', 'last_attempted_at TEXT');
                ensureColumn(d, 'campaign_recipients', 'next_retry_at', 'next_retry_at TEXT');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_retry_due ON campaign_recipients(tenant_id, campaign_run_id, status, next_retry_at, id)');
            }
        },
        {
            id: '021_suppressed_recipients',
            description: 'Keep manually suppressed recipients out of campaign queues',
            run: () => {
                d.run(`CREATE TABLE IF NOT EXISTS suppressed_recipients (
                    tenant_id TEXT NOT NULL,
                    normalized_phone TEXT NOT NULL,
                    display_phone TEXT,
                    name TEXT,
                    surname TEXT,
                    reason TEXT,
                    source TEXT NOT NULL DEFAULT 'manual',
                    active INTEGER NOT NULL DEFAULT 1,
                    suppressed_at TEXT NOT NULL,
                    unsuppressed_at TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, normalized_phone),
                    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
                )`);
                d.run('CREATE INDEX IF NOT EXISTS idx_suppressed_recipients_active ON suppressed_recipients(tenant_id, active, updated_at)');
            }
        },
        {
            id: '022_campaign_recipient_report_indexes',
            description: 'Add report indexes for failed recipient and recent status lists',
            run: () => {
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_tenant_status_updated ON campaign_recipients(tenant_id, status, updated_at)');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_recipients_tenant_phone_status ON campaign_recipients(tenant_id, normalized_phone, status)');
            }
        },
        {
            id: '023_campaign_finished_state',
            description: 'Track campaigns explicitly finished by the user',
            run: () => {
                ensureColumn(d, 'campaign_runs', 'finished_at', 'finished_at TEXT');
                d.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_tenant_owner_status_updated ON campaign_runs(tenant_id, owner_email, status, updated_at)');
            }
        }
    ];
}

function runMigrations(d) {
    ensureBaseTables(d);

    const migrations = buildMigrations(d);

    const hasPending = migrations.some(migration => !hasMigration(d, migration.id));
    if (hasPending) requireSuccessfulBackup('before-migrations');

    let changed = false;
    migrations.forEach(migration => {
        changed = applyMigration(d, migration.id, migration.description, migration.run) || changed;
    });

    return changed;
}

function readAppliedMigrations(d) {
    const hasTable = queryOne(d, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
    if (!hasTable) return [];
    return queryAll(d, 'SELECT id, description, applied_at FROM schema_migrations ORDER BY id');
}

function buildMigrationStatus(appliedRows, filePath = dbFile, exists = fs.existsSync(filePath)) {
    const appliedIds = new Set(appliedRows.map(row => row.id));
    const catalog = buildMigrations(null).map(({ id, description }) => ({ id, description }));
    const pending = catalog.filter(migration => !appliedIds.has(migration.id));
    return {
        ok: true,
        db_file: filePath,
        exists,
        migration_count: appliedRows.length,
        total_migrations: catalog.length,
        latest_migration: appliedRows[appliedRows.length - 1] || null,
        pending_count: pending.length,
        pending,
        applied: appliedRows
    };
}

async function getMigrationStatus(filePath = dbFile) {
    const resolvedFile = path.resolve(filePath);
    if (!fs.existsSync(resolvedFile)) {
        return buildMigrationStatus([], resolvedFile, false);
    }

    const statusDb = await openDatabaseAdapter(resolvedFile);
    try {
        return buildMigrationStatus(readAppliedMigrations(statusDb), resolvedFile, true);
    } finally {
        statusDb.close();
    }
}

async function applyPendingMigrations() {
    const before = await getMigrationStatus(dbFile);
    const d = await getDb();
    const after = buildMigrationStatus(readAppliedMigrations(d), dbFile, fs.existsSync(dbFile));
    return {
        ok: true,
        before,
        after,
        applied_count: Math.max(0, before.pending_count - after.pending_count),
        backup_dir: backupDir
    };
}

function maskPhone(phone) {
    const normalized = normalizePhone(phone);
    if (normalized.length < 6) return normalized;
    return `${normalized.slice(0, 4)}***${normalized.slice(-2)}`;
}

function maskEmail(email) {
    const value = String(email || '').trim();
    const at = value.indexOf('@');
    if (at <= 0) return value ? '[masked]' : value;
    const name = value.slice(0, at);
    const domain = value.slice(at + 1);
    const maskedName = name.length <= 2 ? `${name[0] || ''}***` : `${name.slice(0, 2)}***${name.slice(-1)}`;
    return `${maskedName}@${domain}`;
}

function maskIp(ip) {
    const value = String(ip || '').trim();
    if (!value) return value;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        const parts = value.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
    if (value.includes(':')) return `${value.split(':').slice(0, 3).join(':')}::`;
    return '[masked]';
}

function safeAuditValue(key, value, seen = new WeakSet()) {
    const normalizedKey = String(key || '').toLowerCase();
    if (value === null || value === undefined) return value;

    if (normalizedKey.includes('password') || normalizedKey.includes('secret') || normalizedKey.includes('token') || normalizedKey.includes('authorization') || normalizedKey.includes('cookie')) {
        return '[redacted]';
    }
    if (normalizedKey.includes('phone')) return maskPhone(value);
    if (normalizedKey.includes('email')) return maskEmail(value);
    if (normalizedKey === 'ip' || normalizedKey.endsWith('_ip')) return maskIp(value);
    if (normalizedKey === 'name' || normalizedKey === 'surname' || normalizedKey === 'message') return '[masked]';

    if (Array.isArray(value)) return value.map(item => safeAuditValue('', item, seen));
    if (typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            safeAuditValue(childKey, childValue, seen)
        ]));
    }
    return value;
}

function safeAuditMetadata(metadata = {}) {
    return safeAuditValue('', metadata || {});
}

function audit(d, action, entityType, entityId, metadata = {}, tenantId = DEFAULT_TENANT_ID) {
    d.run(
        'INSERT INTO audit_logs (tenant_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [resolveTenantId(tenantId), action, entityType, String(entityId || ''), toSqlJson(safeAuditMetadata(metadata)), now()]
    );
}

function ensureTenant(d, tenantId = DEFAULT_TENANT_ID) {
    const tenant = resolveTenantId(tenantId);
    const row = queryOne(d, 'SELECT * FROM tenants WHERE id = ? AND status = ?', [tenant, 'active']);
    if (!row) throw new DbError('Tenant bulunamadı', 404, 'TENANT_NOT_FOUND');
    return row;
}

function ensureActiveGroup(d, groupId, tenantId = DEFAULT_TENANT_ID) {
    const tenant = resolveTenantId(tenantId);
    const group = queryOne(d, 'SELECT * FROM groups WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [groupId, tenant]);
    if (!group) throw new DbError('Grup bulunamadı', 404, 'GROUP_NOT_FOUND');
    return group;
}

function ensureUniqueGroupName(d, name, tenantId = DEFAULT_TENANT_ID, excludeId = null) {
    const tenant = resolveTenantId(tenantId);
    const normalized = normalizeGroupName(name);
    const existing = excludeId
        ? queryOne(d, 'SELECT id FROM groups WHERE tenant_id = ? AND name_normalized = ? AND id != ? AND deleted_at IS NULL', [tenant, normalized, excludeId])
        : queryOne(d, 'SELECT id FROM groups WHERE tenant_id = ? AND name_normalized = ? AND deleted_at IS NULL', [tenant, normalized]);
    if (existing) throw new DbError('Bu isimde aktif bir grup zaten var', 409, 'DUPLICATE_GROUP_NAME');
    return normalized;
}

function ensureUniqueContactPhone(d, groupId, normalizedPhone, tenantId = DEFAULT_TENANT_ID, excludeContactId = null) {
    const tenant = resolveTenantId(tenantId);
    const existing = excludeContactId
        ? queryOne(d, 'SELECT id FROM contacts WHERE tenant_id = ? AND group_id = ? AND normalized_phone = ? AND id != ? AND deleted_at IS NULL', [tenant, groupId, normalizedPhone, excludeContactId])
        : queryOne(d, 'SELECT id FROM contacts WHERE tenant_id = ? AND group_id = ? AND normalized_phone = ? AND deleted_at IS NULL', [tenant, groupId, normalizedPhone]);
    if (existing) throw new DbError('Bu telefon numarası bu grupta zaten kayıtlı', 409, 'DUPLICATE_CONTACT_PHONE');
}

function mapContact(row) {
    return {
        id: row.id,
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
        group_id: row.group_id,
        name: row.name || '',
        surname: row.surname || '',
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || row.phone || '',
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function getContactById(d, groupId, contactId, tenantId = DEFAULT_TENANT_ID) {
    const contact = queryOne(d, 'SELECT * FROM contacts WHERE id = ? AND group_id = ? AND tenant_id = ? AND deleted_at IS NULL', [contactId, groupId, resolveTenantId(tenantId)]);
    if (!contact) throw new DbError('Kişi bulunamadı', 404, 'CONTACT_NOT_FOUND');
    return contact;
}

function migrateJSONsWithDb(d) {
    const tplPath = path.join(dataDir, 'templates.json');
    const grpPath = path.join(dataDir, 'groups.json');

    if (!fs.existsSync(tplPath) && !fs.existsSync(grpPath)) return false;

    requireSuccessfulBackup('before-json-migration');
    runInSqlTransaction(d, () => {
        if (fs.existsSync(tplPath)) {
            const templates = fs.readJsonSync(tplPath);
            templates.forEach(t => {
                d.run('INSERT OR IGNORE INTO templates (id, tenant_id, name, text) VALUES (?, ?, ?, ?)', [String(t.id), DEFAULT_TENANT_ID, cleanText(t.name), String(t.text || '')]);
            });
            d.run('UPDATE templates SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ?', [DEFAULT_TENANT_ID, '']);
            fs.renameSync(tplPath, `${tplPath}.migrated`);
            audit(d, 'legacy_templates_migrated', 'template', 'legacy', { count: templates.length }, DEFAULT_TENANT_ID);
        }

        if (fs.existsSync(grpPath)) {
            const groups = fs.readJsonSync(grpPath);
            groups.forEach(g => {
                const groupName = cleanText(g.name);
                const groupId = String(g.id);
                d.run('INSERT OR IGNORE INTO groups (id, tenant_id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
                    groupId,
                    DEFAULT_TENANT_ID,
                    groupName,
                    normalizeGroupName(groupName),
                    now(),
                    now()
                ]);

                const { contacts } = normalizeContactsDetailed(g.contacts || []);
                contacts.forEach(c => {
                    d.run('INSERT INTO contacts (tenant_id, group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
                        DEFAULT_TENANT_ID,
                        groupId,
                        c.name,
                        c.surname,
                        c.phone,
                        c.normalized_phone,
                        now(),
                        now()
                    ]);
                });
            });
            fs.renameSync(grpPath, `${grpPath}.migrated`);
            audit(d, 'legacy_groups_migrated', 'group', 'legacy', { count: groups.length }, DEFAULT_TENANT_ID);
        }
    });
    save();
    return true;
}

function businessDate(date = new Date()) {
    return date.toLocaleDateString('en-CA');
}

function migrateRecipientRuntimeJsonsWithDb(d) {
    const historyPath = path.join(dataDir, 'recipient_history.json');
    const statsPath = path.join(dataDir, 'daily_stats.json');
    const current = now();
    let changed = false;

    runInSqlTransaction(d, () => {
        if (fs.existsSync(historyPath)) {
            const history = fs.readJsonSync(historyPath);
            Object.entries(history || {}).forEach(([phone, sentAtMs]) => {
                const normalizedPhone = normalizePhone(phone);
                const timestamp = Number(sentAtMs);
                if (!isValidPhone(normalizedPhone) || !Number.isFinite(timestamp)) return;
                const sentAt = new Date(timestamp).toISOString();
                d.run(`
                    INSERT INTO recipient_history (tenant_id, normalized_phone, last_sent_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(tenant_id, normalized_phone)
                    DO UPDATE SET last_sent_at = excluded.last_sent_at, updated_at = excluded.updated_at
                `, [DEFAULT_TENANT_ID, normalizedPhone, sentAt, current, current]);
            });
            fs.renameSync(historyPath, `${historyPath}.migrated`);
            changed = true;
        }

        if (fs.existsSync(statsPath)) {
            const stats = fs.readJsonSync(statsPath);
            const count = Number.parseInt(stats?.count || '0', 10);
            if (Number.isFinite(count) && count > 0) {
                d.run(`
                    INSERT INTO daily_send_stats (tenant_id, send_date, count, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(tenant_id, send_date)
                    DO UPDATE SET count = MAX(daily_send_stats.count, excluded.count), updated_at = excluded.updated_at
                `, [DEFAULT_TENANT_ID, businessDate(), count, current]);
            }
            fs.renameSync(statsPath, `${statsPath}.migrated`);
            changed = true;
        }
    });

    if (changed) save();
    return changed;
}

async function getDb() {
    if (db) return db;

    db = await openDatabaseAdapter(dbFile);

    enableForeignKeys(db);
    const changed = runMigrations(db);
    if (changed || !fs.existsSync(dbFile)) save();
    migrateJSONsWithDb(db);
    migrateRecipientRuntimeJsonsWithDb(db);
    enableForeignKeys(db);

    return db;
}

async function withWriteTransaction(reason, fn) {
    const d = await getDb();
    if (reason) requireTransactionBackup(reason);
    writeTransactionCountForTests++;
    const result = runInSqlTransaction(d, () => fn(d));
    save();
    return result;
}

// --- PUBLIC API ---

const createTenant = async (id, name) => withWriteTransaction(null, (d) => {
    const tenantId = resolveTenantId(id);
    const tenantName = cleanText(name);
    if (!tenantName) throw new DbError('Tenant adı zorunlu', 400, 'TENANT_NAME_REQUIRED');
    const current = now();
    d.run('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        tenantId,
        tenantName,
        'active',
        current,
        current
    ]);
    audit(d, 'tenant_created', 'tenant', tenantId, { tenant_name: tenantName }, tenantId);
    return { id: tenantId, name: tenantName, status: 'active', created_at: current, updated_at: current };
});

const getGroups = async (tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    return queryAll(d, `
        SELECT
            g.id,
            g.tenant_id,
            g.name,
            g.created_at,
            g.updated_at,
            COUNT(c.id) AS contact_count,
            COALESCE(SUM(CASE
                WHEN c.id IS NOT NULL
                 AND sr.normalized_phone IS NULL
                 AND uw.normalized_phone IS NULL
                THEN 1 ELSE 0 END), 0) AS sendable_count
        FROM groups g
        LEFT JOIN contacts c
          ON c.group_id = g.id
         AND c.tenant_id = g.tenant_id
         AND c.deleted_at IS NULL
        LEFT JOIN suppressed_recipients sr
          ON sr.tenant_id = g.tenant_id
         AND sr.normalized_phone = c.normalized_phone
         AND sr.active = 1
        LEFT JOIN unavailable_whatsapp_recipients uw
          ON uw.tenant_id = g.tenant_id
         AND uw.normalized_phone = c.normalized_phone
        WHERE g.tenant_id = ? AND g.deleted_at IS NULL
        GROUP BY g.id, g.tenant_id, g.name, g.created_at, g.updated_at
        ORDER BY datetime(g.created_at) DESC, g.name ASC
    `, [tenant]).map(group => ({
        ...group,
        contact_count: Number(group.contact_count || 0),
        sendable_count: Number(group.sendable_count || 0),
        contacts: []
    }));
};

const getGroupContacts = async (groupId, tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);
    return queryAll(d, `
        SELECT id, tenant_id, group_id, name, surname, phone, normalized_phone, created_at, updated_at
        FROM contacts
        WHERE tenant_id = ? AND group_id = ? AND deleted_at IS NULL
        ORDER BY id ASC
    `, [tenant, groupId]).map(mapContact);
};

function normalizePaginationOptions(options = {}) {
    const rawLimit = Number.parseInt(options.limit, 10);
    const rawOffset = Number.parseInt(options.offset, 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const search = cleanText(options.search || options.q || '');
    const sort = ['name', 'phone', 'created_at', 'updated_at'].includes(options.sort) ? options.sort : 'id';
    const direction = String(options.direction || options.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return { limit, offset, search, sort, direction };
}

function contactOrderBy(sort, direction) {
    const columns = {
        id: 'id',
        name: 'name',
        phone: 'normalized_phone',
        created_at: 'datetime(created_at)',
        updated_at: 'datetime(updated_at)'
    };
    return `${columns[sort] || columns.id} ${direction}, id ASC`;
}

const getGroupContactsPage = async (groupId, options = {}, tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);

    const { limit, offset, search, sort, direction } = normalizePaginationOptions(options);
    const where = ['tenant_id = ?', 'group_id = ?', 'deleted_at IS NULL'];
    const params = [tenant, groupId];

    if (search) {
        where.push('(name LIKE ? OR surname LIKE ? OR phone LIKE ? OR normalized_phone LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const totalRow = queryOne(d, `SELECT COUNT(*) AS total FROM contacts WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const rows = queryAll(d, `
        SELECT id, tenant_id, group_id, name, surname, phone, normalized_phone, created_at, updated_at
        FROM contacts
        WHERE ${whereSql}
        ORDER BY ${contactOrderBy(sort, direction)}
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]).map(mapContact);

    return {
        contacts: rows,
        pagination: {
            total,
            limit,
            offset,
            returned: rows.length,
            has_more: offset + rows.length < total,
            next_offset: offset + rows.length < total ? offset + rows.length : null
        },
        sort: {
            field: sort,
            direction: direction.toLowerCase()
        },
        search
    };
};

const getExportableContacts = async (tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const rows = queryAll(d, `
        SELECT
            c.id,
            c.tenant_id,
            c.group_id,
            c.name,
            c.surname,
            c.phone,
            c.normalized_phone,
            c.created_at,
            c.updated_at
        FROM contacts c
        INNER JOIN groups g
          ON g.id = c.group_id
         AND g.tenant_id = c.tenant_id
         AND g.deleted_at IS NULL
        LEFT JOIN suppressed_recipients sr
          ON sr.tenant_id = c.tenant_id
         AND sr.normalized_phone = c.normalized_phone
         AND sr.active = 1
        LEFT JOIN unavailable_whatsapp_recipients uw
          ON uw.tenant_id = c.tenant_id
         AND uw.normalized_phone = c.normalized_phone
        WHERE c.tenant_id = ?
          AND c.deleted_at IS NULL
          AND sr.normalized_phone IS NULL
          AND uw.normalized_phone IS NULL
        ORDER BY datetime(g.created_at) DESC, g.name ASC, c.id ASC
    `, [tenant]).map(mapContact);

    const seen = new Set();
    return rows.filter(contact => {
        const normalizedPhone = normalizePhone(contact.normalized_phone || contact.phone);
        if (!normalizedPhone || seen.has(normalizedPhone)) return false;
        seen.add(normalizedPhone);
        return true;
    });
};

const createGroup = async (id, name, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const groupName = cleanText(name);
    if (!groupName) throw new DbError('Grup adı zorunlu', 400, 'GROUP_NAME_REQUIRED');
    const normalized = ensureUniqueGroupName(d, groupName, tenant);
    const current = now();

    d.run('INSERT INTO groups (id, tenant_id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, tenant, groupName, normalized, current, current]);
    audit(d, 'group_created', 'group', id, { group_name: groupName }, tenant);
    return { id, tenant_id: tenant, name: groupName, created_at: current, updated_at: current, contact_count: 0, sendable_count: 0, contacts: [] };
});

const updateGroupContacts = async (groupId, contactsList, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('replace-group-contacts', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);
    const { contacts, summary } = normalizeContactsDetailed(contactsList);
    const current = now();

    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND group_id = ? AND deleted_at IS NULL', [current, current, tenant, groupId]);
    contacts.forEach(contact => {
        d.run('INSERT INTO contacts (tenant_id, group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            tenant,
            groupId,
            contact.name,
            contact.surname,
            contact.phone,
            contact.normalized_phone,
            current,
            current
        ]);
    });
    d.run('UPDATE groups SET updated_at = ? WHERE id = ? AND tenant_id = ?', [current, groupId, tenant]);
    audit(d, 'group_contacts_replaced', 'group', groupId, summary, tenant);
    return { success: true, summary: { ...summary, saved: contacts.length } };
});

const deleteGroup = async (id, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('delete-group', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, id, tenant);
    const current = now();
    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND group_id = ? AND deleted_at IS NULL', [current, current, tenant, id]);
    d.run('UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [current, current, id, tenant]);
    audit(d, 'group_deleted', 'group', id, {}, tenant);
    return { success: true };
});

const createContact = async (groupId, input, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);
    const contact = normalizeContact(input);
    if (!contact) throw new DbError('Geçerli telefon numarası gerekli', 400, 'INVALID_CONTACT_PHONE');
    ensureUniqueContactPhone(d, groupId, contact.normalized_phone, tenant);
    const current = now();

    d.run('INSERT INTO contacts (tenant_id, group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        tenant,
        groupId,
        contact.name,
        contact.surname,
        contact.phone,
        contact.normalized_phone,
        current,
        current
    ]);
    const row = queryOne(d, 'SELECT last_insert_rowid() AS id');
    audit(d, 'contact_created', 'contact', row.id, { phone: contact.normalized_phone, group_id: groupId }, tenant);
    return mapContact({ ...contact, id: row.id, tenant_id: tenant, group_id: groupId, created_at: current, updated_at: current });
});

const updateContact = async (groupId, contactId, input, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);
    const existing = getContactById(d, groupId, contactId, tenant);
    const nextPhone = input.phone !== undefined ? normalizePhone(input.phone) : existing.normalized_phone;
    if (!isValidPhone(nextPhone)) throw new DbError('Geçerli telefon numarası gerekli', 400, 'INVALID_CONTACT_PHONE');
    if (nextPhone !== existing.normalized_phone) ensureUniqueContactPhone(d, groupId, nextPhone, tenant, contactId);

    const nextName = input.name !== undefined ? cleanText(input.name) : cleanText(existing.name);
    const nextSurname = input.surname !== undefined ? cleanText(input.surname) : cleanText(existing.surname);
    const current = now();

    d.run('UPDATE contacts SET name = ?, surname = ?, phone = ?, normalized_phone = ?, updated_at = ? WHERE id = ? AND group_id = ? AND tenant_id = ? AND deleted_at IS NULL', [
        nextName,
        nextSurname,
        nextPhone,
        nextPhone,
        current,
        contactId,
        groupId,
        tenant
    ]);
    d.run('UPDATE groups SET updated_at = ? WHERE id = ? AND tenant_id = ?', [current, groupId, tenant]);
    audit(d, 'contact_updated', 'contact', contactId, { phone: nextPhone, group_id: groupId }, tenant);
    return mapContact({ id: Number(contactId), tenant_id: tenant, group_id: groupId, name: nextName, surname: nextSurname, phone: nextPhone, normalized_phone: nextPhone, created_at: existing.created_at, updated_at: current });
});

const deleteContact = async (groupId, contactId, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('delete-contact', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureActiveGroup(d, groupId, tenant);
    getContactById(d, groupId, contactId, tenant);
    const current = now();
    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ? AND tenant_id = ? AND deleted_at IS NULL', [current, current, contactId, groupId, tenant]);
    d.run('UPDATE groups SET updated_at = ? WHERE id = ? AND tenant_id = ?', [current, groupId, tenant]);
    audit(d, 'contact_deleted', 'contact', contactId, { group_id: groupId }, tenant);
    return { success: true };
});

const getTemplates = async (tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    return queryAll(d, 'SELECT id, tenant_id, name, text, created_at FROM templates WHERE tenant_id = ? ORDER BY datetime(created_at) DESC', [tenant]).map(row => ({
        id: row.id,
        tenant_id: row.tenant_id || tenant,
        name: row.name,
        text: row.text,
        created_at: row.created_at
    }));
};

const createTemplate = async (id, name, text, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const tplName = cleanText(name);
    if (!tplName || !String(text || '').trim()) throw new DbError('Şablon adı ve içerik zorunlu', 400, 'TEMPLATE_REQUIRED');
    d.run('INSERT INTO templates (id, tenant_id, name, text, created_at) VALUES (?, ?, ?, ?, ?)', [id, tenant, tplName, String(text), now()]);
    return { id, tenant_id: tenant, name: tplName, text: String(text) };
});

function mapCampaignRun(row) {
    if (!row) return null;
    const total = Number(row.total_count || 0);
    const sent = Number(row.sent_count || 0);
    const failed = Number(row.failed_count || 0);
    const processed = sent + failed;
    return {
        id: row.id,
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
        owner_email: row.owner_email || null,
        status: row.status,
        template_id: row.template_id || null,
        group_id: row.group_id || null,
        message: row.message || '',
        total,
        processed,
        sent_count: sent,
        failed_count: failed,
        progress: total > 0 ? Math.min(100, (processed / total) * 100) : 0,
        daily_limit: row.daily_limit,
        delay_min_ms: row.delay_min_ms,
        delay_max_ms: row.delay_max_ms,
        pause_until: row.pause_until || null,
        pause_reason: row.pause_reason || null,
        wait_until: row.wait_until || null,
        current_recipient_name: row.current_recipient_name || null,
        current_recipient_phone: row.current_recipient_phone || null,
        last_recipient_name: row.last_recipient_name || null,
        last_recipient_phone: row.last_recipient_phone || null,
        started_at: row.started_at,
        stopped_at: row.stopped_at,
        completed_at: row.completed_at,
        finished_at: row.finished_at || null,
        error: row.error || null,
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        estimate_remaining_seconds: 0,
        estimate_remaining_minutes: 0,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function applyCampaignRecipientSummary(d, run) {
    if (!run?.id) return run;
    const row = queryOne(d, `
        SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS legacy_skipped_count,
            SUM(CASE WHEN status = 'skipped_cooldown' THEN 1 ELSE 0 END) AS cooldown_skipped_count,
            SUM(CASE WHEN status = 'not_on_whatsapp' THEN 1 ELSE 0 END) AS not_on_whatsapp_count,
            SUM(CASE WHEN status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed_count,
            SUM(CASE WHEN status = 'validation_unknown' THEN 1 ELSE 0 END) AS validation_unknown_count
        FROM campaign_recipients
        WHERE campaign_run_id = ?
    `, [run.id]) || {};
    const pending = Number(row.pending_count || 0);
    const failed = Number(row.failed_count || 0);
    const legacySkipped = Number(row.legacy_skipped_count || 0);
    const cooldownSkipped = Number(row.cooldown_skipped_count || 0);
    const notOnWhatsApp = Number(row.not_on_whatsapp_count || 0);
    const suppressed = Number(row.suppressed_count || 0);
    const validationUnknown = Number(row.validation_unknown_count || 0);
    const skipped = legacySkipped + cooldownSkipped + notOnWhatsApp + suppressed;
    const sent = Number(row.sent_count || run.sent_count || 0);
    const remaining = pending + failed + validationUnknown;

    run.pending_count = pending;
    run.sent_count = sent;
    run.failed_count = failed;
    run.skipped_count = skipped;
    run.legacy_skipped_count = legacySkipped;
    run.cooldown_skipped_count = cooldownSkipped;
    run.not_on_whatsapp_count = notOnWhatsApp;
    run.suppressed_count = suppressed;
    run.validation_unknown_count = validationUnknown;
    run.remaining_count = remaining;
    run.processed = sent + failed + skipped + validationUnknown;
    run.progress = run.total > 0 ? Math.min(100, (run.processed / run.total) * 100) : 0;
    run.estimate_remaining_seconds = estimateRemainingSeconds({
        remaining,
        delay_min_ms: run.delay_min_ms,
        delay_max_ms: run.delay_max_ms,
        sentCount: sent,
        batchSize: run.metadata?.batch_size,
        batchPauseMinutes: process.env.CAMPAIGN_BATCH_PAUSE_MINUTES ?? run.metadata?.batch_pause_minutes,
        longPauseSize: process.env.CAMPAIGN_LONG_PAUSE_SIZE ?? run.metadata?.long_pause_size,
        longPauseMinutes: process.env.CAMPAIGN_LONG_PAUSE_MINUTES ?? run.metadata?.long_pause_minutes
    });
    run.estimate_remaining_minutes = estimateRemainingMinutes({
        remaining,
        delay_min_ms: run.delay_min_ms,
        delay_max_ms: run.delay_max_ms,
        sentCount: sent,
        batchSize: run.metadata?.batch_size,
        batchPauseMinutes: process.env.CAMPAIGN_BATCH_PAUSE_MINUTES ?? run.metadata?.batch_pause_minutes,
        longPauseSize: process.env.CAMPAIGN_LONG_PAUSE_SIZE ?? run.metadata?.long_pause_size,
        longPauseMinutes: process.env.CAMPAIGN_LONG_PAUSE_MINUTES ?? run.metadata?.long_pause_minutes
    });
    return run;
}

function mapCampaignLog(row) {
    return {
        id: row.id,
        type: row.type,
        message: row.message,
        progress: row.progress === null || row.progress === undefined ? undefined : Number(row.progress),
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        timestamp: row.created_at
    };
}

function mapCampaignRecipient(row) {
    return {
        id: row.contact_id || undefined,
        phone: row.phone,
        normalized_phone: row.normalized_phone,
        name: row.name,
        surname: row.surname,
        status: row.status,
        attempt_count: row.attempt_count,
        last_error: row.last_error || null,
        last_attempted_at: row.last_attempted_at || null,
        next_retry_at: row.next_retry_at || null
    };
}

function mapUnavailableWhatsAppRecipient(row) {
    if (!row) return null;
    return {
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
        phone: row.display_phone || row.normalized_phone,
        normalized_phone: row.normalized_phone,
        name: row.name || '',
        surname: row.surname || '',
        reason: row.reason || 'WhatsApp kullanıcısı değil',
        source_campaign_id: row.source_campaign_id || null,
        first_detected_at: row.first_detected_at,
        last_detected_at: row.last_detected_at,
        detection_count: Number(row.detection_count || 1),
        updated_at: row.updated_at
    };
}

function mapSuppressedRecipient(row) {
    if (!row) return null;
    return {
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
        phone: row.display_phone || row.normalized_phone,
        normalized_phone: row.normalized_phone,
        name: row.name || '',
        surname: row.surname || '',
        reason: row.reason || 'Manuel olarak gönderim dışı bırakıldı',
        source: row.source || 'manual',
        active: Number(row.active || 0) === 1,
        suppressed_at: row.suppressed_at,
        unsuppressed_at: row.unsuppressed_at || null,
        updated_at: row.updated_at
    };
}

function unavailableReason(value) {
    const text = value instanceof Error ? (value.message || String(value)) : String(value || '');
    return cleanText(text) || 'WhatsApp kullanıcısı değil';
}

function suppressedReason(value) {
    return cleanText(value) || 'Manuel olarak gönderim dışı bırakıldı';
}

function upsertUnavailableWhatsAppRecipientWithDb(d, {
    tenantId = DEFAULT_TENANT_ID,
    normalizedPhone,
    contact = {},
    reason = 'WhatsApp kullanıcısı değil',
    campaignId = null,
    detectedAt = now()
} = {}) {
    const tenant = resolveTenantId(tenantId);
    const phone = normalizePhone(normalizedPhone || contact.normalized_phone || contact.phone);
    if (!isValidPhone(phone)) return null;

    const displayPhone = cleanText(contact.phone || phone);
    const name = cleanText(contact.name);
    const surname = cleanText(contact.surname);
    const detected = String(detectedAt || now());
    const resolvedReason = unavailableReason(reason);

    d.run(`
        INSERT INTO unavailable_whatsapp_recipients (
            tenant_id, normalized_phone, display_phone, name, surname, reason, source_campaign_id,
            first_detected_at, last_detected_at, detection_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(tenant_id, normalized_phone)
        DO UPDATE SET
            display_phone = COALESCE(NULLIF(excluded.display_phone, ''), unavailable_whatsapp_recipients.display_phone),
            name = COALESCE(NULLIF(excluded.name, ''), unavailable_whatsapp_recipients.name),
            surname = COALESCE(NULLIF(excluded.surname, ''), unavailable_whatsapp_recipients.surname),
            reason = excluded.reason,
            source_campaign_id = COALESCE(excluded.source_campaign_id, unavailable_whatsapp_recipients.source_campaign_id),
            last_detected_at = excluded.last_detected_at,
            detection_count = unavailable_whatsapp_recipients.detection_count + 1,
            updated_at = excluded.updated_at
    `, [
        tenant,
        phone,
        displayPhone,
        name,
        surname,
        resolvedReason,
        campaignId ? String(campaignId) : null,
        detected,
        detected,
        detected
    ]);

    return mapUnavailableWhatsAppRecipient(queryOne(d, `
        SELECT *
        FROM unavailable_whatsapp_recipients
        WHERE tenant_id = ? AND normalized_phone = ?
    `, [tenant, phone]));
}

function getUnavailableWhatsAppRecipientsByPhonesWithDb(d, tenantId, phones = []) {
    const tenant = resolveTenantId(tenantId);
    const uniquePhones = Array.from(new Set(
        (Array.isArray(phones) ? phones : [])
            .map(normalizePhone)
            .filter(isValidPhone)
    ));
    const unavailable = new Map();

    for (let i = 0; i < uniquePhones.length; i += 500) {
        const chunk = uniquePhones.slice(i, i + 500);
        if (chunk.length === 0) continue;
        queryAll(d, `
            SELECT *
            FROM unavailable_whatsapp_recipients
            WHERE tenant_id = ?
              AND normalized_phone IN (${chunk.map(() => '?').join(', ')})
        `, [tenant, ...chunk]).forEach(row => {
            unavailable.set(row.normalized_phone, mapUnavailableWhatsAppRecipient(row));
        });
    }

    return unavailable;
}

function upsertSuppressedRecipientWithDb(d, {
    tenantId = DEFAULT_TENANT_ID,
    normalizedPhone,
    contact = {},
    reason = 'Manuel olarak gönderim dışı bırakıldı',
    source = 'manual',
    suppressedAt = now()
} = {}) {
    const tenant = resolveTenantId(tenantId);
    const phone = normalizePhone(normalizedPhone || contact.normalized_phone || contact.phone);
    if (!isValidPhone(phone)) return null;

    const displayPhone = cleanText(contact.phone || phone);
    const name = cleanText(contact.name);
    const surname = cleanText(contact.surname);
    const current = String(suppressedAt || now());
    const resolvedReason = suppressedReason(reason);
    const resolvedSource = cleanText(source) || 'manual';

    d.run(`
        INSERT INTO suppressed_recipients (
            tenant_id, normalized_phone, display_phone, name, surname, reason, source,
            active, suppressed_at, unsuppressed_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
        ON CONFLICT(tenant_id, normalized_phone)
        DO UPDATE SET
            display_phone = COALESCE(NULLIF(excluded.display_phone, ''), suppressed_recipients.display_phone),
            name = COALESCE(NULLIF(excluded.name, ''), suppressed_recipients.name),
            surname = COALESCE(NULLIF(excluded.surname, ''), suppressed_recipients.surname),
            reason = excluded.reason,
            source = excluded.source,
            active = 1,
            suppressed_at = CASE
                WHEN suppressed_recipients.active = 1 THEN suppressed_recipients.suppressed_at
                ELSE excluded.suppressed_at
            END,
            unsuppressed_at = NULL,
            updated_at = excluded.updated_at
    `, [
        tenant,
        phone,
        displayPhone,
        name,
        surname,
        resolvedReason,
        resolvedSource,
        current,
        current
    ]);

    return mapSuppressedRecipient(queryOne(d, `
        SELECT *
        FROM suppressed_recipients
        WHERE tenant_id = ? AND normalized_phone = ?
    `, [tenant, phone]));
}

function getSuppressedRecipientsByPhonesWithDb(d, tenantId, phones = []) {
    const tenant = resolveTenantId(tenantId);
    const uniquePhones = Array.from(new Set(
        (Array.isArray(phones) ? phones : [])
            .map(normalizePhone)
            .filter(isValidPhone)
    ));
    const suppressed = new Map();

    for (let i = 0; i < uniquePhones.length; i += 500) {
        const chunk = uniquePhones.slice(i, i + 500);
        if (chunk.length === 0) continue;
        queryAll(d, `
            SELECT *
            FROM suppressed_recipients
            WHERE tenant_id = ?
              AND active = 1
              AND normalized_phone IN (${chunk.map(() => '?').join(', ')})
        `, [tenant, ...chunk]).forEach(row => {
            suppressed.set(row.normalized_phone, mapSuppressedRecipient(row));
        });
    }

    return suppressed;
}

function requireCampaignOwner(ownerEmail) {
    const owner = cleanText(ownerEmail);
    if (!owner) throw new DbError('Kampanya sahibi doğrulanamadı', 401, 'CAMPAIGN_OWNER_REQUIRED');
    return owner;
}

function ensureCampaignOwner(d, campaignId, ownerEmail, tenantId = null) {
    const owner = requireCampaignOwner(ownerEmail);
    const row = queryOne(d, 'SELECT * FROM campaign_runs WHERE id = ?', [campaignId]);
    if (!row) throw new DbError('Kampanya bulunamadı', 404, 'CAMPAIGN_NOT_FOUND');
    if (tenantId && row.tenant_id !== resolveTenantId(tenantId)) throw new DbError('Bu kampanyaya erişim yetkiniz yok', 403, 'CAMPAIGN_FORBIDDEN');
    if (row.owner_email !== owner) throw new DbError('Bu kampanyaya erişim yetkiniz yok', 403, 'CAMPAIGN_FORBIDDEN');
    return row;
}

function assertCampaignRestartable(row) {
    if (row?.status === STATUS_CAMPAIGN_FINISHED) {
        throw new DbError('Bu kampanya bitirildi; tekrar mesaj gönderilemez', 409, 'CAMPAIGN_FINISHED');
    }
}

function assertNoActiveCampaign(d, ownerEmail, tenantId, excludeCampaignId = null) {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const params = [tenant, owner, ...ACTIVE_CAMPAIGN_STATUSES];
    let excludeSql = '';

    if (excludeCampaignId) {
        excludeSql = ' AND id != ?';
        params.push(excludeCampaignId);
    }

    const row = queryOne(d, `
        SELECT id, status FROM campaign_runs
        WHERE tenant_id = ? AND owner_email = ? AND status IN (${ACTIVE_CAMPAIGN_STATUSES.map(() => '?').join(', ')})${excludeSql}
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
    `, params);
    if (row) throw new DbError('Bu kullanıcı için zaten aktif bir kampanya var', 409, 'CAMPAIGN_ALREADY_ACTIVE');
}

const createCampaignRun = async (input = {}) => withWriteTransaction(null, (d) => {
    const campaignId = String(input.id || '').trim();
    if (!campaignId) throw new DbError('Campaign id zorunlu', 400, 'CAMPAIGN_ID_REQUIRED');
    const tenant = resolveTenantId(input.tenantId);
    ensureTenant(d, tenant);
    const ownerEmail = requireCampaignOwner(input.ownerEmail);
    assertNoActiveCampaign(d, ownerEmail, tenant);
    const normalized = normalizeContactsDetailed(input.contacts || []);
    if (normalized.contacts.length === 0) throw new DbError('Gönderilecek geçerli kişi yok', 400, 'CAMPAIGN_CONTACTS_REQUIRED');
    const unavailableByPhone = getUnavailableWhatsAppRecipientsByPhonesWithDb(
        d,
        tenant,
        normalized.contacts.map(contact => contact.normalized_phone)
    );
    const suppressedByPhone = getSuppressedRecipientsByPhonesWithDb(
        d,
        tenant,
        normalized.contacts.map(contact => contact.normalized_phone)
    );
    const suppressedOnlyCount = normalized.contacts.filter(contact => (
        !unavailableByPhone.has(contact.normalized_phone) && suppressedByPhone.has(contact.normalized_phone)
    )).length;

    const delayRange = Array.isArray(input.delayRange) ? input.delayRange : [];
    const delayMinMs = Number.parseInt(delayRange[0], 10) * 1000 || null;
    const delayMaxMs = Number.parseInt(delayRange[1], 10) * 1000 || null;
    const current = now();

    d.run(`INSERT INTO campaign_runs (
        id, tenant_id, owner_email, status, message, total_count, sent_count, failed_count, daily_limit,
        delay_min_ms, delay_max_ms, started_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`, [
        campaignId,
        tenant,
        ownerEmail,
        'queued',
        String(input.message || ''),
        normalized.contacts.length,
        Number.parseInt(input.dailyLimit, 10) || null,
        delayMinMs,
        delayMaxMs,
        current,
        toSqlJson({
            import_summary: {
                ...normalized.summary,
                unavailable_whatsapp: unavailableByPhone.size,
                suppressed: suppressedOnlyCount
            },
            batch_size: input.batchSize,
            batch_pause_minutes: input.batchPauseMinutes,
            long_pause_size: input.longPauseSize,
            long_pause_minutes: input.longPauseMinutes,
            media_count: Number(input.mediaCount || 0),
            media_files: Array.isArray(input.mediaFiles) ? input.mediaFiles : []
        }),
        current,
        current
    ]);

    normalized.contacts.forEach(contact => {
        const unavailable = unavailableByPhone.get(contact.normalized_phone);
        const suppressed = suppressedByPhone.get(contact.normalized_phone);
        const status = unavailable
            ? STATUS_NOT_ON_WHATSAPP
            : (suppressed ? STATUS_SUPPRESSED : 'pending');
        const lastError = unavailable
            ? `WhatsApp kullanıcısı değil (önceden doğrulandı: ${unavailable.last_detected_at})`
            : (suppressed ? suppressed.reason : null);
        d.run(`INSERT INTO campaign_recipients (
            tenant_id, campaign_run_id, contact_id, phone, normalized_phone, name, surname, status,
            attempt_count, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, [
            tenant,
            campaignId,
            contact.id || null,
            contact.phone,
            contact.normalized_phone,
            contact.name,
            contact.surname,
            status,
            lastError,
            current,
            current
        ]);
    });

    return getCampaignRunStatusWithDb(d, campaignId, ownerEmail, tenant);
});

const setCampaignRunStatus = async (campaignId, status, metadata = {}) => withWriteTransaction(null, (d) => {
    const current = now();
    const existing = queryOne(d, 'SELECT status, pause_until, pause_reason FROM campaign_runs WHERE id = ?', [campaignId]);
    if (existing?.status === STATUS_CAMPAIGN_FINISHED && status !== STATUS_CAMPAIGN_FINISHED) {
        return getCampaignRunStatusWithDb(d, campaignId);
    }
    const preserveTimedPause = status === 'stopped' && shouldPreserveTimedPause(existing, current);
    const fields = ['status = ?', 'updated_at = ?'];
    const params = [status, current];

    if (status === 'running') {
        fields.push('started_at = COALESCE(started_at, ?)');
        params.push(current);
    }
    if (status === 'stopped') {
        fields.push('stopped_at = ?');
        params.push(current);
    }
    if (status === 'completed') {
        fields.push('completed_at = ?');
        params.push(current);
    }
    if (status === STATUS_CAMPAIGN_FINISHED) {
        fields.push('finished_at = ?');
        params.push(current);
    }
    if (metadata.error !== undefined) {
        fields.push('error = ?');
        params.push(String(metadata.error || ''));
    }
    const metadataSetsPause = metadata.pause_reason !== undefined || metadata.pause_until !== undefined;
    if (['paused', 'stopped', 'completed', STATUS_CAMPAIGN_FINISHED].includes(status)) {
        if (!preserveTimedPause && !metadataSetsPause) {
            fields.push('pause_until = NULL');
            fields.push('pause_reason = NULL');
        }
        fields.push('wait_until = NULL');
        fields.push('current_recipient_name = NULL');
        fields.push('current_recipient_phone = NULL');
    }
    if (metadata.pause_until !== undefined) {
        fields.push('pause_until = ?');
        params.push(metadata.pause_until === null ? null : String(metadata.pause_until || ''));
    }
    if (metadata.pause_reason !== undefined) {
        fields.push('pause_reason = ?');
        params.push(metadata.pause_reason === null ? null : String(metadata.pause_reason || ''));
    }

    params.push(campaignId);
    d.run(`UPDATE campaign_runs SET ${fields.join(', ')} WHERE id = ?`, params);
    return getCampaignRunStatusWithDb(d, campaignId);
});

function updateCampaignRuntimeStateWithDb(d, campaignId, state = {}) {
    const allowed = [
        'pause_until',
        'pause_reason',
        'wait_until',
        'current_recipient_name',
        'current_recipient_phone',
        'last_recipient_name',
        'last_recipient_phone'
    ];
    const fields = [];
    const params = [];

    allowed.forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(state, key)) return;
        fields.push(`${key} = ?`);
        const value = state[key];
        params.push(value === undefined || value === null ? null : String(value));
    });

    if (fields.length === 0) return getCampaignRunStatusWithDb(d, campaignId);
    const current = now();
    fields.push('updated_at = ?');
    params.push(current, campaignId);
    d.run(`UPDATE campaign_runs SET ${fields.join(', ')} WHERE id = ?`, params);
    return getCampaignRunStatusWithDb(d, campaignId);
}

const updateCampaignRuntimeState = async (campaignId, state = {}) => withWriteTransaction(null, (d) => {
    return updateCampaignRuntimeStateWithDb(d, campaignId, state);
});

const updateCampaignMediaFiles = async (campaignId, mediaFiles) => withWriteTransaction(null, (d) => {
    const current = now();
    const run = queryOne(d, 'SELECT metadata FROM campaign_runs WHERE id = ?', [campaignId]);
    if (!run) return null;

    let metadata = {};
    try {
        metadata = JSON.parse(run.metadata || '{}');
    } catch (_) {}

    metadata.media_files = Array.isArray(mediaFiles) ? mediaFiles : [];
    metadata.media_count = metadata.media_files.length;

    d.run(
        'UPDATE campaign_runs SET metadata = ?, updated_at = ? WHERE id = ?',
        [toSqlJson(metadata), current, campaignId]
    );
    return getCampaignRunStatusWithDb(d, campaignId);
});

function getCampaignTenantIdWithDb(d, campaignId, tenantId = null) {
    if (tenantId) return resolveTenantId(tenantId);
    const run = queryOne(d, 'SELECT tenant_id FROM campaign_runs WHERE id = ?', [campaignId]);
    return run?.tenant_id || DEFAULT_TENANT_ID;
}

function addCampaignLogWithDb(d, campaignId, type, message, progress, metadata = {}, tenantId = null) {
    d.run(
        'INSERT INTO campaign_logs (tenant_id, campaign_run_id, type, message, progress, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [getCampaignTenantIdWithDb(d, campaignId, tenantId), campaignId, type, String(message || ''), progress === undefined ? null : Number(progress), toSqlJson(metadata), now()]
    );
}

const addCampaignLog = async (campaignId, type, message, progress, metadata = {}, tenantId = null) => withWriteTransaction(null, (d) => {
    return addCampaignLogWithDb(d, campaignId, type, message, progress, metadata, tenantId);
});

function updateCampaignRecipientWithDb(d, campaignId, contact, status, error = null, tenantId = null) {
    const normalizedPhone = normalizePhone(contact?.phone || contact?.normalized_phone);
    if (!normalizedPhone) return null;
    const current = now();
    const sentAt = status === 'sent' ? current : null;
    const nextRetryAt = null;
    d.run(`UPDATE campaign_recipients
        SET status = ?,
            attempt_count = attempt_count + 1,
            last_error = ?,
            sent_at = COALESCE(?, sent_at),
            last_attempted_at = ?,
            next_retry_at = ?,
            updated_at = ?
        WHERE campaign_run_id = ? AND normalized_phone = ?`, [
        status,
        error ? (error instanceof Error ? (error.stack || String(error)) : String(error)) : null,
        sentAt,
        current,
        nextRetryAt,
        current,
        campaignId,
        normalizedPhone
    ]);

    if (status === STATUS_NOT_ON_WHATSAPP) {
        upsertUnavailableWhatsAppRecipientWithDb(d, {
            tenantId: getCampaignTenantIdWithDb(d, campaignId, tenantId),
            normalizedPhone,
            contact,
            reason: error || 'WhatsApp kullanıcısı değil',
            campaignId,
            detectedAt: current
        });
    }

    const counts = queryOne(d, `
        SELECT
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM campaign_recipients
        WHERE campaign_run_id = ?
    `, [campaignId]);

    d.run('UPDATE campaign_runs SET sent_count = ?, failed_count = ?, updated_at = ? WHERE id = ?', [
        Number(counts?.sent_count || 0),
        Number(counts?.failed_count || 0),
        current,
        campaignId
    ]);
    return getCampaignRunStatusWithDb(d, campaignId);
}

const updateCampaignRecipient = async (campaignId, contact, status, error = null, tenantId = null) => withWriteTransaction(null, (d) => {
    return updateCampaignRecipientWithDb(d, campaignId, contact, status, error, tenantId);
});

function setRecipientMessageIdWithDb(d, campaignId, normalizedPhone, messageId) {
    if (!messageId) return;
    d.run(
        'UPDATE campaign_recipients SET message_id = ?, updated_at = ? WHERE campaign_run_id = ? AND normalized_phone = ?',
        [String(messageId), now(), campaignId, normalizePhone(normalizedPhone)]
    );
}

const setRecipientMessageId = async (campaignId, normalizedPhone, messageId) => {
    if (!messageId) return;
    return withWriteTransaction(null, (d) => {
        return setRecipientMessageIdWithDb(d, campaignId, normalizedPhone, messageId);
    });
};

// Bildirimler sırasız gelebilir; durum yalnızca ileri gider (read sonrası gelen delivered yok sayılır).
const DELIVERY_STATUS_RANK = { server_ack: 1, delivered: 2, read: 3, played: 4 };
const DELIVERY_STATUS_RANK_SQL = `CASE delivery_status ${Object.entries(DELIVERY_STATUS_RANK)
    .map(([status, rank]) => `WHEN '${status}' THEN ${rank}`).join(' ')} ELSE 0 END`;

const updateDeliveryStatus = async (messageId, deliveryStatus) => {
    if (!messageId || !DELIVERY_STATUS_RANK[deliveryStatus]) return null;
    const d = await getDb();
    const deliveredAt = deliveryStatus === 'server_ack' ? null : now();
    d.run(
        `UPDATE campaign_recipients
         SET delivery_status = ?, delivered_at = COALESCE(delivered_at, ?), updated_at = ?
         WHERE message_id = ? AND ${DELIVERY_STATUS_RANK_SQL} < ?`,
        [deliveryStatus, deliveredAt, now(), String(messageId), DELIVERY_STATUS_RANK[deliveryStatus]]
    );
    save();
    return queryOne(d, 'SELECT campaign_run_id, normalized_phone, delivery_status FROM campaign_recipients WHERE message_id = ?', [String(messageId)]);
};

function getCampaignRunStatusWithDb(d, campaignId, ownerEmail = null, tenantId = null) {
    if (ownerEmail) ensureCampaignOwner(d, campaignId, ownerEmail, tenantId);
    if (!ownerEmail && tenantId) {
        const row = queryOne(d, 'SELECT tenant_id FROM campaign_runs WHERE id = ?', [campaignId]);
        if (!row) return null;
        if (row.tenant_id !== resolveTenantId(tenantId)) throw new DbError('Bu kampanyaya erişim yetkiniz yok', 403, 'CAMPAIGN_FORBIDDEN');
    }
    const run = applyCampaignRecipientSummary(d, mapCampaignRun(queryOne(d, 'SELECT * FROM campaign_runs WHERE id = ?', [campaignId])));
    if (!run) return null;
    run.logs = queryAll(d, `
        SELECT id, type, message, progress, metadata, created_at
        FROM campaign_logs
        WHERE campaign_run_id = ?
        ORDER BY id DESC
        LIMIT 300
    `, [campaignId]).reverse().map(mapCampaignLog);
    return run;
}

const getCampaignRunStatus = async (campaignId, ownerEmail = null, tenantId = null) => {
    const d = await getDb();
    return getCampaignRunStatusWithDb(d, campaignId, ownerEmail, tenantId);
};

const getLatestCampaignRunStatus = async (ownerEmail = null, tenantId = null) => {
    const d = await getDb();
    if (!ownerEmail) {
        const params = [];
        let where = '';
        if (tenantId) {
            where = 'WHERE tenant_id = ?';
            params.push(resolveTenantId(tenantId));
        }
        const row = queryOne(d, `SELECT id FROM campaign_runs ${where} ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC LIMIT 1`, params);
        return row ? getCampaignRunStatusWithDb(d, row.id) : null;
    }

    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = queryOne(d, `
        SELECT id FROM campaign_runs
        WHERE tenant_id = ? AND owner_email = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
    `, [tenant, owner]);
    return row ? getCampaignRunStatusWithDb(d, row.id, owner, tenant) : null;
};

const getDueBatchPauseCampaignRuns = async (asOf = new Date()) => {
    const d = await getDb();
    const cutoff = asOf instanceof Date ? asOf.toISOString() : String(asOf || now());
    const rows = queryAll(d, `
        SELECT * FROM campaign_runs
        WHERE status = 'running'
          AND pause_reason IN ('batch_pause', 'long_pause', 'night_pause')
          AND pause_until IS NOT NULL
          AND pause_until != ''
          AND pause_until <= ?
        ORDER BY pause_until ASC
    `, [cutoff]);
    return rows.map(row => applyCampaignRecipientSummary(d, mapCampaignRun(row)));
};

const stopLatestRunningCampaign = async (ownerEmail, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = queryOne(d, `
        SELECT id, pause_until, pause_reason FROM campaign_runs
        WHERE tenant_id = ? AND owner_email = ? AND status IN ('queued', 'running', 'paused')
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
    `, [tenant, owner]);
    if (!row) return null;
    const current = now();
    const preserveTimedPause = shouldPreserveTimedPause(row, current);
    const pauseFields = preserveTimedPause ? '' : 'pause_until = NULL, pause_reason = NULL,';
    d.run(`UPDATE campaign_runs
        SET status = ?, stopped_at = ?, ${pauseFields}
            wait_until = NULL, current_recipient_name = NULL, current_recipient_phone = NULL, updated_at = ?
        WHERE id = ?`, ['stopped', current, current, row.id]);
    return getCampaignRunStatusWithDb(d, row.id, owner, tenant);
});

const stopCampaignRun = async (campaignId, ownerEmail, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, owner, tenant);
    if (!['queued', 'running', 'paused'].includes(row.status)) {
        return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
    }

    const current = now();
    const preserveTimedPause = shouldPreserveTimedPause(row, current);
    const pauseFields = preserveTimedPause ? '' : 'pause_until = NULL, pause_reason = NULL,';
    d.run(`UPDATE campaign_runs
        SET status = ?, stopped_at = ?, ${pauseFields}
            wait_until = NULL, current_recipient_name = NULL, current_recipient_phone = NULL, updated_at = ?
        WHERE id = ?`, ['stopped', current, current, campaignId]);
    return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
});

const finishCampaignRun = async (campaignId, ownerEmail, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, owner, tenant);
    if (row.status === STATUS_CAMPAIGN_FINISHED) {
        return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
    }

    const current = now();
    d.run(`
        UPDATE campaign_runs
        SET status = ?,
            stopped_at = COALESCE(stopped_at, ?),
            finished_at = ?,
            pause_until = NULL,
            pause_reason = NULL,
            wait_until = NULL,
            current_recipient_name = NULL,
            current_recipient_phone = NULL,
            error = NULL,
            updated_at = ?
        WHERE id = ?
    `, [STATUS_CAMPAIGN_FINISHED, current, current, current, campaignId]);
    return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
});

const getCampaignRecipientsForRun = async (campaignId, ownerEmail, statuses = [], tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    ensureCampaignOwner(d, campaignId, ownerEmail, tenantId);
    const statusList = Array.isArray(statuses) ? statuses.filter(Boolean).map(String) : [];
    const params = [campaignId];
    let where = 'WHERE campaign_run_id = ?';
    if (statusList.length > 0) {
        where += ` AND status IN (${statusList.map(() => '?').join(', ')})`;
        params.push(...statusList);
    }

    return queryAll(d, `
        SELECT contact_id, phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at
        FROM campaign_recipients
        ${where}
        ORDER BY id ASC
    `, params).map(mapCampaignRecipient);
};

const getCampaignRecipientsForRestart = async (campaignId, ownerEmail, mode, tenantId = DEFAULT_TENANT_ID, options = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, ownerEmail, tenant);
    assertCampaignRestartable(row);
    if (!['resume', 'retry'].includes(mode)) throw new DbError('Geçersiz kampanya yeniden başlatma modu', 400, 'CAMPAIGN_RESTART_MODE_INVALID');

    const firstPassPending = hasUnattemptedPendingRecipientsWithDb(d, campaignId, tenant);
    if (mode === 'resume') {
        if (firstPassPending) {
            return queryAll(d, `
                SELECT contact_id, phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at
                FROM campaign_recipients
                WHERE campaign_run_id = ?
                  AND tenant_id = ?
                  AND status = 'pending'
                  AND attempt_count = 0
                ORDER BY id ASC
            `, [campaignId, tenant]).map(mapCampaignRecipient);
        }

        return queryAll(d, `
            SELECT contact_id, phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at
            FROM campaign_recipients
            WHERE campaign_run_id = ?
              AND tenant_id = ?
              AND status = 'pending'
            ORDER BY id ASC
        `, [campaignId, tenant]).map(mapCampaignRecipient);
    }

    if (firstPassPending) return [];

    const statuses = ['pending', ...TEMPORARY_RETRY_STATUSES];

    return queryAll(d, `
        SELECT contact_id, phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND status IN (${statuses.map(() => '?').join(', ')})
          AND (
              status != 'pending'
              OR attempt_count > 0
          )
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id ASC
    `, [campaignId, tenant, ...statuses]).map(mapCampaignRecipient);
};

const getRetryableSkippedCampaignRecipients = async (campaignId, ownerEmail, tenantId = DEFAULT_TENANT_ID, options = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, ownerEmail, tenant);
    assertCampaignRestartable(row);
    if (hasUnattemptedPendingRecipientsWithDb(d, campaignId, tenant)) return [];

    const cooldownMs = Number.parseInt(options.cooldownMs, 10);
    const resolvedCooldownMs = Number.isFinite(cooldownMs) && cooldownMs > 0
        ? cooldownMs
        : DEFAULT_RECIPIENT_COOLDOWN_MS;
    const asOfMs = options.asOf instanceof Date
        ? options.asOf.getTime()
        : Number.parseInt(options.asOfMs ?? Date.now(), 10);
    const resolvedAsOfMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();

    const rows = queryAll(d, `
        SELECT
            cr.contact_id,
            cr.phone,
            cr.normalized_phone,
            cr.name,
            cr.surname,
            cr.status,
            cr.attempt_count,
            cr.last_error,
            cr.last_attempted_at,
            cr.next_retry_at,
            rh.last_sent_at AS cooldown_last_sent_at
        FROM campaign_recipients cr
        LEFT JOIN recipient_history rh
          ON rh.tenant_id = cr.tenant_id
         AND rh.normalized_phone = cr.normalized_phone
        WHERE cr.campaign_run_id = ?
          AND cr.tenant_id = ?
          AND cr.status IN (${SKIPPED_RETRY_STATUSES.map(() => '?').join(', ')})
        ORDER BY cr.id ASC
    `, [campaignId, tenant, ...SKIPPED_RETRY_STATUSES]);

    return rows
        .filter(row => {
            if (!isRetryDue(row, resolvedAsOfMs)) return false;
            if (row.status !== 'skipped_cooldown') return true;
            const lastSentAt = new Date(row.cooldown_last_sent_at || '').getTime();
            if (!Number.isFinite(lastSentAt)) return true;
            return resolvedAsOfMs - lastSentAt >= resolvedCooldownMs;
        })
        .map(mapCampaignRecipient);
};

function queueCampaignRunForRestart(d, row, campaignId, current) {
    const counts = queryOne(d, `
        SELECT
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM campaign_recipients
        WHERE campaign_run_id = ?
    `, [campaignId]);

    const currentTimedPauseStillActive = shouldPreserveTimedPause(row, current);
    const pauseResetFields = currentTimedPauseStillActive
        ? ''
        : 'pause_until = NULL, pause_reason = NULL,';

    d.run(`
        UPDATE campaign_runs
        SET status = 'queued',
            sent_count = ?,
            failed_count = ?,
            stopped_at = NULL,
            completed_at = NULL,
            error = NULL,
            ${pauseResetFields}
            wait_until = NULL,
            current_recipient_name = NULL,
            current_recipient_phone = NULL,
            updated_at = ?
        WHERE id = ?
    `, [
        Number(counts?.sent_count || 0),
        Number(counts?.failed_count || 0),
        current,
        campaignId
    ]);
}

const prepareCampaignRunForRestart = async (campaignId, ownerEmail, mode, tenantId = DEFAULT_TENANT_ID, options = {}) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, owner, tenant);
    assertCampaignRestartable(row);
    if (row.status === 'running') throw new DbError('Çalışan kampanya yeniden başlatılamaz', 409, 'CAMPAIGN_ALREADY_RUNNING');
    if (!['resume', 'retry'].includes(mode)) throw new DbError('Geçersiz kampanya yeniden başlatma modu', 400, 'CAMPAIGN_RESTART_MODE_INVALID');
    assertNoActiveCampaign(d, owner, tenant, campaignId);

    const current = resolveAsOfIso(options);
    const firstPassPending = hasUnattemptedPendingRecipientsWithDb(d, campaignId, tenant);
    if (firstPassPending && mode === 'retry') {
        throw new DbError('Önce hiç denenmemiş bekleyen numaralar tamamlanmalı', 400, 'CAMPAIGN_FIRST_PASS_PENDING');
    }

    const restartStatuses = mode === 'retry' ? TEMPORARY_RETRY_STATUSES : [];
    if (restartStatuses.length > 0) {
        d.run(`
            UPDATE campaign_recipients
            SET status = 'pending',
                last_error = NULL,
                sent_at = NULL,
                next_retry_at = NULL,
                updated_at = ?
            WHERE campaign_run_id = ?
              AND tenant_id = ?
              AND status IN (${restartStatuses.map(() => '?').join(', ')})
        `, [current, campaignId, tenant, ...restartStatuses]);
    }

    queueCampaignRunForRestart(d, row, campaignId, current);

    return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
});

const prepareSkippedCampaignRunForRetry = async (campaignId, ownerEmail, recipients = [], tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, owner, tenant);
    assertCampaignRestartable(row);
    if (row.status === 'running') throw new DbError('Çalışan kampanya yeniden başlatılamaz', 409, 'CAMPAIGN_ALREADY_RUNNING');
    assertNoActiveCampaign(d, owner, tenant, campaignId);
    if (hasUnattemptedPendingRecipientsWithDb(d, campaignId, tenant)) {
        throw new DbError('Önce hiç denenmemiş bekleyen numaralar tamamlanmalı', 400, 'CAMPAIGN_FIRST_PASS_PENDING');
    }

    const normalizedPhones = Array.from(new Set(
        (Array.isArray(recipients) ? recipients : [])
            .map(contact => normalizePhone(contact?.normalized_phone || contact?.phone))
            .filter(isValidPhone)
    ));
    if (normalizedPhones.length === 0) throw new DbError('Tekrar denenecek atlanan kişi yok', 400, 'CAMPAIGN_RETRY_SKIPPED_EMPTY');

    const current = now();
    const result = d.run(`
        UPDATE campaign_recipients
        SET status = 'pending', last_error = NULL, sent_at = NULL, next_retry_at = NULL, updated_at = ?
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND normalized_phone IN (${normalizedPhones.map(() => '?').join(', ')})
          AND status IN (${SKIPPED_RETRY_STATUSES.map(() => '?').join(', ')})
          AND (
              next_retry_at IS NULL
              OR next_retry_at = ''
              OR next_retry_at <= ?
          )
    `, [current, campaignId, tenant, ...normalizedPhones, ...SKIPPED_RETRY_STATUSES, current]);
    if (Number(result?.changes || 0) === 0) throw new DbError('Tekrar denenecek atlanan kişi yok', 400, 'CAMPAIGN_RETRY_SKIPPED_EMPTY');

    queueCampaignRunForRestart(d, row, campaignId, current);

    return getCampaignRunStatusWithDb(d, campaignId, owner, tenant);
});

function mapAuditLog(row) {
    let metadata = {};
    try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch (_) {
        metadata = {};
    }

    return {
        id: row.id,
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id || '',
        metadata,
        created_at: row.created_at
    };
}

function normalizeAuditOptions(options = {}) {
    const rawLimit = Number.parseInt(options.limit, 10);
    const rawOffset = Number.parseInt(options.offset, 10);
    const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    return {
        limit,
        offset,
        action: cleanText(options.action || ''),
        entityType: cleanText(options.entityType || options.entity_type || ''),
        entityId: cleanText(options.entityId || options.entity_id || ''),
        from: cleanText(options.from || ''),
        to: cleanText(options.to || '')
    };
}

function appendAuditFilter(where, params, column, value) {
    if (!value) return;
    where.push(`${column} = ?`);
    params.push(value);
}

const addAuditLog = async (action, entityType, entityId, metadata = {}, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    audit(d, cleanText(action), cleanText(entityType), entityId, metadata, tenantId);
    return { success: true };
});

const getAuditLogs = async (options = {}, tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const normalized = normalizeAuditOptions(options);
    const where = ['tenant_id = ?'];
    const params = [tenant];

    appendAuditFilter(where, params, 'action', normalized.action);
    appendAuditFilter(where, params, 'entity_type', normalized.entityType);
    appendAuditFilter(where, params, 'entity_id', normalized.entityId);
    if (normalized.from) {
        where.push('created_at >= ?');
        params.push(normalized.from);
    }
    if (normalized.to) {
        where.push('created_at <= ?');
        params.push(normalized.to);
    }

    const whereSql = where.join(' AND ');
    const totalRow = queryOne(d, `SELECT COUNT(*) AS total FROM audit_logs WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const rows = queryAll(d, `
        SELECT id, tenant_id, action, entity_type, entity_id, metadata, created_at
        FROM audit_logs
        WHERE ${whereSql}
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ? OFFSET ?
    `, [...params, normalized.limit, normalized.offset]).map(mapAuditLog);

    return {
        logs: rows,
        pagination: {
            total,
            limit: normalized.limit,
            offset: normalized.offset,
            returned: rows.length,
            has_more: normalized.offset + rows.length < total,
            next_offset: normalized.offset + rows.length < total ? normalized.offset + rows.length : null
        },
        filters: {
            action: normalized.action || null,
            entity_type: normalized.entityType || null,
            entity_id: normalized.entityId || null,
            from: normalized.from || null,
            to: normalized.to || null
        }
    };
};

const purgeExpiredAuditLogs = async (retentionDays, tenantId = null) => {
    const days = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: null, enabled: false };

    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    return withWriteTransaction(null, (d) => {
        const params = [cutoff];
        let where = 'created_at < ?';
        if (tenantId) {
            where += ' AND tenant_id = ?';
            params.push(resolveTenantId(tenantId));
        }
        const result = d.run(`DELETE FROM audit_logs WHERE ${where}`, params);
        return {
            deleted: Number(result?.changes || 0),
            cutoff,
            enabled: true
        };
    });
};

const purgeCampaignLogs = async (retentionDays) => {
    const days = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: null, enabled: false };
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    return withWriteTransaction(null, (d) => {
        const result = d.run(
            `DELETE FROM campaign_logs WHERE created_at < ?
             AND campaign_run_id IN (
                 SELECT id FROM campaign_runs WHERE status IN ('completed','stopped','paused','finished') AND updated_at < ?
             )`,
            [cutoff, cutoff]
        );
        return { deleted: Number(result?.changes || 0), cutoff, enabled: true };
    });
};

const purgeCampaignRuns = async (retentionDays) => {
    const days = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: null, enabled: false };
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    return withWriteTransaction(null, (d) => {
        // campaign_recipients ve campaign_logs CASCADE ile silinir
        const result = d.run(
            `DELETE FROM campaign_runs WHERE status IN ('completed','stopped','paused','finished') AND updated_at < ?`,
            [cutoff]
        );
        return { deleted: Number(result?.changes || 0), cutoff, enabled: true };
    });
};

const purgeDailySendStats = async (retentionDays) => {
    const days = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: null, enabled: false };
    const cutoffDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    return withWriteTransaction(null, (d) => {
        const result = d.run(`DELETE FROM daily_send_stats WHERE send_date < ?`, [cutoffDate]);
        return { deleted: Number(result?.changes || 0), cutoff: cutoffDate, enabled: true };
    });
};

const addSystemEvent = async (tenantId, eventType, severity, message, metadata = {}) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    d.run(
        'INSERT INTO system_events (tenant_id, event_type, severity, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [tenant, String(eventType), String(severity || 'info'), String(message || ''), toSqlJson(metadata), now()]
    );
});

const getSystemEvents = async (tenantId, { limit = 100, offset = 0, eventType = null, severity = null } = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const params = [tenant];
    let where = 'WHERE tenant_id = ?';
    if (eventType) { where += ' AND event_type = ?'; params.push(eventType); }
    if (severity) { where += ' AND severity = ?'; params.push(severity); }
    params.push(Math.max(1, Number.parseInt(limit, 10) || 100));
    params.push(Math.max(0, Number.parseInt(offset, 10) || 0));
    const rows = queryAll(d, `SELECT id, tenant_id, event_type, severity, message, metadata, created_at FROM system_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
    return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
};

const purgeSystemEvents = async (retentionDays) => {
    const days = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: null, enabled: false };
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    return withWriteTransaction(null, (d) => {
        const result = d.run('DELETE FROM system_events WHERE created_at < ?', [cutoff]);
        return { deleted: Number(result?.changes || 0), cutoff, enabled: true };
    });
};

const getCampaignReport = async (campaignId, tenantId) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const run = mapCampaignRun(queryOne(d, 'SELECT * FROM campaign_runs WHERE id = ? AND tenant_id = ?', [campaignId, tenant]));
    if (!run) return null;

    const recipientStats = queryAll(d,
        'SELECT status, COUNT(*) as count FROM campaign_recipients WHERE campaign_run_id = ? GROUP BY status',
        [campaignId]
    ).reduce((acc, row) => { acc[row.status] = Number(row.count); return acc; }, {});

    const failedRecipients = queryAll(d,
        "SELECT phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at, updated_at FROM campaign_recipients WHERE campaign_run_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 50",
        [campaignId]
    );

    const unsentRecipients = queryAll(d, `
        SELECT phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at, updated_at
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND (
              status IN ('failed', 'validation_unknown')
              OR (status = 'pending' AND attempt_count > 0)
          )
        ORDER BY datetime(COALESCE(last_attempted_at, updated_at)) DESC, id DESC
    `, [campaignId, tenant]).map(row => ({
        ...row,
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || normalizePhone(row.phone),
        name: row.name || '',
        surname: row.surname || '',
        attempt_count: Number(row.attempt_count || 0),
        last_error: row.last_error || ''
    }));

    const unavailableRecipients = queryAll(d, `
        SELECT phone, normalized_phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at, updated_at
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND status = ?
        ORDER BY datetime(updated_at) DESC, id DESC
    `, [campaignId, tenant, STATUS_NOT_ON_WHATSAPP]).map(row => ({
        ...row,
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || normalizePhone(row.phone),
        name: row.name || '',
        surname: row.surname || '',
        attempt_count: Number(row.attempt_count || 0),
        last_error: row.last_error || 'WhatsApp kullanıcısı değil'
    }));

    const sentRecipients = queryAll(d, `
        SELECT phone, normalized_phone, name, surname, status, attempt_count, sent_at, updated_at
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND tenant_id = ?
          AND status = 'sent'
        ORDER BY datetime(COALESCE(sent_at, updated_at)) DESC, id DESC
    `, [campaignId, tenant]).map(row => ({
        ...row,
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || normalizePhone(row.phone),
        name: row.name || '',
        surname: row.surname || '',
        attempt_count: Number(row.attempt_count || 0)
    }));

    const skippedRecipients = queryAll(d, `
        SELECT phone, name, surname, status, attempt_count, last_error, last_attempted_at, next_retry_at, updated_at
        FROM campaign_recipients
        WHERE campaign_run_id = ?
          AND status IN ('skipped', 'skipped_cooldown', 'not_on_whatsapp', 'validation_unknown', 'suppressed')
        ORDER BY updated_at DESC
        LIMIT 200
    `, [campaignId]);

    const logs = queryAll(d,
        'SELECT id, type, message, progress, metadata, created_at FROM campaign_logs WHERE campaign_run_id = ? ORDER BY id DESC LIMIT 500',
        [campaignId]
    ).reverse().map(mapCampaignLog);

    return {
        run,
        recipient_stats: recipientStats,
        failed_recipients: failedRecipients,
        skipped_recipients: skippedRecipients,
        unsent_recipients: unsentRecipients,
        unavailable_recipients: unavailableRecipients,
        sent_recipients: sentRecipients,
        logs
    };
};

const getCampaignSummary = async (tenantId) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);

    const totals = queryOne(d, `
        SELECT
            COUNT(*) as total_campaigns,
            COALESCE(SUM(sent_count), 0) as total_sent,
            COALESCE(SUM(failed_count), 0) as total_failed,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
            SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) as stopped
        FROM campaign_runs WHERE tenant_id = ?
    `, [tenant]);

    const recent = queryAll(d, `
        SELECT id, status, sent_count, failed_count, total_count, owner_email, created_at, updated_at
        FROM campaign_runs WHERE tenant_id = ?
        ORDER BY datetime(updated_at) DESC LIMIT 10
    `, [tenant]).map(row => ({
        id: row.id,
        status: row.status,
        sent_count: Number(row.sent_count || 0),
        failed_count: Number(row.failed_count || 0),
        total_count: Number(row.total_count || 0),
        owner_email: row.owner_email,
        created_at: row.created_at,
        updated_at: row.updated_at
    }));

    return {
        total_campaigns: Number(totals?.total_campaigns || 0),
        total_sent: Number(totals?.total_sent || 0),
        total_failed: Number(totals?.total_failed || 0),
        by_status: {
            completed: Number(totals?.completed || 0),
            running: Number(totals?.running || 0),
            paused: Number(totals?.paused || 0),
            stopped: Number(totals?.stopped || 0)
        },
        recent_campaigns: recent
    };
};

const recordUnavailableWhatsAppRecipient = async (contact, tenantId = DEFAULT_TENANT_ID, metadata = {}) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    return upsertUnavailableWhatsAppRecipientWithDb(d, {
        tenantId: tenant,
        normalizedPhone: contact?.normalized_phone || contact?.phone,
        contact,
        reason: metadata.reason || 'WhatsApp kullanıcısı değil',
        campaignId: metadata.campaignId || null,
        detectedAt: metadata.detectedAt || now()
    });
});

const getUnavailableWhatsAppRecipient = async (phone, tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return null;
    return mapUnavailableWhatsAppRecipient(queryOne(d, `
        SELECT *
        FROM unavailable_whatsapp_recipients
        WHERE tenant_id = ? AND normalized_phone = ?
    `, [tenant, normalizedPhone]));
};

const isUnavailableWhatsAppRecipient = async (phone, tenantId = DEFAULT_TENANT_ID) => {
    const recipient = await getUnavailableWhatsAppRecipient(phone, tenantId);
    return !!recipient;
};

const getUnavailableWhatsAppRecipients = async (tenantId = DEFAULT_TENANT_ID, options = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit, 10) || 200));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    return queryAll(d, `
        SELECT *
        FROM unavailable_whatsapp_recipients
        WHERE tenant_id = ?
        ORDER BY datetime(last_detected_at) DESC, normalized_phone ASC
        LIMIT ? OFFSET ?
    `, [tenant, limit, offset]).map(mapUnavailableWhatsAppRecipient);
};

const FAILED_REPORT_STATUSES = ['failed', 'validation_unknown'];

function normalizeRecipientReportOptions(options = {}) {
    const rawLimit = Number.parseInt(options.limit, 10);
    const rawOffset = Number.parseInt(options.offset, 10);
    return {
        limit: Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100)),
        offset: Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0),
        search: cleanText(options.search || '')
    };
}

const getFailedCampaignRecipients = async (tenantId = DEFAULT_TENANT_ID, options = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const { limit, offset, search } = normalizeRecipientReportOptions(options);
    const where = [
        'cr.tenant_id = ?',
        `cr.status IN (${FAILED_REPORT_STATUSES.map(() => '?').join(', ')})`
    ];
    const params = [tenant, ...FAILED_REPORT_STATUSES];

    if (search) {
        const like = `%${search}%`;
        where.push('(cr.normalized_phone LIKE ? OR cr.phone LIKE ? OR cr.name LIKE ? OR cr.surname LIKE ? OR cr.last_error LIKE ?)');
        params.push(like, like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const rows = queryAll(d, `
        SELECT
            cr.campaign_run_id,
            cr.phone,
            cr.normalized_phone,
            cr.name,
            cr.surname,
            cr.status,
            cr.attempt_count,
            cr.last_error,
            cr.last_attempted_at,
            cr.next_retry_at,
            cr.updated_at,
            run.status AS campaign_status,
            run.created_at AS campaign_created_at,
            run.updated_at AS campaign_updated_at
        FROM campaign_recipients cr
        LEFT JOIN campaign_runs run
          ON run.id = cr.campaign_run_id
         AND run.tenant_id = cr.tenant_id
        WHERE ${whereSql}
        ORDER BY datetime(cr.updated_at) DESC, cr.id DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]).map(row => ({
        campaign_run_id: row.campaign_run_id,
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || normalizePhone(row.phone),
        name: row.name || '',
        surname: row.surname || '',
        status: row.status,
        attempt_count: Number(row.attempt_count || 0),
        last_error: row.last_error || '',
        last_attempted_at: row.last_attempted_at || null,
        next_retry_at: row.next_retry_at || null,
        updated_at: row.updated_at,
        campaign_status: row.campaign_status || null,
        campaign_created_at: row.campaign_created_at || null,
        campaign_updated_at: row.campaign_updated_at || null
    }));

    const totalRow = queryOne(d, `
        SELECT COUNT(*) AS total
        FROM campaign_recipients cr
        WHERE ${whereSql}
    `, params);

    return {
        recipients: rows,
        total: Number(totalRow?.total || 0),
        limit,
        offset,
        has_more: offset + rows.length < Number(totalRow?.total || 0)
    };
};

const suppressRecipients = async (contactsList = [], tenantId = DEFAULT_TENANT_ID, options = {}) => withWriteTransaction('suppress-recipients', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const { contacts, summary } = normalizeContactsDetailed(contactsList);
    if (contacts.length === 0) throw new DbError('Gönderim dışı bırakılacak geçerli telefon yok', 400, 'SUPPRESSED_RECIPIENTS_EMPTY');

    const current = now();
    const recipients = contacts
        .map(contact => upsertSuppressedRecipientWithDb(d, {
            tenantId: tenant,
            normalizedPhone: contact.normalized_phone,
            contact,
            reason: options.reason || 'Manuel olarak gönderim dışı bırakıldı',
            source: options.source || 'manual',
            suppressedAt: current
        }))
        .filter(Boolean);
    const recipientPhones = recipients.map(recipient => recipient.normalized_phone);
    const suppressibleStatuses = ['pending', 'failed', 'validation_unknown', 'skipped', 'skipped_cooldown'];
    let affectedCampaignRecipients = 0;

    for (let i = 0; i < recipientPhones.length; i += 500) {
        const chunk = recipientPhones.slice(i, i + 500);
        if (chunk.length === 0) continue;
        const result = d.run(`
            UPDATE campaign_recipients
            SET status = ?,
                last_error = ?,
                next_retry_at = NULL,
                updated_at = ?
            WHERE tenant_id = ?
              AND normalized_phone IN (${chunk.map(() => '?').join(', ')})
              AND status IN (${suppressibleStatuses.map(() => '?').join(', ')})
              AND campaign_run_id IN (
                  SELECT id
                  FROM campaign_runs
                  WHERE tenant_id = ?
                    AND status IN ('queued', 'running', 'paused', 'stopped')
              )
        `, [
            STATUS_SUPPRESSED,
            options.reason || 'Manuel olarak gönderim dışı bırakıldı',
            current,
            tenant,
            ...chunk,
            ...suppressibleStatuses,
            tenant
        ]);
        affectedCampaignRecipients += Number(result?.changes || 0);
    }

    audit(d, 'recipients_suppressed', 'suppressed_recipient', 'bulk', {
        count: recipients.length,
        affected_campaign_recipients: affectedCampaignRecipients,
        phones: recipientPhones
    }, tenant);

    return {
        recipients,
        summary: {
            ...summary,
            saved: recipients.length,
            affected_campaign_recipients: affectedCampaignRecipients
        }
    };
});

const unsuppressRecipients = async (phones = [], tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('unsuppress-recipients', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const normalizedPhones = Array.from(new Set(
        (Array.isArray(phones) ? phones : [])
            .map(normalizePhone)
            .filter(isValidPhone)
    ));
    if (normalizedPhones.length === 0) throw new DbError('Gönderime geri alınacak geçerli telefon yok', 400, 'SUPPRESSED_RECIPIENTS_EMPTY');

    const current = now();
    const result = d.run(`
        UPDATE suppressed_recipients
        SET active = 0,
            unsuppressed_at = ?,
            updated_at = ?
        WHERE tenant_id = ?
          AND active = 1
          AND normalized_phone IN (${normalizedPhones.map(() => '?').join(', ')})
    `, [current, current, tenant, ...normalizedPhones]);

    audit(d, 'recipients_unsuppressed', 'suppressed_recipient', 'bulk', {
        count: Number(result?.changes || 0),
        phones: normalizedPhones
    }, tenant);

    return { success: true, removed: Number(result?.changes || 0) };
});

const getSuppressedRecipient = async (phone, tenantId = DEFAULT_TENANT_ID) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return null;
    return mapSuppressedRecipient(queryOne(d, `
        SELECT *
        FROM suppressed_recipients
        WHERE tenant_id = ? AND normalized_phone = ? AND active = 1
    `, [tenant, normalizedPhone]));
};

const isSuppressedRecipient = async (phone, tenantId = DEFAULT_TENANT_ID) => {
    const recipient = await getSuppressedRecipient(phone, tenantId);
    return !!recipient;
};

const getSuppressedRecipients = async (tenantId = DEFAULT_TENANT_ID, options = {}) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit, 10) || 200));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const includeInactive = options.active === 'all';
    const active = options.active === false || options.active === 'false' ? 0 : 1;
    const params = [tenant];
    let activeSql = '';
    if (!includeInactive) {
        activeSql = 'AND active = ?';
        params.push(active);
    }
    params.push(limit, offset);

    return queryAll(d, `
        SELECT *
        FROM suppressed_recipients
        WHERE tenant_id = ?
          ${activeSql}
        ORDER BY datetime(updated_at) DESC, normalized_phone ASC
        LIMIT ? OFFSET ?
    `, params).map(mapSuppressedRecipient);
};

const getDailySendCount = async (tenantId = DEFAULT_TENANT_ID, date = businessDate()) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const row = queryOne(d, 'SELECT count FROM daily_send_stats WHERE tenant_id = ? AND send_date = ?', [tenant, String(date)]);
    return Number(row?.count || 0);
};

const isRecipientInCooldown = async (phone, tenantId = DEFAULT_TENANT_ID, cooldownMs = 24 * 60 * 60 * 1000) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return false;
    const row = queryOne(d, 'SELECT last_sent_at FROM recipient_history WHERE tenant_id = ? AND normalized_phone = ?', [tenant, normalizedPhone]);
    if (!row?.last_sent_at) return false;
    const lastSentAt = new Date(row.last_sent_at).getTime();
    if (!Number.isFinite(lastSentAt)) return false;
    return Date.now() - lastSentAt < cooldownMs;
};

const getRecipientCooldownExpiresAt = async (phone, tenantId = DEFAULT_TENANT_ID, cooldownMs = 24 * 60 * 60 * 1000) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return null;
    const row = queryOne(d, 'SELECT last_sent_at FROM recipient_history WHERE tenant_id = ? AND normalized_phone = ?', [tenant, normalizedPhone]);
    if (!row?.last_sent_at) return null;
    const lastSentAt = new Date(row.last_sent_at).getTime();
    if (!Number.isFinite(lastSentAt)) return null;
    return new Date(lastSentAt + cooldownMs);
};

const checkCooldownWithMessage = async (contacts, messageHash, tenantId = DEFAULT_TENANT_ID, cooldownMs = 24 * 60 * 60 * 1000) => {
    const d = await getDb();
    const tenant = resolveTenantId(tenantId);
    const now = Date.now();
    const sameMessage = [];
    const differentMessage = [];

    for (const contact of contacts) {
        const rawPhone = String(contact.phone || '').replace(/[^0-9]/g, '');
        const normalizedPhone = normalizePhone(rawPhone);
        if (!isValidPhone(normalizedPhone)) continue;
        const row = queryOne(d, 'SELECT last_sent_at, last_message_hash FROM recipient_history WHERE tenant_id = ? AND normalized_phone = ?', [tenant, normalizedPhone]);
        if (!row?.last_sent_at) continue;
        const lastSentAt = new Date(row.last_sent_at).getTime();
        if (!Number.isFinite(lastSentAt) || now - lastSentAt >= cooldownMs) continue;
        const expiresAt = new Date(lastSentAt + cooldownMs);
        const entry = { name: contact.name || '', phone: contact.phone, normalizedPhone, expiresAt };
        if (row.last_message_hash && row.last_message_hash === messageHash) {
            sameMessage.push(entry);
        } else {
            differentMessage.push(entry);
        }
    }

    return { sameMessage, differentMessage };
};

function recordRecipientSendWithDb(d, phone, tenantId = DEFAULT_TENANT_ID, sentAt = new Date(), messageHash = null) {
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return { recorded: false };

    const current = sentAt instanceof Date ? sentAt : new Date(sentAt);
    const currentIso = current.toISOString();
    const date = businessDate(current);

    d.run(`
        INSERT INTO recipient_history (tenant_id, normalized_phone, last_sent_at, last_message_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, normalized_phone)
        DO UPDATE SET last_sent_at = excluded.last_sent_at, last_message_hash = excluded.last_message_hash, updated_at = excluded.updated_at
    `, [tenant, normalizedPhone, currentIso, messageHash || null, currentIso, currentIso]);

    d.run(`
        INSERT INTO daily_send_stats (tenant_id, send_date, count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(tenant_id, send_date)
        DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
    `, [tenant, date, currentIso]);

    return { recorded: true, tenant_id: tenant, normalized_phone: normalizedPhone, send_date: date };
}

const recordRecipientSend = async (phone, tenantId = DEFAULT_TENANT_ID, sentAt = new Date(), messageHash = null) => withWriteTransaction(null, (d) => {
    return recordRecipientSendWithDb(d, phone, tenantId, sentAt, messageHash);
});

const recordCampaignRecipientResult = async (campaignId, result = {}) => withWriteTransaction(null, (d) => {
    let resolvedTenantId = result.tenantId ? resolveTenantId(result.tenantId) : null;
    const campaignTenantId = () => {
        if (!resolvedTenantId) resolvedTenantId = getCampaignTenantIdWithDb(d, campaignId);
        return resolvedTenantId;
    };
    const recipient = result.contact;

    if (result.messageId) {
        setRecipientMessageIdWithDb(d, campaignId, recipient?.phone || recipient?.normalized_phone, result.messageId);
    }
    if (result.sendLog?.phone) {
        recordRecipientSendWithDb(d, result.sendLog.phone, campaignTenantId(), new Date(), result.sendLog.msgHash);
    }
    if (result.status) {
        updateCampaignRecipientWithDb(d, campaignId, recipient, result.status, result.error, campaignTenantId());
    }
    if (result.runtimeState) {
        updateCampaignRuntimeStateWithDb(d, campaignId, result.runtimeState);
    }
    if (result.log) {
        addCampaignLogWithDb(
            d,
            campaignId,
            result.log.type,
            result.log.message,
            result.log.progress,
            result.log.metadata,
            campaignTenantId()
        );
    }
});

const cleanupRecipientHistory = async (tenantId = DEFAULT_TENANT_ID, retentionMs = 48 * 60 * 60 * 1000) => {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    return withWriteTransaction(null, (d) => {
        const result = d.run('DELETE FROM recipient_history WHERE tenant_id = ? AND last_sent_at < ?', [resolveTenantId(tenantId), cutoff]);
        return { deleted: Number(result?.changes || 0), cutoff };
    });
};

const getSession = async (sid) => {
    const d = await getDb();
    const row = queryOne(d, 'SELECT session_json, expires_at FROM app_sessions WHERE sid = ?', [String(sid)]);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
        await destroySession(sid);
        return null;
    }
    return JSON.parse(row.session_json);
};

const setSession = async (sid, sess, expiresAt) => withWriteTransaction(null, (d) => {
    const current = now();
    d.run(`
        INSERT INTO app_sessions (sid, session_json, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
            session_json = excluded.session_json,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
    `, [String(sid), JSON.stringify(sess || {}), Number(expiresAt), current, current]);
});

const touchSession = async (sid, sess, expiresAt) => withWriteTransaction(null, (d) => {
    const current = now();
    d.run('UPDATE app_sessions SET session_json = ?, expires_at = ?, updated_at = ? WHERE sid = ?', [
        JSON.stringify(sess || {}),
        Number(expiresAt),
        current,
        String(sid)
    ]);
});

const destroySession = async (sid) => withWriteTransaction(null, (d) => {
    d.run('DELETE FROM app_sessions WHERE sid = ?', [String(sid)]);
});

const pruneExpiredSessions = async (nowMs = Date.now()) => withWriteTransaction(null, (d) => {
    const result = d.run('DELETE FROM app_sessions WHERE expires_at <= ?', [Number(nowMs)]);
    return { deleted: Number(result?.changes || 0) };
});

const getUserByEmail = async (email) => {
    const d = await getDb();
    return queryOne(d, 'SELECT * FROM users WHERE email = ? AND status = ?', [cleanText(email), 'active']);
};

const createUser = async (tenantId, email, passwordHash, role, displayName) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const userEmail = cleanText(email);
    if (!userEmail) throw new DbError('Email zorunlu', 400, 'USER_EMAIL_REQUIRED');

    const existing = queryOne(d, 'SELECT id FROM users WHERE tenant_id = ? AND email = ?', [tenant, userEmail]);
    if (existing) throw new DbError('Bu email adresi zaten kullanımda', 409, 'DUPLICATE_USER_EMAIL');

    const userId = `${tenant}:${Date.now()}`;
    const current = now();

    d.run('INSERT INTO users (id, tenant_id, email, password_hash, role, status, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        userId,
        tenant,
        userEmail,
        passwordHash,
        role || 'user',
        'active',
        cleanText(displayName) || 'User',
        current,
        current
    ]);

    audit(d, 'user_created', 'user', userId, { email: userEmail, role }, tenant);
    return { id: userId, tenant_id: tenant, email: userEmail, role: role || 'user', status: 'active', display_name: displayName, created_at: current, updated_at: current };
});

const updateUserLastLogin = async (userId) => withWriteTransaction(null, (d) => {
    const current = now();
    d.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [current, current, userId]);
});

const getAllUsers = async () => {
    const d = await getDb();
    return queryAll(d, 'SELECT id, tenant_id, email, role, status, display_name, last_login_at, created_at FROM users ORDER BY created_at DESC');
};

const getUserCount = async () => {
    const d = await getDb();
    const row = queryOne(d, 'SELECT COUNT(*) as count FROM users');
    return Number(row?.count || 0);
};

const deleteUser = async (userId) => withWriteTransaction('delete-user', (d) => {
    // Note: Deleting a user does not delete the tenant data automatically
    d.run('DELETE FROM users WHERE id = ?', [userId]);
});

module.exports = {
    getDb,
    save,
    createBackup,
    requireSuccessfulBackup,
    resolveBackupRetentionCount,
    resolveBackupMinIntervalMs,
    getMigrationStatus,
    applyPendingMigrations,
    DEFAULT_TENANT_ID,
    STATUS_NOT_ON_WHATSAPP,
    STATUS_SUPPRESSED,
    STATUS_CAMPAIGN_FINISHED,
    normalizePhone,
    normalizeContact,
    normalizeContactsDetailed,
    createTenant,
    getGroups,
    getGroupContacts,
    getGroupContactsPage,
    getExportableContacts,
    createGroup,
    updateGroupContacts,
    deleteGroup,
    createContact,
    updateContact,
    deleteContact,
    getTemplates,
    createTemplate,
    createCampaignRun,
    setCampaignRunStatus,
    updateCampaignRuntimeState,
    updateCampaignMediaFiles,
    addCampaignLog,
    updateCampaignRecipient,
    recordCampaignRecipientResult,
    getCampaignRunStatus,
    getLatestCampaignRunStatus,
    getDueBatchPauseCampaignRuns,
    stopLatestRunningCampaign,
    stopCampaignRun,
    finishCampaignRun,
    getCampaignRecipientsForRun,
    getCampaignRecipientsForRestart,
    getRetryableSkippedCampaignRecipients,
    prepareCampaignRunForRestart,
    prepareSkippedCampaignRunForRetry,
    recordUnavailableWhatsAppRecipient,
    getUnavailableWhatsAppRecipient,
    isUnavailableWhatsAppRecipient,
    getUnavailableWhatsAppRecipients,
    getFailedCampaignRecipients,
    suppressRecipients,
    unsuppressRecipients,
    isSuppressedRecipient,
    getSuppressedRecipients,
    addAuditLog,
    getAuditLogs,
    purgeExpiredAuditLogs,
    safeAuditMetadata,
    getDailySendCount,
    isRecipientInCooldown,
    getRecipientCooldownExpiresAt,
    checkCooldownWithMessage,
    recordRecipientSend,
    __writeTransactionCountForTests: () => writeTransactionCountForTests,
    cleanupRecipientHistory,
    getSession,
    setSession,
    touchSession,
    destroySession,
    pruneExpiredSessions,
    getUserByEmail,
    createUser,
    updateUserLastLogin,
    getAllUsers,
    getUserCount,
    deleteUser,
    setRecipientMessageId,
    updateDeliveryStatus,
    purgeCampaignLogs,
    purgeCampaignRuns,
    purgeDailySendStats,
    addSystemEvent,
    getSystemEvents,
    purgeSystemEvents,
    getCampaignReport,
    getCampaignSummary
};
