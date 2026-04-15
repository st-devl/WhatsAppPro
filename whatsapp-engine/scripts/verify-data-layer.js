const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { randomUUID } = require('crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-data-'));
process.env.WHASAPPC_DATA_DIR = tempDir;

const db = require('../lib/db');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function expectStatus(status, fn, message) {
    try {
        await fn();
    } catch (err) {
        if (err.status === status) return;
        throw new Error(`${message}: expected ${status}, got ${err.status || 'no-status'} (${err.message})`);
    }
    throw new Error(`${message}: expected error ${status}`);
}

(async () => {
    try {
        const groupName = `Test Grup ${Date.now()}`;
        const group = await db.createGroup(randomUUID(), groupName);
        assert(group.id && group.name === groupName, 'group create failed');

        await expectStatus(409, () => db.createGroup(randomUUID(), groupName), 'duplicate group was not blocked');

        const contact = await db.createContact(group.id, { name: 'Ali', surname: 'Yilmaz', phone: '05320000000' });
        assert(contact.id && contact.phone === '905320000000', 'contact create/normalize failed');

        await expectStatus(409, () => db.createContact(group.id, { name: 'Duplicate', phone: '+90 532 000 00 00' }), 'duplicate contact was not blocked');

        const updated = await db.updateContact(group.id, contact.id, { name: 'Veli', surname: 'Kaya', phone: '905320000001' });
        assert(updated.name === 'Veli' && updated.phone === '905320000001', 'contact update failed');

        await db.deleteContact(group.id, contact.id);
        const contactsAfterDelete = await db.getGroupContacts(group.id);
        assert(contactsAfterDelete.length === 0, 'soft deleted contact still visible');

        await db.deleteGroup(group.id);
        const groupsAfterDelete = await db.getGroups();
        assert(!groupsAfterDelete.some(item => item.id === group.id), 'soft deleted group still visible');

        const d = await db.getDb();
        const migrations = d.exec('SELECT id FROM schema_migrations ORDER BY id');
        assert((migrations[0]?.values || []).length >= 3, 'migrations were not recorded');

        const backups = fs.readdirSync(path.join(tempDir, 'backups')).filter(file => file.endsWith('.sqlite'));
        assert(backups.length > 0, 'backup files were not created for write operations');

        console.log(JSON.stringify({ ok: true, tempDir, backups: backups.length }, null, 2));
    } finally {
        fs.removeSync(tempDir);
    }
})().catch(err => {
    console.error(err);
    fs.removeSync(tempDir);
    process.exit(1);
});
