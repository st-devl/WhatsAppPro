const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');

const db = require('./lib/db');
const { LoginRateLimiter } = require('./lib/login_rate_limiter');
const { MediaStore } = require('./lib/media_store');
const { createUploadMiddleware, uploadStorageBaseDir } = require('./lib/upload_middleware');
const { createTenantUploadMiddleware } = require('./lib/tenant_uploads');
const { WhatsAppRegistry } = require('./lib/whatsapp_registry');
const { KeepAwake } = require('./lib/keep_awake');
const { createErrorMiddleware, createNotFoundMiddleware } = require('./lib/api_errors');
const { componentLogger, createRequestLoggerMiddleware, logger } = require('./lib/logger');
const { acquireProcessLock } = require('./lib/process_lock');
const { parseTrustProxy } = require('./lib/proxy_config');
const { readReleaseManifest } = require('./lib/release_manifest');
const { requireAuth } = require('./middleware/auth');
const { createSecurityHeaders, requireSameOriginForStateChanges } = require('./middleware/security');
const { createSessionMiddleware } = require('./middleware/session');
const { createAuthRouter } = require('./routes/auth');
const { createSystemRouter } = require('./routes/system');
const { createUsersRouter } = require('./routes/users');
const { createTemplateRouter } = require('./routes/templates');
const { createGroupRouter } = require('./routes/groups');
const { createContactRouter } = require('./routes/contacts');
const { createUploadRouter } = require('./routes/uploads');
const { createCampaignRouter } = require('./routes/campaigns');
const { createAuditRouter } = require('./routes/audit');
const { CampaignService } = require('./services/campaign_service');
const { registerCampaignSocket } = require('./socket/campaign_socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const serverLogger = componentLogger('server');
const processLock = acquireProcessLock(__dirname);

app.set('trust proxy', parseTrustProxy());
app.disable('x-powered-by');

fs.ensureDirSync(path.join(uploadStorageBaseDir(__dirname), 'uploads'));

const { sessionName, sessionCookieOptions, sessionMiddleware } = createSessionMiddleware(__dirname);
const loginLimiter = new LoginRateLimiter({
    windowMs: process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
    maxAttempts: process.env.LOGIN_RATE_LIMIT_MAX
});
const mediaStore = new MediaStore();
const keepAwake = new KeepAwake();
const upload = createUploadMiddleware(__dirname);
const defaultTenantId = process.env.DEFAULT_TENANT_ID || 'default';
const runtime = new WhatsAppRegistry({
    io,
    baseDir: __dirname,
    maxAutoRetries: process.env.WHATSAPP_MAX_AUTO_RETRIES || '3',
    logger: componentLogger('whatsapp_runtime')
});

// Admin server başladıktan sonra auth check veya lazy-init
runtime.getOrCreate(defaultTenantId);

const campaignService = new CampaignService({ db, runtime, mediaStore, keepAwake, logger: componentLogger('campaign_service') });
const authRouterOptions = {
    db,
    loginLimiter,
    sessionName,
    sessionCookieOptions,
    defaultTenantId
};
const protectedApiOptions = { baseDir: __dirname, runtime, upload, mediaStore, db, campaignService };

function mountProtectedApi(prefix, options) {
    app.use(prefix, createSystemRouter({ baseDir: options.baseDir, runtime: options.runtime }));
    app.use(prefix + '/users', createUsersRouter(options.db));
    app.use(prefix, createTemplateRouter(options.db));
    app.use(prefix, createGroupRouter(options.db));
    app.use(prefix, createContactRouter(options.db));
    app.use(prefix, createUploadRouter({
        baseDir: options.baseDir,
        upload: options.upload,
        mediaStore: options.mediaStore,
        db: options.db
    }));
    app.use(prefix, createCampaignRouter({ campaignService: options.campaignService }));
    app.use(prefix, createAuditRouter(options.db));
}

function legacyApiDeprecationHeaders(req, res, next) {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/v1>; rel="successor-version"');
    res.setHeader('Sunset', 'Wed, 30 Sep 2026 00:00:00 GMT');
    next();
}

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(createRequestLoggerMiddleware());
app.use(createSecurityHeaders({ secureCookies: sessionCookieOptions.secure }));
app.use(express.json({ limit: '10mb' }));
app.use(requireSameOriginForStateChanges);

app.use('/api', createAuthRouter(authRouterOptions));
app.use('/api/v1', createAuthRouter(authRouterOptions));

app.get('/app-version', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: await readReleaseManifest(__dirname), error: null, code: 'VERSION' });
});

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        status: {
            http: runtime.getStatus(defaultTenantId).http,
            uptime_seconds: Math.round(process.uptime())
        }
    });
});

app.get('/readyz', async (req, res) => {
    try {
        const d = await db.getDb();
        const journalMode = d.pragma('journal_mode', { simple: true });
        const status = runtime.getStatus(defaultTenantId);
        const ready = status.http === 'listening';
        res.status(ready ? 200 : 503).json({
            ok: ready,
            checks: {
                http: status.http,
                database: 'ok',
                journal_mode: journalMode,
                whatsapp: status.whatsapp
            }
        });
    } catch (err) {
        serverLogger.error({ err }, 'readiness_check_failed');
        res.status(503).json({
            ok: false,
            checks: {
                database: 'error'
            }
        });
    }
});

app.get('/healthz/details', requireAuth, (req, res) => {
    const tenantId = req.session?.user?.tenant_id || defaultTenantId;
    const status = runtime.getStatus(tenantId);
    res.json({
        ok: status.http === 'listening',
        status
    });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/release.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public/release.json'));
});
app.use('/css', express.static(path.join(__dirname, 'public/css'), {
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));
app.use(requireAuth, express.static(path.join(__dirname, 'public'), {
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/shared', requireAuth, express.static(path.join(__dirname, 'shared'), {
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));
app.get('/uploads/:tenantId/*', requireAuth, createTenantUploadMiddleware(__dirname));
app.use('/api', requireAuth);
mountProtectedApi('/api/v1', protectedApiOptions);
app.use('/api', legacyApiDeprecationHeaders);
mountProtectedApi('/api', protectedApiOptions);
app.use('/api/v1', createNotFoundMiddleware());
app.use('/api', createNotFoundMiddleware());
app.use(createErrorMiddleware());

registerCampaignSocket(io, { runtime, campaignService });

process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled_rejection');
});

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught_exception');
    process.exit(1);
});

const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || '0.0.0.0';
const AUDIT_RETENTION_DAYS = process.env.AUDIT_RETENTION_DAYS;

function scheduleAuditRetention() {
    if (!AUDIT_RETENTION_DAYS) return;
    const runRetention = () => {
        db.purgeExpiredAuditLogs(AUDIT_RETENTION_DAYS)
            .then(result => {
                if (result.enabled) serverLogger.info(result, 'audit_retention_completed');
            })
            .catch(err => serverLogger.error({ err }, 'audit_retention_failed'));
    };
    runRetention();
    const timer = setInterval(runRetention, 24 * 60 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
}

server.on('error', (err) => {
    runtime.setHttpStatus('error', err);
    serverLogger.fatal({ err }, 'http_server_start_failed');
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    runtime.setHttpStatus('listening');
    serverLogger.info({ host: HOST, port: PORT, processLockPath: processLock?.lockPath || null }, 'http_server_listening');
    scheduleAuditRetention();
    runtime.scheduleInit();
    recoverRunningCampaigns();
});

async function recoverRunningCampaigns() {
    try {
        const d = await db.getDb();
        const result = d.exec("SELECT id FROM campaign_runs WHERE status = 'running'");
        if (!result || !result[0] || result[0].values.length === 0) return;
        const ids = result[0].values.map(row => row[0]);
        d.run("UPDATE campaign_runs SET status = 'paused' WHERE status = 'running'");
        serverLogger.warn({ count: ids.length, ids }, 'recovered_running_campaigns_paused');
    } catch (err) {
        serverLogger.error({ err }, 'campaign_recovery_failed');
    }
}
