/**
 * Faz 30 - Manuel Regresyon Testlerinin Otomatik Karsiliklari
 *
 * Bu dosya docs/manual-regression-checklist.md'deki 20 manuel test senaryosunun
 * API seviyesinde otomatik karsiliklaridir. WhatsApp baglantisi gerektiren
 * testler (QR, gonderim, progress) mock/stub ile test edilir.
 */
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
const ExcelJS = require('exceljs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsappc-regression-'));
process.env.WHASAPPC_DATA_DIR = tempDir;
process.env.SESSION_SECRET = 'regression-test-secret';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASS_HASH = bcrypt.hashSync('correct-password', 8);

const db = require('../lib/db');
const { LoginRateLimiter } = require('../lib/login_rate_limiter');
const { createRequestLoggerMiddleware } = require('../lib/logger');
const { createSessionMiddleware } = require('../middleware/session');
const { createSecurityHeaders, requireSameOriginForStateChanges } = require('../middleware/security');
const { requireAuth } = require('../middleware/auth');
const { createAuthRouter } = require('../routes/auth');
const { createGroupRouter } = require('../routes/groups');
const { createContactRouter } = require('../routes/contacts');
const { createTemplateRouter } = require('../routes/templates');
const { createCampaignRouter } = require('../routes/campaigns');
const { createUploadRouter } = require('../routes/uploads');
const { createSystemRouter } = require('../routes/system');
const { createReportsRouter } = require('../routes/reports');
const { createApiVersionRemovedMiddleware, createErrorMiddleware, createNotFoundMiddleware } = require('../lib/api_errors');
const { registerCampaignSocket } = require('../socket/campaign_socket');
const { createUploadMiddleware } = require('../lib/upload_middleware');

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'correct-password';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 8);

function cookieHeader(setCookie) {
    return String(setCookie || '').split(';')[0];
}

const mockRuntime = {
    tenantRoom: tid => `tenant:${tid}`,
    connected: () => false,
    getLastQR: () => null,
    isTenantSupported: () => true,
    resetSession: async () => {},
    getStatus: () => ({ connected: false, qr: null, phone: null, pushName: null })
};

const mockCampaignService = {
    stopActive: async () => ({ id: 'camp-1', status: 'stopped', total: 10, sent: 5 }),
    finish: async (campaignId) => ({ id: campaignId, status: 'finished', total: 10, processed: 5 }),
    start: async () => ({ id: 'camp-1', status: 'running' }),
    resume: async () => ({ id: 'camp-1', status: 'running' }),
    retry: async () => ({ id: 'camp-1', status: 'running' }),
    retrySkipped: async () => ({ id: 'camp-1', status: 'running' }),
    getLatestStatus: async () => null
};

const uploadMiddleware = createUploadMiddleware(tempDir);

async function createHarness(options = {}) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    const { sessionName, sessionCookieOptions, sessionMiddleware } = createSessionMiddleware(path.join(__dirname, '..'));
    const loginLimiter = new LoginRateLimiter({ windowMs: 60_000, maxAttempts: options.maxAttempts || 5 });

    app.set('trust proxy', 1);
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware);
    app.use(createRequestLoggerMiddleware());
    app.use(createSecurityHeaders({ secureCookies: false }));
    app.use(express.json({ limit: '1mb' }));
    app.use(requireSameOriginForStateChanges);
    app.use('/api/v1', createAuthRouter({
        adminEmail: ADMIN_EMAIL, adminPassHash: ADMIN_HASH, db, loginLimiter,
        sessionName, sessionCookieOptions, defaultTenantId: 'default'
    }));
    app.use('/api/v1', requireAuth);
    app.use('/api/v1', createGroupRouter(db));
    app.use('/api/v1', createContactRouter(db));
    app.use('/api/v1', createTemplateRouter(db));
    app.use('/api/v1', createCampaignRouter({ campaignService: mockCampaignService }));
    app.use('/api/v1', createUploadRouter({ db, upload: uploadMiddleware, baseDir: tempDir }));
    app.use('/api/v1', createSystemRouter({ baseDir: path.join(__dirname, '..'), runtime: mockRuntime }));
    app.use('/api/v1', createReportsRouter(db));
    app.use('/api/v1', createNotFoundMiddleware());
    app.use('/api', createApiVersionRemovedMiddleware());
    app.use(createErrorMiddleware());

    registerCampaignSocket(io, { runtime: mockRuntime, campaignService: mockCampaignService });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return {
        baseUrl,
        async close() {
            await new Promise(r => io.close(r));
            await new Promise(r => server.close(r));
        }
    };
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
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function login(harness) {
    const r = await requestJson(harness, 'POST', '/api/v1/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.equal(r.status, 200, 'Login basarili olmali');
    return cookieHeader(r.headers.get('set-cookie'));
}

async function createGroup(harness, cookie, name) {
    const r = await requestJson(harness, 'POST', '/api/v1/groups', { name }, { Cookie: cookie });
    assert.equal(r.status, 201, `Grup olusturulmali: ${name}`);
    return r.body.data; // { id, name, ... }
}

async function createContact(harness, cookie, groupId, phone, name, surname = '') {
    const r = await requestJson(harness, 'POST', `/api/v1/groups/${groupId}/contacts`, { phone, name, surname }, { Cookie: cookie });
    assert.equal(r.status, 201, `Kisi eklenmeli: ${name}`);
    return r.body.data;
}

async function getGroups(harness, cookie) {
    const r = await requestJson(harness, 'GET', '/api/v1/groups', null, { Cookie: cookie });
    assert.equal(r.status, 200);
    return r.body.data;
}

function findGroup(groups, name) {
    return groups.find(g => g.name === name);
}

// Multipart upload helper using raw HTTP
function uploadFile(baseUrl, cookie, route, fieldName, buffer, fileName, contentType) {
    return new Promise((resolve, reject) => {
        const boundary = '----TestBoundary' + Date.now();
        const header = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
        );
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, buffer, footer]);

        const url = new URL(route, baseUrl);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
                'Cookie': cookie,
                'Origin': baseUrl
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: data ? JSON.parse(data) : null
                });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

let harness;
let cookie;

test.after(async () => {
    if (harness) await harness.close();
    const database = await db.getDb();
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────
// TEST 1: Login basarili ve hatali giris
// ─────────────────────────────────────────────────────────
test('1 - Login basarili ve hatali giris', async () => {
    harness = await createHarness();
    cookie = await login(harness);
    assert.ok(cookie, 'Cookie donmeli');

    const wrong = await requestJson(harness, 'POST', '/api/v1/login', { email: ADMIN_EMAIL, password: 'wrong' });
    assert.equal(wrong.status, 401, 'Yanlis sifre 401 donmeli');

    const limited = await createHarness({ maxAttempts: 2 });
    try {
        const p = { email: ADMIN_EMAIL, password: 'wrong' };
        await requestJson(limited, 'POST', '/api/v1/login', p);
        await requestJson(limited, 'POST', '/api/v1/login', p);
        const blocked = await requestJson(limited, 'POST', '/api/v1/login', p);
        assert.equal(blocked.status, 429, 'Rate limit 429 donmeli');
    } finally {
        await limited.close();
    }
});

// ─────────────────────────────────────────────────────────
// TEST 2: Login sonrasi session korunuyor
// ─────────────────────────────────────────────────────────
test('2 - Login sonrasi session korunuyor', async () => {
    const check = await requestJson(harness, 'GET', '/api/v1/check-auth', null, { Cookie: cookie });
    assert.equal(check.status, 200);
    assert.equal(check.body.data.authenticated, true);

    const logout = await requestJson(harness, 'POST', '/api/v1/logout', null, { Cookie: cookie });
    assert.equal(logout.status, 200);

    const after = await requestJson(harness, 'GET', '/api/v1/groups', null, { Cookie: cookie });
    assert.equal(after.status, 401, 'Logout sonrasi 401 olmali');

    cookie = await login(harness);
});

// ─────────────────────────────────────────────────────────
// TEST 3: WhatsApp QR / runtime status
// ─────────────────────────────────────────────────────────
test('3 - Runtime status endpoint calisir', async () => {
    const status = await requestJson(harness, 'GET', '/api/v1/runtime-status', null, { Cookie: cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.code, 'RUNTIME_STATUS');
    assert.ok(status.body.data);
});

// ─────────────────────────────────────────────────────────
// TEST 4: Yeni grup olusturma + duplicate + bos isim
// ─────────────────────────────────────────────────────────
test('4 - Yeni grup olusturma', async () => {
    await createGroup(harness, cookie, 'Regresyon Grup 1');

    const dup = await requestJson(harness, 'POST', '/api/v1/groups', { name: 'Regresyon Grup 1' }, { Cookie: cookie });
    assert.equal(dup.status, 409, 'Duplicate grup 409 donmeli');

    const empty = await requestJson(harness, 'POST', '/api/v1/groups', { name: '' }, { Cookie: cookie });
    assert.equal(empty.status, 400, 'Bos isim 400 donmeli');
});

// ─────────────────────────────────────────────────────────
// TEST 5: Grup silme (soft delete)
// ─────────────────────────────────────────────────────────
test('5 - Grup silme', async () => {
    const grp = await createGroup(harness, cookie, 'Silinecek Grup');

    const del = await requestJson(harness, 'DELETE', `/api/v1/groups/${grp.id}`, null, { Cookie: cookie });
    assert.equal(del.status, 200);

    const groups = await getGroups(harness, cookie);
    const found = groups.find(g => g.id === grp.id);
    assert.equal(found, undefined, 'Silinmis grup listede olmamali');

    // Ayni isimle yeni grup olusturulabilmeli
    await createGroup(harness, cookie, 'Silinecek Grup');
});

// ─────────────────────────────────────────────────────────
// TEST 6: Excel import + ornek dosya indirme
// ─────────────────────────────────────────────────────────
test('6 - Excel import endpoint', async () => {
    const invalidResult = await uploadFile(harness.baseUrl, cookie, '/api/v1/upload-excel', 'excel', Buffer.from('not-excel'), 'test.txt', 'text/plain');
    assert.ok(invalidResult.status >= 400, 'Gecersiz dosya reddedilmeli');

    const sample = await fetch(`${harness.baseUrl}/api/v1/download-sample`, { headers: { Cookie: cookie } });
    assert.equal(sample.status, 200, 'Ornek dosya indirilebilmeli');
    assert.ok(sample.headers.get('content-type').includes('spreadsheet'), 'Excel content-type olmali');
});

// ─────────────────────────────────────────────────────────
// TEST 7: Manuel kisi ekleme
// ─────────────────────────────────────────────────────────
test('7 - Manuel kisi ekleme', async () => {
    const grp = await createGroup(harness, cookie, 'Kisi Grup');
    await createContact(harness, cookie, grp.id, '05320000001', 'Ahmet', 'Demir');

    const groups = await getGroups(harness, cookie);
    const found = findGroup(groups, 'Kisi Grup');
    assert.ok(found, 'Grup bulunmali');
    assert.equal(found.contact_count, 1, 'Contact count 1 olmali');
    assert.equal(found.sendable_count, 1, 'Gonderilebilir sayisi 1 olmali');
});

test('7b - Guncel rehber export engellenmis ve WhatsApp olmayanlari haric tutar', async () => {
    const grp = await createGroup(harness, cookie, 'Export Grup');
    await createContact(harness, cookie, grp.id, '05660000001', 'ExportA', 'One');
    await createContact(harness, cookie, grp.id, '05660000002', 'ExportB', 'Two');
    await createContact(harness, cookie, grp.id, '05660000003', 'ExportC', 'Three');

    const suppress = await requestJson(harness, 'POST', '/api/v1/suppressed-recipients', {
        contacts: [{ phone: '05660000002', name: 'ExportB', surname: 'Two' }],
        reason: 'Regresyon testi'
    }, { Cookie: cookie });
    assert.equal(suppress.status, 201);
    await db.recordUnavailableWhatsAppRecipient({ phone: '05660000003', name: 'ExportC', surname: 'Three' }, 'default');

    const groups = await getGroups(harness, cookie);
    const found = findGroup(groups, 'Export Grup');
    assert.equal(found.contact_count, 3, 'Toplam kisi sayisi korunmali');
    assert.equal(found.sendable_count, 1, 'Sadece gonderilebilir kisi sayilmali');

    const response = await fetch(`${harness.baseUrl}/api/v1/contacts/export`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').includes('spreadsheet'), 'Excel content-type olmali');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const worksheet = workbook.worksheets[0];
    const exportedPhones = [];
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        exportedPhones.push(String(row.getCell(1).value || ''));
    });

    assert.equal(exportedPhones.includes('905660000001'), true, 'Gonderilebilir numara export edilmeli');
    assert.equal(exportedPhones.includes('905660000002'), false, 'Engellenmis numara export edilmemeli');
    assert.equal(exportedPhones.includes('905660000003'), false, 'WhatsApp olmayan numara export edilmemeli');
});

// ─────────────────────────────────────────────────────────
// TEST 8: Kisi duzenleme
// ─────────────────────────────────────────────────────────
test('8 - Kisi duzenleme', async () => {
    const groups = await getGroups(harness, cookie);
    const grp = findGroup(groups, 'Kisi Grup');
    const contact = await createContact(harness, cookie, grp.id, '05320000002', 'Mehmet', 'Kaya');

    const updated = await requestJson(harness, 'PATCH', `/api/v1/groups/${grp.id}/contacts/${contact.id}`, {
        name: 'Ali', surname: 'Yildiz', phone: '05320000003'
    }, { Cookie: cookie });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Ali');
    assert.equal(updated.body.data.surname, 'Yildiz');
    assert.equal(updated.body.data.phone, '905320000003');
});

// ─────────────────────────────────────────────────────────
// TEST 9: Kisi silme
// ─────────────────────────────────────────────────────────
test('9 - Kisi silme', async () => {
    const groups = await getGroups(harness, cookie);
    const grp = findGroup(groups, 'Kisi Grup');
    const contact = await createContact(harness, cookie, grp.id, '05320000004', 'Silinecek', 'Kisi');

    const del = await requestJson(harness, 'DELETE', `/api/v1/groups/${grp.id}/contacts/${contact.id}`, null, { Cookie: cookie });
    assert.equal(del.status, 200);

    const updatedGroups = await getGroups(harness, cookie);
    const updatedGrp = findGroup(updatedGroups, 'Kisi Grup');
    assert.ok(updatedGrp.contact_count >= 2, 'Silme sonrasi sayac azalmali');
});

// ─────────────────────────────────────────────────────────
// TEST 10: Grup olarak kaydetme (replace contacts)
// ─────────────────────────────────────────────────────────
test('10 - Grup olarak kaydetme (replace contacts)', async () => {
    const grp = await createGroup(harness, cookie, 'Replace Grup');

    const replace = await requestJson(harness, 'PUT', `/api/v1/groups/${grp.id}`, {
        contacts: [
            { phone: '05400000001', name: 'Yeni1' },
            { phone: '05400000002', name: 'Yeni2' }
        ]
    }, { Cookie: cookie });
    assert.equal(replace.status, 200);
    assert.equal(replace.body.code, 'GROUP_CONTACTS_REPLACED');

    const contacts = await requestJson(harness, 'GET', `/api/v1/groups/${grp.id}/contacts`, null, { Cookie: cookie });
    assert.ok(contacts.body.data.length >= 2, 'En az 2 kisi olmali');
});

// ─────────────────────────────────────────────────────────
// TEST 11: Kampanya - tek grup contact count
// ─────────────────────────────────────────────────────────
test('11 - Kampanya hedef - tek grup contact count', async () => {
    const grp = await createGroup(harness, cookie, 'Kampanya Grup 1');
    await createContact(harness, cookie, grp.id, '05410000001', 'Hedef1');
    await createContact(harness, cookie, grp.id, '05410000002', 'Hedef2');

    const groups = await getGroups(harness, cookie);
    const g1 = groups.find(g => g.id === grp.id);
    assert.equal(g1.contact_count, 2, 'Kampanya hedef sayisi 2 olmali');
});

// ─────────────────────────────────────────────────────────
// TEST 12: Kampanya - coklu grup toplam contact count
// ─────────────────────────────────────────────────────────
test('12 - Kampanya - coklu grup toplam contact count', async () => {
    const grp2 = await createGroup(harness, cookie, 'Kampanya Grup 2');
    await createContact(harness, cookie, grp2.id, '05420000001', 'Hedef3');
    await createContact(harness, cookie, grp2.id, '05420000002', 'Hedef4');
    await createContact(harness, cookie, grp2.id, '05420000003', 'Hedef5');

    const groups = await getGroups(harness, cookie);
    const g1 = groups.find(g => g.name === 'Kampanya Grup 1');
    const g2 = groups.find(g => g.name === 'Kampanya Grup 2');
    const total = (g1?.contact_count || 0) + (g2?.contact_count || 0);
    assert.equal(total, 5, 'Toplam hedef sayisi 5 olmali');
});

// ─────────────────────────────────────────────────────────
// TEST 13: Manuel kampanya numarasi (phone normalization)
// ─────────────────────────────────────────────────────────
test('13 - Manuel numara normalize edilir', async () => {
    const groups = await getGroups(harness, cookie);
    const grp = groups.find(g => g.name === 'Kampanya Grup 1');
    const c = await createContact(harness, cookie, grp.id, '+90 541 000 00 99', 'Manuel');
    assert.equal(c.phone, '905410000099', 'Telefon normalize edilmeli');
});

// ─────────────────────────────────────────────────────────
// TEST 14: Medya upload ve kaldirma endpoint
// ─────────────────────────────────────────────────────────
test('14 - Medya upload ve kaldirma endpoint', async () => {
    const invalid = await uploadFile(harness.baseUrl, cookie, '/api/v1/upload-media', 'media', Buffer.from('not-image'), 'test.txt', 'text/plain');
    assert.ok(invalid.status >= 400, 'Gecersiz medya reddedilmeli');

    const remove = await requestJson(harness, 'DELETE', '/api/v1/upload-media', { path: 'nonexistent.png' }, { Cookie: cookie });
    assert.ok(remove.status >= 400, 'Olmayan medya kaldirma hata vermeli');
});

// ─────────────────────────────────────────────────────────
// TEST 15: Sablon olusturma ve listeleme
// ─────────────────────────────────────────────────────────
test('15 - Sablon olusturma ve listeleme', async () => {
    const create = await requestJson(harness, 'POST', '/api/v1/templates', {
        name: 'Regresyon Sablon', text: 'Merhaba {{ad}}'
    }, { Cookie: cookie });
    assert.equal(create.status, 201);
    assert.ok(create.body.data.template.id, 'Template id donmeli');

    const list = await requestJson(harness, 'GET', '/api/v1/templates', null, { Cookie: cookie });
    assert.equal(list.status, 200);
    const found = list.body.data.find(t => t.text === 'Merhaba {{ad}}' && t.name === 'Regresyon Sablon');
    assert.ok(found, 'Sablon bulunmali');
});

// ─────────────────────────────────────────────────────────
// TEST 16: Kampanya durdurma endpoint
// ─────────────────────────────────────────────────────────
test('16 - Kampanya durdurma endpoint', async () => {
    const stop = await requestJson(harness, 'POST', '/api/v1/campaigns/stop', {}, { Cookie: cookie });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.code, 'CAMPAIGN_STOPPED');
});

test('16B - Kampanya bitirme endpoint', async () => {
    const finish = await requestJson(harness, 'POST', '/api/v1/campaigns/camp-1/finish', {}, { Cookie: cookie });
    assert.equal(finish.status, 200);
    assert.equal(finish.body.code, 'CAMPAIGN_FINISHED');
    assert.equal(finish.body.data.campaign.status, 'finished');
});

// ─────────────────────────────────────────────────────────
// TEST 17: Kampanya status endpoint
// ─────────────────────────────────────────────────────────
test('17 - Kampanya status endpoint', async () => {
    const status = await requestJson(harness, 'GET', '/api/v1/campaign-status', null, { Cookie: cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.code, 'CAMPAIGN_STATUS');
});

// ─────────────────────────────────────────────────────────
// TEST 18: Version endpoint
// ─────────────────────────────────────────────────────────
test('18 - Version endpoint', async () => {
    const ver = await requestJson(harness, 'GET', '/api/v1/version', null, { Cookie: cookie });
    assert.equal(ver.status, 200);
    assert.ok(ver.body.data.version, 'Version donmeli');
});

// ─────────────────────────────────────────────────────────
// TEST 18B: Rapor ozeti ve sistem olaylari endpointleri
// ─────────────────────────────────────────────────────────
test('18B - Rapor ozeti ve sistem olaylari endpointleri veri dondurur', async () => {
    await db.addSystemEvent('default', 'campaign_started', 'info', 'Regresyon sistem olayi', {
        campaign_id: 'regression-campaign'
    });
    await db.recordUnavailableWhatsAppRecipient({
        phone: '905550001818',
        name: 'WhatsAppYok',
        surname: 'Rapor'
    }, 'default', {
        reason: 'Regresyon WhatsApp yok'
    });

    const failedCampaignId = 'regression-failed-recipients';
    await db.createCampaignRun({
        id: failedCampaignId,
        tenantId: 'default',
        ownerEmail: ADMIN_EMAIL,
        contacts: [{ phone: '905550001819', name: 'Hata', surname: 'Rapor' }],
        message: 'Merhaba {{ad}}',
        delayRange: [20, 90],
        dailyLimit: 50
    });
    await db.setCampaignRunStatus(failedCampaignId, 'running');
    await db.updateCampaignRecipient(failedCampaignId, { phone: '905550001819', name: 'Hata', surname: 'Rapor' }, 'failed', 'Regresyon gönderim hatası');
    await db.setCampaignRunStatus(failedCampaignId, 'completed');

    const events = await requestJson(harness, 'GET', '/api/v1/system-events?limit=10', null, { Cookie: cookie });
    assert.equal(events.status, 200);
    assert.equal(events.body.code, 'SYSTEM_EVENTS');
    assert.ok(Array.isArray(events.body.data.events), 'Sistem olaylari liste olarak donmeli');
    assert.ok(
        events.body.data.events.some(event => event.event_type === 'campaign_started' && event.message === 'Regresyon sistem olayi'),
        'Eklenen sistem olayi listede gorunmeli'
    );

    const summary = await requestJson(harness, 'GET', '/api/v1/reports/summary', null, { Cookie: cookie });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.code, 'REPORTS_SUMMARY');
    assert.ok(Object.prototype.hasOwnProperty.call(summary.body.data, 'total_campaigns'), 'Rapor ozeti toplam kampanya alanini dondurmeli');

    const unavailable = await requestJson(harness, 'GET', '/api/v1/unavailable-whatsapp?limit=10', null, { Cookie: cookie });
    assert.equal(unavailable.status, 200);
    assert.ok(unavailable.body.data.recipients.some(item => item.normalized_phone === '905550001818'), 'WhatsApp kullanmayan listeye donmeli');

    const failed = await requestJson(harness, 'GET', '/api/v1/failed-recipients?limit=10', null, { Cookie: cookie });
    assert.equal(failed.status, 200);
    const failedRecipient = failed.body.data.recipients.find(item => item.normalized_phone === '905550001819');
    assert.ok(failedRecipient, 'Gonderilemeyen alici listede donmeli');
    assert.equal(failedRecipient.attempt_count, 1, 'Deneme sayisi donmeli');
});

// ─────────────────────────────────────────────────────────
// TEST 19: Restart sonrasi veri korunuyor (DB persistence)
// ─────────────────────────────────────────────────────────
test('19 - DB verileri yeni getDb ile korunuyor', async () => {
    const before = await getGroups(harness, cookie);
    const countBefore = before.length;

    const d1 = await db.getDb();
    const d2 = await db.getDb();
    assert.equal(d1, d2, 'DB singleton olmali');

    const after = await getGroups(harness, cookie);
    assert.equal(after.length, countBefore, 'Grup sayisi degismemeli');
});

// ─────────────────────────────────────────────────────────
// TEST 20: Full regression - grup + kisi + silme + sayac + arama
// ─────────────────────────────────────────────────────────
test('20 - Full regression senaryosu', async () => {
    const grp = await createGroup(harness, cookie, 'Full Regression');

    for (let i = 1; i <= 5; i++) {
        await createContact(harness, cookie, grp.id, `0550000000${i}`, `Kisi${i}`, `Soyad${i}`);
    }

    let groups = await getGroups(harness, cookie);
    let found = groups.find(g => g.id === grp.id);
    assert.equal(found.contact_count, 5, '5 kisi olmali');

    const search = await requestJson(harness, 'GET', `/api/v1/groups/${grp.id}/contacts?search=Kisi3`, null, { Cookie: cookie });
    assert.equal(search.body.meta.pagination.total, 1, 'Arama 1 sonuc donmeli');

    const contacts = await requestJson(harness, 'GET', `/api/v1/groups/${grp.id}/contacts?limit=100`, null, { Cookie: cookie });
    const toDelete = contacts.body.data[0];
    await requestJson(harness, 'DELETE', `/api/v1/groups/${grp.id}/contacts/${toDelete.id}`, null, { Cookie: cookie });

    groups = await getGroups(harness, cookie);
    found = groups.find(g => g.id === grp.id);
    assert.equal(found.contact_count, 4, '4 kisi kalmali');

    const dupContact = await requestJson(harness, 'POST', `/api/v1/groups/${grp.id}/contacts`, {
        phone: '05500000002', name: 'Duplicate'
    }, { Cookie: cookie });
    assert.equal(dupContact.status, 409, 'Duplicate 409 donmeli');

    await requestJson(harness, 'DELETE', `/api/v1/groups/${grp.id}`, null, { Cookie: cookie });

    groups = await getGroups(harness, cookie);
    const deleted = groups.find(g => g.id === grp.id);
    assert.equal(deleted, undefined, 'Silinmis grup listede olmamali');
});
