const express = require('express');
const { asyncHandler, badRequest } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');
const { readReleaseManifest } = require('../lib/release_manifest');

function createSystemRouter(options = {}) {
    const router = express.Router();
    const { baseDir, runtime } = options;

    router.get('/version', asyncHandler(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, await readReleaseManifest(baseDir), 'VERSION');
    }));

    router.get('/runtime-status', (req, res) => {
        const tenantId = req.session?.user?.tenant_id || 'default';
        sendSuccess(res, runtime.getStatus(tenantId), 'RUNTIME_STATUS');
    });

    router.post('/reset-session', asyncHandler(async (req, res) => {
        const tenantId = req.session?.user?.tenant_id || 'default';
        if (!runtime.isTenantSupported(tenantId)) {
            throw badRequest('Bu tenant icin WhatsApp hesabi yapilandirilmadi.', 'WHATSAPP_ACCOUNT_NOT_CONFIGURED');
        }
        await runtime.resetSession();
        sendSuccess(res, { success: true, message: 'Oturum temizlendi.' }, 'SESSION_RESET');
    }));

    return router;
}

module.exports = { createSystemRouter };
