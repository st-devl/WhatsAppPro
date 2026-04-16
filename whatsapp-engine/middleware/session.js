const path = require('path');
const session = require('express-session');
const { createFileSessionStore } = require('../lib/session_store');

function createSessionMiddleware(baseDir) {
    const sessionName = 'whasappc.sid';
    const secureCookies = process.env.COOKIE_SECURE === 'true';
    const sessionCookieOptions = {
        secure: secureCookies,
        sameSite: secureCookies ? 'none' : 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    };

    const sessionStore = createFileSessionStore({
        filePath: path.join(baseDir, 'data/sessions/sessions.json'),
        ttlMs: sessionCookieOptions.maxAge
    });

    const sessionMiddleware = session({
        name: sessionName,
        secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
        resave: false,
        saveUninitialized: false,
        store: sessionStore,
        proxy: true,
        cookie: sessionCookieOptions
    });

    return {
        sessionName,
        sessionCookieOptions,
        sessionStore,
        sessionMiddleware
    };
}

module.exports = { createSessionMiddleware };

