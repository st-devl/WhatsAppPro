const db = require('./db');
const { componentLogger } = require('./logger');

const recipientLogger = componentLogger('recipient_manager');
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
const VALIDATION_MAX_RETRIES = 2;
const VALIDATION_BASE_DELAY_MS = 1000;

function validationRetryDelay(attempt) {
    return VALIDATION_BASE_DELAY_MS * Math.pow(2, attempt);
}

class RecipientManager {
    async getDailyCount(tenantId = db.DEFAULT_TENANT_ID) {
        return db.getDailySendCount(tenantId);
    }

    async validateOnWhatsApp(sock, phone) {
        let lastError = null;

        for (let attempt = 0; attempt <= VALIDATION_MAX_RETRIES; attempt++) {
            try {
                const [result] = await sock.onWhatsApp(phone);
                return !!(result && result.exists);
            } catch (err) {
                lastError = err;
                recipientLogger.warn(
                    { err, phone, attempt: attempt + 1, maxAttempts: VALIDATION_MAX_RETRIES + 1 },
                    'whatsapp_recipient_validation_failed'
                );

                if (attempt < VALIDATION_MAX_RETRIES) {
                    const delayMs = validationRetryDelay(attempt);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        recipientLogger.error(
            { err: lastError, phone, totalAttempts: VALIDATION_MAX_RETRIES + 1 },
            'whatsapp_recipient_validation_exhausted'
        );
        return false;
    }

    async isInCooldown(phone, tenantId = db.DEFAULT_TENANT_ID, cooldownMs = DEFAULT_COOLDOWN_MS) {
        return db.isRecipientInCooldown(phone, tenantId, cooldownMs);
    }

    async getCooldownExpiresAt(phone, tenantId = db.DEFAULT_TENANT_ID, cooldownMs = DEFAULT_COOLDOWN_MS) {
        return db.getRecipientCooldownExpiresAt(phone, tenantId, cooldownMs);
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
