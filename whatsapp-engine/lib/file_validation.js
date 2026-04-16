const path = require('path');
const fs = require('fs-extra');

async function readSignature(filePath, bytes = 16) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function startsWithBytes(buffer, bytes) {
    if (buffer.length < bytes.length) return false;
    return bytes.every((byte, index) => buffer[index] === byte);
}

async function validateExcelFile(baseDir, file) {
    const ext = path.extname(file.originalname || '').toLocaleLowerCase('tr-TR');
    if (ext !== '.xlsx') throw new Error('Sadece .xlsx dosyası yüklenebilir.');
    const signature = await readSignature(path.resolve(baseDir, file.path), 4);
    if (!startsWithBytes(signature, [0x50, 0x4b, 0x03, 0x04])) {
        throw new Error('Excel dosya imzası geçersiz.');
    }
}

function mediaTypeFromSignature(signature) {
    if (startsWithBytes(signature, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWithBytes(signature, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
    if (
        signature.length >= 12 &&
        signature.subarray(0, 4).toString('ascii') === 'RIFF' &&
        signature.subarray(8, 12).toString('ascii') === 'WEBP'
    ) return 'image/webp';
    if (
        signature.length >= 12 &&
        signature.subarray(4, 8).toString('ascii') === 'ftyp'
    ) return 'video/mp4';
    if (startsWithBytes(signature, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
    return null;
}

async function validateMediaFiles(baseDir, files = []) {
    for (const file of files) {
        const signature = await readSignature(path.resolve(baseDir, file.path), 16);
        const detectedType = mediaTypeFromSignature(signature);
        if (!detectedType) throw new Error(`${file.originalname} dosya imzası desteklenmiyor.`);
        if (detectedType.startsWith('image/') && file.mimetype !== detectedType) {
            throw new Error(`${file.originalname} dosya türü ile içerik imzası uyuşmuyor.`);
        }
        if (detectedType.startsWith('video/') && !file.mimetype.startsWith('video/')) {
            throw new Error(`${file.originalname} video dosyası olarak doğrulanamadı.`);
        }
    }
}

async function removeUploadedFiles(baseDir, files = []) {
    await Promise.all((files || []).map(file => fs.remove(path.resolve(baseDir, file.path)).catch(() => {})));
}

module.exports = {
    readSignature,
    startsWithBytes,
    validateExcelFile,
    validateMediaFiles,
    removeUploadedFiles
};

