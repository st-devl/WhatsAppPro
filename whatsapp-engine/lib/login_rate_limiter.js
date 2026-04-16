class LoginRateLimiter {
    constructor(options = {}) {
        this.windowMs = Number.parseInt(options.windowMs || `${15 * 60 * 1000}`, 10);
        this.maxAttempts = Number.parseInt(options.maxAttempts || '5', 10);
        this.attempts = new Map();

        this.pruneTimer = setInterval(() => this.prune(), Math.max(this.windowMs, 60 * 1000));
        if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    }

    key(req, email) {
        return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(email || '').toLocaleLowerCase('tr-TR')}`;
    }

    getAttempt(req, email) {
        const key = this.key(req, email);
        const current = Date.now();
        const attempt = this.attempts.get(key);
        if (!attempt || attempt.resetAt <= current) {
            const fresh = { count: 0, resetAt: current + this.windowMs };
            this.attempts.set(key, fresh);
            return fresh;
        }
        return attempt;
    }

    assertAllowed(req, email) {
        const attempt = this.getAttempt(req, email);
        if (attempt.count < this.maxAttempts) return;

        const retryAfter = Math.ceil((attempt.resetAt - Date.now()) / 1000);
        const err = new Error('Cok fazla hatali giris denemesi. Daha sonra tekrar deneyin.');
        err.status = 429;
        err.retryAfter = retryAfter;
        throw err;
    }

    recordFailure(req, email) {
        const attempt = this.getAttempt(req, email);
        attempt.count += 1;
    }

    clear(req, email) {
        this.attempts.delete(this.key(req, email));
    }

    prune() {
        const current = Date.now();
        for (const [key, attempt] of this.attempts.entries()) {
            if (attempt.resetAt <= current) this.attempts.delete(key);
        }
    }
}

module.exports = { LoginRateLimiter };

