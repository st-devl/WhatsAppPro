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
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
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
        }
    ];

    const hasPending = migrations.some(migration => !hasMigration(d, migration.id));
    if (hasPending) createBackup('before-migrations');

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

    createBackup('before-json-migration');
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

    const changed = runMigrations(db);
    if (changed || !fs.existsSync(dbFile)) save();
    migrateJSONsWithDb(db);

    return db;
}

async function withWriteTransaction(reason, fn) {
    const d = await getDb();
    if (reason) createBackup(reason);
    const result = runInSqlTransaction(d, () => fn(d));
    save();
    return result;
}

// --- PUBLIC API ---

const getGroups = async () => {
    const d = await getDb();
    const groupRows = queryAll(d, `
        SELECT id, name, created_at, updated_at
        FROM groups
        WHERE deleted_at IS NULL
        ORDER BY datetime(created_at) DESC, name ASC
    `);

    const contactRows = queryAll(d, `
        SELECT id, group_id, name, surname, phone, normalized_phone, created_at, updated_at
        FROM contacts
        WHERE deleted_at IS NULL
        ORDER BY id ASC
    `);

    groupRows.forEach(group => {
        group.contacts = contactRows
            .filter(contact => contact.group_id === group.id)
            .map(mapContact);
    });

    return groupRows;
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

const createGroup = async (id, name) => withWriteTransaction('create-group', (d) => {
    const groupName = cleanText(name);
    if (!groupName) throw new DbError('Grup adı zorunlu', 400, 'GROUP_NAME_REQUIRED');
    const normalized = ensureUniqueGroupName(d, groupName);
    const current = now();

    d.run('INSERT INTO groups (id, name, name_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, groupName, normalized, current, current]);
    audit(d, 'group_created', 'group', id, { group_name: groupName });
    return { id, name: groupName, created_at: current, updated_at: current, contacts: [] };
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

module.exports = {
    DbError,
    getDb,
    save,
    createBackup,
    migrateJSONs,
    normalizePhone,
    normalizeContact,
    normalizeContacts,
    normalizeContactsDetailed,
    getGroups,
    getGroupContacts,
    createGroup,
    updateGroupContacts,
    deleteGroup,
    createContact,
    updateContact,
    deleteContact,
    getTemplates,
    createTemplate
};
