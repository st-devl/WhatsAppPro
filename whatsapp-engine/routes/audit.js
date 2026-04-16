const express = require('express');
const { asyncHandler } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');

function tenantId(req) {
    return req.session?.user?.tenant_id || 'default';
}

function safeFilenameSegment(value) {
    return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function createAuditRouter(db) {
    const router = express.Router();

    router.get('/audit-logs', asyncHandler(async (req, res) => {
        const result = await db.getAuditLogs(req.query, tenantId(req));
        sendSuccess(res, result, 'AUDIT_LOGS');
    }));

    router.get('/audit-logs/export', asyncHandler(async (req, res) => {
        const result = await db.getAuditLogs({
            ...req.query,
            limit: req.query.limit || 1000
        }, tenantId(req));
        const tenant = safeFilenameSegment(tenantId(req));
        const date = new Date().toISOString().slice(0, 10);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${tenant}-${date}.json"`);
        res.json({
            data: {
                exported_at: new Date().toISOString(),
                tenant_id: tenantId(req),
                filters: result.filters,
                pagination: result.pagination,
                logs: result.logs
            },
            error: null,
            code: 'AUDIT_LOGS_EXPORTED'
        });
    }));

    return router;
}

module.exports = { createAuditRouter };
