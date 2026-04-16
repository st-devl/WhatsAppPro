const session = require('express-session');
const fs = require('fs-extra');
const path = require('path');
const { componentLogger } = require('./logger');

const sessionLogger = componentLogger('session_store');

class FileSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.filePath = options.filePath;
        this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;
        this.sessions = {};
        this.writeQueue = Promise.resolve();

        fs.ensureDirSync(path.dirname(this.filePath));
        this.load();
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            this.sessions = {};
            return;
        }

        try {
            this.sessions = fs.readJsonSync(this.filePath);
            this.pruneExpired();
        } catch (err) {
            const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
            fs.renameSync(this.filePath, corruptPath);
            this.sessions = {};
            sessionLogger.error({ err, corruptPath }, 'session_store_corrupt_file_moved');
        }
    }

    persist(callback = () => {}) {
        this.writeQueue = this.writeQueue
            .then(async () => {
                const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
                await fs.writeJson(tmpFile, this.sessions);
                await fs.rename(tmpFile, this.filePath);
            })
            .then(() => callback())
            .catch((err) => callback(err));
    }

    get(sid, callback) {
        const record = this.sessions[sid];
        if (!record) return callback(null, null);

        if (record.expiresAt && record.expiresAt <= Date.now()) {
            delete this.sessions[sid];
            this.persist(() => {});
            return callback(null, null);
        }

        callback(null, record.session);
    }

    set(sid, sess, callback = () => {}) {
        this.sessions[sid] = {
            session: sess,
            expiresAt: this.getExpiry(sess)
        };
        this.persist(callback);
    }

    touch(sid, sess, callback = () => {}) {
        if (!this.sessions[sid]) return callback();
        this.sessions[sid].session = sess;
        this.sessions[sid].expiresAt = this.getExpiry(sess);
        this.persist(callback);
    }

    destroy(sid, callback = () => {}) {
        delete this.sessions[sid];
        this.persist(callback);
    }

    pruneExpired(callback = () => {}) {
        const current = Date.now();
        let changed = false;

        for (const [sid, record] of Object.entries(this.sessions)) {
            if (record.expiresAt && record.expiresAt <= current) {
                delete this.sessions[sid];
                changed = true;
            }
        }

        if (changed) return this.persist(callback);
        callback();
    }

    getExpiry(sess) {
        const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
        if (cookieExpires && !Number.isNaN(cookieExpires)) return cookieExpires;
        return Date.now() + this.ttlMs;
    }
}

function createFileSessionStore(options = {}) {
    const store = new FileSessionStore(options);
    const pruneIntervalMs = options.pruneIntervalMs || 15 * 60 * 1000;
    const timer = setInterval(() => store.pruneExpired(), pruneIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return store;
}

module.exports = { FileSessionStore, createFileSessionStore };
