const path = require('path');
const fs = require('fs-extra');
const { safeTenantSegment, uploadStorageBaseDir } = require('./upload_middleware');

function tenantUploadsDir(baseDir, tenantId = 'default') {
    return path.resolve(uploadStorageBaseDir(baseDir), 'uploads', safeTenantSegment(tenantId));
}

function resolveTenantUploadPath(baseDir, tenantId, relativePath = '') {
    const uploadsDir = tenantUploadsDir(baseDir, tenantId);
    const absolutePath = path.resolve(uploadsDir, relativePath);
    if (absolutePath !== uploadsDir && !absolutePath.startsWith(uploadsDir + path.sep)) {
        return null;
    }
    return absolutePath;
}

function createTenantUploadMiddleware(baseDir) {
    return async function serveTenantUpload(req, res, next) {
        try {
            const sessionTenant = safeTenantSegment(req.session?.user?.tenant_id || 'default');
            const requestedTenant = safeTenantSegment(req.params.tenantId || 'default');
            if (requestedTenant !== sessionTenant) {
                return res.status(403).json({ data: null, error: 'Dosyaya erişim yetkiniz yok', code: 'UPLOAD_FORBIDDEN' });
            }

            const relativePath = req.params[0] || '';
            const absolutePath = resolveTenantUploadPath(baseDir, requestedTenant, relativePath);
            if (!absolutePath) {
                return res.status(400).json({ data: null, error: 'Geçersiz dosya yolu', code: 'INVALID_UPLOAD_PATH' });
            }

            const stat = await fs.stat(absolutePath).catch(() => null);
            if (!stat?.isFile()) return next();
            return res.sendFile(absolutePath, { dotfiles: 'deny' });
        } catch (err) {
            return next(err);
        }
    };
}

module.exports = {
    createTenantUploadMiddleware,
    resolveTenantUploadPath,
    tenantUploadsDir
};
