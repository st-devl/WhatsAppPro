const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs-extra');

const dataDir = path.join(__dirname, '../data');
fs.ensureDirSync(dataDir);

const dbFile = path.join(dataDir, 'database.sqlite');
let db = null;

async function getDb() {
    if (db) return db;

    const SQL = await initSqlJs();

    if (fs.existsSync(dbFile)) {
        const buffer = fs.readFileSync(dbFile);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // Tablo oluştur
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        name TEXT,
        surname TEXT,
        phone TEXT,
        FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migration: JSON varsa taşı
    await migrateJSONs();
    save();

    return db;
}

function save() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFile, buffer);
}

async function migrateJSONs() {
    const tplPath = path.join(dataDir, 'templates.json');
    if (fs.existsSync(tplPath)) {
        try {
            const templates = fs.readJsonSync(tplPath);
            templates.forEach(t => {
                db.run(`INSERT OR IGNORE INTO templates (id, name, text) VALUES (?, ?, ?)`, [String(t.id), t.name, t.text]);
            });
            fs.renameSync(tplPath, tplPath + '.migrated');
            console.log("✅ Templates veritabanına taşındı.");
        } catch (e) { console.error("Template migration error", e); }
    }

    const grpPath = path.join(dataDir, 'groups.json');
    if (fs.existsSync(grpPath)) {
        try {
            const groups = fs.readJsonSync(grpPath);
            groups.forEach(g => {
                db.run(`INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)`, [g.id, g.name]);
                if (g.contacts && g.contacts.length > 0) {
                    g.contacts.forEach(c => {
                        db.run(`INSERT INTO contacts (group_id, name, surname, phone) VALUES (?, ?, ?, ?)`,
                            [g.id, c.name || '', c.surname || '', c.phone]);
                    });
                }
            });
            fs.renameSync(grpPath, grpPath + '.migrated');
            console.log("✅ Groups veritabanına taşındı.");
        } catch (e) { console.error("Group migration error", e); }
    }
}

// --- PUBLIC API ---

const getGroups = async () => {
    const d = await getDb();
    const groups = d.exec(`SELECT * FROM groups`);
    const contacts = d.exec(`SELECT * FROM contacts`);

    const groupRows = groups.length > 0 ? groups[0].values.map(r => ({ id: r[0], name: r[1], created_at: r[2] })) : [];
    const contactRows = contacts.length > 0 ? contacts[0].values.map(r => ({ id: r[0], group_id: r[1], name: r[2], surname: r[3], phone: r[4] })) : [];

    groupRows.forEach(g => {
        g.contacts = contactRows.filter(c => c.group_id === g.id).map(c => ({
            name: c.name, surname: c.surname, phone: c.phone
        }));
    });
    return groupRows;
};

const createGroup = async (id, name) => {
    const d = await getDb();
    d.run(`INSERT INTO groups (id, name) VALUES (?, ?)`, [id, name]);
    save();
    return { id, name, contacts: [] };
};

const updateGroupContacts = async (groupId, contactsList) => {
    const d = await getDb();
    d.run(`DELETE FROM contacts WHERE group_id = ?`, [groupId]);
    contactsList.forEach(c => {
        d.run(`INSERT INTO contacts (group_id, name, surname, phone) VALUES (?, ?, ?, ?)`,
            [groupId, c.name || '', c.surname || '', c.phone]);
    });
    save();
};

const deleteGroup = async (id) => {
    const d = await getDb();
    d.run(`DELETE FROM contacts WHERE group_id = ?`, [id]);
    d.run(`DELETE FROM groups WHERE id = ?`, [id]);
    save();
};

const getTemplates = async () => {
    const d = await getDb();
    const result = d.exec(`SELECT * FROM templates`);
    if (result.length === 0) return [];
    return result[0].values.map(r => ({ id: r[0], name: r[1], text: r[2], created_at: r[3] }));
};

const createTemplate = async (id, name, text) => {
    const d = await getDb();
    d.run(`INSERT INTO templates (id, name, text) VALUES (?, ?, ?)`, [id, name, text]);
    save();
    return { id, name, text };
};

module.exports = { getGroups, createGroup, updateGroupContacts, deleteGroup, getTemplates, createTemplate };
