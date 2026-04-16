const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs-extra');

const dataDir = process.env.WHASAPPC_DATA_DIR
    ? path.resolve(process.env.WHASAPPC_DATA_DIR)
    : path.join(__dirname, '../data');
const backupDir = path.join(dataDir, 'backups');
fs.ensureDirSync(dataDir);
fs.ensureDirSync(backupDir);

const dbFile = process.env.WHASAPPC_DB_FILE
    ? path.resolve(process.env.WHASAPPC_DB_FILE)
    : path.join(dataDir, 'database.sqlite');
let db = null;

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

function cleanupBackups(keep = 30) {
    const backups = fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sqlite'))
        .map(file => ({ file, fullPath: path.join(backupDir, file), stat: fs.statSync(path.join(backupDir, file)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    backups.slice(keep).forEach(item => fs.removeSync(item.fullPath));
}

function createBackup(reason = 'manual') {
    fs.ensureDirSync(backupDir);
    if (!fs.existsSync(dbFile)) return null;
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
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpFile = `${dbFile}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tmpFile, buffer);
        fs.renameSync(tmpFile, dbFile);
    } catch (err) {
        fs.removeSync(tmpFile);
        throw new DbError(`Veritabanı kaydedilemedi: ${err.message}`, 500, 'DB_SAVE_FAILED');
    }
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
        return result;
    } catch (err) {
        try { d.run('ROLLBACK'); } catch (_) {}
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
    d.run('PRAGMA foreign_keys = ON');
}

function runMigrations(d) {
    ensureBaseTables(d);

    const migrations = [
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
        }
    ];

    const hasPending = migrations.some(migration => !hasMigration(d, migration.id));
    if (hasPending) requireSuccessfulBackup('before-migrations');

    let changed = false;
    migrations.forEach(migration => {
        changed = applyMigration(d, migration.id, migration.description, migration.run) || changed;
    });

    return changed;
}

function maskPhone(phone) {
    const normalized = normalizePhone(phone);
    if (normalized.length < 6) return normalized;
    return `${normalized.slice(0, 4)}***${normalized.slice(-2)}`;
}

function safeAuditMetadata(metadata = {}) {
    const copy = { ...metadata };
    if (copy.phone) copy.phone = maskPhone(copy.phone);
    if (copy.normalized_phone) copy.normalized_phone = maskPhone(copy.normalized_phone);
    if (copy.name) copy.name = '[masked]';
    if (copy.surname) copy.surname = '[masked]';
    if (copy.message) copy.message = '[masked]';
    return copy;
}

function audit(d, action, entityType, entityId, metadata = {}) {
    d.run(
        'INSERT INTO audit_logs (action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
        [action, entityType, String(entityId || ''), toSqlJson(safeAuditMetadata(metadata)), now()]
    );
}

function ensureActiveGroup(d, groupId) {
    const group = queryOne(d, 'SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL', [groupId]);
    if (!group) throw new DbError('Grup bulunamadı', 404, 'GROUP_NOT_FOUND');
    return group;
}

function ensureUniqueGroupName(d, name, excludeId = null) {
    const normalized = normalizeGroupName(name);
    const existing = excludeId
        ? queryOne(d, 'SELECT id FROM groups WHERE name_normalized = ? AND id != ? AND deleted_at IS NULL', [normalized, excludeId])
        : queryOne(d, 'SELECT id FROM groups WHERE name_normalized = ? AND deleted_at IS NULL', [normalized]);
    if (existing) throw new DbError('Bu isimde aktif bir grup zaten var', 409, 'DUPLICATE_GROUP_NAME');
    return normalized;
}

function ensureUniqueContactPhone(d, groupId, normalizedPhone, excludeContactId = null) {
    const existing = excludeContactId
        ? queryOne(d, 'SELECT id FROM contacts WHERE group_id = ? AND normalized_phone = ? AND id != ? AND deleted_at IS NULL', [groupId, normalizedPhone, excludeContactId])
        : queryOne(d, 'SELECT id FROM contacts WHERE group_id = ? AND normalized_phone = ? AND deleted_at IS NULL', [groupId, normalizedPhone]);
    if (existing) throw new DbError('Bu telefon numarası bu grupta zaten kayıtlı', 409, 'DUPLICATE_CONTACT_PHONE');
}

function mapContact(row) {
    return {
        id: row.id,
        group_id: row.group_id,
        name: row.name || '',
        surname: row.surname || '',
        phone: row.phone || row.normalized_phone || '',
        normalized_phone: row.normalized_phone || row.phone || '',
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function getContactById(d, groupId, contactId) {
    const contact = queryOne(d, 'SELECT * FROM contacts WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [contactId, groupId]);
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
                d.run('INSERT OR IGNORE INTO templates (id, name, text) VALUES (?, ?, ?)', [String(t.id), cleanText(t.name), String(t.text || '')]);
            });
            fs.renameSync(tplPath, `${tplPath}.migrated`);
            audit(d, 'legacy_templates_migrated', 'template', 'legacy', { count: templates.length });
        }

        if (fs.existsSync(grpPath)) {
            const groups = fs.readJsonSync(grpPath);
            groups.forEach(g => {
                const groupName = cleanText(g.name);
                const groupId = String(g.id);
                d.run('INSERT OR IGNORE INTO groups (id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
                    groupId,
                    groupName,
                    normalizeGroupName(groupName),
                    now(),
                    now()
                ]);

                const { contacts } = normalizeContactsDetailed(g.contacts || []);
                contacts.forEach(c => {
                    d.run('INSERT INTO contacts (group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
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
            audit(d, 'legacy_groups_migrated', 'group', 'legacy', { count: groups.length });
        }
    });
    save();
    return true;
}

async function migrateJSONs() {
    const d = await getDb();
    return migrateJSONsWithDb(d);
}

async function getDb() {
    if (db) return db;

    const SQL = await initSqlJs();

    if (fs.existsSync(dbFile)) {
        const buffer = fs.readFileSync(dbFile);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    enableForeignKeys(db);
    const changed = runMigrations(db);
    if (changed || !fs.existsSync(dbFile)) save();
    migrateJSONsWithDb(db);

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

const getGroups = async () => {
    const d = await getDb();
    return queryAll(d, `
        SELECT
            g.id,
            g.name,
            g.created_at,
            g.updated_at,
            COUNT(c.id) AS contact_count
        FROM groups g
        LEFT JOIN contacts c ON c.group_id = g.id AND c.deleted_at IS NULL
        WHERE g.deleted_at IS NULL
        GROUP BY g.id, g.name, g.created_at, g.updated_at
        ORDER BY datetime(g.created_at) DESC, g.name ASC
    `).map(group => ({
        ...group,
        contact_count: Number(group.contact_count || 0),
        contacts: []
    }));
};

const getGroupContacts = async (groupId) => {
    const d = await getDb();
    ensureActiveGroup(d, groupId);
    return queryAll(d, `
        SELECT id, group_id, name, surname, phone, normalized_phone, created_at, updated_at
        FROM contacts
        WHERE group_id = ? AND deleted_at IS NULL
        ORDER BY id ASC
    `, [groupId]).map(mapContact);
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

const getGroupContactsPage = async (groupId, options = {}) => {
    const d = await getDb();
    ensureActiveGroup(d, groupId);

    const { limit, offset, search, sort, direction } = normalizePaginationOptions(options);
    const where = ['group_id = ?', 'deleted_at IS NULL'];
    const params = [groupId];

    if (search) {
        where.push('(name LIKE ? OR surname LIKE ? OR phone LIKE ? OR normalized_phone LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const totalRow = queryOne(d, `SELECT COUNT(*) AS total FROM contacts WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const rows = queryAll(d, `
        SELECT id, group_id, name, surname, phone, normalized_phone, created_at, updated_at
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

const createGroup = async (id, name) => withWriteTransaction('create-group', (d) => {
    const groupName = cleanText(name);
    if (!groupName) throw new DbError('Grup adı zorunlu', 400, 'GROUP_NAME_REQUIRED');
    const normalized = ensureUniqueGroupName(d, groupName);
    const current = now();

    d.run('INSERT INTO groups (id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, groupName, normalized, current, current]);
    audit(d, 'group_created', 'group', id, { group_name: groupName });
    return { id, name: groupName, created_at: current, updated_at: current, contact_count: 0, contacts: [] };
});

const updateGroupContacts = async (groupId, contactsList) => withWriteTransaction('replace-group-contacts', (d) => {
    ensureActiveGroup(d, groupId);
    const { contacts, summary } = normalizeContactsDetailed(contactsList);
    const current = now();

    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE group_id = ? AND deleted_at IS NULL', [current, current, groupId]);
    contacts.forEach(contact => {
        d.run('INSERT INTO contacts (group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            groupId,
            contact.name,
            contact.surname,
            contact.phone,
            contact.normalized_phone,
            current,
            current
        ]);
    });
    d.run('UPDATE groups SET updated_at = ? WHERE id = ?', [current, groupId]);
    audit(d, 'group_contacts_replaced', 'group', groupId, summary);
    return { success: true, summary: { ...summary, saved: contacts.length } };
});

const deleteGroup = async (id) => withWriteTransaction('delete-group', (d) => {
    ensureActiveGroup(d, id);
    const current = now();
    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE group_id = ? AND deleted_at IS NULL', [current, current, id]);
    d.run('UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [current, current, id]);
    audit(d, 'group_deleted', 'group', id);
    return { success: true };
});

const createContact = async (groupId, input) => withWriteTransaction('create-contact', (d) => {
    ensureActiveGroup(d, groupId);
    const contact = normalizeContact(input);
    if (!contact) throw new DbError('Geçerli telefon numarası gerekli', 400, 'INVALID_CONTACT_PHONE');
    ensureUniqueContactPhone(d, groupId, contact.normalized_phone);
    const current = now();

    d.run('INSERT INTO contacts (group_id, name, surname, phone, normalized_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        groupId,
        contact.name,
        contact.surname,
        contact.phone,
        contact.normalized_phone,
        current,
        current
    ]);
    const row = queryOne(d, 'SELECT last_insert_rowid() AS id');
    audit(d, 'contact_created', 'contact', row.id, { phone: contact.normalized_phone, group_id: groupId });
    return mapContact({ ...contact, id: row.id, group_id: groupId, created_at: current, updated_at: current });
});

const updateContact = async (groupId, contactId, input) => withWriteTransaction('update-contact', (d) => {
    ensureActiveGroup(d, groupId);
    const existing = getContactById(d, groupId, contactId);
    const nextPhone = input.phone !== undefined ? normalizePhone(input.phone) : existing.normalized_phone;
    if (!isValidPhone(nextPhone)) throw new DbError('Geçerli telefon numarası gerekli', 400, 'INVALID_CONTACT_PHONE');
    if (nextPhone !== existing.normalized_phone) ensureUniqueContactPhone(d, groupId, nextPhone, contactId);

    const nextName = input.name !== undefined ? cleanText(input.name) : cleanText(existing.name);
    const nextSurname = input.surname !== undefined ? cleanText(input.surname) : cleanText(existing.surname);
    const current = now();

    d.run('UPDATE contacts SET name = ?, surname = ?, phone = ?, normalized_phone = ?, updated_at = ? WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [
        nextName,
        nextSurname,
        nextPhone,
        nextPhone,
        current,
        contactId,
        groupId
    ]);
    d.run('UPDATE groups SET updated_at = ? WHERE id = ?', [current, groupId]);
    audit(d, 'contact_updated', 'contact', contactId, { phone: nextPhone, group_id: groupId });
    return mapContact({ id: Number(contactId), group_id: groupId, name: nextName, surname: nextSurname, phone: nextPhone, normalized_phone: nextPhone, created_at: existing.created_at, updated_at: current });
});

const deleteContact = async (groupId, contactId) => withWriteTransaction('delete-contact', (d) => {
    ensureActiveGroup(d, groupId);
    getContactById(d, groupId, contactId);
    const current = now();
    d.run('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [current, current, contactId, groupId]);
    d.run('UPDATE groups SET updated_at = ? WHERE id = ?', [current, groupId]);
    audit(d, 'contact_deleted', 'contact', contactId, { group_id: groupId });
    return { success: true };
});

const getTemplates = async () => {
    const d = await getDb();
    return queryAll(d, 'SELECT id, name, text, created_at FROM templates ORDER BY datetime(created_at) DESC').map(row => ({
        id: row.id,
        name: row.name,
        text: row.text,
        created_at: row.created_at
    }));
};

const createTemplate = async (id, name, text) => withWriteTransaction(null, (d) => {
    const tplName = cleanText(name);
    if (!tplName || !String(text || '').trim()) throw new DbError('Şablon adı ve içerik zorunlu', 400, 'TEMPLATE_REQUIRED');
    d.run('INSERT INTO templates (id, name, text, created_at) VALUES (?, ?, ?, ?)', [id, tplName, String(text), now()]);
    return { id, name: tplName, text: String(text) };
});

function mapCampaignRun(row) {
    if (!row) return null;
    const total = Number(row.total_count || 0);
    const sent = Number(row.sent_count || 0);
    const failed = Number(row.failed_count || 0);
    const processed = sent + failed;
    return {
        id: row.id,
        status: row.status,
        template_id: row.template_id || null,
        group_id: row.group_id || null,
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
        created_at: row.created_at,
        updated_at: row.updated_at
    };
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

const createCampaignRun = async (input = {}) => withWriteTransaction('create-campaign-run', (d) => {
    const campaignId = String(input.id || '').trim();
    if (!campaignId) throw new DbError('Campaign id zorunlu', 400, 'CAMPAIGN_ID_REQUIRED');
    const normalized = normalizeContactsDetailed(input.contacts || []);
    if (normalized.contacts.length === 0) throw new DbError('Gönderilecek geçerli kişi yok', 400, 'CAMPAIGN_CONTACTS_REQUIRED');

    const delayRange = Array.isArray(input.delayRange) ? input.delayRange : [];
    const delayMinMs = Number.parseInt(delayRange[0], 10) * 1000 || null;
    const delayMaxMs = Number.parseInt(delayRange[1], 10) * 1000 || null;
    const current = now();

    d.run(`INSERT INTO campaign_runs (
        id, status, message, total_count, sent_count, failed_count, daily_limit,
        delay_min_ms, delay_max_ms, started_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`, [
        campaignId,
        'queued',
        String(input.message || ''),
        normalized.contacts.length,
        Number.parseInt(input.dailyLimit, 10) || null,
        delayMinMs,
        delayMaxMs,
        current,
        toSqlJson({ import_summary: normalized.summary, media_count: Number(input.mediaCount || 0) }),
        current,
        current
    ]);

    normalized.contacts.forEach(contact => {
        d.run(`INSERT INTO campaign_recipients (
            campaign_run_id, contact_id, phone, normalized_phone, name, surname, status,
            attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, [
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

    return getCampaignRunStatusWithDb(d, campaignId);
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
    d.run(
        'INSERT INTO campaign_logs (campaign_run_id, type, message, progress, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [campaignId, type, String(message || ''), progress === undefined ? null : Number(progress), toSqlJson(metadata), now()]
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

function getCampaignRunStatusWithDb(d, campaignId) {
    const run = mapCampaignRun(queryOne(d, 'SELECT * FROM campaign_runs WHERE id = ?', [campaignId]));
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

const getCampaignRunStatus = async (campaignId) => {
    const d = await getDb();
    return getCampaignRunStatusWithDb(d, campaignId);
};

const getLatestCampaignRunStatus = async () => {
    const d = await getDb();
    const row = queryOne(d, 'SELECT id FROM campaign_runs ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC LIMIT 1');
    return row ? getCampaignRunStatusWithDb(d, row.id) : null;
};

const stopLatestRunningCampaign = async () => withWriteTransaction(null, (d) => {
    const row = queryOne(d, `
        SELECT id FROM campaign_runs
        WHERE status IN ('queued', 'running', 'paused')
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
    `);
    if (!row) return null;
    const current = now();
    d.run('UPDATE campaign_runs SET status = ?, stopped_at = ?, updated_at = ? WHERE id = ?', ['stopped', current, current, row.id]);
    return getCampaignRunStatusWithDb(d, row.id);
});

module.exports = {
    DbError,
    getDb,
    save,
    createBackup,
    requireSuccessfulBackup,
    migrateJSONs,
    normalizePhone,
    normalizeContact,
    normalizeContacts,
    normalizeContactsDetailed,
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
    stopLatestRunningCampaign
};
