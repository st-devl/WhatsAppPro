function requireTenant(req, res, next) {
    const tenantId = req.session?.user?.tenant_id;
    if (!tenantId) {
        return res.status(403).json({ 
            error: 'Bu işlem için aktif bir hesap gerekli.', 
            code: 'TENANT_REQUIRED' 
        });
    }
    // Req nesnesine kolay erişim için ekle
    req.tenantId = tenantId;
    next();
}

function requireSuperAdmin(req, res, next) {
    const role = req.session?.user?.role;
    // Mevcut sistemde "owner" veya "super_admin" rollerini super admin kabul ediyoruz.
    if (role !== 'super_admin' && role !== 'owner') {
        return res.status(403).json({ 
            error: 'Bu işlem için yetkiniz yok.', 
            code: 'FORBIDDEN' 
        });
    }
    next();
}

module.exports = {
    requireTenant,
    requireSuperAdmin
};
