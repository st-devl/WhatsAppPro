const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');

const db = require('./lib/db');
const { LoginRateLimiter } = require('./lib/login_rate_limiter');
const { MediaStore } = require('./lib/media_store');
const { createUploadMiddleware } = require('./lib/upload_middleware');
const { WhatsAppRuntime } = require('./lib/whatsapp_runtime');
const { createErrorMiddleware, createNotFoundMiddleware } = require('./lib/api_errors');
const { componentLogger, createRequestLoggerMiddleware, logger } = require('./lib/logger');
const { requireAuth } = require('./middleware/auth');
const { createSecurityHeaders, requireSameOriginForStateChanges } = require('./middleware/security');
const { createSessionMiddleware } = require('./middleware/session');
const { createAuthRouter } = require('./routes/auth');
const { createSystemRouter } = require('./routes/system');
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

app.set('trust proxy', 1);
app.disable('x-powered-by');

fs.ensureDirSync(path.join(__dirname, 'uploads'));

const { sessionName, sessionCookieOptions, sessionMiddleware } = createSessionMiddleware(__dirname);
const loginLimiter = new LoginRateLimiter({
    windowMs: process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
    maxAttempts: process.env.LOGIN_RATE_LIMIT_MAX
});
const mediaStore = new MediaStore();
const upload = createUploadMiddleware(__dirname);
const runtime = new WhatsAppRuntime({
    io,
    baseDir: __dirname,
    defaultTenantId: process.env.DEFAULT_TENANT_ID || 'default',
    maxAutoRetries: process.env.WHATSAPP_MAX_AUTO_RETRIES || '3',
    logger: componentLogger('whatsapp_runtime')
});
const campaignService = new CampaignService({ db, runtime, mediaStore, logger: componentLogger('campaign_service') });
const authRouterOptions = {
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassHash: process.env.ADMIN_PASS_HASH,
    db,
    loginLimiter,
    sessionName,
    sessionCookieOptions,
    defaultTenantId: process.env.DEFAULT_TENANT_ID || 'default'
};
const protectedApiOptions = { baseDir: __dirname, runtime, upload, mediaStore, db, campaignService };

function mountProtectedApi(prefix, options) {
    app.use(prefix, createSystemRouter({ baseDir: options.baseDir, runtime: options.runtime }));
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
    const pkg = await fs.readJson(path.join(__dirname, 'package.json')).catch(() => ({ version: '0.0.0' }));
    res.json({ data: { version: pkg.version }, error: null, code: 'VERSION' });
});

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        status: {
            http: runtime.getStatus().http,
            uptime_seconds: Math.round(process.uptime())
        }
    });
});

app.get('/readyz', async (req, res) => {
    try {
        const d = await db.getDb();
        const journalMode = d.pragma('journal_mode', { simple: true });
        const status = runtime.getStatus();
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

app.get('/healthz/details', (req, res) => {
    const status = runtime.getStatus();
    res.json({
        ok: status.http === 'listening',
        status
    });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));
app.use('/shared', requireAuth, express.static(path.join(__dirname, 'shared')));
app.use('/uploads', requireAuth, express.static(path.join(__dirname, 'uploads')));
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
    serverLogger.info({ host: HOST, port: PORT }, 'http_server_listening');
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
