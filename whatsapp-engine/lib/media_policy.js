const path = require('path');
const fs = require('fs-extra');
const { spawnSync } = require('child_process');
const { safeTenantSegment, uploadStorageBaseDir } = require('./upload_middleware');
const { invalidateMediaUploadCache } = require('./media_upload_cache');

const DEFAULT_MEDIA_TOTAL_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_VIDEO_THUMBNAIL_AUTO = 'auto';
const MEDIA_VIDEO_THUMBNAIL_OFF = 'off';

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createFfmpegDetector(commandRunner = spawnSync) {
    let available;

    return () => {
        if (available !== undefined) return available;
        try {
            available = commandRunner('ffmpeg', ['-version'], { stdio: 'ignore' })?.status === 0;
        } catch (_) {
            available = false;
        }
        return available;
    };
}

const isFfmpegAvailable = createFfmpegDetector();

function videoThumbnailMode(value = process.env.MEDIA_VIDEO_THUMBNAIL) {
    return String(value || MEDIA_VIDEO_THUMBNAIL_AUTO).trim().toLowerCase() === MEDIA_VIDEO_THUMBNAIL_OFF
        ? MEDIA_VIDEO_THUMBNAIL_OFF
        : MEDIA_VIDEO_THUMBNAIL_AUTO;
}

function shouldGenerateVideoThumbnail(options = {}) {
    if (videoThumbnailMode(options.videoThumbnailMode) === MEDIA_VIDEO_THUMBNAIL_OFF) return false;
    const detectFfmpeg = options.detectFfmpeg || isFfmpegAvailable;
    return Boolean(detectFfmpeg());
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
        invalidateMediaUploadCache(file.path);
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
    createFfmpegDetector,
    isFfmpegAvailable,
    shouldGenerateVideoThumbnail,
    videoThumbnailMode,
    cleanupExpiredMedia,
    getUploadDirectorySize,
    assertMediaQuota,
    listUploadFiles
};
