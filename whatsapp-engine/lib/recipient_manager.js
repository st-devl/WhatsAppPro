const db = require('./db');
const { componentLogger } = require('./logger');

const recipientLogger = componentLogger('recipient_manager');
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;

class RecipientManager {
    async getDailyCount(tenantId = db.DEFAULT_TENANT_ID) {
        return db.getDailySendCount(tenantId);
    }

    async validateOnWhatsApp(sock, phone) {
        try {
            const [result] = await sock.onWhatsApp(phone);
            if (!result || !result.exists) return false;
            return true;
        } catch (err) {
            recipientLogger.warn({ err, phone }, 'whatsapp_recipient_validation_failed');
            return true;
        }
    }

    isInCooldown(phone, tenantId = db.DEFAULT_TENANT_ID, cooldownMs = DEFAULT_COOLDOWN_MS) {
        return db.isRecipientInCooldown(phone, tenantId, cooldownMs);
    }

    logSend(phone, tenantId = db.DEFAULT_TENANT_ID) {
        return db.recordRecipientSend(phone, tenantId);
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
