const path = require('path');
const fs = require('fs-extra');
const initSqlJs = require('sql.js');
const { estimateRemainingSeconds, estimateRemainingMinutes } = require('./campaign_estimate');

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
let db = null;
let sqlModulePromise = null;

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

    checkpoint() {
        if (this.closed) return;
        fs.ensureDirSync(path.dirname(this.filePath));
        const tempFile = `${this.filePath}.tmp-${process.pid}`;
        fs.writeFileSync(tempFile, Buffer.from(this.raw.export()));
        fs.renameSync(tempFile, this.filePath);
        this.raw.run('PRAGMA foreign_keys = ON');
    }

    close() {
        if (this.closed) return;
        this.checkpoint();
        this.raw.close();
        this.closed = true;
    }
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
    let digits = String(value || '').replace(/[^\d]/g, '');
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

function normalizeContacts(list) {
    return normalizeContactsDetailed(list).contacts;
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

function cleanupBackups(keep = resolveBackupRetentionCount()) {
    const backups = fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sqlite'))
        .map(file => ({ file, fullPath: path.join(backupDir, file), stat: fs.statSync(path.join(backupDir, file)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    backups.slice(keep).forEach(item => fs.removeSync(item.fullPath));
}

function createBackup(reason = 'manual') {
    fs.ensureDirSync(backupDir);
    if (!fs.existsSync(dbFile)) return null;
    if (db) db.checkpoint();
    const backupFile = path.join(backupDir, `database-${timestampForFile()}-${sanitizeBackupReason(reason)}.sqlite`);
    fs.copyFileSync(dbFile, backupFile);
    cleanupBackups();
    return backupFile;
}

function requireSuccessfulBackup(reason) {
    if (!fs.existsSync(dbFile)) return null;
    const backupFile = createBackup(reason);
    if (!backupFile) {
        throw new DbError('Yazma işleminden önce veritabanı yedeği alınamadı', 500, 'DB_BACKUP_REQUIRED');
    }
    return backupFile;
}

function save() {
    if (db) db.checkpoint();
}

function queryAll(d, sql, params = []) {
    const stmt = d.prepare(sql);
    try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally {
        stmt.free();
    }
}

function queryOne(d, sql, params = []) {
    return queryAll(d, sql, params)[0] || null;
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

    const statusDb = await SqliteDatabaseAdapter.open(resolvedFile);
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

async function migrateJSONs() {
    const d = await getDb();
    return migrateJSONsWithDb(d);
}

async function getDb() {
    if (db) return db;

    db = await SqliteDatabaseAdapter.open(dbFile);

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
    if (reason) requireSuccessfulBackup(reason);
    const result = runInSqlTransaction(d, () => fn(d));
    save();
    return result;
}

// --- PUBLIC API ---

const getTenants = async () => {
    const d = await getDb();
    return queryAll(d, 'SELECT id, name, status, created_at, updated_at FROM tenants ORDER BY datetime(created_at) ASC, id ASC');
};

const createTenant = async (id, name) => withWriteTransaction('create-tenant', (d) => {
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
            COUNT(c.id) AS contact_count
        FROM groups g
        LEFT JOIN contacts c ON c.group_id = g.id AND c.deleted_at IS NULL
        WHERE g.tenant_id = ? AND g.deleted_at IS NULL
        GROUP BY g.id, g.tenant_id, g.name, g.created_at, g.updated_at
        ORDER BY datetime(g.created_at) DESC, g.name ASC
    `, [tenant]).map(group => ({
        ...group,
        contact_count: Number(group.contact_count || 0),
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

const createGroup = async (id, name, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('create-group', (d) => {
    const tenant = resolveTenantId(tenantId);
    ensureTenant(d, tenant);
    const groupName = cleanText(name);
    if (!groupName) throw new DbError('Grup adı zorunlu', 400, 'GROUP_NAME_REQUIRED');
    const normalized = ensureUniqueGroupName(d, groupName, tenant);
    const current = now();

    d.run('INSERT INTO groups (id, tenant_id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, tenant, groupName, normalized, current, current]);
    audit(d, 'group_created', 'group', id, { group_name: groupName }, tenant);
    return { id, tenant_id: tenant, name: groupName, created_at: current, updated_at: current, contact_count: 0, contacts: [] };
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

const createContact = async (groupId, input, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('create-contact', (d) => {
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

const updateContact = async (groupId, contactId, input, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction('update-contact', (d) => {
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
        started_at: row.started_at,
        stopped_at: row.stopped_at,
        completed_at: row.completed_at,
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
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
        FROM campaign_recipients
        WHERE campaign_run_id = ?
    `, [run.id]) || {};
    const pending = Number(row.pending_count || 0);
    const failed = Number(row.failed_count || 0);
    const skipped = Number(row.skipped_count || 0);
    const sent = Number(row.sent_count || run.sent_count || 0);
    const remaining = pending + failed;

    run.pending_count = pending;
    run.sent_count = sent;
    run.failed_count = failed;
    run.skipped_count = skipped;
    run.remaining_count = remaining;
    run.processed = sent + failed + skipped;
    run.progress = run.total > 0 ? Math.min(100, (run.processed / run.total) * 100) : 0;
    run.estimate_remaining_seconds = estimateRemainingSeconds({
        remaining,
        delay_min_ms: run.delay_min_ms,
        delay_max_ms: run.delay_max_ms,
        batchSize: run.metadata?.batch_size,
        batchPauseMinutes: run.metadata?.batch_pause_minutes
    });
    run.estimate_remaining_minutes = estimateRemainingMinutes({
        remaining,
        delay_min_ms: run.delay_min_ms,
        delay_max_ms: run.delay_max_ms,
        batchSize: run.metadata?.batch_size,
        batchPauseMinutes: run.metadata?.batch_pause_minutes
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

function requireCampaignOwner(ownerEmail) {
    const owner = cleanText(ownerEmail);
    if (!owner) throw new DbError('Kampanya sahibi doğrulanamadı', 401, 'CAMPAIGN_OWNER_REQUIRED');
    return owner;
}

function ensureCampaignOwner(d, campaignId, ownerEmail, tenantId = null) {
    const owner = requireCampaignOwner(ownerEmail);
    const row = queryOne(d, 'SELECT id, tenant_id, owner_email, status FROM campaign_runs WHERE id = ?', [campaignId]);
    if (!row) throw new DbError('Kampanya bulunamadı', 404, 'CAMPAIGN_NOT_FOUND');
    if (tenantId && row.tenant_id !== resolveTenantId(tenantId)) throw new DbError('Bu kampanyaya erişim yetkiniz yok', 403, 'CAMPAIGN_FORBIDDEN');
    if (row.owner_email !== owner) throw new DbError('Bu kampanyaya erişim yetkiniz yok', 403, 'CAMPAIGN_FORBIDDEN');
    return row;
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

const createCampaignRun = async (input = {}) => withWriteTransaction('create-campaign-run', (d) => {
    const campaignId = String(input.id || '').trim();
    if (!campaignId) throw new DbError('Campaign id zorunlu', 400, 'CAMPAIGN_ID_REQUIRED');
    const tenant = resolveTenantId(input.tenantId);
    ensureTenant(d, tenant);
    const ownerEmail = requireCampaignOwner(input.ownerEmail);
    assertNoActiveCampaign(d, ownerEmail, tenant);
    const normalized = normalizeContactsDetailed(input.contacts || []);
    if (normalized.contacts.length === 0) throw new DbError('Gönderilecek geçerli kişi yok', 400, 'CAMPAIGN_CONTACTS_REQUIRED');

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
            import_summary: normalized.summary,
            batch_size: input.batchSize,
            batch_pause_minutes: input.batchPauseMinutes,
            media_count: Number(input.mediaCount || 0),
            media_files: Array.isArray(input.mediaFiles) ? input.mediaFiles : []
        }),
        current,
        current
    ]);

    normalized.contacts.forEach(contact => {
        d.run(`INSERT INTO campaign_recipients (
            tenant_id, campaign_run_id, contact_id, phone, normalized_phone, name, surname, status,
            attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, [
            tenant,
            campaignId,
            contact.id || null,
            contact.phone,
            contact.normalized_phone,
            contact.name,
            contact.surname,
            current,
            current
        ]);
    });

    return getCampaignRunStatusWithDb(d, campaignId, ownerEmail, tenant);
});

const setCampaignRunStatus = async (campaignId, status, metadata = {}) => withWriteTransaction(null, (d) => {
    const current = now();
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
    if (metadata.error !== undefined) {
        fields.push('error = ?');
        params.push(String(metadata.error || ''));
    }

    params.push(campaignId);
    d.run(`UPDATE campaign_runs SET ${fields.join(', ')} WHERE id = ?`, params);
    return getCampaignRunStatusWithDb(d, campaignId);
});

const addCampaignLog = async (campaignId, type, message, progress, metadata = {}) => withWriteTransaction(null, (d) => {
    const run = queryOne(d, 'SELECT tenant_id FROM campaign_runs WHERE id = ?', [campaignId]);
    d.run(
        'INSERT INTO campaign_logs (tenant_id, campaign_run_id, type, message, progress, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [run?.tenant_id || DEFAULT_TENANT_ID, campaignId, type, String(message || ''), progress === undefined ? null : Number(progress), toSqlJson(metadata), now()]
    );
});

const updateCampaignRecipient = async (campaignId, contact, status, error = null) => withWriteTransaction(null, (d) => {
    const normalizedPhone = normalizePhone(contact?.phone || contact?.normalized_phone);
    if (!normalizedPhone) return null;
    const current = now();
    const sentAt = status === 'sent' ? current : null;
    d.run(`UPDATE campaign_recipients
        SET status = ?, attempt_count = attempt_count + 1, last_error = ?, sent_at = COALESCE(?, sent_at), updated_at = ?
        WHERE campaign_run_id = ? AND normalized_phone = ?`, [
        status,
        error ? String(error) : null,
        sentAt,
        current,
        campaignId,
        normalizedPhone
    ]);

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
});

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

const stopLatestRunningCampaign = async (ownerEmail, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = queryOne(d, `
        SELECT id FROM campaign_runs
        WHERE tenant_id = ? AND owner_email = ? AND status IN ('queued', 'running', 'paused')
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
    `, [tenant, owner]);
    if (!row) return null;
    const current = now();
    d.run('UPDATE campaign_runs SET status = ?, stopped_at = ?, updated_at = ? WHERE id = ?', ['stopped', current, current, row.id]);
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
    d.run('UPDATE campaign_runs SET status = ?, stopped_at = ?, updated_at = ? WHERE id = ?', ['stopped', current, current, campaignId]);
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
        SELECT contact_id, phone, normalized_phone, name, surname, status, attempt_count, last_error
        FROM campaign_recipients
        ${where}
        ORDER BY id ASC
    `, params).map(row => ({
        id: row.contact_id || undefined,
        phone: row.phone,
        normalized_phone: row.normalized_phone,
        name: row.name,
        surname: row.surname,
        status: row.status,
        attempt_count: row.attempt_count,
        last_error: row.last_error || null
    }));
};

const prepareCampaignRunForRestart = async (campaignId, ownerEmail, mode, tenantId = DEFAULT_TENANT_ID) => withWriteTransaction(null, (d) => {
    const owner = requireCampaignOwner(ownerEmail);
    const tenant = resolveTenantId(tenantId);
    const row = ensureCampaignOwner(d, campaignId, owner, tenant);
    if (row.status === 'running') throw new DbError('Çalışan kampanya yeniden başlatılamaz', 409, 'CAMPAIGN_ALREADY_RUNNING');
    if (!['resume', 'retry'].includes(mode)) throw new DbError('Geçersiz kampanya yeniden başlatma modu', 400, 'CAMPAIGN_RESTART_MODE_INVALID');
    assertNoActiveCampaign(d, owner, tenant, campaignId);

    const current = now();
    if (mode === 'retry' || mode === 'resume') {
        d.run(`
            UPDATE campaign_recipients
            SET status = 'pending', last_error = NULL, sent_at = NULL, updated_at = ?
            WHERE campaign_run_id = ? AND status = 'failed'
        `, [current, campaignId]);
    }

    const counts = queryOne(d, `
        SELECT
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM campaign_recipients
        WHERE campaign_run_id = ?
    `, [campaignId]);

    d.run(`
        UPDATE campaign_runs
        SET status = 'queued',
            sent_count = ?,
            failed_count = ?,
            stopped_at = NULL,
            completed_at = NULL,
            error = NULL,
            updated_at = ?
        WHERE id = ?
    `, [
        Number(counts?.sent_count || 0),
        Number(counts?.failed_count || 0),
        current,
        campaignId
    ]);

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

const recordRecipientSend = async (phone, tenantId = DEFAULT_TENANT_ID, sentAt = new Date()) => withWriteTransaction(null, (d) => {
    const tenant = resolveTenantId(tenantId);
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) return { recorded: false };

    const current = sentAt instanceof Date ? sentAt : new Date(sentAt);
    const currentIso = current.toISOString();
    const date = businessDate(current);

    d.run(`
        INSERT INTO recipient_history (tenant_id, normalized_phone, last_sent_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, normalized_phone)
        DO UPDATE SET last_sent_at = excluded.last_sent_at, updated_at = excluded.updated_at
    `, [tenant, normalizedPhone, currentIso, currentIso, currentIso]);

    d.run(`
        INSERT INTO daily_send_stats (tenant_id, send_date, count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(tenant_id, send_date)
        DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
    `, [tenant, date, currentIso]);

    return { recorded: true, tenant_id: tenant, normalized_phone: normalizedPhone, send_date: date };
});

const cleanupRecipientHistory = async (tenantId = DEFAULT_TENANT_ID, retentionMs = 48 * 60 * 60 * 1000) => {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    return withWriteTransaction(null, (d) => {
        const result = d.run('DELETE FROM recipient_history WHERE tenant_id = ? AND last_sent_at < ?', [resolveTenantId(tenantId), cutoff]);
        return { deleted: Number(result?.changes || 0), cutoff };
    });
};

module.exports = {
    DbError,
    getDb,
    save,
    createBackup,
    requireSuccessfulBackup,
    resolveBackupRetentionCount,
    getMigrationStatus,
    applyPendingMigrations,
    migrateJSONs,
    DEFAULT_TENANT_ID,
    normalizePhone,
    normalizeContact,
    normalizeContacts,
    normalizeContactsDetailed,
    getTenants,
    createTenant,
    getGroups,
    getGroupContacts,
    getGroupContactsPage,
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
    addCampaignLog,
    updateCampaignRecipient,
    getCampaignRunStatus,
    getLatestCampaignRunStatus,
    stopLatestRunningCampaign,
    stopCampaignRun,
    getCampaignRecipientsForRun,
    prepareCampaignRunForRestart,
    addAuditLog,
    getAuditLogs,
    purgeExpiredAuditLogs,
    safeAuditMetadata,
    getDailySendCount,
    isRecipientInCooldown,
    recordRecipientSend,
    cleanupRecipientHistory
};
