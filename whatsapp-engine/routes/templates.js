const express = require('express');
const { asyncHandler } = require('../lib/api_errors');
const { sendCreated, sendSuccess } = require('../lib/api_response');
const { createTemplateService } = require('../services/template_service');

function createTemplateRouter(db) {
    const router = express.Router();
    const templateService = createTemplateService(db);
    const context = (req) => ({ tenantId: req.session?.user?.tenant_id || 'default' });

    router.get('/templates', asyncHandler(async (req, res) => {
        sendSuccess(res, await templateService.listTemplates(context(req)), 'TEMPLATES_LISTED');
    }));

    router.post('/templates', asyncHandler(async (req, res) => {
        const template = await templateService.createTemplate(req.body, context(req));
        sendCreated(res, { success: true, template }, 'TEMPLATE_CREATED');
    }));

    return router;
}

module.exports = { createTemplateRouter };
