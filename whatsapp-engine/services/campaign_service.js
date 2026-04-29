const { v4: uuidv4 } = require('uuid');
const {
    sendBulkWithProgress,
    stopCampaign
} = require('../lib/messenger');
const { badRequest, createApiError } = require('../lib/api_errors');
const { componentLogger } = require('../lib/logger');
const {
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_BATCH_SIZE,
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

function normalizeCampaignLimits(data = {}) {
    const dailyLimit = data.dailyLimit === undefined || data.dailyLimit === null || data.dailyLimit === ''
        ? 50
        : Number.parseInt(data.dailyLimit, 10);
    if (!Number.isFinite(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) {
        throw badRequest('Günlük limit 1 ile 500 arasında olmalı', 'CAMPAIGN_DAILY_LIMIT_INVALID');
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

class CampaignService {
    constructor(options = {}) {
        this.db = options.db;
        this.runtime = options.runtime;
        this.mediaStore = options.mediaStore;
        this.keepAwake = options.keepAwake || null;
        this.logger = options.logger || componentLogger('campaign_service');
        this.activeRunIds = new Map();
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

    async start(data = {}, socket) {
        const ownerEmail = getOwnerFromSocket(socket);
        const tenantId = getTenantFromSocket(socket);
        if (!ownerEmail) throw badRequest('Oturum sahibi doğrulanamadı', 'CAMPAIGN_OWNER_REQUIRED');
        const contacts = Array.isArray(data.contacts) ? data.contacts : [];
        const message = String(data.message || '').trim();
        if (contacts.length === 0) throw badRequest('Gönderilecek kişi yok', 'CAMPAIGN_CONTACTS_REQUIRED');
        if (!message) throw badRequest('Mesaj içeriği zorunlu', 'CAMPAIGN_MESSAGE_REQUIRED');
        assertValidCampaignMessage(message, contacts[0]);
        this.assertNoInMemoryActive(ownerEmail, tenantId);

        const sock = this.assertConnected(tenantId);

        const mediaFiles = this.mediaStore.list(tenantId);
        const campaignId = uuidv4();
        const { dailyLimit, delayRange } = normalizeCampaignLimits(data);
        const batchSettings = resolveBatchSettings(data);
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
            media_count: mediaFiles.length
        }, tenantId);

        socket.emit('campaign-started', { campaignId, status: run });
        socket.emit('log', { type: 'info', message: '🚀 Gönderim kuyruğu başladı.' });

        try {
            await sendBulkWithProgress(sock, contacts, message, socket, delayRange, mediaFiles, campaignId, {
                dailyLimit,
                batchSize: batchSettings.batchSize,
                batchPauseMinutes: batchSettings.batchPauseMinutes,
                campaignStore: this,
                tenantId
            });
            this.mediaStore.clear(tenantId);
            this.activeRunIds.delete(activeKeyValue);
            this.keepAwake?.stop(activeKeyValue);
        } catch (err) {
            await this.setRunStatus(campaignId, 'paused', { error: err.message });
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
            await this.audit('campaign_stopped', stoppedRun.id, {
                status: stoppedRun.status,
                processed: stoppedRun.processed,
                total: stoppedRun.total
            }, tenantId);
        }
        return stoppedRun;
    }

    assertConnected(tenantId = 'default') {
        const sock = this.runtime.getSocket(tenantId);
        if (!this.runtime.connected(tenantId) || !sock) throw badRequest('Bağlı değil!', 'WHATSAPP_NOT_CONNECTED');
        return sock;
    }

    getLatestStatus(ownerEmail, tenantId = 'default') {
        return this.db.getLatestCampaignRunStatus(ownerEmail, tenantId);
    }

    async resume(campaignId, ownerEmail, socket, options = {}) {
        const tenantId = options.tenantId || getTenantFromSocket(socket);
        this.assertConnected(tenantId);
        this.assertNoInMemoryActive(ownerEmail, tenantId, campaignId);
        const unsentContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['pending', 'failed'], tenantId);
        if (unsentContacts.length === 0) throw badRequest('Devam edilecek bekleyen kişi yok', 'CAMPAIGN_RESUME_EMPTY');
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
        this.assertConnected(tenantId);
        this.assertNoInMemoryActive(ownerEmail, tenantId, campaignId);
        const failedContacts = await this.db.getCampaignRecipientsForRun(campaignId, ownerEmail, ['failed'], tenantId);
        if (failedContacts.length === 0) throw badRequest('Retry edilecek başarısız kişi yok', 'CAMPAIGN_RETRY_EMPTY');
        const run = await this.db.prepareCampaignRunForRestart(campaignId, ownerEmail, 'retry', tenantId);
        const execution = this.runExistingCampaign(run, failedContacts, ownerEmail, tenantId, socket, 'Başarısız kişiler yeniden kuyruğa alındı.');
        if (options.detached) {
            execution.catch(err => this.logger.error({ err, tenantId, campaignId }, 'campaign_retry_failed'));
            return run;
        }
        return execution;
    }

    async runExistingCampaign(run, contacts, ownerEmail, tenantId, socket, message) {
        const sock = this.assertConnected(tenantId);
        if (!run?.id) throw badRequest('Kampanya bulunamadı', 'CAMPAIGN_NOT_FOUND');
        if (!String(run.message || '').trim()) throw badRequest('Kampanya mesaj içeriği bulunamadı', 'CAMPAIGN_MESSAGE_REQUIRED');
        assertValidCampaignMessage(run.message, contacts[0]);

        const key = activeKey(ownerEmail, tenantId);
        const emitter = socket || {
            emit: (event, payload) => this.runtime?.emitToTenant?.(event, payload, tenantId)
        };
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
                batchSize: run.metadata?.batch_size,
                batchPauseMinutes: run.metadata?.batch_pause_minutes
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
                    batchSize: run.metadata?.batch_size,
                    batchPauseMinutes: run.metadata?.batch_pause_minutes,
                    campaignStore: this,
                    tenantId
                }
            );
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
        } catch (err) {
            await this.setRunStatus(run.id, 'paused', { error: err.message });
            this.activeRunIds.delete(key);
            this.keepAwake?.stop(key);
            throw err;
        }
    }

    setRunStatus(campaignId, status, metadata = {}) {
        return this.db.setCampaignRunStatus(campaignId, status, metadata);
    }

    addLog(campaignId, type, message, progress, metadata = {}) {
        return this.db.addCampaignLog(campaignId, type, message, progress, metadata);
    }

    markRecipient(campaignId, contact, status, error = null) {
        return this.db.updateCampaignRecipient(campaignId, contact, status, error);
    }
}

module.exports = { CampaignService };
