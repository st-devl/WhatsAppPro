function createSecurityHeaders(options = {}) {
    const secureCookies = !!options.secureCookies;

    return function setSecurityHeaders(req, res, next) {
        const csp = [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: https://user-images.githubusercontent.com",
            "media-src 'self'",
            "connect-src 'self' ws: wss:"
        ].join('; ');

        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
        next();
    };
}

function requestOrigin(req) {
    const source = req.get('origin') || req.get('referer');
    if (!source) return null;
    try {
        return new URL(source).origin;
    } catch {
        return 'invalid';
    }
}

function expectedOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function requireSameOriginForStateChanges(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const origin = requestOrigin(req);
    if (!origin) return next();
    if (origin === expectedOrigin(req)) return next();

    return res.status(403).json({ error: 'Gecersiz istek kaynagi' });
}

module.exports = { createSecurityHeaders, requireSameOriginForStateChanges };

