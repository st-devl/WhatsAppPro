const express = require('express');
const { sendSuccess } = require('../lib/api_response');

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
