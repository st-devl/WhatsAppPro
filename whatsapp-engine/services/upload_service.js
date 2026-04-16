const path = require('path');
const fs = require('fs-extra');
const { badRequest } = require('../lib/api_errors');
const {
    validateExcelFile,
    validateMediaFiles,
    removeUploadedFiles
} = require('../lib/file_validation');
const { safeTenantSegment } = require('../lib/upload_middleware');
const {
    createSampleWorkbookBuffer,
    readWorkbookObjectsInWorker
} = require('../lib/excel_import');
const {
    assertMediaQuota,
    cleanupExpiredMedia,
    createMediaPolicy
} = require('../lib/media_policy');
const {
    requiredString,
    requiredUploadFile
} = require('../lib/validation');
const { componentLogger } = require('../lib/logger');

const PHONE_ALIASES = ['Numara', 'numara', 'phone', 'Phone', 'telefon', 'Telefon', 'tel', 'Tel', 'cep', 'Cep', 'mobile', 'Mobile', 'no', 'No', 'number', 'Number', 'PhoneNumber', 'phone_number', 'telefon_no'];
const NAME_ALIASES = ['İsim', 'isim', 'name', 'Name', 'ad', 'Ad', 'AD', 'İSİM', 'first_name', 'firstName', 'Ad Soyad', 'ad soyad', 'adsoyad', 'AdSoyad', 'isim soyisim', 'İsim Soyisim'];
const SURNAME_ALIASES = ['Soyisim', 'soyisim', 'SOYİSİM', 'surname', 'Surname', 'soyad', 'Soyad', 'last_name', 'lastName'];
const uploadLogger = componentLogger('upload_service');

function findColumn(row, aliases) {
    const keys = Object.keys(row);
    for (const alias of aliases) {
        const found = keys.find(k => k.trim().toLowerCase() === alias.toLowerCase());
        if (found && row[found] !== undefined && row[found] !== null) {
            return String(row[found]).trim();
        }
    }
    return '';
}

function assertInsideUploads(baseDir, filePath, tenantId = 'default') {
    const uploadsDir = path.resolve(baseDir, 'uploads', safeTenantSegment(tenantId));
    const absolutePath = path.resolve(baseDir, filePath);
    if (!absolutePath.startsWith(uploadsDir + path.sep)) {
        throw badRequest('Geçersiz dosya yolu', 'INVALID_UPLOAD_PATH');
    }
    return absolutePath;
}

function publicMediaPath(baseDir, filePath, tenantId = 'default') {
    const absolutePath = assertInsideUploads(baseDir, filePath, tenantId);
    return path.relative(baseDir, absolutePath).split(path.sep).join('/');
}

function createUploadService(options = {}) {
    const {
        baseDir,
        db,
        mediaStore,
        mediaPolicy = createMediaPolicy()
    } = options;
    const tenantId = (context = {}) => String(context.tenantId || 'default').trim() || 'default';

    return {
        async replaceMedia(files = [], context = {}) {
            const tenant = tenantId(context);
            try {
                await validateMediaFiles(baseDir, files);
                await cleanupExpiredMedia(baseDir, mediaPolicy, Date.now(), tenant);
                await assertMediaQuota(baseDir, mediaPolicy, tenant);
                const mediaFiles = files.map(file => ({
                    path: publicMediaPath(baseDir, file.path, tenant),
                    mimetype: file.mimetype,
                    name: file.originalname,
                    size: file.size || 0,
                    uploaded_at: new Date().toISOString()
                }));
                return mediaStore.replace(mediaFiles, tenant);
            } catch (err) {
                await removeUploadedFiles(baseDir, files);
                if (err.status) throw err;
                throw badRequest(err.message, err.code || 'INVALID_MEDIA_FILE');
            }
        },

        async removeMedia(inputPath, context = {}) {
            const tenant = tenantId(context);
            const mediaPath = requiredString(inputPath, 'Medya yolu gerekli', 'MEDIA_PATH_REQUIRED');
            mediaStore.remove(mediaPath, tenant);
            const absoluteMediaPath = assertInsideUploads(baseDir, mediaPath, tenant);
            await fs.remove(absoluteMediaPath);
            return mediaStore.list(tenant);
        },

        async importContactsFromExcel(file, context = {}) {
            const tenant = tenantId(context);
            requiredUploadFile(file, 'Excel dosyası gerekli.', 'EXCEL_FILE_REQUIRED');
            const uploadedPath = assertInsideUploads(baseDir, file.path, tenant);

            try {
                await validateExcelFile(baseDir, file);
                const { rows: rawData, columns } = await readWorkbookObjectsInWorker(uploadedPath);

                if (!rawData || rawData.length === 0) {
                    throw badRequest('Excel dosyası boş veya okunamadı.', 'EXCEL_EMPTY');
                }

                const normalizedResult = db.normalizeContactsDetailed(rawData.map(row => ({
                    phone: db.normalizePhone(findColumn(row, PHONE_ALIASES)),
                    name: findColumn(row, NAME_ALIASES),
                    surname: findColumn(row, SURNAME_ALIASES)
                })));
                const data = normalizedResult.contacts;
                const summary = normalizedResult.summary;

                uploadLogger.info({
                    tenantId: tenant,
                    rowsRead: rawData.length,
                    validContacts: data.length,
                    duplicateContacts: summary.duplicate,
                    invalidContacts: summary.invalid,
                    columns
                }, 'excel_import_parsed');

                if (data.length === 0) {
                    throw badRequest(
                        `Excel'de geçerli kişi bulunamadı. Algılanan sütunlar: [${columns.join(', ')}]. Beklenen: Numara, İsim, Soyisim`,
                        'EXCEL_NO_VALID_CONTACTS'
                    );
                }

                if (db.addAuditLog) {
                    await db.addAuditLog('excel_imported', 'upload', 'excel', {
                        rows_read: rawData.length,
                        summary,
                        columns
                    }, tenant).catch(err => {
                        uploadLogger.error({ err, tenantId: tenant, auditAction: 'excel_imported' }, 'audit_log_write_failed');
                    });
                }

                return { contacts: data, summary };
            } catch (err) {
                if (err.status) throw err;
                throw badRequest(`Excel okuma hatası: ${err.message}`, 'EXCEL_PARSE_FAILED');
            } finally {
                await fs.remove(uploadedPath).catch(removeErr => {
                    uploadLogger.warn({ err: removeErr, tenantId: tenant }, 'excel_temp_file_cleanup_failed');
                });
            }
        },

        createSampleWorkbookBuffer
    };
}

module.exports = { createUploadService };
