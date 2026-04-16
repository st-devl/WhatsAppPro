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
const { CampaignService } = require('./services/campaign_service');
const { registerCampaignSocket } = require('./socket/campaign_socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    maxAutoRetries: process.env.WHATSAPP_MAX_AUTO_RETRIES || '3'
});
const campaignService = new CampaignService({ db, runtime, mediaStore });
const authRouterOptions = {
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassHash: process.env.ADMIN_PASS_HASH,
    loginLimiter,
    sessionName,
    sessionCookieOptions
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
}

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(createSecurityHeaders({ secureCookies: sessionCookieOptions.secure }));
app.use(express.json({ limit: '10mb' }));
app.use(requireSameOriginForStateChanges);

app.use('/api', createAuthRouter(authRouterOptions));
app.use('/api/v1', createAuthRouter(authRouterOptions));

app.get('/healthz', (req, res) => {
    const status = runtime.getStatus();
    res.json({
        ok: status.http === 'listening',
        status
    });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));
app.use('/uploads', requireAuth, express.static(path.join(__dirname, 'uploads')));
app.use('/api', requireAuth);
mountProtectedApi('/api/v1', protectedApiOptions);
mountProtectedApi('/api', protectedApiOptions);
app.use('/api/v1', createNotFoundMiddleware());
app.use('/api', createNotFoundMiddleware());
app.use(createErrorMiddleware());

registerCampaignSocket(io, { runtime, campaignService });

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [CRITICAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRITICAL] Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || '0.0.0.0';

server.on('error', (err) => {
    runtime.setHttpStatus('error', err);
    console.error('🚨 HTTP sunucu başlatılamadı:', err);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    runtime.setHttpStatus('listening');
    console.log(`\n================================================`);
    console.log(`🌍 WhasAppC Pro Enterprise Aktif: http://${HOST}:${PORT}`);
    console.log(`================================================\n`);
    runtime.scheduleInit();
});
