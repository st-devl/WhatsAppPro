const express = require('express');

const qrcodeScriptPath = require.resolve('qrcode/build/qrcode.js');

function createVendorAssetsRouter(options = {}) {
    const router = express.Router();
    const auth = typeof options.requireAuth === 'function'
        ? options.requireAuth
        : (_req, _res, next) => next();

    router.get('/vendor/qrcode.min.js', auth, (req, res, next) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(qrcodeScriptPath, err => {
            if (err) next(err);
        });
    });

    return router;
}

module.exports = { createVendorAssetsRouter };
