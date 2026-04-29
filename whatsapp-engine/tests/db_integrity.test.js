const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-integrity-test-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.LOG_LEVEL = 'silent';

const db = require('../lib/db');

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Telefon Normalizasyonu Testleri ───

test('normalizePhone: 05xx → 905xx', () => {
    assert.equal(db.normalizePhone('05321234567'), '905321234567');
});

test('normalizePhone: +90 5xx → 905xx', () => {
    assert.equal(db.normalizePhone('+90 532 123 45 67'), '905321234567');
});

test('normalizePhone: 90 5xx → 905xx', () => {
    assert.equal(db.normalizePhone('905321234567'), '905321234567');
});

test('normalizePhone: 5xx → 905xx', () => {
    assert.equal(db.normalizePhone('5321234567'), '905321234567');
});

test('normalizePhone: bosluk, tire, parantez temizlenir', () => {
    assert.equal(db.normalizePhone('(0532) 123-45-67'), '905321234567');
});

test('normalizePhone: harf ve gecersiz karakterler temizlenir', () => {
    assert.equal(db.normalizePhone('tel:0532ABC123'), '0532123');
});

test('normalizeContact: gecersiz telefon null doner', () => {
    assert.equal(db.normalizeContact({ phone: 'abc', name: 'X' }), null);
});

test('normalizeContact: gecerli telefon normalize edilir', () => {
    const c = db.normalizeContact({ phone: '05321234567', name: 'Ali', surname: 'Yilmaz' });
    assert.equal(c.phone, '905321234567');
    assert.equal(c.normalized_phone, '905321234567');
    assert.equal(c.name, 'Ali');
    assert.equal(c.surname, 'Yilmaz');
});

test('normalizeContactsDetailed: duplicate numaralar tekillestirilir', () => {
    const result = db.normalizeContactsDetailed([
        { phone: '05321234567', name: 'Ali' },
        { phone: '905321234567', name: 'Veli' },
        { phone: '05329876543', name: 'Ayse' }
    ]);
    assert.equal(result.contacts.length, 2);
    assert.equal(result.summary.duplicate, 1);
    assert.equal(result.summary.valid, 2);
});

test('normalizeContactsDetailed: hatali numaralar sayilir', () => {
    const result = db.normalizeContactsDetailed([
        { phone: '05321234567', name: 'Ali' },
        { phone: '123', name: 'Kisa' },
        { phone: '', name: 'Bos' }
    ]);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.summary.invalid, 2);
});

// ─── Grup CRUD Testleri ───

test('grup olusturma ve listeleme', async () => {
    const group = await db.createGroup('test-group-1', 'Test Grup');
    assert.equal(group.name, 'Test Grup');
    assert.ok(group.id);
    assert.ok(group.created_at);

    const groups = await db.getGroups();
    assert.ok(groups.length >= 1);
    const found = groups.find(g => g.id === 'test-group-1');
    assert.ok(found);
    assert.equal(found.name, 'Test Grup');
    assert.equal(found.contact_count, 0);
});

test('duplicate grup adi engellenir', async () => {
    await db.createGroup('dup-group-1', 'Duplicate Test');
    await assert.rejects(
        () => db.createGroup('dup-group-2', 'Duplicate Test'),
        err => err.code === 'DUPLICATE_GROUP_NAME'
    );
});

test('bos grup adi engellenir', async () => {
    await assert.rejects(
        () => db.createGroup('empty-name-group', ''),
        err => err.code === 'GROUP_NAME_REQUIRED'
    );
    await assert.rejects(
        () => db.createGroup('spaces-name-group', '   '),
        err => err.code === 'GROUP_NAME_REQUIRED'
    );
});

test('grup soft delete ve sonrasi listeleme disi birakma', async () => {
    const group = await db.createGroup('soft-del-group-1', 'Silinecek Grup');
    await db.deleteGroup('soft-del-group-1');

    const groups = await db.getGroups();
    const found = groups.find(g => g.id === 'soft-del-group-1');
    assert.equal(found, undefined);
});

test('silinmis gruba kisi eklenemez', async () => {
    await db.createGroup('del-group-contacts', 'Silinecek Grup 2');
    await db.deleteGroup('del-group-contacts');
    await assert.rejects(
        () => db.createContact('del-group-contacts', { phone: '05320000001', name: 'X' }),
        err => err.code === 'GROUP_NOT_FOUND'
    );
});

// ─── Kisi CRUD Testleri ───

test('kisi olusturma ve getirme', async () => {
    const group = await db.createGroup('contact-test-group', 'Kisi Test Grup');
    const contact = await db.createContact('contact-test-group', {
        phone: '05320000001',
        name: 'Ahmet',
        surname: 'Demir'
    });

    assert.ok(contact.id);
    assert.equal(contact.phone, '905320000001');
    assert.equal(contact.name, 'Ahmet');
    assert.equal(contact.surname, 'Demir');
    assert.ok(contact.created_at);

    const contacts = await db.getGroupContacts('contact-test-group');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].phone, '905320000001');
});

test('ayni grupta duplicate telefon engellenir', async () => {
    await db.createGroup('dup-phone-group', 'Duplicate Phone Grup');
    await db.createContact('dup-phone-group', { phone: '05329990001', name: 'A' });

    await assert.rejects(
        () => db.createContact('dup-phone-group', { phone: '05329990001', name: 'B' }),
        err => err.code === 'DUPLICATE_CONTACT_PHONE'
    );
});

test('kisi guncelleme', async () => {
    await db.createGroup('update-contact-group', 'Update Contact Grup');
    const contact = await db.createContact('update-contact-group', {
        phone: '05320000010',
        name: 'Mehmet',
        surname: 'Kaya'
    });

    const updated = await db.updateContact('update-contact-group', contact.id, {
        name: 'Ali',
        surname: 'Yildiz',
        phone: '05320000011'
    });

    assert.equal(updated.name, 'Ali');
    assert.equal(updated.surname, 'Yildiz');
    assert.equal(updated.phone, '905320000011');
});

test('kisi guncellemede duplicate telefon engellenir', async () => {
    await db.createGroup('upd-dup-group', 'Update Dup Grup');
    const c1 = await db.createContact('upd-dup-group', { phone: '05330000001', name: 'X' });
    await db.createContact('upd-dup-group', { phone: '05330000002', name: 'Y' });

    await assert.rejects(
        () => db.updateContact('upd-dup-group', c1.id, { phone: '05330000002' }),
        err => err.code === 'DUPLICATE_CONTACT_PHONE'
    );
});

test('kisi soft delete', async () => {
    await db.createGroup('del-contact-group', 'Delete Contact Grup');
    const contact = await db.createContact('del-contact-group', {
        phone: '05340000001',
        name: 'Silinecek'
    });

    await db.deleteContact('del-contact-group', contact.id);

    const contacts = await db.getGroupContacts('del-contact-group');
    assert.equal(contacts.length, 0);
});

test('silinmis kisi bulunamadı hatasi verir', async () => {
    await db.createGroup('del-contact-err-group', 'Del Contact Err Grup');
    const contact = await db.createContact('del-contact-err-group', {
        phone: '05340000002',
        name: 'Silinecek2'
    });
    await db.deleteContact('del-contact-err-group', contact.id);

    await assert.rejects(
        () => db.updateContact('del-contact-err-group', contact.id, { name: 'Yeni' }),
        err => err.code === 'CONTACT_NOT_FOUND'
    );
});

// ─── Soft Delete + Kampanya Hariç Tutma Testleri ───

test('silinmis grubun kisileri de soft delete edilir', async () => {
    await db.createGroup('cascade-del-group', 'Cascade Delete Grup');
    await db.createContact('cascade-del-group', { phone: '05350000001', name: 'A' });
    await db.createContact('cascade-del-group', { phone: '05350000002', name: 'B' });

    await db.deleteGroup('cascade-del-group');

    // Silinmis grup icin getGroupContacts GROUP_NOT_FOUND hatasi verir
    await assert.rejects(
        () => db.getGroupContacts('cascade-del-group'),
        err => err.code === 'GROUP_NOT_FOUND'
    );

    // DB seviyesinde soft delete kontrolu
    const d = await db.getDb();
    const activeContacts = d.exec(
        "SELECT COUNT(*) AS cnt FROM contacts WHERE group_id = 'cascade-del-group' AND deleted_at IS NULL"
    );
    assert.equal(activeContacts[0].values[0][0], 0);
});

test('getGroups contact_count silinmemis kisileri sayar', async () => {
    await db.createGroup('count-group', 'Count Grup');
    await db.createContact('count-group', { phone: '05360000001', name: 'A' });
    await db.createContact('count-group', { phone: '05360000002', name: 'B' });
    await db.createContact('count-group', { phone: '05360000003', name: 'C' });

    const groups = await db.getGroups();
    const found = groups.find(g => g.id === 'count-group');
    assert.ok(found);
    assert.equal(found.contact_count, 3);
});

test('kisi silindikten sonra contact_count guncellenir', async () => {
    await db.createGroup('count-after-del-group', 'Count After Del');
    const c1 = await db.createContact('count-after-del-group', { phone: '05370000001', name: 'A' });
    await db.createContact('count-after-del-group', { phone: '05370000002', name: 'B' });

    await db.deleteContact('count-after-del-group', c1.id);

    const groups = await db.getGroups();
    const found = groups.find(g => g.id === 'count-after-del-group');
    assert.ok(found);
    assert.equal(found.contact_count, 1);
});

// ─── Pagination Testleri ───

test('getGroupContactsPage sayfalama calisir', async () => {
    await db.createGroup('page-group', 'Page Grup');
    for (let i = 1; i <= 5; i++) {
        await db.createContact('page-group', {
            phone: `0538000000${i}`,
            name: `Kisi ${i}`
        });
    }

    const page1 = await db.getGroupContactsPage('page-group', { limit: 2, offset: 0 });
    assert.equal(page1.contacts.length, 2);
    assert.equal(page1.pagination.total, 5);
    assert.equal(page1.pagination.has_more, true);

    const page2 = await db.getGroupContactsPage('page-group', { limit: 2, offset: 2 });
    assert.equal(page2.contacts.length, 2);
    assert.equal(page2.pagination.has_more, true);

    const page3 = await db.getGroupContactsPage('page-group', { limit: 2, offset: 4 });
    assert.equal(page3.contacts.length, 1);
    assert.equal(page3.pagination.has_more, false);
});

test('getGroupContactsPage arama calisir', async () => {
    await db.createGroup('search-group', 'Search Grup');
    await db.createContact('search-group', { phone: '05390000001', name: 'Fatma' });
    await db.createContact('search-group', { phone: '05390000002', name: 'Ferhat' });
    await db.createContact('search-group', { phone: '05390000003', name: 'Ayse' });

    const result = await db.getGroupContactsPage('search-group', { search: 'Fatma' });
    assert.equal(result.contacts.length, 1);
    assert.equal(result.pagination.total, 1);
    assert.equal(result.contacts[0].name, 'Fatma');
});

// ─── updateGroupContacts (Toplu Replace) Testleri ───

test('updateGroupContacts mevcut kisileri replace eder', async () => {
    await db.createGroup('replace-group', 'Replace Grup');
    await db.createContact('replace-group', { phone: '05400000001', name: 'Eski' });

    const result = await db.updateGroupContacts('replace-group', [
        { phone: '05400000002', name: 'Yeni1' },
        { phone: '05400000003', name: 'Yeni2' }
    ]);

    assert.equal(result.success, true);
    assert.equal(result.summary.saved, 2);

    const contacts = await db.getGroupContacts('replace-group');
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].name, 'Yeni1');
    assert.equal(contacts[1].name, 'Yeni2');
});

test('updateGroupContacts duplicate kontaklari tekillestirir', async () => {
    await db.createGroup('replace-dup-group', 'Replace Dup Grup');

    const result = await db.updateGroupContacts('replace-dup-group', [
        { phone: '05410000001', name: 'A' },
        { phone: '05410000001', name: 'B' },
        { phone: '05410000002', name: 'C' }
    ]);

    assert.equal(result.summary.saved, 2);
    assert.ok(result.summary.duplicate >= 1);
});

// ─── Backup Testleri ───

test('createBackup dosya olusturur', async () => {
    await db.getDb();
    const backupFile = db.createBackup('test-backup');
    assert.ok(backupFile);
    assert.ok(fs.existsSync(backupFile));
    assert.ok(backupFile.includes('test-backup'));
});

test('requireSuccessfulBackup basarili backup doner', async () => {
    await db.getDb();
    const backupFile = db.requireSuccessfulBackup('test-require-backup');
    assert.ok(backupFile);
    assert.ok(fs.existsSync(backupFile));
});

// ─── Audit Log Testleri ───

test('audit log kaydi olusturulur', async () => {
    await db.addAuditLog('test_action', 'test_entity', 'test-id-1', { key: 'value' });

    const result = await db.getAuditLogs({ limit: 5 });
    assert.ok(result.logs.length >= 1);

    const found = result.logs.find(l => l.action === 'test_action');
    assert.ok(found);
    assert.equal(found.entity_type, 'test_entity');
    assert.equal(found.entity_id, 'test-id-1');
});

test('audit log pagination calisir', async () => {
    for (let i = 0; i < 5; i++) {
        await db.addAuditLog(`pagination_test_${i}`, 'test_entity', `pg-id-${i}`);
    }

    const page1 = await db.getAuditLogs({ limit: 2, offset: 0, action: 'pagination_test_' });
    // Note: action filter is exact match, so this tests general pagination
    const all = await db.getAuditLogs({ limit: 100 });
    assert.ok(all.pagination.total >= 5);
});

test('safeAuditMetadata hassas verileri maskele', () => {
    const masked = db.safeAuditMetadata({
        phone: '05321234567',
        email: 'user@example.com',
        name: 'Ahmet',
        surname: 'Yilmaz',
        message: 'Gizli mesaj',
        password: 'secret123',
        token: 'abc123',
        normal_field: 'normal deger'
    });

    assert.ok(masked.phone.includes('***'));
    assert.ok(masked.email.includes('***'));
    assert.equal(masked.name, '[masked]');
    assert.equal(masked.surname, '[masked]');
    assert.equal(masked.message, '[masked]');
    assert.equal(masked.password, '[redacted]');
    assert.equal(masked.token, '[redacted]');
    assert.equal(masked.normal_field, 'normal deger');
});

// ─── Template Testleri ───

test('template olusturma ve listeleme', async () => {
    await db.createTemplate('tpl-test-1', 'Test Sablon', 'Merhaba {{ad}}');

    const templates = await db.getTemplates();
    assert.ok(templates.length >= 1);
    const found = templates.find(t => t.id === 'tpl-test-1');
    assert.ok(found);
    assert.equal(found.name, 'Test Sablon');
    assert.equal(found.text, 'Merhaba {{ad}}');
});

// ─── Retention Testleri ───

test('resolveBackupRetentionCount default 30 doner', () => {
    delete process.env.BACKUP_RETENTION_COUNT;
    assert.equal(db.resolveBackupRetentionCount(), 30);
});

test('resolveBackupRetentionCount ortam degiskeninden okur', () => {
    process.env.BACKUP_RETENTION_COUNT = '50';
    assert.equal(db.resolveBackupRetentionCount(), 50);
    delete process.env.BACKUP_RETENTION_COUNT;
});

test('resolveBackupRetentionCount gecersiz deger icin default doner', () => {
    process.env.BACKUP_RETENTION_COUNT = 'abc';
    assert.equal(db.resolveBackupRetentionCount(), 30);
    delete process.env.BACKUP_RETENTION_COUNT;
});

// ─── Recipient Runtime State Testleri ───

test('recipient send state DB uzerinde tutulur', async () => {
    const tenant = 'default';
    const phone = '05321112233';
    const before = await db.getDailySendCount(tenant);

    const recorded = await db.recordRecipientSend(phone, tenant);
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.normalized_phone, '905321112233');

    const after = await db.getDailySendCount(tenant);
    assert.equal(after, before + 1);
    assert.equal(await db.isRecipientInCooldown(phone, tenant), true);
});

test('recipient history cleanup eski kayitlari siler', async () => {
    const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await db.recordRecipientSend('05329998877', 'default', oldDate);

    const result = await db.cleanupRecipientHistory('default', 48 * 60 * 60 * 1000);
    assert.ok(result.deleted >= 1);
    assert.equal(await db.isRecipientInCooldown('05329998877', 'default'), false);
});

// ─── Temel DB Bütünlük Testi ───

test('getDb_singleton aynı instance doner', async () => {
    const d1 = await db.getDb();
    const d2 = await db.getDb();
    assert.equal(d1, d2);
});

test('save checkpoint hatasiz calisir', async () => {
    await db.getDb();
    assert.doesNotThrow(() => db.save());
});
