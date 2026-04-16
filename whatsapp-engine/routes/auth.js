const express = require('express');
const bcrypt = require('bcryptjs');
const { sendSuccess } = require('../lib/api_response');
const { getRequestLogger } = require('../lib/logger');

function sessionRegenerate(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => err ? reject(err) : resolve());
    });
}

function sessionSave(req) {
    return new Promise((resolve, reject) => {
        req.session.save((err) => err ? reject(err) : resolve());
    });
}

function sessionDestroy(req) {
    return new Promise((resolve, reject) => {
        req.session.destroy((err) => err ? reject(err) : resolve());
    });
}

async function writeAuthAudit(db, req, action, metadata = {}, tenantId = 'default', entityId = 'auth') {
    if (!db?.addAuditLog) return;
    try {
        await db.addAuditLog(action, 'auth', entityId, {
            ...metadata,
            ip: req.ip,
            user_agent: req.get('user-agent')
        }, tenantId);
    } catch (err) {
        getRequestLogger(req, { component: 'auth', auditAction: action }).error({ err }, 'audit_log_write_failed');
    }
}

function createAuthRouter(options = {}) {
    const router = express.Router();
    const {
        adminEmail,
        adminPassHash,
        db,
        loginLimiter,
        sessionName,
        sessionCookieOptions,
        defaultTenantId = 'default'
    } = options;

    router.post('/login', async (req, res) => {
        const log = getRequestLogger(req, { component: 'auth' });
        const email = String(req.body?.email || '').trim();
        try {
            const password = String(req.body?.password || '');
            if (!adminEmail || !adminPassHash) {
                log.error('auth_config_missing');
                return res.status(500).json({ data: null, error: 'Sunucu giriş yapılandırması eksik.', code: 'AUTH_CONFIG_MISSING' });
            }

            loginLimiter.assertAllowed(req, email);

            if (email !== adminEmail) {
                loginLimiter.recordFailure(req, email);
                await writeAuthAudit(db, req, 'login_failed', { email, reason: 'unknown_email' }, defaultTenantId);
                log.warn({ email, authResult: 'failed', reason: 'unknown_email' }, 'login_failed');
                return res.status(401).json({ data: null, error: 'Geçersiz e-posta veya şifre', code: 'INVALID_CREDENTIALS' });
            }

            const match = await bcrypt.compare(password, adminPassHash);
            if (!match) {
                loginLimiter.recordFailure(req, email);
                await writeAuthAudit(db, req, 'login_failed', { email, reason: 'bad_password' }, defaultTenantId);
                log.warn({ email, authResult: 'failed', reason: 'bad_password' }, 'login_failed');
                return res.status(401).json({ data: null, error: 'Geçersiz e-posta veya şifre', code: 'INVALID_CREDENTIALS' });
            }

            try {
                await sessionRegenerate(req);
            } catch (err) {
                log.error({ err }, 'session_regenerate_failed');
                return res.status(500).json({ data: null, error: 'Oturum başlatılamadı.', code: 'SESSION_REGENERATE_FAILED' });
            }
            req.session.user = {
                email,
                tenant_id: defaultTenantId,
                user_id: `${defaultTenantId}:admin`,
                role: 'owner'
            };
            try {
                await sessionSave(req);
            } catch (err) {
                log.error({ err }, 'session_save_failed');
                return res.status(500).json({ data: null, error: 'Oturum kaydedilemedi.', code: 'SESSION_SAVE_FAILED' });
            }

            loginLimiter.clear(req, email);
            await writeAuthAudit(db, req, 'login_success', { email, user_id: req.session.user.user_id }, defaultTenantId, req.session.user.user_id);
            getRequestLogger(req, { component: 'auth' }).info({ authResult: 'success' }, 'login_success');
            sendSuccess(res, { success: true }, 'LOGIN_SUCCESS');
        } catch (err) {
            if (err.status === 429) {
                if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
                await writeAuthAudit(db, req, 'login_failed', { email, reason: 'rate_limited' }, defaultTenantId);
                log.warn({ email, retryAfter: err.retryAfter, authResult: 'failed', reason: 'rate_limited' }, 'login_rate_limited');
                return res.status(429).json({ data: null, error: err.message, code: err.code || 'RATE_LIMITED' });
            }
            log.error({ err }, 'login_endpoint_failed');
            res.status(500).json({ data: null, error: 'Giriş sırasında beklenmeyen bir hata oluştu.', code: 'LOGIN_FAILED' });
        }
    });

    router.post('/logout', async (req, res) => {
        const log = getRequestLogger(req, { component: 'auth' });
        const user = req.session?.user || null;
        const clearSessionCookie = () => {
            res.clearCookie(sessionName, {
                secure: sessionCookieOptions.secure,
                sameSite: sessionCookieOptions.sameSite,
                httpOnly: sessionCookieOptions.httpOnly
            });
        };

        if (!req.session) {
            clearSessionCookie();
            return sendSuccess(res, { success: true }, 'LOGOUT_SUCCESS');
        }

        try {
            await sessionDestroy(req);
            clearSessionCookie();
            if (user) {
                await writeAuthAudit(db, req, 'logout_success', { user_id: user.user_id }, user.tenant_id || defaultTenantId, user.user_id || 'auth');
                log.info({ tenantId: user.tenant_id, userId: user.user_id }, 'logout_success');
            }
            sendSuccess(res, { success: true }, 'LOGOUT_SUCCESS');
        } catch (err) {
            log.error({ err }, 'logout_session_destroy_failed');
            res.status(500).json({ data: null, error: 'Oturum kapatılamadı.', code: 'LOGOUT_FAILED' });
        }
    });

    router.get('/check-auth', (req, res) => {
        sendSuccess(res, { authenticated: !!(req.session && req.session.user) }, 'AUTH_STATUS');
    });

    return router;
}

module.exports = { createAuthRouter };
