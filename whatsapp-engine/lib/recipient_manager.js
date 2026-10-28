const db = require('./db');
const { componentLogger } = require('./logger');

const recipientLogger = componentLogger('recipient_manager');
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
const VALIDATION_MAX_RETRIES = 2;
const VALIDATION_BASE_DELAY_MS = 1000;

const VALIDATION_STATUS = Object.freeze({
    EXISTS: 'exists',
    NOT_FOUND: 'not_found',
    UNKNOWN: 'unknown'
});

function validationRetryDelay(attempt) {
    return VALIDATION_BASE_DELAY_MS * Math.pow(2, attempt);
}

class RecipientManager {
    async getDailyCount(tenantId = db.DEFAULT_TENANT_ID) {
        return db.getDailySendCount(tenantId);
    }

    async validateOnWhatsApp(sock, phone) {
        let lastError = null;
        let lastReason = 'no_response';

        for (let attempt = 0; attempt <= VALIDATION_MAX_RETRIES; attempt++) {
            try {
                const results = await sock.onWhatsApp(phone);
                if (!Array.isArray(results)) {
                    lastReason = 'invalid_response';
                    recipientLogger.warn(
                        { phone, attempt: attempt + 1, maxAttempts: VALIDATION_MAX_RETRIES + 1, responseType: typeof results },
                        'whatsapp_recipient_validation_uncertain'
                    );
                } else {
                    const existing = results.find(result => result?.exists === true);
                    if (existing) {
                        return {
                            status: VALIDATION_STATUS.EXISTS,
                            exists: true,
                            jid: existing.jid || null,
                            lid: existing.lid || null
                        };
                    }

                    if (results.some(result => result?.exists === false)) {
                        return {
                            status: VALIDATION_STATUS.NOT_FOUND,
                            exists: false,
                            reason: 'explicit_not_found'
                        };
                    }

                    lastReason = results.length === 0 ? 'empty_response' : 'missing_exists_flag';
                    recipientLogger.warn(
                        { phone, attempt: attempt + 1, maxAttempts: VALIDATION_MAX_RETRIES + 1, resultCount: results.length },
                        'whatsapp_recipient_validation_uncertain'
                    );
                }
            } catch (err) {
                lastError = err;
                lastReason = 'query_failed';
                recipientLogger.warn(
                    { err, phone, attempt: attempt + 1, maxAttempts: VALIDATION_MAX_RETRIES + 1 },
                    'whatsapp_recipient_validation_failed'
                );
            }

            if (attempt < VALIDATION_MAX_RETRIES) {
                const delayMs = validationRetryDelay(attempt);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        recipientLogger.error(
            { err: lastError, phone, reason: lastReason, totalAttempts: VALIDATION_MAX_RETRIES + 1 },
            'whatsapp_recipient_validation_exhausted'
        );
        return {
            status: VALIDATION_STATUS.UNKNOWN,
            exists: null,
            reason: lastReason,
            error: lastError ? (lastError.message || String(lastError)) : null
        };
    }

    async isInCooldown(phone, tenantId = db.DEFAULT_TENANT_ID, cooldownMs = DEFAULT_COOLDOWN_MS) {
        return db.isRecipientInCooldown(phone, tenantId, cooldownMs);
    }

    async getCooldownExpiresAt(phone, tenantId = db.DEFAULT_TENANT_ID, cooldownMs = DEFAULT_COOLDOWN_MS) {
        return db.getRecipientCooldownExpiresAt(phone, tenantId, cooldownMs);
    }

    async isUnavailableOnWhatsApp(phone, tenantId = db.DEFAULT_TENANT_ID) {
        return db.isUnavailableWhatsAppRecipient(phone, tenantId);
    }

    recordUnavailableOnWhatsApp(contact, tenantId = db.DEFAULT_TENANT_ID, metadata = {}) {
        return db.recordUnavailableWhatsAppRecipient(contact, tenantId, metadata);
    }

    logSend(phone, tenantId = db.DEFAULT_TENANT_ID, messageHash = null) {
        return db.recordRecipientSend(phone, tenantId, new Date(), messageHash);
    }

    async cleanup(tenantId = db.DEFAULT_TENANT_ID, retentionMs = DEFAULT_HISTORY_RETENTION_MS) {
        const result = await db.cleanupRecipientHistory(tenantId, retentionMs);
        if (result.deleted > 0) {
            recipientLogger.info({ tenantId, cleaned: result.deleted }, 'recipient_history_cleanup_completed');
        }
        return result;
    }
}

module.exports = new RecipientManager();
module.exports.VALIDATION_STATUS = VALIDATION_STATUS;
