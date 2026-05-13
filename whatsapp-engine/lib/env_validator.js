const { componentLogger } = require('./logger');

const envLogger = componentLogger('env_validator');

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function hasValue(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStrongSessionSecret(value) {
    return hasValue(value)
        && value !== 'fallback-dev-secret'
        && value !== 'change-me-to-a-long-random-secret'
        && value.length >= 32;
}

function isValidBcryptHash(value) {
    return hasValue(value)
        && value !== 'replace-with-bcrypt-hash'
        && BCRYPT_HASH_PATTERN.test(value);
}

const PRODUCTION_REQUIRED = [
    {
        name: 'SESSION_SECRET',
        validate: isStrongSessionSecret,
        message: 'SESSION_SECRET production ortamında en az 32 karakterlik güçlü, benzersiz bir değer olmalıdır'
    },
    {
        name: 'COOKIE_SECURE',
        validate: (value) => value === 'true',
        message: 'COOKIE_SECURE production ortamında true olmalıdır (HTTPS zorunlu)'
    },
    {
        name: 'ADMIN_PASS_HASH',
        validate: isValidBcryptHash,
        message: 'ADMIN_PASS_HASH production ortamında geçerli bir bcrypt hash olmalıdır'
    }
];

const ALWAYS_WARN = [
    {
        name: 'ADMIN_PASS_HASH',
        validate: isValidBcryptHash,
        message: 'ADMIN_PASS_HASH geçerli bir bcrypt hash ile doldurulmalıdır'
    },
    {
        name: 'WHASAPPC_DATA_DIR',
        validate: (value) => !!value,
        message: 'WHASAPPC_DATA_DIR belirtilmemiş, varsayılan data dizini kullanılacak. Production ortamında kalıcı bir dizin belirtin'
    }
];

function validateProductionEnv() {
    const isProduction = process.env.NODE_ENV === 'production';
    const productionRequiredNames = new Set(PRODUCTION_REQUIRED.map(rule => rule.name));
    const errors = [];
    const warnings = [];

    if (isProduction) {
        for (const rule of PRODUCTION_REQUIRED) {
            if (!rule.validate(process.env[rule.name])) {
                errors.push({ variable: rule.name, message: rule.message });
            }
        }
    }

    for (const rule of ALWAYS_WARN) {
        if (isProduction && productionRequiredNames.has(rule.name)) continue;
        if (!rule.validate(process.env[rule.name])) {
            warnings.push({ variable: rule.name, message: rule.message });
        }
    }

    for (const warning of warnings) {
        envLogger.warn(warning, 'env_validation_warning');
    }

    if (errors.length > 0) {
        for (const error of errors) {
            envLogger.fatal(error, 'env_validation_fatal');
        }
        throw new Error(
            `Production ortam değişkeni doğrulaması başarısız: ${errors.map(e => e.variable).join(', ')}`
        );
    }

    if (warnings.length === 0 && errors.length === 0) {
        envLogger.info({ environment: isProduction ? 'production' : 'development' }, 'env_validation_passed');
    }

    return { errors, warnings };
}

module.exports = { validateProductionEnv };
