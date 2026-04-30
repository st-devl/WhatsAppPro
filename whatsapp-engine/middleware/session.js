const path = require('path');
const session = require('express-session');
const db = require('../lib/db');
const { createDbSessionStore, createFileSessionStore } = require('../lib/session_store');

function resolveSessionStore(baseDir, ttlMs) {
    const storeType = String(process.env.SESSION_STORE || 'sqlite').trim().toLowerCase();
    if (storeType === 'file') {
        const dataDir = process.env.WHASAPPC_DATA_DIR
            ? path.resolve(process.env.WHASAPPC_DATA_DIR)
            : path.join(baseDir, 'data');
        return createFileSessionStore({
            filePath: path.join(dataDir, 'sessions/sessions.json'),
            ttlMs
        });
    }

    if (storeType !== 'sqlite') {
        throw new Error(`SESSION_STORE sqlite veya file olmali. Gelen: ${storeType}`);
    }

    return createDbSessionStore({ db, ttlMs });
}

function createSessionMiddleware(baseDir) {
    const sessionName = 'whasappc.sid';
    const secureCookies = process.env.COOKIE_SECURE === 'true';
    const sessionSecret = process.env.SESSION_SECRET;
    if (process.env.NODE_ENV === 'production' && !sessionSecret) {
        throw new Error('SESSION_SECRET production ortaminda zorunludur');
    }
    const sessionCookieOptions = {
        secure: secureCookies,
        sameSite: secureCookies ? 'none' : 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    };

    const sessionStore = resolveSessionStore(baseDir, sessionCookieOptions.maxAge);

    const sessionMiddleware = session({
        name: sessionName,
        secret: sessionSecret || 'fallback-dev-secret',
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
