const path = require('path');
const fs = require('fs-extra');
const { safeTenantSegment, uploadStorageBaseDir } = require('./upload_middleware');

const DEFAULT_MEDIA_TOTAL_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createMediaPolicy(options = {}) {
    return {
        totalQuotaBytes: parsePositiveInteger(
            options.totalQuotaBytes || process.env.MEDIA_TOTAL_QUOTA_BYTES,
            DEFAULT_MEDIA_TOTAL_QUOTA_BYTES
        ),
        retentionMs: parsePositiveInteger(
            options.retentionMs || process.env.MEDIA_RETENTION_MS,
            DEFAULT_MEDIA_RETENTION_MS
        )
    };
}

function uploadsDir(baseDir, tenantId = null) {
    return tenantId
        ? path.resolve(uploadStorageBaseDir(baseDir), 'uploads', safeTenantSegment(tenantId))
        : path.resolve(uploadStorageBaseDir(baseDir), 'uploads');
}

async function listUploadFiles(baseDir, tenantId = null) {
    const dir = uploadsDir(baseDir, tenantId);
    await fs.ensureDir(dir);
    const entries = await fs.readdir(dir);
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isFile()) files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
        if (stat?.isDirectory() && !tenantId) {
            const childFiles = await listUploadFiles(baseDir, entry);
            files.push(...childFiles);
        }
    }

    return files;
}

async function cleanupExpiredMedia(baseDir, policy = createMediaPolicy(), nowMs = Date.now(), tenantId = null) {
    if (!policy.retentionMs) return [];

    const removed = [];
    const files = await listUploadFiles(baseDir, tenantId);
    await Promise.all(files.map(async (file) => {
        if (nowMs - file.mtimeMs <= policy.retentionMs) return;
        await fs.remove(file.path);
        removed.push(file.path);
    }));
    return removed;
}

async function getUploadDirectorySize(baseDir, tenantId = null) {
    const files = await listUploadFiles(baseDir, tenantId);
    return files.reduce((total, file) => total + file.size, 0);
}

async function assertMediaQuota(baseDir, policy = createMediaPolicy(), tenantId = null) {
    const totalSize = await getUploadDirectorySize(baseDir, tenantId);
    if (totalSize > policy.totalQuotaBytes) {
        const err = new Error(`Medya kotası aşıldı. Kullanım: ${totalSize} bayt, kota: ${policy.totalQuotaBytes} bayt.`);
        err.code = 'MEDIA_QUOTA_EXCEEDED';
        throw err;
    }
    return totalSize;
}

module.exports = {
    createMediaPolicy,
    cleanupExpiredMedia,
    getUploadDirectorySize,
    assertMediaQuota,
    listUploadFiles
};
