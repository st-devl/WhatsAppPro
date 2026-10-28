const path = require('path');
const express = require('express');

function createFaviconRouter(baseDir) {
    const router = express.Router();
    const faviconPath = path.join(baseDir, 'public', 'favicon.svg');

    router.get('/favicon.svg', (req, res, next) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(faviconPath, err => {
            if (err) next(err);
        });
    });

    router.get('/favicon.ico', (req, res) => {
        res.redirect(302, '/favicon.svg');
    });

    return router;
}

module.exports = { createFaviconRouter };
