const { v4: uuidv4 } = require('uuid');
const {
    sendBulkWithProgress,
    stopCampaign,
    finishCampaign
} = require('../lib/messenger');
const { badRequest, createApiError } = require('../lib/api_errors');
const { componentLogger } = require('../lib/logger');
const {
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_BATCH_SIZE,
    DEFAULT_LONG_PAUSE_MINUTES,
    DEFAULT_LONG_PAUSE_SIZE,
    estimateRemainingMinutes
} = require('../lib/campaign_estimate');
const { renderTemplate, validateTemplate } = require('../shared/message_renderer');

function getOwnerFromSocket(socket) {
    return String(socket?.request?.session?.user?.email || '').trim();
}

function getTenantFromSocket(socket) {
    return String(socket?.request?.session?.user?.tenant_id || 'default').trim() || 'default';
}

function activeKey(ownerEmail, tenantId = 'default') {
    return `${tenantId}:${ownerEmail}`;
}

function getDelayRangeFromRun(run) {
    const fallback = [20, 90];
    if (!run) return fallback;
    const min = Number(run.delay_min_ms || 0);
    const max = Number(run.delay_max_ms || 0);
    if (min <= 0 || max <= 0) return fallback;
    return [Math.max(1, Math.round(min / 1000)), Math.max(1, Math.round(max / 1000))];
}

function getMediaFilesFromRun(run) {
    const files = run?.metadata?.media_files;
    return Array.isArray(files) ? files : [];
}

function assertValidCampaignMessage(message, sampleContact = {}) {
    const validation = validateTemplate(message);
    if (!validation.valid) {
        throw badRequest('Mesaj şablonu geçersiz', 'TEMPLATE_SYNTAX_INVALID', validation.issues);
    }

    const rendered = renderTemplate(message, sampleContact, { choiceMode: 'first' }).text;
    if (!rendered) throw badRequest('Mesaj şablonu boş sonuç üretiyor', 'TEMPLATE_RENDER_EMPTY');
    return rendered;
}

function conflict(message, code) {
    return createApiError(409, message, code);
}

function recipientName(contact = {}) {
    return `${contact.name || ''} ${contact.surname || ''}`.trim() || contact.name || '';
}

function unavailableReportFromContacts(contacts = []) {
    return contacts.map(contact => ({
        name: recipientName(contact),
        phone: contact.phone || contact.normalized_phone || '',
        reason: 'WhatsApp yok'
    }));
}

function unavailableLogMessage(contacts = []) {
    const phones = contacts
        .map(contact => contact.phone || contact.normalized_phone)
        .filter(Boolean);
    const preview = phones.slice(0, 10).join(', ');
    const suffix = phones.length > 10 ? ` ve ${phones.length - 10} numara daha` : '';
    return `WhatsApp kullanmayan ${phones.length} numara gönderim kuyruğundan ayrıldı${preview ? `: ${preview}${suffix}` : '.'}`;
}

function suppressedReportFromContacts(contacts = []) {
    return contacts.map(contact => ({
        name: recipientName(contact),
        phone: contact.phone || contact.normalized_phone || '',
        reason: 'Manuel gönderim dışı'
    }));
}

function suppressedLogMessage(contacts = []) {
    const phones = contacts
        .map(contact => contact.phone || contact.normalized_phone)
        .filter(Boolean);
    const preview = phones.slice(0, 10).join(', ');
    const suffix = phones.length > 10 ? ` ve ${phones.length - 10} numara daha` : '';
    return `Manuel gönderim dışı bırakılmış ${phones.length} numara kuyruktan ayrıldı${preview ? `: ${preview}${suffix}` : '.'}`;
}

function campaignEventMetadata(campaignId, run = {}, extra = {}) {
    return {
        campaign_id: campaignId,
        status: run.status || extra.status || null,
        total_count: Number(run.total ?? run.total_count ?? extra.total_count ?? 0),
        sent_count: Number(run.sent_count ?? extra.sent_count ?? 0),
        failed_count: Number(run.failed_count ?? extra.failed_count ?? 0),
        skipped_count: Number(run.skipped_count ?? extra.skipped_count ?? 0),
        cooldown_skipped_count: Number(run.cooldown_skipped_count ?? extra.cooldown_skipped_count ?? 0),
        not_on_whatsapp_count: Number(run.not_on_whatsapp_count ?? extra.not_on_whatsapp_count ?? 0),
        suppressed_count: Number(run.suppressed_count ?? extra.suppressed_count ?? 0),
        validation_unknown_count: Number(run.validation_unknown_count ?? extra.validation_unknown_count ?? 0),
        ...extra
    };
}

function normalizeCampaignLimits(data = {}) {
    const dailyLimit = data.dailyLimit === undefined || data.dailyLimit === null || data.dailyLimit === ''
        ? 50
        : Number.parseInt(data.dailyLimit, 10);
    if (!Number.isFinite(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) {
        throw badRequest('Uzun mola sınırı 1 ile 500 mesaj arasında olmalı', 'CAMPAIGN_DAILY_LIMIT_INVALID');
    }

    const delayRange = Array.isArray(data.delayRange) ? data.delayRange : [20, 90];
    const minDelay = Number.parseInt(delayRange[0], 10);
    const maxDelay = Number.parseInt(delayRange[1], 10);
    if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay) || minDelay < 5 || maxDelay > 3600 || minDelay > maxDelay) {
        throw badRequest('Gecikme aralığı 5 ile 3600 saniye arasında ve min <= max olmalı', 'CAMPAIGN_DELAY_RANGE_INVALID');
    }

    return { dailyLimit, delayRange: [minDelay, maxDelay] };
}

function resolveBatchSettings(data = {}) {
    const batchSize = Number.parseInt(data.batchSize ?? process.env.CAMPAIGN_BATCH_SIZE ?? DEFAULT_BATCH_SIZE, 10);
    const batchPauseMinutes = Number.parseInt(data.batchPauseMinutes ?? process.env.CAMPAIGN_BATCH_PAUSE_MINUTES ?? DEFAULT_BATCH_PAUSE_MINUTES, 10);
    return {
        batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.min(batchSize, 500) : DEFAULT_BATCH_SIZE,
        batchPauseMinutes: Number.isFinite(batchPauseMinutes) && batchPauseMinutes > 0 ? Math.min(batchPauseMinutes, 1440) : DEFAULT_BATCH_PAUSE_MINUTES
    };
}

function resolveLongPauseSettings(data = {}) {
    const longPauseSize = Number.parseInt(data.longPauseSize ?? data.dailyLimit ?? process.env.CAMPAIGN_LONG_PAUSE_SIZE ?? DEFAULT_LONG_PAUSE_SIZE, 10);
    const longPauseMinutes = Number.parseInt(data.longPauseMinutes ?? process.env.CAMPAIGN_LONG_PAUSE_MINUTES ?? DEFAULT_LONG_PAUSE_MINUTES, 10);
    return {
        longPauseSize: Number.isFinite(longPauseSize) && longPauseSize > 0 ? Math.min(longPauseSize, 5000) : DEFAULT_LONG_PAUSE_SIZE,
        longPauseMinutes: Number.isFinite(longPauseMinutes) && longPauseMinutes > 0 ? Math.min(longPauseMinutes, 1440) : DEFAULT_LONG_PAUSE_MINUTES
    };
}

class CampaignService {
    constructor(options = {}) {
        this.db = options.db;
        this.runtime = options.runtime;
        this.mediaStore = options.mediaStore;
        this.keepAwake = options.keepAwake || null;
        this.logger = options.logger || componentLogger('campaign_service');
        this.activeRunIds = new Map();
        this.pauseRecoveryTimer = null;
        this.recoveringPauseRunIds = new Set();
    }

    assertNoInMemoryActive(ownerEmail, tenantId, allowCampaignId = null) {
        const activeRunId = this.activeRunIds.get(activeKey(ownerEmail, tenantId));
        if (activeRunId && activeRunId !== allowCampaignId) {
            throw conflict('Bu kullanıcı için zaten aktif bir kampanya var', 'CAMPAIGN_ALREADY_ACTIVE');
        }
    }

    async audit(action, campaignId, metadata = {}, tenantId = 'default') {
        if (!this.db?.addAuditLog) return;
        try {
            await this.db.addAuditLog(action, 'campaign', campaignId, metadata, tenantId);
        } catch (err) {
            this.logger.error({ err, tenantId, campaignId, auditAction: action }, 'audit_log_write_failed');
        }
    }

    async systemEvent(eventType, severity, message, metadata = {}, tenantId = 'default') {
        if (!this.db?.addSystemEvent) return;
        try {
            await this.db.addSystemEvent(tenantId, eventType, severity, message, metadata);
        } catch (err) {
            this.logger.error({ err, tenantId, eventType }, 'system_event_write_failed');
        }
    }

    async recordCampaignTerminalEvent(campaignId, tenantId = 'default', extraMetadata = {}) {
        const { skip_if_stopped: skipIfStopped, ...eventMetadata } = extraMetadata;
        let run = null;
        try {
            run = await this.db.getCampaignRunStatus(campaignId, null, tenantId);
        } catch (err) {
            this.logger.error({ err, tenantId, campaignId }, 'campaign_terminal_status_read_failed');
        }
        const status = run?.status || eventMetadata.status || 'paused';
        if (['stopped', 'finished'].includes(status) && skipIfStopped) return run;
        const eventTypeByStatus = {
            completed: 'campaign_completed',
            paused: 'campaign_paused',
            stopped: 'campaign_stopped',
            finished: 'campaign_finished'
        };
        const eventType = eventTypeByStatus[status] || 'campaign_paused';
        const severity = status === 'completed' ? 'info' : eventMetadata.error ? 'error' : 'warn';
        const messageByStatus = {
            completed: 'Kampanya tamamlandı.',
            paused: eventMetadata.error ? 'Kampanya hata nedeniyle duraklatıldı.' : 'Kampanya duraklatıldı.',
            stopped: 'Kampanya durduruldu.',
            finished: 'Kampanya bitirildi.'
        };
        await this.systemEvent(
            eventType,
            severity,
            messageByStatus[status] || 'Kampanya duraklatıldı.',
            campaignEventMetadata(campaignId, run || {}, eventMetadata),
            tenantId
        );
        return run;
    }

    async start(data = {}, socket) {
        const ownerEmail = getOwnerFromSocket(socket);
        const tenantId = getTenantFromSocket(socket);
        if (!ownerEmail) throw badRequest('Oturum sahibi doğrulanamadı', 'CAMPAIGN_OWNER_REQUIRED');
        const contacts = Array.isArray(data.contacts) ? data.contacts : [];
        const message = String(data.message || '').trim();
        if (contacts.length === 0) throw badRequest('Gönderilecek kişi yok', 'CAMPAIGN_CONTACTS_REQUIRED');
        this.assertNoInMemoryActive(ownerEmail, tenantId);

        const sock = this.assertConnected(tenantId);

        const mediaFiles = this.mediaStore.list(tenantId);
        if (!message && mediaFiles.length === 0) throw badRequest('Mesaj içeriği veya en az bir görsel gereklidir', 'CAMPAIGN_CONTENT_REQUIRED');
        if (message) assertValidCampaignMessage(message, contacts[0]);
        const campaignId = uuidv4();
        const { dailyLimit, delayRange } = normalizeCampaignLimits(data);
        const batchSettings = resolveBatchSettings(data);
        const longPauseSettings = resolveLongPauseSettings(data);
        const activeKeyValue = activeKey(ownerEmail, tenantId);

        const run = await this.db.createCampaignRun({
            id: campaignId,
            tenantId,
            ownerEmail,
            contacts,
            message,
            delayRange,
            dailyLimit,
            batchSize: batchSettings.batchSize,
            batchPauseMinutes: batchSettings.batchPauseMinutes,
            longPauseSize: longPauseSettings.longPauseSize,
            longPauseMinutes: longPauseSettings.longPauseMinutes,
            mediaCount: mediaFiles.length,
            mediaFiles: mediaFiles.map(file => ({
                path: file.path,
                name: file.name,
                mimetype: file.mimetype,
                size: file.size
            }))
        });
        this.activeRunIds.set(activeKeyValue, campaignId);
        this.keepAwake?.start(activeKeyValue);
        await this.audit('campaign_started', campaignId, {
            total_count: contacts.length,
            daily_limit: dailyLimit,
            delay_range: delayRange,
            batch_size: batchSettings.batchSize,
            batch_pause_minutes: batchSettings.batchPauseMinutes,
            long_pause_size: longPauseSettings.longPauseSize,
            long_pause_minutes: longPauseSettings.longPauseMinutes,
            media_count: mediaFiles.length
        }, tenantId);
        await this.systemEvent('campaign_started', 'info', 'Kampanya başlatıldı.', {
            campaign_id: campaignId,
            total_count: contacts.length,
            media_count: mediaFiles.length,
            batch_size: batchSettings.batchSize,
            batch_pause_minutes: batchSettings.batchPauseMinutes,
            long_pause_size: longPauseSettings.longPauseSize,
            long_pause_minutes: longPauseSettings.longPauseMinutes
        }, tenantId);

        this.logger.info({ campaignId, tenantId, ownerEmail, contactCount: contacts.length, mediaCount: mediaFiles.length }, 'campaign_started');
        socket.emit('campaign-started', { campaignId, status: run });
        socket.emit('log', { type: 'info', message: '🚀 Gönderim kuyruğu başladı.' });

        const sendableContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending'], tenantId);
        const unavailableContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['not_on_whatsapp'], tenantId);
        const suppressedContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['suppressed'], tenantId);
        const unavailableReport = unavailableReportFromContacts(unavailableContacts);
        const suppressedReport = suppressedReportFromContacts(suppressedContacts);
        const initialSkippedReport = [...unavailableReport, ...suppressedReport];
        if (unavailableContacts.length > 0) {
            const message = unavailableLogMessage(unavailableContacts);
            await this.db.addCampaignLog(campaignId, 'error', message, run.progress, {
                skippedReport: unavailableReport,
                notOnWhatsAppCount: unavailableContacts.length,
                phase: 'not_on_whatsapp'
            });
            socket.emit('log', {
                type: 'error',
                message,
                skippedReport: unavailableReport,
                notOnWhatsAppCount: unavailableContacts.length,
                phase: 'not_on_whatsapp'
            });
        }
        if (suppressedContacts.length > 0) {
            const message = suppressedLogMessage(suppressedContacts);
            await this.db.addCampaignLog(campaignId, 'warn', message, run.progress, {
                skippedReport: suppressedReport,
                suppressedCount: suppressedContacts.length,
                phase: 'suppressed'
            });
            socket.emit('log', {
                type: 'warn',
                message,
                skippedReport: suppressedReport,
                suppressedCount: suppressedContacts.length,
                phase: 'suppressed'
            });
        }

        if (sendableContacts.length === 0) {
            const completed = await this.setRunStatus(campaignId, 'completed');
            socket.emit('campaign-progress', {
                processed: completed.processed,
                total: completed.total,
                sent: completed.sent_count,
                failed: completed.failed_count,
                skipped: completed.skipped_count,
                not_on_whatsapp: completed.not_on_whatsapp_count,
                suppressed: completed.suppressed_count,
                validation_unknown: completed.validation_unknown_count,
                progress: 100,
                phase: 'excluded'
            });
            socket.emit('log', {
                type: 'success',
                message: 'Gönderilecek uygun kişi yok. WhatsApp kullanmayan veya manuel dışlanan numaralar kuyruktan ayrıldı.',
                progress: 100,
                done: true,
                sentCount: 0,
                totalCount: completed.total,
                skippedReport: initialSkippedReport,
                notOnWhatsAppCount: completed.not_on_whatsapp_count,
                suppressedCount: completed.suppressed_count
            });
            await this.audit('campaign_completed', campaignId, {
                total_count: completed.total,
                not_on_whatsapp_count: completed.not_on_whatsapp_count,
                suppressed_count: completed.suppressed_count,
                sent_count: 0
            }, tenantId);
            await this.systemEvent('campaign_completed', 'info', 'Kampanya tamamlandı; gönderilecek uygun kişi yoktu.', campaignEventMetadata(campaignId, completed), tenantId);
            this.mediaStore.clear(tenantId);
            this.activeRunIds.delete(activeKeyValue);
            this.keepAwake?.stop(activeKeyValue);
            return;
        }

        try {
            await sendBulkWithProgress(sock, sendableContacts, message, socket, delayRange, mediaFiles, campaignId, {
                dailyLimit,
                batchSize: batchSettings.batchSize,
                batchPauseMinutes: batchSettings.batchPauseMinutes,
                longPauseSize: longPauseSettings.longPauseSize,
                longPauseMinutes: longPauseSettings.longPauseMinutes,
                campaignStore: this,
                tenantId,
                overrideCooldown: Array.isArray(data.overrideCooldown) ? data.overrideCooldown : [],
                initialStatus: run,
                initialSkippedReport
            });
            await this.recordCampaignTerminalEvent(campaignId, tenantId, { skip_if_stopped: true });
            this.mediaStore.clear(tenantId);
            this.activeRunIds.delete(activeKeyValue);
            this.keepAwake?.stop(activeKeyValue);
        } catch (err) {
            await this.setRunStatus(campaignId, 'paused', { error: err.message });
            await this.recordCampaignTerminalEvent(campaignId, tenantId, { error: err.message });
            this.activeRunIds.delete(activeKeyValue);
            this.keepAwake?.stop(activeKeyValue);
            throw err;
        }
    }

    async stopActive(ownerEmail, campaignId = null, tenantId = 'default') {
        const stoppedRun = campaignId
            ? await this.db.stopCampaignRun(campaignId, ownerEmail, tenantId)
            : await this.db.stopLatestRunningCampaign(ownerEmail, tenantId);
        const key = activeKey(ownerEmail, tenantId);
        const activeRunId = this.activeRunIds.get(key);
        if (activeRunId) stopCampaign(activeRunId);
        if (stoppedRun?.id) stopCampaign(stoppedRun.id);
        if (stoppedRun) {
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
            this.logger.info({ campaignId: stoppedRun?.id, tenantId, ownerEmail }, 'campaign_stopped_by_user');
            await this.audit('campaign_stopped', stoppedRun.id, {
                status: stoppedRun.status,
                processed: stoppedRun.processed,
                total: stoppedRun.total
            }, tenantId);
            await this.systemEvent('campaign_stopped', 'warn', 'Kampanya kullanıcı tarafından durduruldu.', campaignEventMetadata(stoppedRun.id, stoppedRun), tenantId);
        }
        return stoppedRun;
    }

    async finish(campaignId, ownerEmail, tenantId = 'default') {
        if (!campaignId) throw badRequest('Bitirilecek kampanya bulunamadı', 'CAMPAIGN_ID_REQUIRED');
        const finishedRun = await this.db.finishCampaignRun(campaignId, ownerEmail, tenantId);
        const key = activeKey(ownerEmail, tenantId);
        const activeRunId = this.activeRunIds.get(key);
        if (activeRunId === campaignId) {
            finishCampaign(activeRunId);
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
        } else {
            finishCampaign(campaignId);
        }
        this.logger.info({ campaignId, tenantId, ownerEmail }, 'campaign_finished_by_user');
        await this.audit('campaign_finished', campaignId, {
            status: finishedRun?.status,
            processed: finishedRun?.processed,
            total: finishedRun?.total
        }, tenantId);
        await this.systemEvent('campaign_finished', 'warn', 'Kampanya kullanıcı tarafından bitirildi; tekrar gönderim yapılmayacak.', campaignEventMetadata(campaignId, finishedRun), tenantId);
        return finishedRun;
    }

    assertConnected(tenantId = 'default') {
        const sock = this.runtime.getSocket(tenantId);
        if (!this.runtime.connected(tenantId) || !sock) throw badRequest('Bağlı değil!', 'WHATSAPP_NOT_CONNECTED');
        return sock;
    }

    getLatestStatus(ownerEmail, tenantId = 'default') {
        return this.db.getLatestCampaignRunStatus(ownerEmail, tenantId);
    }

    async assertNotFinished(campaignId, ownerEmail, tenantId = 'default') {
        const run = await this.db.getCampaignRunStatus(campaignId, ownerEmail, tenantId);
        if (run?.status === 'finished') {
            throw conflict('Bu kampanya bitirildi; tekrar mesaj gönderilemez', 'CAMPAIGN_FINISHED');
        }
        return run;
    }

    async resume(campaignId, ownerEmail, socket, options = {}) {
        const tenantId = options.tenantId || getTenantFromSocket(socket);
        await this.assertNotFinished(campaignId, ownerEmail, tenantId);
        this.assertConnected(tenantId);
        this.assertNoInMemoryActive(ownerEmail, tenantId, campaignId);

        // Resume sirasinda guncel media store icerigini campaign metadata'sina yazalim
        const currentMedia = this.mediaStore.list(tenantId);
        await this.db.updateCampaignMediaFiles(campaignId, currentMedia.map(file => ({
            path: file.path,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size
        })));

        const unsentContacts = await this.db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId);
        if (unsentContacts.length === 0) {
            throw badRequest('Devam edilecek bekleyen kişi yok. Gönderilmeyenler için "Gönderilmeyenlere Tekrar Gönder" butonunu kullanın.', 'CAMPAIGN_RESUME_EMPTY');
        }
        this.logger.info({ campaignId, tenantId, ownerEmail, unsentCount: unsentContacts.length }, 'campaign_resumed');
        await this.systemEvent('campaign_resumed', 'info', 'Kampanya kaldığı yerden devam etti.', {
            campaign_id: campaignId,
            restart_contact_count: unsentContacts.length
        }, tenantId);
        const run = await this.db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'resume', tenantId);
        const execution = this.runExistingCampaign(run, unsentContacts, ownerEmail, tenantId, socket, 'Kampanya kaldığı yerden devam ediyor.');
        if (options.detached) {
            execution.catch(err => this.logger.error({ err, tenantId, campaignId }, 'campaign_resume_failed'));
            return run;
        }
        return execution;
    }

    async retry(campaignId, ownerEmail, socket, options = {}) {
        const tenantId = options.tenantId || getTenantFromSocket(socket);
        await this.assertNotFinished(campaignId, ownerEmail, tenantId);
        this.assertConnected(tenantId);
        this.assertNoInMemoryActive(ownerEmail, tenantId, campaignId);

        // Retry sirasinda guncel media store icerigini campaign metadata'sina yazalim
        const currentMedia = this.mediaStore.list(tenantId);
        await this.db.updateCampaignMediaFiles(campaignId, currentMedia.map(file => ({
            path: file.path,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size
        })));

        const failedContacts = await this.db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'retry', tenantId);
        if (failedContacts.length === 0) {
            const pendingContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending'], tenantId);
            const firstPassPending = pendingContacts.filter(contact => Number(contact.attempt_count || 0) === 0);
            if (firstPassPending.length > 0) throw badRequest('Önce sıradaki hiç denenmemiş numaralar tamamlanmalı. "Devam Et" butonunu kullanın.', 'CAMPAIGN_FIRST_PASS_PENDING');
            if (pendingContacts.length > 0) throw badRequest('Gönderilmeyen kişi yok. Kampanya beklemede — "Devam Et" butonunu kullanın.', 'CAMPAIGN_RETRY_EMPTY');
            throw badRequest('Tekrar gönderilecek güncel gönderilmeyen kişi yok.', 'CAMPAIGN_RETRY_EMPTY');
        }
        this.logger.info({ campaignId, tenantId, ownerEmail, failedCount: failedContacts.length }, 'campaign_unsent_retried');
        await this.systemEvent('campaign_retry_started', 'info', 'Gönderilmeyen kişiler tekrar gönderime alındı.', {
            campaign_id: campaignId,
            restart_contact_count: failedContacts.length
        }, tenantId);
        const run = await this.db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'retry', tenantId);
        const execution = this.runExistingCampaign(run, failedContacts, ownerEmail, tenantId, socket, 'Gönderilmeyen kişiler yeniden gönderim kuyruğuna alındı.');
        if (options.detached) {
            execution.catch(err => this.logger.error({ err, tenantId, campaignId }, 'campaign_retry_failed'));
            return run;
        }
        return execution;
    }

    async retrySkipped(campaignId, ownerEmail, socket, options = {}) {
        const tenantId = options.tenantId || getTenantFromSocket(socket);
        await this.assertNotFinished(campaignId, ownerEmail, tenantId);
        this.assertConnected(tenantId);
        this.assertNoInMemoryActive(ownerEmail, tenantId, campaignId);

        // RetrySkipped sirasinda guncel media store icerigini campaign metadata'sina yazalim
        const currentMedia = this.mediaStore.list(tenantId);
        await this.db.updateCampaignMediaFiles(campaignId, currentMedia.map(file => ({
            path: file.path,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size
        })));

        const skippedContacts = await this.db.getRetryableSkippedCampaignRecipients(campaignId, ownerEmail, tenantId);
        if (skippedContacts.length === 0) {
            throw badRequest(
                'Tekrar denenecek uygun atlanan kişi yok. Önce hiç denenmemiş numaralar tamamlanmalı; sonra cooldown süresi dolan atlananlar denenebilir. WhatsApp olmayanlar, gönderilmeyenler ve manuel dışlananlar bu listeye girmez.',
                'CAMPAIGN_RETRY_SKIPPED_EMPTY'
            );
        }
        this.logger.info({ campaignId, tenantId, ownerEmail, skippedCount: skippedContacts.length }, 'campaign_skipped_retried');
        await this.systemEvent('campaign_retry_skipped_started', 'info', 'Atlanan kişiler tekrar denemeye alındı.', {
            campaign_id: campaignId,
            restart_contact_count: skippedContacts.length
        }, tenantId);
        const run = await this.db.prepareSkippedCampaignRunForRetry(campaignId, ownerEmail, skippedContacts, tenantId);
        const execution = this.runExistingCampaign(run, skippedContacts, ownerEmail, tenantId, socket, 'Atlanan kişiler yeniden kuyruğa alındı.');
        if (options.detached) {
            execution.catch(err => this.logger.error({ err, tenantId, campaignId }, 'campaign_retry_skipped_failed'));
            return run;
        }
        return execution;
    }

    async runExistingCampaign(run, contacts, ownerEmail, tenantId, socket, message) {
        const sock = this.assertConnected(tenantId);
        if (!run?.id) throw badRequest('Kampanya bulunamadı', 'CAMPAIGN_NOT_FOUND');
        const runMessage = String(run.message || '').trim();
        const hasRunMedia = getMediaFilesFromRun(run).length > 0;
        if (!runMessage && !hasRunMedia) throw badRequest('Kampanya mesaj içeriği bulunamadı', 'CAMPAIGN_CONTENT_REQUIRED');
        if (runMessage) assertValidCampaignMessage(run.message, contacts[0]);

        const key = activeKey(ownerEmail, tenantId);
        const emitter = socket || {
            emit: (event, payload) => this.runtime?.emitToTenant?.(event, payload, tenantId)
        };
        const batchSettings = resolveBatchSettings({
            batchSize: run.metadata?.batch_size,
            batchPauseMinutes: process.env.CAMPAIGN_BATCH_PAUSE_MINUTES ?? run.metadata?.batch_pause_minutes
        });
        const longPauseSettings = resolveLongPauseSettings({
            dailyLimit: run.daily_limit,
            longPauseSize: process.env.CAMPAIGN_LONG_PAUSE_SIZE ?? run.metadata?.long_pause_size ?? run.daily_limit,
            longPauseMinutes: process.env.CAMPAIGN_LONG_PAUSE_MINUTES ?? run.metadata?.long_pause_minutes
        });
        this.activeRunIds.set(key, run.id);
        this.keepAwake?.start(key);
        emitter.emit('campaign-started', { campaignId: run.id, status: run });
        emitter.emit('log', {
            type: 'info',
            message,
            estimate_remaining_minutes: estimateRemainingMinutes({
                remaining: contacts.length,
                delay_min_ms: run.delay_min_ms,
                delay_max_ms: run.delay_max_ms,
                batchSize: batchSettings.batchSize,
                batchPauseMinutes: batchSettings.batchPauseMinutes,
                longPauseSize: longPauseSettings.longPauseSize,
                longPauseMinutes: longPauseSettings.longPauseMinutes
            })
        });

        try {
            await sendBulkWithProgress(
                sock,
                contacts,
                run.message,
                emitter,
                getDelayRangeFromRun(run),
                getMediaFilesFromRun(run),
                run.id,
                {
                    dailyLimit: Number(run.daily_limit || 50),
                    batchSize: batchSettings.batchSize,
                    batchPauseMinutes: batchSettings.batchPauseMinutes,
                    longPauseSize: longPauseSettings.longPauseSize,
                    longPauseMinutes: longPauseSettings.longPauseMinutes,
                    campaignStore: this,
                    tenantId,
                    initialStatus: run
                }
            );
            await this.recordCampaignTerminalEvent(run.id, tenantId, { skip_if_stopped: true });
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
        } catch (err) {
            await this.setRunStatus(run.id, 'paused', { error: err.message });
            await this.recordCampaignTerminalEvent(run.id, tenantId, { error: err.message });
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
            throw err;
        }
    }

    setRunStatus(campaignId, status, metadata = {}) {
        return this.db.setCampaignRunStatus(campaignId, status, metadata);
    }

    getRunStatus(campaignId) {
        return this.db.getCampaignRunStatus(campaignId);
    }

    updateRuntimeState(campaignId, state = {}) {
        return this.db.updateCampaignRuntimeState(campaignId, state);
    }

    addLog(campaignId, type, message, progress, metadata = {}) {
        return this.db.addCampaignLog(campaignId, type, message, progress, metadata);
    }

    markRecipient(campaignId, contact, status, error = null) {
        return this.db.updateCampaignRecipient(campaignId, contact, status, error);
    }

    recordRecipientResult(campaignId, result = {}) {
        return this.db.recordCampaignRecipientResult(campaignId, result);
    }

    startBatchPauseRecovery(options = {}) {
        const intervalMs = Math.max(10000, Number.parseInt(options.intervalMs || '60000', 10) || 60000);
        if (this.pauseRecoveryTimer) clearInterval(this.pauseRecoveryTimer);
        const tick = () => {
            this.recoverDueBatchPauses().catch(err => {
                this.logger.error({ err }, 'campaign_batch_pause_recovery_failed');
            });
        };
        tick();
        this.pauseRecoveryTimer = setInterval(tick, intervalMs);
        if (typeof this.pauseRecoveryTimer.unref === 'function') this.pauseRecoveryTimer.unref();
    }

    stopBatchPauseRecovery() {
        if (!this.pauseRecoveryTimer) return;
        clearInterval(this.pauseRecoveryTimer);
        this.pauseRecoveryTimer = null;
    }

    async recoverDueBatchPauses() {
        if (!this.db?.getDueBatchPauseCampaignRuns) return [];
        const dueRuns = await this.db.getDueBatchPauseCampaignRuns(new Date());
        const resumed = [];

        for (const run of dueRuns) {
            const campaignId = run?.id;
            const ownerEmail = run?.owner_email;
            const tenantId = run?.tenant_id || 'default';
            if (!campaignId || !ownerEmail) continue;
            if (this.recoveringPauseRunIds.has(campaignId)) continue;

            const key = activeKey(ownerEmail, tenantId);
            if (this.activeRunIds.get(key) === campaignId) continue;
            if (this.activeRunIds.get(key)) continue;
            if (!this.runtime.connected(tenantId)) {
                this.logger.warn({ campaignId, tenantId, ownerEmail }, 'campaign_batch_pause_due_but_whatsapp_disconnected');
                await this.systemEvent('campaign_paused', 'warn', 'Mola süresi doldu ancak WhatsApp bağlı olmadığı için kampanya otomatik devam edemedi.', {
                    campaign_id: campaignId,
                    pause_reason: run.pause_reason,
                    pause_until: run.pause_until
                }, tenantId);
                continue;
            }

            const contacts = await this.db.getCampaignRecipientsForRestart(campaignId, ownerEmail, 'resume', tenantId);
            if (contacts.length === 0) {
                const remainingContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending', 'failed', 'validation_unknown'], tenantId);
                await this.db.updateCampaignRuntimeState(campaignId, {
                    pause_until: null,
                    pause_reason: null,
                    wait_until: null
                });
                if (remainingContacts.length === 0) {
                    await this.db.setCampaignRunStatus(campaignId, 'completed');
                    await this.systemEvent('campaign_completed', 'info', 'Mola süresi doldu; kampanyada işlenecek alıcı kalmadığı için tamamlandı.', {
                        campaign_id: campaignId,
                        pause_reason: run.pause_reason
                    }, tenantId);
                    resumed.push(campaignId);
                } else {
                    await this.db.setCampaignRunStatus(campaignId, 'completed');
                    await this.systemEvent('campaign_completed', 'info', 'Mola tamamlandı; kalan kişiler gönderilmeyenler listesine ayrıldı.', {
                        campaign_id: campaignId,
                        pause_reason: run.pause_reason,
                        unsent_count: remainingContacts.length
                    }, tenantId);
                    resumed.push(campaignId);
                }
                continue;
            }

            this.recoveringPauseRunIds.add(campaignId);
            await this.db.updateCampaignRuntimeState(campaignId, {
                pause_until: null,
                pause_reason: null,
                wait_until: null
            });
            const execution = this.runExistingCampaign(
                { ...run, pause_until: null, pause_reason: null, wait_until: null },
                contacts,
                ownerEmail,
                tenantId,
                null,
                'Mola tamamlandı. Kampanya kaldığı yerden otomatik devam ediyor.'
            );
            await this.systemEvent('campaign_resumed', 'info', 'Mola tamamlandı; kampanya otomatik devam etti.', {
                campaign_id: campaignId,
                pause_reason: run.pause_reason,
                restart_contact_count: contacts.length
            }, tenantId);
            execution
                .then(() => this.recoveringPauseRunIds.delete(campaignId))
                .catch(err => {
                    this.recoveringPauseRunIds.delete(campaignId);
                    this.logger.error({ err, campaignId, tenantId }, 'campaign_batch_pause_auto_resume_failed');
                    this.systemEvent('campaign_paused', 'error', 'Mola sonrası otomatik devam hatayla durdu.', {
                        campaign_id: campaignId,
                        pause_reason: run.pause_reason,
                        error: err.message
                    }, tenantId).catch(() => {});
                });
            resumed.push(campaignId);
        }

        return resumed;
    }
}

module.exports = { CampaignService };
