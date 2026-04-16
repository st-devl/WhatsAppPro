const express = require('express');
const { asyncHandler, badRequest } = require('../lib/api_errors');
const { sendSuccess } = require('../lib/api_response');
const { createUploadService } = require('../services/upload_service');

function runUpload(middleware, req, res) {
    return new Promise((resolve, reject) => {
        middleware(req, res, (err) => {
            if (err) return reject(badRequest(err.message, 'UPLOAD_REJECTED'));
            resolve();
        });
    });
}

function createUploadRouter(options = {}) {
    const router = express.Router();
    const { upload } = options;
    const uploadService = createUploadService(options);

    router.post('/upload-media', asyncHandler(async (req, res) => {
        await runUpload(upload.array('media'), req, res);
        sendSuccess(res, await uploadService.replaceMedia(req.files || []), 'MEDIA_UPLOADED');
    }));

    router.delete('/upload-media', asyncHandler(async (req, res) => {
        sendSuccess(res, await uploadService.removeMedia(req.body?.path), 'MEDIA_REMOVED');
    }));

    router.post('/upload-excel', asyncHandler(async (req, res) => {
        await runUpload(upload.single('excel'), req, res);
        sendSuccess(res, await uploadService.importContactsFromExcel(req.file), 'EXCEL_IMPORTED');
    }));

    router.get('/download-sample', asyncHandler(async (req, res) => {
        const buf = await uploadService.createSampleWorkbookBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=ornek_rehber.xlsx');
        res.send(buf);
    }));

    return router;
}

module.exports = { createUploadRouter };
