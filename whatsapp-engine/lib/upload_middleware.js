const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

function createUploadMiddleware(baseDir) {
    const storage = multer.diskStorage({
        destination: path.join(baseDir, 'uploads'),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, uuidv4() + ext);
        }
    });

    return multer({
        storage,
        limits: { fileSize: 50 * 1024 * 1024 },
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

module.exports = { createUploadMiddleware };
