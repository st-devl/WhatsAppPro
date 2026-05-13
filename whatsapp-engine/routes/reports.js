const express = require('express');
const { asyncHandler, createApiError } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');

function tenantId(req) {
    return req.session?.user?.tenant_id || 'default';
}

function createReportsRouter(db) {
    const router = express.Router();

    router.get('/system-events', asyncHandler(async (req, res) => {
        const { limit, offset, event_type, severity } = req.query;
        const events = await db.getSystemEvents(tenantId(req), {
            limit: Number.parseInt(limit, 10) || 100,
            offset: Number.parseInt(offset, 10) || 0,
            eventType: event_type || null,
            severity: severity || null
        });
        sendSuccess(res, { events }, 'SYSTEM_EVENTS');
    }));

    router.get('/campaigns/:campaignId/report', asyncHandler(async (req, res) => {
        const report = await db.getCampaignReport(req.params.campaignId, tenantId(req));
        if (!report) throw createApiError(404, 'Kampanya bulunamadı', 'CAMPAIGN_NOT_FOUND');
        sendSuccess(res, report, 'CAMPAIGN_REPORT');
    }));

    router.get('/reports/summary', asyncHandler(async (req, res) => {
        const summary = await db.getCampaignSummary(tenantId(req));
        sendSuccess(res, summary, 'REPORTS_SUMMARY');
    }));

    return router;
}

module.exports = { createReportsRouter };
