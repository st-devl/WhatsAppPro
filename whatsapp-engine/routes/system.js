const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { asyncHandler } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');

function createSystemRouter(options = {}) {
    const router = express.Router();
    const { baseDir, runtime } = options;

    router.get('/version', asyncHandler(async (req, res) => {
        const pkg = await fs.readJson(path.join(baseDir, 'package.json')).catch(() => ({ version: '1.0.0' }));
        sendSuccess(res, { version: pkg.version }, 'VERSION');
    }));

    router.get('/runtime-status', (req, res) => {
        sendSuccess(res, runtime.getStatus(), 'RUNTIME_STATUS');
    });

    router.post('/reset-session', asyncHandler(async (req, res) => {
        await runtime.resetSession();
        sendSuccess(res, { success: true, message: 'Oturum temizlendi.' }, 'SESSION_RESET');
    }));

    return router;
}

module.exports = { createSystemRouter };
