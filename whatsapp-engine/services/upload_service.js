const path = require('path');
const fs = require('fs-extra');
const { badRequest } = require('../lib/api_errors');
const {
    validateExcelFile,
    validateMediaFiles,
    removeUploadedFiles
} = require('../lib/file_validation');
const {
    createSampleWorkbookBuffer,
    readWorkbookObjects
} = require('../lib/excel_import');
const {
    requiredString,
    requiredUploadFile
} = require('../lib/validation');

const PHONE_ALIASES = ['Numara', 'numara', 'phone', 'Phone', 'telefon', 'Telefon', 'tel', 'Tel', 'cep', 'Cep', 'mobile', 'Mobile', 'no', 'No', 'number', 'Number', 'PhoneNumber', 'phone_number', 'telefon_no'];
const NAME_ALIASES = ['İsim', 'isim', 'name', 'Name', 'ad', 'Ad', 'AD', 'İSİM', 'first_name', 'firstName', 'Ad Soyad', 'ad soyad', 'adsoyad', 'AdSoyad', 'isim soyisim', 'İsim Soyisim'];
const SURNAME_ALIASES = ['Soyisim', 'soyisim', 'SOYİSİM', 'surname', 'Surname', 'soyad', 'Soyad', 'last_name', 'lastName'];

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

function assertInsideUploads(baseDir, filePath) {
    const uploadsDir = path.resolve(baseDir, 'uploads');
    const absolutePath = path.resolve(baseDir, filePath);
    if (!absolutePath.startsWith(uploadsDir + path.sep)) {
        throw badRequest('Geçersiz dosya yolu', 'INVALID_UPLOAD_PATH');
    }
    return absolutePath;
}

function publicMediaPath(baseDir, filePath) {
    const absolutePath = assertInsideUploads(baseDir, filePath);
    return path.relative(baseDir, absolutePath).split(path.sep).join('/');
}

function createUploadService(options = {}) {
    const {
        baseDir,
        db,
        mediaStore
    } = options;

    return {
        async replaceMedia(files = []) {
            try {
                await validateMediaFiles(baseDir, files);
                const mediaFiles = files.map(file => ({
                    path: publicMediaPath(baseDir, file.path),
                    mimetype: file.mimetype,
                    name: file.originalname
                }));
                return mediaStore.replace(mediaFiles);
            } catch (err) {
                await removeUploadedFiles(baseDir, files);
                if (err.status) throw err;
                throw badRequest(err.message, 'INVALID_MEDIA_FILE');
            }
        },

        async removeMedia(inputPath) {
            const mediaPath = requiredString(inputPath, 'Medya yolu gerekli', 'MEDIA_PATH_REQUIRED');
            mediaStore.remove(mediaPath);
            const absoluteMediaPath = assertInsideUploads(baseDir, mediaPath);
            await fs.remove(absoluteMediaPath);
            return mediaStore.list();
        },

        async importContactsFromExcel(file) {
            requiredUploadFile(file, 'Excel dosyası gerekli.', 'EXCEL_FILE_REQUIRED');
            const uploadedPath = assertInsideUploads(baseDir, file.path);

            try {
                await validateExcelFile(baseDir, file);
                const { rows: rawData, columns } = await readWorkbookObjects(uploadedPath);

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

                console.log(`📊 Excel yüklendi: ${rawData.length} satır okundu, ${data.length} geçerli kişi bulundu, ${summary.duplicate} duplicate, ${summary.invalid} hatalı. Sütunlar: ${columns.join(', ')}`);

                if (data.length === 0) {
                    throw badRequest(
                        `Excel'de geçerli kişi bulunamadı. Algılanan sütunlar: [${columns.join(', ')}]. Beklenen: Numara, İsim, Soyisim`,
                        'EXCEL_NO_VALID_CONTACTS'
                    );
                }

                return { contacts: data, summary };
            } catch (err) {
                if (err.status) throw err;
                throw badRequest(`Excel okuma hatası: ${err.message}`, 'EXCEL_PARSE_FAILED');
            } finally {
                await fs.remove(uploadedPath).catch(removeErr => {
                    console.error('Excel geçici dosyası temizlenemedi:', removeErr);
                });
            }
        },

        createSampleWorkbookBuffer
    };
}

module.exports = { createUploadService };
