const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSampleWorkbookBuffer, readWorkbookObjectsInWorker } = require('../lib/excel_import');
const { MediaStore } = require('../lib/media_store');
const { createUploadService } = require('../services/upload_service');
const { resolveTenantUploadPath } = require('../lib/tenant_uploads');

async function createTempBaseDir() {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsappc-upload-test-'));
    await fs.mkdir(path.join(baseDir, 'uploads', 'default'), { recursive: true });
    return baseDir;
}

async function cleanup(baseDir) {
    await fs.rm(baseDir, { recursive: true, force: true });
}

function createService(baseDir, policy = {}) {
    return createUploadService({
        baseDir,
        db: {
            normalizePhone(value) {
                return String(value || '').replace(/[^\d]/g, '');
            },
            normalizeContactsDetailed(list) {
                return { contacts: list, summary: { total: list.length, valid: list.length, invalid: 0, duplicate: 0 } };
            }
        },
        mediaStore: new MediaStore({ filePath: path.join(baseDir, 'media-store.json') }),
        mediaPolicy: {
            totalQuotaBytes: policy.totalQuotaBytes || 1024 * 1024,
            retentionMs: policy.retentionMs === undefined ? 60 * 60 * 1000 : policy.retentionMs
        }
    });
}

function jpegBytes(size = 32) {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4))]);
}

function fileObject(filePath, overrides = {}) {
    return {
        path: filePath,
        originalname: overrides.originalname || path.basename(filePath),
        mimetype: overrides.mimetype || 'image/jpeg',
        size: overrides.size || 0
    };
}

test('media removal rejects path traversal', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const service = createService(baseDir);
        await assert.rejects(
            () => service.removeMedia('../package.json'),
            err => err.code === 'INVALID_UPLOAD_PATH'
        );
    } finally {
        await cleanup(baseDir);
    }
});

test('tenant upload resolver rejects cross-tenant traversal', async () => {
    const baseDir = await createTempBaseDir();
    try {
        await fs.mkdir(path.join(baseDir, 'uploads', 'other'), { recursive: true });
        const valid = resolveTenantUploadPath(baseDir, 'default', 'file.jpg');
        const invalid = resolveTenantUploadPath(baseDir, 'default', '../other/file.jpg');

        assert.equal(valid, path.join(baseDir, 'uploads', 'default', 'file.jpg'));
        assert.equal(invalid, null);
    } finally {
        await cleanup(baseDir);
    }
});

test('invalid media magic number is rejected and removed', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const uploadPath = path.join(baseDir, 'uploads', 'default', 'fake.jpg');
        await fs.writeFile(uploadPath, Buffer.from('not-an-image'));

        const service = createService(baseDir);
        await assert.rejects(
            () => service.replaceMedia([fileObject(uploadPath, { size: 12 })]),
            err => err.code === 'INVALID_MEDIA_FILE'
        );
        await assert.rejects(() => fs.stat(uploadPath), { code: 'ENOENT' });
    } finally {
        await cleanup(baseDir);
    }
});

test('media total quota rejects new upload and removes it', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const uploadPath = path.join(baseDir, 'uploads', 'default', 'large.jpg');
        const content = jpegBytes(64);
        await fs.writeFile(uploadPath, content);

        const service = createService(baseDir, { totalQuotaBytes: 16 });
        await assert.rejects(
            () => service.replaceMedia([fileObject(uploadPath, { size: content.length })]),
            err => err.code === 'MEDIA_QUOTA_EXCEEDED'
        );
        await assert.rejects(() => fs.stat(uploadPath), { code: 'ENOENT' });
    } finally {
        await cleanup(baseDir);
    }
});

test('media retention removes expired upload files before accepting new media', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const oldPath = path.join(baseDir, 'uploads', 'default', 'old.jpg');
        const newPath = path.join(baseDir, 'uploads', 'default', 'new.jpg');
        await fs.writeFile(oldPath, jpegBytes(32));
        await fs.writeFile(newPath, jpegBytes(32));
        const oldDate = new Date(Date.now() - 10_000);
        await fs.utimes(oldPath, oldDate, oldDate);

        const service = createService(baseDir, { totalQuotaBytes: 1024, retentionMs: 1 });
        const files = await service.replaceMedia([fileObject(newPath, { size: 32 })]);

        assert.equal(files.length, 1);
        assert.equal(files[0].path, 'uploads/default/new.jpg');
        await assert.rejects(() => fs.stat(oldPath), { code: 'ENOENT' });
        await fs.stat(newPath);
    } finally {
        await cleanup(baseDir);
    }
});

test('media store persists selected media between instances', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const storePath = path.join(baseDir, 'media-store.json');
        const firstStore = new MediaStore({ filePath: storePath });
        firstStore.replace([{ path: 'uploads/default/new.jpg', mimetype: 'image/jpeg', name: 'new.jpg' }], 'default');

        const secondStore = new MediaStore({ filePath: storePath });
        assert.deepEqual(secondStore.list('default'), [
            { path: 'uploads/default/new.jpg', mimetype: 'image/jpeg', name: 'new.jpg' }
        ]);
    } finally {
        await cleanup(baseDir);
    }
});

test('excel import runs through worker thread', async () => {
    const baseDir = await createTempBaseDir();
    try {
        const workbookPath = path.join(baseDir, 'uploads', 'default', 'sample.xlsx');
        await fs.writeFile(workbookPath, await createSampleWorkbookBuffer());

        const result = await readWorkbookObjectsInWorker(workbookPath, { timeoutMs: 5000 });
        assert.deepEqual(result.columns, ['Numara', 'İsim', 'Soyisim']);
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0].Numara, '905320000000');
    } finally {
        await cleanup(baseDir);
    }
});
