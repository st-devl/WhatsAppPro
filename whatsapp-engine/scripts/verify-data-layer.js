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

        const tenantA = await db.createTenant(`tenant_a_${Date.now()}`, 'Tenant A');
        const tenantB = await db.createTenant(`tenant_b_${Date.now()}`, 'Tenant B');
        const sharedGroupName = `Ortak Grup ${Date.now()}`;
        const tenantAGroup = await db.createGroup(randomUUID(), sharedGroupName, tenantA.id);
        const tenantBGroup = await db.createGroup(randomUUID(), sharedGroupName, tenantB.id);
        await expectStatus(409, () => db.createGroup(randomUUID(), sharedGroupName, tenantA.id), 'duplicate group inside same tenant was not blocked');

        const tenantAGroups = await db.getGroups(tenantA.id);
        assert(tenantAGroups.some(item => item.id === tenantAGroup.id), 'tenant A group was not listed');
        assert(!tenantAGroups.some(item => item.id === tenantBGroup.id), 'tenant B group leaked into tenant A list');

        const tenantAContact = await db.createContact(tenantAGroup.id, { name: 'Tenant', surname: 'A', phone: '05322220000' }, tenantA.id);
        await expectStatus(404, () => db.getGroupContacts(tenantAGroup.id, tenantB.id), 'cross-tenant contacts read was not blocked');
        await expectStatus(404, () => db.updateContact(tenantAGroup.id, tenantAContact.id, { name: 'Blocked' }, tenantB.id), 'cross-tenant contact update was not blocked');

        const tenantATemplate = await db.createTemplate(randomUUID(), 'Tenant Template', 'Merhaba', tenantA.id);
        const tenantBTemplates = await db.getTemplates(tenantB.id);
        assert(!tenantBTemplates.some(item => item.id === tenantATemplate.id), 'template leaked across tenants');

        const ownerEmail = 'owner@example.com';
        const otherOwnerEmail = 'other@example.com';
        const campaign = await db.createCampaignRun({
            id: randomUUID(),
            ownerEmail,
            contacts: [{ name: 'Ayse', surname: 'Demir', phone: '05321110000' }],
            message: 'Merhaba {{ad}}',
            delayRange: [1, 2],
            dailyLimit: 10,
            mediaCount: 1,
            mediaFiles: [{ path: 'uploads/test-image.jpg', name: 'test-image.jpg', mimetype: 'image/jpeg', size: 100 }]
        });
        assert(campaign.owner_email === ownerEmail, 'campaign owner was not persisted');
        assert(campaign.message === 'Merhaba {{ad}}', 'campaign message was not persisted');
        assert(campaign.metadata.media_files.length === 1, 'campaign media metadata was not persisted');

        await expectStatus(403, () => db.getCampaignRunStatus(campaign.id, otherOwnerEmail), 'cross-owner campaign status was not blocked');
        await expectStatus(403, () => db.stopCampaignRun(campaign.id, otherOwnerEmail), 'cross-owner campaign stop was not blocked');
        const noOtherLatest = await db.getLatestCampaignRunStatus(otherOwnerEmail);
        assert(noOtherLatest === null, 'latest campaign leaked across owners');

        await db.updateCampaignRecipient(campaign.id, { phone: '05321110000' }, 'failed', 'test failure');
        const failedRecipients = await db.getCampaignRecipientsForRun(campaign.id, ownerEmail, ['failed']);
        assert(failedRecipients.length === 1, 'failed campaign recipient was not returned for owner');

        const stoppedCampaign = await db.stopLatestRunningCampaign(ownerEmail);
        assert(stoppedCampaign.id === campaign.id && stoppedCampaign.status === 'stopped', 'owner-scoped latest campaign stop failed');

        const retryRun = await db.prepareCampaignRunForRestart(campaign.id, ownerEmail, 'retry');
        assert(retryRun.status === 'queued' && retryRun.failed_count === 0, 'retry preparation did not reset failed recipients');
        const retryRecipients = await db.getCampaignRecipientsForRun(campaign.id, ownerEmail, ['pending']);
        assert(retryRecipients.length === 1, 'retry preparation did not return recipient to pending queue');

        const tenantCampaign = await db.createCampaignRun({
            id: randomUUID(),
            tenantId: tenantA.id,
            ownerEmail,
            contacts: [{ name: 'Tenant', surname: 'Campaign', phone: '05323330000' }],
            message: 'Tenant scoped',
            delayRange: [1, 2],
            dailyLimit: 10
        });
        await expectStatus(403, () => db.getCampaignRunStatus(tenantCampaign.id, ownerEmail, tenantB.id), 'cross-tenant campaign status was not blocked');
        const latestTenantA = await db.getLatestCampaignRunStatus(ownerEmail, tenantA.id);
        assert(latestTenantA.id === tenantCampaign.id, 'tenant-scoped latest campaign lookup failed');

        await db.addAuditLog('test_pii_redaction', 'auth', 'auth', {
            email: 'owner@example.com',
            phone: '05320000000',
            normalized_phone: '905320000000',
            password: 'plain-secret',
            ip: '192.168.1.45',
            message: 'private message'
        });
        const auditLogs = await db.getAuditLogs({ action: 'test_pii_redaction' });
        assert(auditLogs.logs.length === 1, 'audit log was not returned');
        const auditMetadata = auditLogs.logs[0].metadata;
        assert(auditMetadata.email !== 'owner@example.com', 'audit email was not masked');
        assert(auditMetadata.phone !== '05320000000', 'audit phone was not masked');
        assert(auditMetadata.normalized_phone !== '905320000000', 'audit normalized phone was not masked');
        assert(auditMetadata.password === '[redacted]', 'audit password was not redacted');
        assert(auditMetadata.ip === '192.168.1.0', 'audit IP was not masked');
        assert(auditMetadata.message === '[masked]', 'audit message was not masked');

        const d = await db.getDb();
        const journalMode = d.pragma('journal_mode', { simple: true }) || 'snapshot';
        assert(['wal', 'delete', 'memory', 'off', 'snapshot'].includes(String(journalMode).toLowerCase()), `unexpected SQLite journal mode: ${journalMode}`);

        const foreignKeys = d.pragma('foreign_keys', { simple: true });
        assert(Number(foreignKeys) === 1, 'foreign key enforcement is not enabled');

        const migrations = d.exec('SELECT id FROM schema_migrations ORDER BY id');
        assert((migrations[0]?.values || []).length >= 12, 'migrations were not recorded');

        const backups = fs.readdirSync(path.join(tempDir, 'backups')).filter(file => file.endsWith('.sqlite'));
        assert(backups.length > 0, 'backup files were not created for write operations');

        console.log(JSON.stringify({ ok: true, tempDir, backups: backups.length, journalMode, driver: 'sql.js' }, null, 2));
    } finally {
        fs.removeSync(tempDir);
    }
})().catch(err => {
    console.error(err);
    fs.removeSync(tempDir);
    process.exit(1);
});
