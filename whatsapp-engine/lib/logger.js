const crypto = require('crypto');
const pino = require('pino');

const REDACTED = '[redacted]';
const SERVICE_NAME = 'whatsapp-engine';

const redactPaths = [
    'password',
    '*.password',
    'body.password',
    'req.body.password',
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    'authorization',
    'cookie',
    'token',
    '*.token',
    'phone',
    '*.phone',
    'normalized_phone',
    '*.normalized_phone',
    'email',
    '*.email',
    'owner_email',
    '*.owner_email',
    'ownerEmail',
    '*.ownerEmail',
    'contacts[*].phone',
    'contacts[*].normalized_phone',
    'contacts[*].email',
    'metadata.phone',
    'metadata.normalized_phone',
    'metadata.email',
    'metadata.owner_email',
    'metadata.ownerEmail'
];

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: {
        service: SERVICE_NAME,
        environment: process.env.NODE_ENV || 'development'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: redactPaths,
        censor: REDACTED,
        remove: false
    },
    serializers: {
        err: pino.stdSerializers.err
    }
});

function requestIdFromHeader(value) {
    if (!value) return null;
    const first = Array.isArray(value) ? value[0] : String(value).split(',')[0];
    const clean = String(first || '').trim();
    if (!clean || clean.length > 128) return null;
    return clean;
}

function userContext(req) {
    const user = req?.session?.user || {};
    return {
        tenantId: user.tenant_id || undefined,
        userId: user.user_id || undefined
    };
}

function requestContext(req, extra = {}) {
    return {
        requestId: req?.id,
        ...userContext(req),
        ...extra
    };
}

function maskIp(value) {
    const ip = String(value || '').trim();
    if (!ip) return ip;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        const parts = ip.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
    if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
    return REDACTED;
}

function getRequestLogger(req, extra = {}) {
    const base = req?.log || logger;
    const context = requestContext(req, extra);
    if (req?.log) delete context.requestId;
    return base.child(context);
}

function createRequestLoggerMiddleware() {
    return (req, res, next) => {
        const startedAt = process.hrtime.bigint();
        req.id = requestIdFromHeader(req.headers['x-request-id']) || crypto.randomUUID();
        res.setHeader('X-Request-Id', req.id);
        req.log = logger.child({ requestId: req.id });

        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
            const log = getRequestLogger(req);
            log[level]({
                req: {
                    method: req.method,
                    path: req.originalUrl || req.url,
                    ip: maskIp(req.ip),
                    userAgent: req.get('user-agent')
                },
                res: {
                    statusCode: res.statusCode
                },
                durationMs: Math.round(durationMs * 100) / 100
            }, 'http_request_completed');
        });

        next();
    };
}

function componentLogger(component, extra = {}) {
    return logger.child({ component, ...extra });
}

module.exports = {
    REDACTED,
    logger,
    componentLogger,
    createRequestLoggerMiddleware,
    getRequestLogger,
    requestContext
};
