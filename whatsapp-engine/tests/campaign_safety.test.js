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
const { sendBulkWithProgress, stopCampaign, finishCampaign } = require('../lib/messenger');
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

function campaignStore() {
    return {
        setRunStatus: db.setCampaignRunStatus,
        getRunStatus: db.getCampaignRunStatus,
        updateRuntimeState: db.updateCampaignRuntimeState,
        addLog: db.addCampaignLog,
        markRecipient: db.updateCampaignRecipient,
        recordRecipientResult: db.recordCampaignRecipientResult
    };
}

function legacyCampaignStore() {
    return {
        setRunStatus: db.setCampaignRunStatus,
        getRunStatus: db.getCampaignRunStatus,
        updateRuntimeState: db.updateCampaignRuntimeState,
        addLog: db.addCampaignLog,
        markRecipient: db.updateCampaignRecipient
    };
}

function queryOne(database, sql, params = []) {
    const statement = database.prepare(sql);
    try {
        statement.bind(params);
        return statement.step() ? statement.getAsObject() : null;
    } finally {
        statement.free();
    }
}

async function campaignPersistenceSnapshot(campaignId, phone) {
    const database = await db.getDb();
    const recipient = queryOne(database, `
        SELECT status, attempt_count, last_error, message_id, sent_at
        FROM campaign_recipients
        WHERE campaign_run_id = ? AND normalized_phone = ?
    `, [campaignId, phone]);
    const history = queryOne(database, `
        SELECT normalized_phone, last_message_hash
        FROM recipient_history
        WHERE tenant_id = ? AND normalized_phone = ?
    `, [tenantId, phone]);
    const dailyStats = queryOne(database, `
        SELECT count
        FROM daily_send_stats
        WHERE tenant_id = ?
        ORDER BY send_date DESC
        LIMIT 1
    `, [tenantId]);
    const run = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    const sentLog = run.logs.find(log => log.message.startsWith('✅ İletildi:'));

    return {
        recipient,
        history,
        dailyCount: Number(dailyStats?.count || 0),
        runtimeState: {
            current_recipient_name: run.current_recipient_name,
            current_recipient_phone: run.current_recipient_phone,
            last_recipient_name: run.last_recipient_name,
            last_recipient_phone: run.last_recipient_phone
        },
        sentLog: sentLog && {
            type: sentLog.type,
            message: sentLog.message,
            progress: sentLog.progress,
            metadata: sentLog.metadata
        }
    };
}

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('batched recipient persistence matches the legacy campaign result with one transaction', async () => {
    const legacyCampaignId = 'recipient-result-legacy';
    const batchedCampaignId = 'recipient-result-batched';
    const legacyPhone = '905320000080';
    const batchedPhone = '905320000081';
    const messageId = 'recipient-result-message-id';
    const contacts = phone => [{ phone, name: 'Sonuç' }];
    const createSock = () => ({
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async () => ({ key: { id: messageId } })
    });
    const sendSettings = (store, initialStatus) => ({
        tenantId,
        campaignStore: store,
        initialStatus,
        typingDelayMs: 0,
        stopPollMs: 10,
        delayScale: 0,
        disableNightMode: true,
        sleep: async () => {}
    });

    await createRun(legacyCampaignId, contacts(legacyPhone));
    const legacyInitialStatus = await db.getCampaignRunStatus(legacyCampaignId, ownerEmail, tenantId);
    const legacyBefore = db.__writeTransactionCountForTests();
    await sendBulkWithProgress(
        createSock(),
        contacts(legacyPhone),
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        legacyCampaignId,
        sendSettings(legacyCampaignStore(), legacyInitialStatus)
    );
    const legacyTransactions = db.__writeTransactionCountForTests() - legacyBefore;
    const legacyResult = await campaignPersistenceSnapshot(legacyCampaignId, legacyPhone);

    await createRun(batchedCampaignId, contacts(batchedPhone));
    const batchedInitialStatus = await db.getCampaignRunStatus(batchedCampaignId, ownerEmail, tenantId);
    const batchedBefore = db.__writeTransactionCountForTests();
    await sendBulkWithProgress(
        createSock(),
        contacts(batchedPhone),
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        batchedCampaignId,
        sendSettings(campaignStore(), batchedInitialStatus)
    );
    const batchedTransactions = db.__writeTransactionCountForTests() - batchedBefore;
    const batchedResult = await campaignPersistenceSnapshot(batchedCampaignId, batchedPhone);

    assert.equal(legacyTransactions, 12);
    assert.equal(batchedTransactions, 8);
    assert.equal(legacyTransactions - batchedTransactions, 4);
    assert.equal(legacyTransactions - 7, 5);
    assert.equal(batchedTransactions - 7, 1);

    assert.deepEqual(batchedResult.recipient, {
        status: 'sent',
        attempt_count: 1,
        last_error: null,
        message_id: messageId,
        sent_at: batchedResult.recipient.sent_at
    });
    assert.ok(batchedResult.recipient.sent_at);
    assert.deepEqual(batchedResult.history, {
        normalized_phone: batchedPhone,
        last_message_hash: legacyResult.history.last_message_hash
    });
    assert.equal(batchedResult.dailyCount, legacyResult.dailyCount + 1);
    assert.deepEqual(batchedResult.runtimeState, {
        current_recipient_name: null,
        current_recipient_phone: null,
        last_recipient_name: 'Sonuç',
        last_recipient_phone: batchedPhone
    });
    assert.deepEqual(batchedResult.sentLog, {
        type: 'success',
        message: '✅ İletildi: Sonuç (1/1)',
        progress: 100,
        metadata: {
            estimate_remaining_minutes: 0,
            phase: 'sent',
            last_recipient_name: 'Sonuç',
            last_recipient_phone: batchedPhone
        }
    });
    assert.deepEqual(
        { ...batchedResult.sentLog, metadata: { ...batchedResult.sentLog.metadata, last_recipient_phone: null } },
        { ...legacyResult.sentLog, metadata: { ...legacyResult.sentLog.metadata, last_recipient_phone: null } }
    );
    assert.deepEqual(
        { ...batchedResult.recipient, sent_at: !!batchedResult.recipient.sent_at },
        { ...legacyResult.recipient, sent_at: !!legacyResult.recipient.sent_at }
    );
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

test('media payloads always include a caption key', async () => {
    const campaignId = 'media-caption-key';
    const mediaPath = path.join(tempDir, 'uploads', tenantId, 'caption-key.jpg');
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.writeFileSync(mediaPath, Buffer.from('media'));
    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone, payload) => {
            sent.push({ phone, payload });
        }
    };
    const mediaFiles = [
        { path: 'uploads/default/caption-key.jpg', mimetype: 'image/jpeg', name: 'caption-key.jpg' },
        { path: 'uploads/default/caption-key.jpg', mimetype: 'image/jpeg', name: 'caption-key.jpg' }
    ];

    await sendBulkWithProgress(
        sock,
        [{ phone: '905320000099', name: 'Ali' }],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        mediaFiles,
        campaignId,
        {
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 2);
    assert.equal(Object.hasOwn(sent[0].payload, 'caption'), true);
    assert.equal(sent[0].payload.caption, 'Merhaba Ali');
    assert.equal(Object.hasOwn(sent[1].payload, 'caption'), true);
    assert.equal(sent[1].payload.caption, undefined);
});

test('message text uses first name for {{ad}} and surname only once', async () => {
    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone, payload) => {
            sent.push(payload.text);
        }
    };

    await sendBulkWithProgress(
        sock,
        [{ phone: '905320000098', name: 'Ahmet', surname: 'Yılmaz' }],
        'Sayın {{ad}} {{soyad}}',
        null,
        [5, 5],
        [],
        'placeholder-full-name',
        {
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.deepEqual(sent, ['Sayın Ahmet Yılmaz']);
});

test('recipients missing a used placeholder are skipped, not sent a half greeting', async () => {
    const campaignId = 'placeholder-missing-skip';
    const recipients = [
        { phone: '905320000096', name: '', surname: 'Kaya' },
        { phone: '905320000097', name: 'Zeynep', surname: 'Kaya' }
    ];
    await createRun(campaignId, recipients);
    const initialStatus = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone, payload) => {
            sent.push({ phone, text: payload.text });
        }
    };

    await sendBulkWithProgress(
        sock,
        recipients,
        'Sayın {{ad}}, Merhaba!',
        null,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 50,
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {},
            campaignStore: campaignStore(),
            initialStatus
        }
    );

    assert.deepEqual(sent.map(item => item.text), ['Sayın Zeynep, Merhaba!']);
    const skipped = await campaignPersistenceSnapshot(campaignId, '905320000096');
    assert.equal(skipped.recipient.status, 'skipped');
    assert.equal(skipped.recipient.last_error, 'Ad boş');
    const report = await db.getCampaignReport(campaignId, tenantId);
    assert.ok(report.skipped_recipients.some(item => item.phone === '905320000096' && item.last_error === 'Ad boş'));
});

test('finish locks campaign against every restart path', async () => {
    const campaignId = 'finished-restart-lock';
    await createRun(campaignId, [
        { phone: '905320000003', name: 'Ali' },
        { phone: '905320000004', name: 'Veli' }
    ]);

    const finished = await db.finishCampaignRun(campaignId, ownerEmail, tenantId);
    assert.equal(finished.status, 'finished');
    assert.ok(finished.finished_at, 'finished timestamp should be stored');

    await assert.rejects(
        () => db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId),
        err => err.code === 'CAMPAIGN_FINISHED' && err.status === 409
    );
    await assert.rejects(
        () => db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId),
        err => err.code === 'CAMPAIGN_FINISHED' && err.status === 409
    );
    await assert.rejects(
        () => db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId),
        err => err.code === 'CAMPAIGN_FINISHED' && err.status === 409
    );
    await assert.rejects(
        () => db.prepareSkippedCampaignRunForRetry(campaignId, ownerEmail, [{ phone: '905320000003' }], tenantId),
        err => err.code === 'CAMPAIGN_FINISHED' && err.status === 409
    );

    const next = await createRun('after-finished-lock');
    assert.equal(next.id, 'after-finished-lock');
    await db.stopCampaignRun('after-finished-lock', ownerEmail, tenantId);
});

test('finish interrupts active sender without downgrading finished status', async () => {
    const campaignId = 'finish-interrupts-active';
    await createRun(campaignId, [
        { phone: '905320000005', name: 'Ali' },
        { phone: '905320000006', name: 'Veli' }
    ]);
    const initialStatus = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    const sent = [];
    const started = Date.now();
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone, payload) => {
            sent.push({ phone, payload });
        }
    };

    setTimeout(() => finishCampaign(campaignId), 30);

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000005', name: 'Ali' },
            { phone: '905320000006', name: 'Veli' }
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
            disableNightMode: true,
            campaignStore: campaignStore(),
            initialStatus
        }
    );

    const run = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(sent.length, 1);
    assert.equal(run.status, 'finished');
    assert.ok(Date.now() - started < 1000, 'finish should interrupt the inter-message delay');

    const report = await db.getCampaignReport(campaignId, tenantId);
    assert.equal(report.sent_recipients.length, 1);
    assert.equal(report.sent_recipients[0].normalized_phone, '905320000005');
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

test('resume finishes first pass before retry sends current unsent pool', async () => {
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

    const eligibleNow = await db.getCampaignRecipientsForRestart('resume-unsent-only', ownerEmail, 'resume', tenantId);
    assert.deepEqual(eligibleNow.map(contact => contact.normalized_phone), ['905320000012']);
    const retryBeforeFirstPass = await db.getCampaignRecipientsForRestart('resume-unsent-only', ownerEmail, 'retry', tenantId);
    assert.deepEqual(retryBeforeFirstPass, []);

    const prepared = await db.prepareCampaignRunForRestart('resume-unsent-only', ownerEmail, 'resume', tenantId);
    assert.equal(prepared.sent_count, 1);
    assert.equal(prepared.failed_count, 1);
    assert.equal(prepared.pending_count, 1);
    assert.equal(prepared.remaining_count, 2);
    assert.ok(prepared.estimate_remaining_minutes > 0);

    await db.updateCampaignRecipient('resume-unsent-only', { phone: '905320000012' }, 'failed', 'second pending failed');
    const resumeAfterFirstPass = await db.getCampaignRecipientsForRestart('resume-unsent-only', ownerEmail, 'resume', tenantId);
    assert.deepEqual(resumeAfterFirstPass, []);

    const retryAfterFirstPass = await db.getCampaignRecipientsForRestart('resume-unsent-only', ownerEmail, 'retry', tenantId);
    assert.deepEqual(retryAfterFirstPass.map(contact => contact.normalized_phone), ['905320000011', '905320000012']);

    const preparedAfterFirstPass = await db.prepareCampaignRunForRestart('resume-unsent-only', ownerEmail, 'retry', tenantId);
    assert.equal(preparedAfterFirstPass.failed_count, 0);
    assert.equal(preparedAfterFirstPass.pending_count, 2);

    await db.updateCampaignRecipient('resume-unsent-only', { phone: '905320000011' }, 'sent');
    await db.updateCampaignRecipient('resume-unsent-only', { phone: '905320000012' }, 'failed', 'still failing');
    const retryAfterSuccessfulRemoval = await db.getCampaignRecipientsForRestart('resume-unsent-only', ownerEmail, 'retry', tenantId);
    assert.deepEqual(retryAfterSuccessfulRemoval.map(contact => contact.normalized_phone), ['905320000012']);

    await db.stopCampaignRun('resume-unsent-only', ownerEmail, tenantId);
});

test('resumed campaign progress preserves durable sent counters', async () => {
    const campaignId = 'resume-durable-counters';
    await createRun(campaignId, [
        { phone: '905320000030', name: 'Sent' },
        { phone: '905320000031', name: 'Next' },
        { phone: '905320000032', name: 'Last' }
    ]);
    await db.updateCampaignRecipient(campaignId, { phone: '905320000030' }, 'sent');

    const unsent = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending', 'failed'], tenantId);
    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    const progressEvents = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async () => {}
    };
    const socket = {
        emit(event, payload) {
            if (event === 'campaign-progress') progressEvents.push(payload);
        }
    };

    await sendBulkWithProgress(
        sock,
        unsent,
        'Merhaba {{ad}}',
        socket,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 250,
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: prepared,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    const firstSentProgress = progressEvents.find(event => event.phase === 'sent');
    assert.equal(firstSentProgress.sent, 2);
    assert.equal(firstSentProgress.total, 3);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.sent_count, 3);
    assert.equal(final.processed, 3);
    assert.equal(final.progress, 100);
});

test('uncertain WhatsApp validation is paused for retry instead of marked as not on WhatsApp', async () => {
    const campaignId = 'validation-unknown-pauses';
    await createRun(campaignId, [
        { phone: '905320000037', name: 'Unknown' },
        { phone: '905320000038', name: 'Pending' }
    ]);

    const sent = [];
    const sock = {
        onWhatsApp: async () => [],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000037', name: 'Unknown' },
            { phone: '905320000038', name: 'Pending' }
        ],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId),
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            validationUnknownStreakLimit: 1,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 0);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.status, 'paused');
    assert.equal(final.validation_unknown_count, 1);
    assert.equal(final.not_on_whatsapp_count, 0);
    assert.equal(final.skipped_count, 0);
    assert.equal(final.pending_count, 1);
    assert.equal(final.remaining_count, 2);

    const recipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(recipients.map(contact => contact.status), ['validation_unknown', 'pending']);
    const report = await db.getCampaignReport(campaignId, tenantId);
    assert.equal(report.skipped_recipients.length, 1);
    assert.equal(report.skipped_recipients[0].status, 'validation_unknown');

    const eligibleNow = await db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.deepEqual(eligibleNow.map(contact => contact.normalized_phone), ['905320000038']);

    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.equal(prepared.validation_unknown_count, 1);
    assert.equal(prepared.pending_count, 1);

    await db.updateCampaignRecipient(campaignId, { phone: '905320000038' }, 'sent');
    const resumeAfterFirstPass = await db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.deepEqual(resumeAfterFirstPass, []);
    const retryAfterFirstPass = await db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'retry', tenantId);
    assert.deepEqual(retryAfterFirstPass.map(contact => contact.normalized_phone), ['905320000037']);

    const preparedAfterFirstPass = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'retry', tenantId);
    assert.equal(preparedAfterFirstPass.validation_unknown_count, 0);
    assert.equal(preparedAfterFirstPass.pending_count, 1);
    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
});

test('completed first pass separates current unsent recipients for immediate retry', async () => {
    const campaignId = 'validation-unknown-completes-first-pass';
    await createRun(campaignId, [
        { phone: '905320000087', name: 'Unknown' },
        { phone: '905320000088', name: 'Sent' }
    ]);

    const sent = [];
    const sock = {
        onWhatsApp: async (phone) => phone.includes('087') ? [] : [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000087', name: 'Unknown' },
            { phone: '905320000088', name: 'Sent' }
        ],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId),
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            validationUnknownStreakLimit: 10,
            sleep: async () => {}
        }
    );

    assert.deepEqual(sent, ['905320000088@s.whatsapp.net']);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.status, 'completed');
    assert.equal(final.sent_count, 1);
    assert.equal(final.validation_unknown_count, 1);
    assert.equal(final.pending_count, 0);

    const retryable = await db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'retry', tenantId);
    assert.deepEqual(retryable.map(contact => contact.normalized_phone), ['905320000087']);

    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'retry', tenantId);
    assert.equal(prepared.pending_count, 1);
    assert.equal(prepared.validation_unknown_count, 0);
    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
});

test('explicit not-on-WhatsApp validation is separated from uncertain validation', async () => {
    const campaignId = 'validation-not-found';
    await createRun(campaignId, [{ phone: '905320000039', name: 'Missing' }]);

    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: false }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };

    await sendBulkWithProgress(
        sock,
        [{ phone: '905320000039', name: 'Missing' }],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId),
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 0);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.status, 'completed');
    assert.equal(final.not_on_whatsapp_count, 1);
    assert.equal(final.validation_unknown_count, 0);
    assert.equal(final.skipped_count, 1);
    assert.equal(final.processed, 1);

    const unavailable = await db.getUnavailableWhatsAppRecipient('905320000039', tenantId);
    assert.equal(unavailable.normalized_phone, '905320000039');
    assert.equal(unavailable.reason, 'WhatsApp kullanıcısı değil');

    const report = await db.getCampaignReport(campaignId, tenantId);
    assert.equal(report.unavailable_recipients.length, 1);
    assert.equal(report.unavailable_recipients[0].normalized_phone, '905320000039');
    assert.equal(report.unsent_recipients.length, 0);
    assert.equal(report.sent_recipients.length, 0);
});

test('confirmed non-WhatsApp recipients stay out of future campaign queues and retries', async () => {
    await db.recordUnavailableWhatsAppRecipient(
        { phone: '905320000050', name: 'Missing Again' },
        tenantId,
        { reason: 'WhatsApp kullanıcısı değil', campaignId: 'previous-campaign' }
    );

    const campaignId = 'global-unavailable-excluded';
    const run = await createRun(campaignId, [
        { phone: '905320000050', name: 'Missing Again' },
        { phone: '905320000051', name: 'Eligible' }
    ]);

    assert.equal(run.pending_count, 1);
    assert.equal(run.not_on_whatsapp_count, 1);
    assert.equal(run.skipped_count, 1);
    assert.equal(run.remaining_count, 1);

    const recipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(recipients.map(contact => [contact.normalized_phone, contact.status]), [
        ['905320000050', 'not_on_whatsapp'],
        ['905320000051', 'pending']
    ]);

    const retryableSkipped = await db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId);
    assert.deepEqual(retryableSkipped.map(contact => contact.normalized_phone), []);

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.equal(prepared.pending_count, 1);
    assert.equal(prepared.not_on_whatsapp_count, 1);
    assert.equal(prepared.skipped_count, 1);

    const resumedRecipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(resumedRecipients.map(contact => [contact.normalized_phone, contact.status]), [
        ['905320000050', 'not_on_whatsapp'],
        ['905320000051', 'pending']
    ]);

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
});

test('manually suppressed recipients stay out of campaign queues and retries', async () => {
    await db.suppressRecipients(
        [{ phone: '905320000070', name: 'Muted' }],
        tenantId,
        { reason: 'Manuel test dışlama' }
    );

    const suppressedList = await db.getSuppressedRecipients(tenantId);
    assert.ok(suppressedList.some(recipient => recipient.normalized_phone === '905320000070'));
    assert.equal(await db.isSuppressedRecipient('905320000070', tenantId), true);

    const campaignId = 'manual-suppressed-excluded';
    const run = await createRun(campaignId, [
        { phone: '905320000070', name: 'Muted' },
        { phone: '905320000071', name: 'Eligible' }
    ]);

    assert.equal(run.pending_count, 1);
    assert.equal(run.suppressed_count, 1);
    assert.equal(run.skipped_count, 1);
    assert.equal(run.remaining_count, 1);

    const recipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(recipients.map(contact => [contact.normalized_phone, contact.status]), [
        ['905320000070', 'suppressed'],
        ['905320000071', 'pending']
    ]);

    const retryableSkipped = await db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId);
    assert.deepEqual(retryableSkipped.map(contact => contact.normalized_phone), []);

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.equal(prepared.pending_count, 1);
    assert.equal(prepared.suppressed_count, 1);
    assert.equal(prepared.skipped_count, 1);

    const report = await db.getCampaignReport(campaignId, tenantId);
    assert.ok(report.skipped_recipients.some(contact => contact.status === 'suppressed' && contact.phone === '905320000070'));

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    await db.unsuppressRecipients(['905320000070'], tenantId);
    assert.equal(await db.isSuppressedRecipient('905320000070', tenantId), false);
});

test('manual suppression removes existing pending recipients before restart', async () => {
    const campaignId = 'manual-suppressed-existing-run';
    await createRun(campaignId, [
        { phone: '905320000072', name: 'Muted Existing' },
        { phone: '905320000073', name: 'Eligible Existing' }
    ]);

    await db.suppressRecipients(
        [{ phone: '905320000072', name: 'Muted Existing' }],
        tenantId,
        { reason: 'Manuel test dışlama' }
    );

    const recipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(recipients.map(contact => [contact.normalized_phone, contact.status]), [
        ['905320000072', 'suppressed'],
        ['905320000073', 'pending']
    ]);

    const restartRecipients = await db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.deepEqual(restartRecipients.map(contact => contact.normalized_phone), ['905320000073']);

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    await db.unsuppressRecipients(['905320000072'], tenantId);
});

test('send loop checks manual suppression before each send', async () => {
    const campaignId = 'manual-suppressed-live-send';
    await createRun(campaignId, [
        { phone: '905320000074', name: 'Muted Live' },
        { phone: '905320000075', name: 'Eligible Live' }
    ]);
    const initialStatus = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    await db.suppressRecipients(
        [{ phone: '905320000074', name: 'Muted Live' }],
        tenantId,
        { reason: 'Manuel test dışlama' }
    );

    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000074', name: 'Muted Live' },
            { phone: '905320000075', name: 'Eligible Live' }
        ],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            tenantId,
            campaignStore: campaignStore(),
            initialStatus,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0], '905320000075@s.whatsapp.net');
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.sent_count, 1);
    assert.equal(final.suppressed_count, 1);
    assert.equal(final.skipped_count, 1);

    await db.unsuppressRecipients(['905320000074'], tenantId);
});

test('skipped retry queue includes only retry-safe skipped recipients', async () => {
    const campaignId = 'retry-safe-skipped';
    await createRun(campaignId, [
        { phone: '905320000060', name: 'Unknown' },
        { phone: '905320000061', name: 'Active Cooldown' },
        { phone: '905320000062', name: 'Expired Cooldown' },
        { phone: '905320000063', name: 'Missing' },
        { phone: '905320000064', name: 'Legacy Skipped' },
        { phone: '905320000065', name: 'Failed' }
    ]);

    await db.updateCampaignRecipient(campaignId, { phone: '905320000060' }, 'validation_unknown', 'temporary validation uncertainty');
    await db.updateCampaignRecipient(campaignId, { phone: '905320000061' }, 'skipped_cooldown', 'Cooldown aktif');
    await db.updateCampaignRecipient(campaignId, { phone: '905320000062' }, 'skipped_cooldown', 'Cooldown aktif');
    await db.updateCampaignRecipient(campaignId, { phone: '905320000063' }, 'not_on_whatsapp', 'WhatsApp kullanıcısı değil');
    await db.updateCampaignRecipient(campaignId, { phone: '905320000064' }, 'skipped', 'Legacy skip');
    await db.updateCampaignRecipient(campaignId, { phone: '905320000065' }, 'failed', 'network down');
    await db.recordRecipientSend('905320000061', tenantId, new Date(), 'same-message');
    await db.recordRecipientSend('905320000062', tenantId, new Date(Date.now() - (25 * 60 * 60 * 1000)), 'same-message');

    const retryable = await db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId);
    assert.deepEqual(retryable.map(contact => contact.normalized_phone), [
        '905320000062',
        '905320000064'
    ]);

    const prepared = await db.prepareSkippedCampaignRunForRetry(campaignId, ownerEmail, retryable, tenantId);
    assert.equal(prepared.pending_count, 2);
    assert.equal(prepared.failed_count, 1);
    assert.equal(prepared.validation_unknown_count, 1);
    assert.equal(prepared.cooldown_skipped_count, 1);
    assert.equal(prepared.not_on_whatsapp_count, 1);

    const recipients = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, [], tenantId);
    assert.deepEqual(recipients.map(contact => [contact.normalized_phone, contact.status]), [
        ['905320000060', 'validation_unknown'],
        ['905320000061', 'skipped_cooldown'],
        ['905320000062', 'pending'],
        ['905320000063', 'not_on_whatsapp'],
        ['905320000064', 'pending'],
        ['905320000065', 'failed']
    ]);

    const retryableAfterSeveralHours = await db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId, {
        asOfMs: Date.now() + (6 * 60 * 60 * 1000)
    });
    assert.deepEqual(retryableAfterSeveralHours.map(contact => contact.normalized_phone), []);

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
});

test('manual stop and resume preserve active batch pause deadline', async () => {
    const campaignId = 'resume-preserves-batch-pause';
    await createRun(campaignId, [
        { phone: '905320000033', name: 'Sent' },
        { phone: '905320000034', name: 'Pending' }
    ]);
    await db.updateCampaignRecipient(campaignId, { phone: '905320000033' }, 'sent');
    const pauseUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.updateCampaignRuntimeState(campaignId, {
        pause_until: pauseUntil,
        pause_reason: 'batch_pause'
    });

    const stopped = await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.pause_until, pauseUntil);
    assert.equal(stopped.pause_reason, 'batch_pause');

    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    assert.equal(prepared.status, 'queued');
    assert.equal(prepared.pause_until, pauseUntil);
    assert.equal(prepared.pause_reason, 'batch_pause');

    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);
});

test('resuming during active batch pause waits instead of sending immediately', async () => {
    const campaignId = 'resume-waits-for-batch-pause';
    const sent = [];
    await createRun(campaignId, [
        { phone: '905320000035', name: 'Sent' },
        { phone: '905320000036', name: 'Pending' }
    ]);
    await db.updateCampaignRecipient(campaignId, { phone: '905320000035' }, 'sent');
    const pauseUntil = new Date(Date.now() + 500).toISOString();
    await db.updateCampaignRuntimeState(campaignId, {
        pause_until: pauseUntil,
        pause_reason: 'batch_pause'
    });
    await db.stopCampaignRun(campaignId, ownerEmail, tenantId);

    const unsent = await db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending', 'failed'], tenantId);
    const prepared = await db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
    const pauseEvents = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };
    const socket = {
        emit(event, payload) {
            if (event === 'campaign-progress' && payload.phase === 'batch_pause') pauseEvents.push(payload);
        }
    };
    let stopPromise = null;
    setTimeout(() => {
        stopCampaign(campaignId);
        stopPromise = db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    }, 30);

    await sendBulkWithProgress(
        sock,
        unsent,
        'Merhaba {{ad}}',
        socket,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 250,
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: prepared,
            typingDelayMs: 0,
            stopPollMs: 10,
            disableNightMode: true
        }
    );
    if (stopPromise) await stopPromise;

    assert.equal(sent.length, 0);
    assert.equal(pauseEvents.length, 1);
    assert.equal(pauseEvents[0].batch_pause_until, pauseUntil);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.status, 'stopped');
    assert.equal(final.pause_until, pauseUntil);
    assert.equal(final.pause_reason, 'batch_pause');
});

test('inter-message random wait emits countdown deadline state', async () => {
    const campaignId = 'inter-message-countdown';
    const waitLogs = [];
    const waitProgress = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async () => {}
    };
    const socket = {
        emit(event, payload) {
            if (event === 'log' && payload.phase === 'inter_message_wait') waitLogs.push(payload);
            if (event === 'campaign-progress' && payload.phase === 'inter_message_wait') waitProgress.push(payload);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000040', name: 'A' },
            { phone: '905320000041', name: 'B' }
        ],
        'Merhaba {{ad}}',
        socket,
        [5, 5],
        [],
        campaignId,
        {
            dailyLimit: 250,
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(waitLogs.length, 1);
    assert.equal(waitLogs[0].wait_seconds, 5);
    assert.ok(Date.parse(waitLogs[0].wait_until) >= 0);
    assert.equal(waitProgress.length, 1);
    assert.equal(waitProgress[0].wait_seconds, 5);
    assert.equal(waitProgress[0].wait_until, waitLogs[0].wait_until);
});

test('long pause is inserted after configured successful sends and takes precedence over batch pause', async () => {
    const campaignId = 'long-pause-visible-state';
    const sent = [];
    const pauseEvents = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };
    const socket = {
        emit(event, payload) {
            if (event === 'log' && payload.long_pause_until) pauseEvents.push(payload);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000050', name: 'A' },
            { phone: '905320000051', name: 'B' },
            { phone: '905320000052', name: 'C' }
        ],
        'Merhaba {{ad}}',
        socket,
        [5, 5],
        [],
        campaignId,
        {
            batchSize: 2,
            batchPauseMinutes: 1,
            longPauseSize: 2,
            longPauseMinutes: 65,
            tenantId,
            typingDelayMs: 0,
            stopPollMs: 10,
            delayScale: 0,
            disableNightMode: true,
            sleep: async () => {}
        }
    );

    assert.equal(sent.length, 3);
    assert.equal(pauseEvents.length, 1);
    assert.equal(pauseEvents[0].pause_reason, 'long_pause');
    assert.match(pauseEvents[0].message, /65 dk bekleme sınırına geldiniz/);
});

test('night pause prevents sending between 21:00 and 10:00 Turkey time', async () => {
    const campaignId = 'night-pause-visible-state';
    await createRun(campaignId, [{ phone: '905320000053', name: 'Night' }]);
    const sent = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };
    let stopPromise = null;
    setTimeout(() => {
        stopCampaign(campaignId);
        stopPromise = db.stopCampaignRun(campaignId, ownerEmail, tenantId);
    }, 30);

    await sendBulkWithProgress(
        sock,
        [{ phone: '905320000053', name: 'Night' }],
        'Merhaba {{ad}}',
        null,
        [5, 5],
        [],
        campaignId,
        {
            tenantId,
            campaignStore: campaignStore(),
            initialStatus: await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId),
            typingDelayMs: 0,
            stopPollMs: 10,
            now: () => new Date('2099-01-01T19:30:00.000Z')
        }
    );
    if (stopPromise) await stopPromise;

    assert.equal(sent.length, 0);
    const final = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.equal(final.status, 'stopped');
    assert.equal(final.pause_reason, 'night_pause');
    assert.ok(final.pause_until);
});

test('campaign inserts automatic batch pause after configured successful sends', async () => {
    const campaignId = 'batch-pause';
    const sent = [];
    const pauseEvents = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            sent.push(phone);
        }
    };
    const socket = {
        emit(event, payload) {
            if (event === 'log' && Object.prototype.hasOwnProperty.call(payload, 'batch_pause_until')) pauseEvents.push(payload);
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
    assert.equal(pauseEvents.length, 2);
    assert.ok(pauseEvents[0].batch_pause_until);
    assert.equal(pauseEvents[0].batch_pause_minutes, 1);
    assert.equal(pauseEvents[0].message, '2 gönderim tamamlandı. 1 dk sonra devam edecek.');
    assert.equal(pauseEvents[1].batch_pause_until, null);
});

test('failed recipients do not count toward automatic batch pause threshold', async () => {
    const campaignId = 'batch-pause-success-only';
    const sent = [];
    const attempted = [];
    const pauseEvents = [];
    const sock = {
        onWhatsApp: async () => [{ exists: true }],
        sendPresenceUpdate: async () => {},
        sendMessage: async (phone) => {
            attempted.push(phone);
            if (String(phone).includes('905320000023')) {
                throw new Error('Simule gonderim hatasi');
            }
            sent.push(phone);
        }
    };
    const socket = {
        emit(event, payload) {
            if (event === 'log' && Object.prototype.hasOwnProperty.call(payload, 'batch_pause_until')) pauseEvents.push(payload);
        }
    };

    await sendBulkWithProgress(
        sock,
        [
            { phone: '905320000023', name: 'Fail' },
            { phone: '905320000024', name: 'A' },
            { phone: '905320000025', name: 'B' },
            { phone: '905320000026', name: 'C' }
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

    assert.equal(attempted.length, 4);
    assert.equal(sent.length, 3);
    const startedPauses = pauseEvents.filter(event => event.batch_pause_until);
    assert.equal(startedPauses.length, 1);
    assert.equal(startedPauses[0].message, '2 gönderim tamamlandı. 1 dk sonra devam edecek.');
});

test('resume keeps campaign media when the upload store was cleared', async () => {
    const campaignId = 'resume-keeps-media';
    const mediaFiles = [{ path: 'uploads/default/video.mp4', name: 'video.mp4', mimetype: 'video/mp4', size: 10 }];
    await db.createCampaignRun({
        id: campaignId,
        tenantId,
        ownerEmail,
        contacts: [{ phone: '905320000071', name: 'Ali' }],
        message: '',
        delayRange: [20, 90],
        dailyLimit: 50,
        mediaCount: 1,
        mediaFiles
    });
    await db.updateCampaignRecipient(campaignId, { phone: '905320000071' }, 'sent', null, tenantId);
    await db.setCampaignRunStatus(campaignId, 'paused');

    const service = new CampaignService({
        db,
        mediaStore: new MediaStore({ filePath: null }),
        runtime: { connected: () => true, getSocket: () => ({}) },
        logger: { info: () => {}, error: () => {} }
    });
    const socket = { request: { session: { user: { email: ownerEmail, tenant_id: tenantId } } }, emit: () => {} };

    await assert.rejects(
        () => service.resume(campaignId, ownerEmail, socket, { tenantId }),
        err => err.code === 'CAMPAIGN_RESUME_EMPTY'
    );
    const run = await db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
    assert.deepEqual(run.metadata.media_files, mediaFiles);
    await db.setCampaignRunStatus(campaignId, 'finished');
});

test('delivery status only moves forward and records video plays', async () => {
    await createRun('delivery-status-run');
    await db.setRecipientMessageId('delivery-status-run', '905320000000', 'MSG-DELIVERY');

    await db.updateDeliveryStatus('MSG-DELIVERY', 'read');
    let row = await db.updateDeliveryStatus('MSG-DELIVERY', 'delivered');
    assert.equal(row.delivery_status, 'read');

    row = await db.updateDeliveryStatus('MSG-DELIVERY', 'played');
    assert.equal(row.delivery_status, 'played');

    row = await db.updateDeliveryStatus('MSG-DELIVERY', 'server_ack');
    assert.equal(row.delivery_status, 'played');

    // Medya gönderiminde message_id gecikmeli yazılır; önceden gelen bildirimler kaybolmamalı.
    assert.equal(await db.updateDeliveryStatus('MSG-EARLY', 'server_ack'), null);
    assert.equal(await db.updateDeliveryStatus('MSG-EARLY', 'delivered'), null);

    await db.setRecipientMessageId('delivery-status-run', '905320000000', 'MSG-EARLY');

    row = await db.updateDeliveryStatus('MSG-EARLY', 'server_ack');
    assert.equal(row.delivery_status, 'delivered');
});
