const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-campaign-safety-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.SESSION_SECRET = 'campaign-safety-test-secret';
process.env.LOG_LEVEL = 'silent';

const db = require('../lib/db');
const { sendBulkWithProgress, stopCampaign } = require('../lib/messenger');
const { MediaStore } = require('../lib/media_store');
const { CampaignService } = require('../services/campaign_service');

const ownerEmail = 'admin@example.com';
const tenantId = 'default';

async function createRun(id, contacts = [{ phone: '905320000000', name: 'Ali' }]) {
    return db.createCampaignRun({
        id,
        tenantId,
        ownerEmail,
        contacts,
        message: 'Merhaba {{ad}}',
        delayRange: [20, 90],
        dailyLimit: 50
    });
}

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('same owner cannot create a second active campaign', async () => {
    await createRun('active-1');

    await assert.rejects(
        () => createRun('active-2'),
        err => err.code === 'CAMPAIGN_ALREADY_ACTIVE' && err.status === 409
    );

    await db.stopCampaignRun('active-1', ownerEmail, tenantId);
    const next = await createRun('active-3');
    assert.equal(next.id, 'active-3');
    await db.stopCampaignRun('active-3', ownerEmail, tenantId);
});

test('stopped campaign cannot restart while another campaign is active', async () => {
    await createRun('restart-source');
    await db.stopCampaignRun('restart-source', ownerEmail, tenantId);
    await createRun('restart-blocker');

    await assert.rejects(
        () => db.prepareCampaignRunForRestart('restart-source', ownerEmail, 'resume', tenantId),
        err => err.code === 'CAMPAIGN_ALREADY_ACTIVE' && err.status === 409
    );
    await db.stopCampaignRun('restart-blocker', ownerEmail, tenantId);
});

test('stop interrupts inter-message wait quickly and prevents next send', async () => {
    const campaignId = 'interruptible-wait';
    const sent = [];
    const started = Date.now();
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone, payload) => {
            sent.push({ phone, payload });
        }
    };

    setTimeout(() => stopCampaign(campaignId), 30);

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000001', name: 'Ali' },
            { phone: '905320000002', name: 'Veli' }
        ],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 50,
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            disableNightMode: true
        }
    );

    assert.equal(sent.length, 1);
    assert.ok(Date.now() - started < 1000, 'stop should not wait for the full inter-message delay');
});

test('campaign start validates send limits on the server', async () => {
    const service = new CampaignService({
        db,
        mediaStore: new MediaStore(),
        runtime: {
            connected: () => true,
            getSocket: () => ({
                onWhatsApp: async () => [{ exists: true }],
                sendPresenceUpdate: async () => {},
                sendMessage: async () => {}
            })
        },
        logger: { error: () => {} }
    });
    const socket = {
        request: { session: { user: { email: ownerEmail, tenant_id: tenantId } } },
        emit: () => {}
    };

    await assert.rejects(
        () => service.start({
            contacts: [{ phone: '905320000003', name: 'Ayse' }],
            message: 'Merhaba {{ad}}',
            dailyLimit: 0,
            delayRange: [20, 90]
        }, socket),
        err => err.code === 'CAMPAIGN_DAILY_LIMIT_INVALID' && err.status === 400
    );

    await assert.rejects(
        () => service.start({
            contacts: [{ phone: '905320000004', name: 'Fatma' }],
            message: 'Merhaba {{ad}}',
            dailyLimit: 50,
            delayRange: [90, 20]
        }, socket),
        err => err.code === 'CAMPAIGN_DELAY_RANGE_INVALID' && err.status === 400
    );
});

test('resume queue includes pending and failed recipients but excludes sent ones', async () => {
    const run = await createRun('resume-unsent-only', [
        { phone: '905320000010', name: 'Sent' },
        { phone: '905320000011', name: 'Failed' },
        { phone: '905320000012', name: 'Pending' }
    ]);
    assert.ok(run.estimate_remaining_minutes > 0);

    await db.updateCampaignRecipient('resume-unsent-only', { phone: '905320000010' }, 'sent');
    await db.updateCampaignRecipient('resume-unsent-only', { phone: '905320000011' }, 'failed', 'network down');

    const unsent = await db.getCampaignRecipientsForRun('resume-unsent-only', ownerEmail, ['pending', 'failed'], tenantId);
    assert.deepEqual(unsent.map(contact => contact.normalized_phone).sort(), ['905320000011', '905320000012']);

    const prepared = await db.prepareCampaignRunForRestart('resume-unsent-only', ownerEmail, 'resume', tenantId);
    assert.equal(prepared.sent_count, 1);
    assert.equal(prepared.failed_count, 0);
    assert.equal(prepared.pending_count, 2);
    assert.equal(prepared.remaining_count, 2);
    assert.ok(prepared.estimate_remaining_minutes > 0);

    await db.stopCampaignRun('resume-unsent-only', ownerEmail, tenantId);
});

test('campaign inserts automatic batch pause after configured successful sends', async () => {
    const campaignId = 'batch-pause';
    const sent = [];
    const waitLogs = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };
    const socket = {
        emit(event, payload) {
            if (event === 'log' && payload.batch_pause_until) waitLogs.push(payload);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000020', name: 'A' },
            { phone: '905320000021', name: 'B' },
            { phone: '905320000022', name: 'C' }
        ],
        'Merhaba {{ad}}',
        socket,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 250,
            batchSize: 2,
            batchPauseMinutes: 1,
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 3);
    assert.equal(waitLogs.length, 1);
    assert.equal(waitLogs[0].batch_pause_minutes, 1);
});
