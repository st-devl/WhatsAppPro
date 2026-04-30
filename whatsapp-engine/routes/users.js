const express = require('express');
const bcrypt = require('bcryptjs');
const { asyncHandler, badRequest, notFound } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');
const { requireSuperAdmin } = require('../middleware/tenant');

function createUsersRouter(db) {
    const router = express.Router();

    // Tüm kullanıcıları listele (Sadece super admin)
    router.get('/', requireSuperAdmin, asyncHandler(async (req, res) => {
        const users = await db.getAllUsers();
        sendSuccess(res, users, 'USERS_LISTED');
    }));

    // Yeni kullanıcı ekle (Sadece super admin)
    router.post('/', requireSuperAdmin, asyncHandler(async (req, res) => {
        const { email, password, displayName } = req.body;
        
        if (!email || !password) {
            throw badRequest('Email ve şifre zorunludur.', 'MISSING_FIELDS');
        }

        // Limit kontrolü (max 10)
        const count = await db.getUserCount();
        if (count >= 10) {
            throw badRequest('Maksimum kullanıcı limitine (10) ulaşıldı.', 'USER_LIMIT_REACHED');
        }

        const passwordHash = await bcrypt.hash(password, 10);
        
        // TenantID oluştur (Kısa ve benzersiz)
        const tenantId = `t_${Math.random().toString(36).substring(2, 9)}`;
        
        // Önce Tenant'ı oluştur
        await db.createTenant(tenantId, displayName || email.split('@')[0]);
        
        // Sonra Kullanıcıyı oluştur
        const user = await db.createUser(tenantId, email, passwordHash, 'user', displayName);
        
        // Response'dan hash'i çıkar
        delete user.password_hash;
        
        sendSuccess(res, user, 'USER_CREATED', 201);
    }));

    // Kullanıcı sil (Sadece super admin)
    router.delete('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        // Kendini silmesini engelle
        if (id === req.session.user.user_id) {
            throw badRequest('Kendi hesabınızı silemezsiniz.', 'CANNOT_DELETE_SELF');
        }
        
        await db.deleteUser(id);
        sendSuccess(res, { success: true }, 'USER_DELETED');
    }));

    return router;
}

module.exports = { createUsersRouter };
