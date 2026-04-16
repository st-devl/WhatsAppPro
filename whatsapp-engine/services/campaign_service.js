const { v4: uuidv4 } = require('uuid');
const {
    sendBulkWithProgress,
    stopAllCampaigns,
    stopCampaign
} = require('../lib/messenger');
const { badRequest } = require('../lib/api_errors');

class CampaignService {
    constructor(options = {}) {
        this.db = options.db;
        this.runtime = options.runtime;
        this.mediaStore = options.mediaStore;
        this.activeRunId = null;
    }

    async start(data = {}, socket) {
        const contacts = Array.isArray(data.contacts) ? data.contacts : [];
        const message = String(data.message || '').trim();
        if (contacts.length === 0) throw badRequest('Gönderilecek kişi yok', 'CAMPAIGN_CONTACTS_REQUIRED');
        if (!message) throw badRequest('Mesaj içeriği zorunlu', 'CAMPAIGN_MESSAGE_REQUIRED');

        const sock = this.runtime.getSocket();
        if (!this.runtime.connected() || !sock) throw badRequest('Bağlı değil!', 'WHATSAPP_NOT_CONNECTED');

        const mediaFiles = this.mediaStore.list();
        const campaignId = uuidv4();
        const dailyLimit = Number.parseInt(data.dailyLimit, 10) || 50;
        const delayRange = Array.isArray(data.delayRange) ? data.delayRange : [20, 90];

        const run = await this.db.createCampaignRun({
            id: campaignId,
            contacts,
            message,
            delayRange,
            dailyLimit,
            mediaCount: mediaFiles.length
        });
        this.activeRunId = campaignId;

        socket.emit('campaign-started', { campaignId, status: run });
        socket.emit('log', { type: 'info', message: '🚀 Gönderim kuyruğu başladı.' });

        try {
            await sendBulkWithProgress(sock, contacts, message, socket, delayRange, mediaFiles, campaignId, {
                dailyLimit,
                campaignStore: this
            });
            this.mediaStore.clear();
        } catch (err) {
            await this.setRunStatus(campaignId, 'paused', { error: err.message });
            throw err;
        }
    }

    async stopActive() {
        const stoppedRun = await this.db.stopLatestRunningCampaign();
        if (this.activeRunId) stopCampaign(this.activeRunId);
        if (stoppedRun?.id) stopCampaign(stoppedRun.id);
        stopAllCampaigns();
        return stoppedRun;
    }

    getLatestStatus() {
        return this.db.getLatestCampaignRunStatus();
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
