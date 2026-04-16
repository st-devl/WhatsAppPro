const express = require('express');
const bcrypt = require('bcryptjs');
const { sendSuccess } = require('../lib/api_response');

function createAuthRouter(options = {}) {
    const router = express.Router();
    const {
        adminEmail,
        adminPassHash,
        loginLimiter,
        sessionName,
        sessionCookieOptions
    } = options;

    router.post('/login', async (req, res) => {
        try {
            const email = String(req.body?.email || '').trim();
            const password = String(req.body?.password || '');
            if (!adminEmail || !adminPassHash) {
                return res.status(500).json({ data: null, error: 'Sunucu giriş yapılandırması eksik.', code: 'AUTH_CONFIG_MISSING' });
            }

            loginLimiter.assertAllowed(req, email);

            if (email !== adminEmail) {
                loginLimiter.recordFailure(req, email);
                return res.status(401).json({ data: null, error: 'Geçersiz e-posta veya şifre', code: 'INVALID_CREDENTIALS' });
            }

            const match = await bcrypt.compare(password, adminPassHash);
            if (!match) {
                loginLimiter.recordFailure(req, email);
                return res.status(401).json({ data: null, error: 'Geçersiz e-posta veya şifre', code: 'INVALID_CREDENTIALS' });
            }

            req.session.regenerate((regenErr) => {
                if (regenErr) {
                    console.error('Session regenerate hatası:', regenErr);
                    return res.status(500).json({ data: null, error: 'Oturum başlatılamadı.', code: 'SESSION_REGENERATE_FAILED' });
                }

                req.session.user = { email };
                req.session.save((saveErr) => {
                    if (saveErr) {
                        console.error('Session save hatası:', saveErr);
                        return res.status(500).json({ data: null, error: 'Oturum kaydedilemedi.', code: 'SESSION_SAVE_FAILED' });
                    }
                    loginLimiter.clear(req, email);
                    sendSuccess(res, { success: true }, 'LOGIN_SUCCESS');
                });
            });
        } catch (err) {
            if (err.status === 429) {
                if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
                return res.status(429).json({ data: null, error: err.message, code: err.code || 'RATE_LIMITED' });
            }
            console.error('Login endpoint hatası:', err);
            res.status(500).json({ data: null, error: 'Giriş sırasında beklenmeyen bir hata oluştu.', code: 'LOGIN_FAILED' });
        }
    });

    router.post('/logout', (req, res) => {
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

        req.session.destroy((err) => {
            if (err) {
                console.error('Logout session destroy hatası:', err);
                return res.status(500).json({ data: null, error: 'Oturum kapatılamadı.', code: 'LOGOUT_FAILED' });
            }
            clearSessionCookie();
            sendSuccess(res, { success: true }, 'LOGOUT_SUCCESS');
        });
    });

    router.get('/check-auth', (req, res) => {
        sendSuccess(res, { authenticated: !!(req.session && req.session.user) }, 'AUTH_STATUS');
    });

    return router;
}

module.exports = { createAuthRouter };
