function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();

    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({
            data: null,
            error: 'Yetkisiz erişim',
            code: 'UNAUTHORIZED'
        });
    }
    res.redirect('/login.html');
}

module.exports = { requireAuth };
