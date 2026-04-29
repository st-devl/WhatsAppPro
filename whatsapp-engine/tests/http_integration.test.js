const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { io: createSocketClient } = require('socket.io-client');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-http-test-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LOG_LEVEL = 'silent';

const db = require('../lib/db');
const { LoginRateLimiter } = require('../lib/login_rate_limiter');
const { createRequestLoggerMiddleware } = require('../lib/logger');
const { createSessionMiddleware } = require('../middleware/session');
const { createSecurityHeaders, requireSameOriginForStateChanges } = require('../middleware/security');
const { requireAuth } = require('../middleware/auth');
const { createAuthRouter } = require('../routes/auth');
const { createGroupRouter } = require('../routes/groups');
const { createContactRouter } = require('../routes/contacts');
const { createErrorMiddleware, createNotFoundMiddleware } = require('../lib/api_errors');
const { registerCampaignSocket } = require('../socket/campaign_socket');
const { createTenantUploadMiddleware } = require('../lib/tenant_uploads');
const { parseTrustProxy } = require('../lib/proxy_config');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'correct-password';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 8);

function cookieHeader(setCookie) {
    return String(setCookie || '').split(';')[0];
}

async function createHarness(options = {}) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    const { sessionName, sessionCookieOptions, sessionMiddleware } = createSessionMiddleware(path.join(__dirname, '..'));
    const loginLimiter = new LoginRateLimiter({
        windowMs: 60_000,
        maxAttempts: options.maxAttempts || 5
    });

    app.set('trust proxy', options.trustProxy ?? false);
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware);
    app.use(createRequestLoggerMiddleware());
    app.use(createSecurityHeaders({ secureCookies: false }));
    app.use(express.json({ limit: '1mb' }));
    app.use(requireSameOriginForStateChanges);
    app.use('/api', createAuthRouter({
        adminEmail: ADMIN_EMAIL,
        adminPassHash: ADMIN_HASH,
        db,
        loginLimiter,
        sessionName,
        sessionCookieOptions,
        defaultTenantId: 'default'
    }));
    app.use('/api', requireAuth);
    app.get('/uploads/:tenantId/*', requireAuth, createTenantUploadMiddleware(tempDir));
    app.use('/api', createGroupRouter(db));
    app.use('/api', createContactRouter(db));
    app.use('/api', createNotFoundMiddleware());
    app.use(createErrorMiddleware());

    registerCampaignSocket(io, {
        runtime: {
            tenantRoom: tenantId => `tenant:${tenantId}`,
            connected: () => false,
            getLastQR: () => null,
            isTenantSupported: () => true
        },
        campaignService: {
            stopActive: async () => null,
            start: async () => {},
            resume: async () => null,
            retry: async () => null
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function close() {
        await new Promise(resolve => io.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }

    return { baseUrl, close };
}

async function requestJson(harness, method, route, body = null, headers = {}) {
    const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const response = await fetch(`${harness.baseUrl}${route}`, {
        method,
        headers: {
            ...(stateChanging && !headers.Origin && !headers.Referer ? { Origin: harness.baseUrl } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual'
    });
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        body: text ? JSON.parse(text) : null
    };
}

async function login(harness) {
    const response = await requestJson(harness, 'POST', '/api/login', {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'LOGIN_SUCCESS');
    return cookieHeader(response.headers.get('set-cookie'));
}

function connectSocket(baseUrl, cookie = '') {
    return new Promise((resolve, reject) => {
        const socket = createSocketClient(baseUrl, {
            transports: ['websocket'],
            reconnection: false,
            timeout: 1000,
            forceNew: true,
            extraHeaders: cookie ? { Cookie: cookie } : undefined
        });
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('socket connection timed out'));
        }, 1500);

        socket.on('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.on('connect_error', err => {
            clearTimeout(timer);
            socket.close();
            reject(err);
        });
    });
}

test.after(async () => {
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('login, auth check and logout flow', async () => {
    const harness = await createHarness();
    try {
        const cookie = await login(harness);

        const check = await requestJson(harness, 'GET', '/api/check-auth', null, { Cookie: cookie });
        assert.equal(check.status, 200);
        assert.equal(check.body.data.authenticated, true);

        const logout = await requestJson(harness, 'POST', '/api/logout', null, { Cookie: cookie });
        assert.equal(logout.status, 200);
        assert.equal(logout.body.code, 'LOGOUT_SUCCESS');
    } finally {
        await harness.close();
    }
});

test('cross-origin state-changing request is blocked', async () => {
    const harness = await createHarness();
    try {
        const response = await requestJson(harness, 'POST', '/api/login', {
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD
        }, {
            Origin: 'http://evil.example'
        });
        assert.equal(response.status, 403);
        assert.equal(response.body.error, 'Gecersiz istek kaynagi');
    } finally {
        await harness.close();
    }
});

test('state-changing request without origin is blocked', async () => {
    const harness = await createHarness();
    try {
        const response = await fetch(`${harness.baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
        });
        const body = await response.json();
        assert.equal(response.status, 403);
        assert.equal(body.error, 'Istek kaynagi zorunlu');
    } finally {
        await harness.close();
    }
});

test('login brute force is rate limited', async () => {
    const harness = await createHarness({ maxAttempts: 2 });
    try {
        const payload = { email: ADMIN_EMAIL, password: 'wrong-password' };
        assert.equal((await requestJson(harness, 'POST', '/api/login', payload)).status, 401);
        assert.equal((await requestJson(harness, 'POST', '/api/login', payload)).status, 401);
        const blocked = await requestJson(harness, 'POST', '/api/login', payload);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.body.code, 'RATE_LIMITED');
    } finally {
        await harness.close();
    }
});

test('rate limit ignores spoofed forwarded IP when proxy trust is disabled', async () => {
    const harness = await createHarness({ maxAttempts: 2, trustProxy: false });
    try {
        const payload = { email: ADMIN_EMAIL, password: 'wrong-password' };
        assert.equal((await requestJson(harness, 'POST', '/api/login', payload, { 'X-Forwarded-For': '198.51.100.1' })).status, 401);
        assert.equal((await requestJson(harness, 'POST', '/api/login', payload, { 'X-Forwarded-For': '198.51.100.2' })).status, 401);
        const blocked = await requestJson(harness, 'POST', '/api/login', payload, { 'X-Forwarded-For': '198.51.100.3' });
        assert.equal(blocked.status, 429);
    } finally {
        await harness.close();
    }
});

test('trust proxy parser defaults closed and accepts explicit proxy settings', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
});

test('group and contact CRUD routes require an authenticated session', async () => {
    const harness = await createHarness();
    try {
        const unauthenticated = await requestJson(harness, 'GET', '/api/groups');
        assert.equal(unauthenticated.status, 401);

        const cookie = await login(harness);
        const groupName = `Integration Group ${Date.now()}`;
        const group = await requestJson(harness, 'POST', '/api/groups', { name: groupName }, { Cookie: cookie });
        assert.equal(group.status, 201);
        assert.equal(group.body.code, 'GROUP_CREATED');
        const groupId = group.body.data.id;

        const contact = await requestJson(harness, 'POST', `/api/groups/${groupId}/contacts`, {
            name: 'Ali',
            surname: 'Yilmaz',
            phone: '05320000000'
        }, { Cookie: cookie });
        assert.equal(contact.status, 201);
        assert.equal(contact.body.data.phone, '905320000000');

        const contactId = contact.body.data.id;
        const updated = await requestJson(harness, 'PATCH', `/api/groups/${groupId}/contacts/${contactId}`, {
            name: 'Veli',
            phone: '05320000001'
        }, { Cookie: cookie });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.data.name, 'Veli');
        assert.equal(updated.body.data.phone, '905320000001');

        const page = await requestJson(harness, 'GET', `/api/groups/${groupId}/contacts?limit=10&search=Veli`, null, { Cookie: cookie });
        assert.equal(page.status, 200);
        assert.equal(page.body.data.length, 1);
        assert.equal(page.body.meta.pagination.total, 1);

        const deleted = await requestJson(harness, 'DELETE', `/api/groups/${groupId}/contacts/${contactId}`, null, { Cookie: cookie });
        assert.equal(deleted.status, 200);

        const deletedGroup = await requestJson(harness, 'DELETE', `/api/groups/${groupId}`, null, { Cookie: cookie });
        assert.equal(deletedGroup.status, 200);
    } finally {
        await harness.close();
    }
});

test('uploaded files are only served for the session tenant', async () => {
    const harness = await createHarness();
    try {
        fs.mkdirSync(path.join(tempDir, 'uploads', 'default'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'uploads', 'other'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'uploads', 'default', 'own.txt'), 'own-file');
        fs.writeFileSync(path.join(tempDir, 'uploads', 'other', 'private.txt'), 'other-file');

        const cookie = await login(harness);
        const own = await fetch(`${harness.baseUrl}/uploads/default/own.txt`, { headers: { Cookie: cookie } });
        assert.equal(own.status, 200);
        assert.equal(await own.text(), 'own-file');

        const other = await fetch(`${harness.baseUrl}/uploads/other/private.txt`, { headers: { Cookie: cookie } });
        const body = await other.json();
        assert.equal(other.status, 403);
        assert.equal(body.code, 'UPLOAD_FORBIDDEN');
    } finally {
        await harness.close();
    }
});

test('socket connections require an authenticated session', async () => {
    const harness = await createHarness();
    try {
        await assert.rejects(
            () => connectSocket(harness.baseUrl),
            err => /Yetkisiz socket/.test(err.message)
        );

        const cookie = await login(harness);
        const socket = await connectSocket(harness.baseUrl, cookie);
        assert.equal(socket.connected, true);
        socket.close();
    } finally {
        await harness.close();
    }
});
