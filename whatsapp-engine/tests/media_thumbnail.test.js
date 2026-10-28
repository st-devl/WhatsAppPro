const test = require('node:test');
const assert = require('node:assert/strict');
const { WAProto } = require('@whiskeysockets/baileys');
const { createFfmpegDetector, shouldGenerateVideoThumbnail } = require('../lib/media_policy');
const { buildMediaPayload } = require('../lib/messenger');

test('ffmpeg detector caches its first availability check', () => {
    let calls = 0;
    const detectFfmpeg = createFfmpegDetector(() => {
        calls++;
        return { status: 0 };
    });

    assert.equal(detectFfmpeg(), true);
    assert.equal(detectFfmpeg(), true);
    assert.equal(calls, 1);
});

test('video payload skips thumbnail generation when ffmpeg is unavailable', () => {
    const payload = buildMediaPayload(
        { type: 'video', path: '/tmp/campaign.mp4' },
        'Merhaba',
        { detectFfmpeg: () => false }
    );

    assert.deepEqual(payload.video, { url: '/tmp/campaign.mp4' });
    assert.equal(payload.caption, 'Merhaba');
    assert.ok(Buffer.isBuffer(payload.jpegThumbnail));
    assert.equal(payload.jpegThumbnail.length, 0);

    const encoded = WAProto.Message.VideoMessage.encode(WAProto.Message.VideoMessage.fromObject({
        ...payload.video,
        jpegThumbnail: payload.jpegThumbnail
    })).finish();
    const decoded = WAProto.Message.VideoMessage.decode(encoded);
    assert.equal(decoded.jpegThumbnail.length, 0);
});

test('video payload preserves thumbnail generation when ffmpeg is available', () => {
    const payload = buildMediaPayload(
        { type: 'video', path: '/tmp/campaign.mp4' },
        undefined,
        { detectFfmpeg: () => true }
    );

    assert.equal(payload.jpegThumbnail, undefined);
    assert.equal(shouldGenerateVideoThumbnail({ detectFfmpeg: () => true }), true);
    assert.equal(shouldGenerateVideoThumbnail({ videoThumbnailMode: 'off', detectFfmpeg: () => true }), false);
});
