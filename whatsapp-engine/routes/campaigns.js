const express = require('express');
const { sendSuccess } = require('../lib/api_response');

function createCampaignRouter(options = {}) {
    const router = express.Router();
    const { campaignService } = options;

    router.get('/campaign-status', async (req, res, next) => {
        try {
            const status = await campaignService.getLatestStatus();
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STATUS');
        } catch (err) {
            next(err);
        }
    });

    router.post('/campaigns/stop', async (req, res, next) => {
        try {
            const status = await campaignService.stopActive();
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STOPPED');
        } catch (err) {
            next(err);
        }
    });

    router.get('/campaigns/latest', async (req, res, next) => {
        try {
            const status = await campaignService.getLatestStatus();
            sendSuccess(res, { campaign: status }, 'CAMPAIGN_STATUS');
        } catch (err) {
            next(err);
        }
    });

    return router;
}

module.exports = { createCampaignRouter };
