const { getRequestLogger } = require('./logger');

class ApiError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = options.status || 500;
        this.statusCode = this.status;
        this.code = options.code || 'API_ERROR';
        this.details = options.details;
        this.expose = options.expose !== undefined ? options.expose : this.status < 500;
    }
}

function createApiError(status, message, code = 'API_ERROR', details = undefined) {
    return new ApiError(message, { status, code, details });
}

function badRequest(message, code = 'BAD_REQUEST', details = undefined) {
    return createApiError(400, message, code, details);
}

function asyncHandler(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendApiError(req, res, err) {
    const status = err.status || err.statusCode || 500;
    const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'API_ERROR');
    const shouldExpose = err.expose !== undefined ? err.expose : status < 500;
    const message = shouldExpose ? (err.message || 'Beklenmeyen hata') : 'Beklenmeyen hata';

    if (status >= 500) getRequestLogger(req, { component: 'api_errors', errorCode: code }).error({ err }, 'api_request_failed');

    const body = { data: null, error: message, code };
    if (err.details && status < 500) body.details = err.details;
    res.status(status).json(body);
}

function createErrorMiddleware() {
    return (err, req, res, next) => {
        if (res.headersSent) return next(err);
        sendApiError(req, res, err);
    };
}

function createNotFoundMiddleware() {
    return (req, res) => {
        res.status(404).json({
            data: null,
            error: 'Endpoint bulunamadı',
            code: 'NOT_FOUND'
        });
    };
}

module.exports = {
    ApiError,
    createApiError,
    badRequest,
    asyncHandler,
    sendApiError,
    createErrorMiddleware,
    createNotFoundMiddleware
};
