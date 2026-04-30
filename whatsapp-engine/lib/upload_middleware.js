const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

function uploadFileSizeLimit() {
    const parsed = Number.parseInt(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || process.env.MEDIA_MAX_FILE_SIZE_BYTES || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024 * 1024;
}

function safeTenantSegment(tenantId = 'default') {
    return String(tenantId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function uploadStorageBaseDir(baseDir) {
    return process.env.WHASAPPC_DATA_DIR
        ? path.resolve(process.env.WHASAPPC_DATA_DIR)
        : baseDir;
}

function createUploadMiddleware(baseDir) {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = path.join(uploadStorageBaseDir(baseDir), 'uploads', safeTenantSegment(req.session?.user?.tenant_id));
            fs.ensureDirSync(uploadDir);
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, uuidv4() + ext);
        }
    });

    return multer({
        storage,
        limits: { fileSize: uploadFileSizeLimit() },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLocaleLowerCase('tr-TR');
            const allowedMimeTypes = [
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'image/jpeg', 'image/png', 'image/webp',
                'video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime'
            ];
            const isSupportedExcel = ext === '.xlsx' && file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            if (isSupportedExcel || file.mimetype.startsWith('video/') || allowedMimeTypes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Güvenlik ihlali: Bu dosya türü yüklenemez.'));
            }
        }
    });
}

module.exports = { createUploadMiddleware, uploadFileSizeLimit, safeTenantSegment, uploadStorageBaseDir };
