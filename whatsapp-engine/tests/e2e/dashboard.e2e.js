const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-e2e-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.SESSION_SECRET = 'e2e-session-secret';
process.env.LOG_LEVEL = 'silent';

const db = require('../../lib/db');
const { LoginRateLimiter } = require('../../lib/login_rate_limiter');
const { createRequestLoggerMiddleware } = require('../../lib/logger');
const { createSessionMiddleware } = require('../../middleware/session');
const { createSecurityHeaders, requireSameOriginForStateChanges } = require('../../middleware/security');
const { requireAuth } = require('../../middleware/auth');
const { createAuthRouter } = require('../../routes/auth');
const { createGroupRouter } = require('../../routes/groups');
const { createContactRouter } = require('../../routes/contacts');
const { createTemplateRouter } = require('../../routes/templates');
const { createCampaignRouter } = require('../../routes/campaigns');
const { createUploadRouter } = require('../../routes/uploads');
const { createSystemRouter } = require('../../routes/system');
const { createAuditRouter } = require('../../routes/audit');
const { createErrorMiddleware, createNotFoundMiddleware } = require('../../lib/api_errors');
const { registerCampaignSocket } = require('../../socket/campaign_socket');
const { createUploadMiddleware } = require('../../lib/upload_middleware');
const { MediaStore } = require('../../lib/media_store');
const { createSampleWorkbookBuffer } = require('../../lib/excel_import');

const engineRoot = path.join(__dirname, '../..');
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'correct-password';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 8);

const mockRuntime = {
    tenantRoom: tenantId => `tenant:${tenantId}`,
    connected: () => false,
    getLastQR: () => null,
    isTenantSupported: () => true,
    resetSession: async () => {},
    getStatus: () => ({
        http: 'listening',
        whatsapp: 'disconnected',
        lastError: null
    })
};

const mockCampaignService = {
    stopActive: async () => ({ id: 'mock-campaign', status: 'stopped', total: 0, processed: 0 }),
    start: async (_data, socket) => {
        socket.emit('campaign-started', { campaignId: 'mock-campaign', status: { progress: 0 } });
        socket.emit('log', { type: 'success', message: 'Gönderiler tamamlandı.', progress: 100, done: true });
    },
    resume: async () => ({ id: 'mock-campaign', status: 'running' }),
    retry: async () => ({ id: 'mock-campaign', status: 'running' }),
    getLatestStatus: async () => null
};

function mountProtectedApi(app, prefix, options) {
    app.use(prefix, createSystemRouter({ baseDir: engineRoot, runtime: mockRuntime }));
    app.use(prefix, createTemplateRouter(db));
    app.use(prefix, createGroupRouter(db));
    app.use(prefix, createContactRouter(db));
    app.use(prefix, createUploadRouter(options));
    app.use(prefix, createCampaignRouter({ campaignService: mockCampaignService }));
    app.use(prefix, createAuditRouter(db));
}

async function createHarness() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    const { sessionName, sessionCookieOptions, sessionMiddleware } = createSessionMiddleware(engineRoot);
    const upload = createUploadMiddleware(tempDir);
    const mediaStore = new MediaStore({ filePath: path.join(tempDir, 'media-store.json') });
    const loginLimiter = new LoginRateLimiter({ windowMs: 60_000, maxAttempts: 5 });

    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware);
    app.use(createRequestLoggerMiddleware());
    app.use(createSecurityHeaders({ secureCookies: false }));
    app.use(express.json({ limit: '1mb' }));
    app.use(requireSameOriginForStateChanges);
    app.use('/css', express.static(path.join(engineRoot, 'public/css')));
    app.get('/login.html', (_req, res) => res.sendFile(path.join(engineRoot, 'public/login.html')));
    app.get('/app-version', (_req, res) => res.json({ data: { version: '0.0.23' }, error: null, code: 'VERSION' }));
    const authOptions = {
        adminEmail: ADMIN_EMAIL,
        adminPassHash: ADMIN_HASH,
        db,
        loginLimiter,
        sessionName,
        sessionCookieOptions,
        defaultTenantId: 'default'
    };
    const apiOptions = { baseDir: tempDir, upload, mediaStore, db };
    app.use('/api', createAuthRouter(authOptions));
    app.use('/api/v1', createAuthRouter(authOptions));
    app.use(requireAuth, express.static(path.join(engineRoot, 'public')));
    app.use('/shared', requireAuth, express.static(path.join(engineRoot, 'shared')));
    app.use('/uploads', requireAuth, express.static(path.join(tempDir, 'uploads')));
    app.use('/api', requireAuth);
    mountProtectedApi(app, '/api/v1', apiOptions);
    mountProtectedApi(app, '/api', apiOptions);
    app.use('/api', createNotFoundMiddleware());
    app.use(createErrorMiddleware());

    registerCampaignSocket(io, { runtime: mockRuntime, campaignService: mockCampaignService });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
            await new Promise(resolve => io.close(resolve));
            await new Promise(resolve => server.close(resolve));
        }
    };
}

let harness;

test.beforeAll(async () => {
    harness = await createHarness();
});

test.afterAll(async () => {
    if (harness) await harness.close();
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('login, group, contact edit/delete and Excel import work through the browser UI', async ({ page }) => {
    await page.goto(`${harness.baseUrl}/login.html`);
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('#login-submit');
    await expect(page.locator('#view-campaign')).toBeVisible();

    await page.click('#tab-contacts');
    await expect(page.locator('#view-contacts')).toBeVisible();

    const groupName = `E2E Grup ${Date.now()}`;
    page.once('dialog', dialog => dialog.accept(groupName));
    await page.click('#create-group-btn');
    await expect(page.locator('#active-group-name')).toHaveText(groupName);

    await page.click('#manual-open-card');
    await page.fill('#manual-name', 'Ayse Test');
    await page.fill('#manual-phone', '05320000000');
    await page.click('#manual-save-btn');
    await expect(page.locator('#contacts-table-body')).toContainText('Ayse Test');
    await expect(page.locator('#contacts-table-body')).toContainText('905320000000');

    await page.locator('[data-action="edit-contact"]').first().click();
    await page.fill('#edit-contact-name', 'Veli Test');
    await page.fill('#edit-contact-surname', 'Kaya');
    await page.fill('#edit-contact-phone', '05320000001');
    await page.click('#edit-contact-save-btn');
    await expect(page.locator('#contacts-table-body')).toContainText('Veli Test Kaya');
    await expect(page.locator('#contacts-table-body')).toContainText('905320000001');

    await page.locator('[data-action="remove-contact"]').first().click();
    await expect(page.locator('#contacts-table-body')).toContainText('Rehber Boş');

    const workbookBuffer = Buffer.from(await createSampleWorkbookBuffer());
    await page.setInputFiles('#excel-input', {
        name: 'ornek_rehber.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: workbookBuffer
    });
    await expect(page.locator('#contacts-table-body')).toContainText('Ahmet Yılmaz');
    await expect(page.locator('#contacts-table-body')).toContainText('905320000000');

    await page.click('#logout-btn');
    await expect(page).toHaveURL(/login\.html/);
});
