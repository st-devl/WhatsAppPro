const express = require('express');
const crypto = require('crypto');
const { sendSuccess } = require('../lib/api_response');
const db = require('../lib/db');

function createCampaignRouter(options = {}) {
    const router = express.Router();
    const { campaignService } = options;
    const ownerEmail = (req) => req.session?.user?.email;
    const tenantId = (req) => req.session?.user?.tenant_id || 'default';

    router.get('/campaign-status', async (req, res, next) => {
        try {
            const status = await campaignService.getLatestStatus(ownerEmail(req), tenantId(req));
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STATUS');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/stop', async (req, res, next) => {
        try {
            const status = await campaignService.stopActive(ownerEmail(req), req.body?.campaignId || null, tenantId(req));
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STOPPED');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/:campaignId/finish', async (req, res, next) => {
        try {
            const status = await campaignService.finish(req.params.campaignId, ownerEmail(req), tenantId(req));
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_FINISHED');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/:campaignId/resume', async (req, res, next) => {
        try {
            const status = await campaignService.resume(req.params.campaignId, ownerEmail(req), null, { detached: true, tenantId: tenantId(req) });
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_RESUME_STARTED');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/:campaignId/retry', async (req, res, next) => {
        try {
            const status = await campaignService.retry(req.params.campaignId, ownerEmail(req), null, { detached: true, tenantId: tenantId(req) });
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_RETRY_STARTED');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/:campaignId/retry-skipped', async (req, res, next) => {
        try {
            const status = await campaignService.retrySkipped(req.params.campaignId, ownerEmail(req), null, { detached: true, tenantId: tenantId(req) });
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_RETRY_SKIPPED_STARTED');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/preflight', async (req, res, next) => {
        try {
            const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
            const message = String(req.body?.message || '');
            const msgHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);
            const result = await db.checkCooldownWithMessage(contacts, msgHash, tenantId(req));
            const fmt = (d) => d ? d.toLocaleString('tr-TR', { timeZone: process.env.TZ || 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
            sendSuccess(res, {
                sameMessage: result.sameMessage.map(r => ({ ...r, expiresAt: fmt(r.expiresAt) })),
                differentMessage: result.differentMessage.map(r => ({ ...r, expiresAt: fmt(r.expiresAt) }))
            }, 'CAMPAIGN_PREFLIGHT');
        } catch (err) {
            next(err);
        }
    });

    router.get('/campaigns/latest', async (req, res, next) => {
        try {
            const status = await campaignService.getLatestStatus(ownerEmail(req), tenantId(req));
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STATUS');
        } catch (err) {
            next(err);
        }
    });

    return router;
}

module.exports = { createCampaignRouter };
