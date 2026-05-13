const assert = require('node:assert/strict');
const test = require('node:test');

process.env.LOG_LEVEL = 'silent';
const { validateProductionEnv } = require('../lib/env_validator');

const VALID_HASH = '$2b$10$Q4yVz88kGKPdbCSCArZZ5OkGuRM68yLRR88MdldfLxP.Ru98FkuCm';

function withEnv(overrides, fn) {
    const snapshot = { ...process.env };
    Object.assign(process.env, overrides);
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
    }

    try {
        return fn();
    } finally {
        for (const key of Object.keys(process.env)) {
            if (!(key in snapshot)) delete process.env[key];
        }
        Object.assign(process.env, snapshot);
    }
}

test('production rejects placeholder admin password hash', () => {
    withEnv({
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(32),
        COOKIE_SECURE: 'true',
        ADMIN_PASS_HASH: 'replace-with-bcrypt-hash',
        WHASAPPC_DATA_DIR: '/tmp/whasappc'
    }, () => {
        assert.throws(
            () => validateProductionEnv(),
            /ADMIN_PASS_HASH/
        );
    });
});

test('production accepts complete secure runtime env', () => {
    withEnv({
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(32),
        COOKIE_SECURE: 'true',
        ADMIN_PASS_HASH: VALID_HASH,
        WHASAPPC_DATA_DIR: '/tmp/whasappc'
    }, () => {
        const result = validateProductionEnv();
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.warnings, []);
    });
});
