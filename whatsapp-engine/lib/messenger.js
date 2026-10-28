const recipientManager = require('./recipient_manager');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { renderTemplate } = require('../shared/message_renderer');
const { componentLogger } = require('./logger');
const { uploadStorageBaseDir } = require('./upload_middleware');
const { shouldGenerateVideoThumbnail } = require('./media_policy');
const db = require('./db');
const {
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_BATCH_SIZE,
    DEFAULT_LONG_PAUSE_MINUTES,
    DEFAULT_LONG_PAUSE_SIZE,
    estimateRemainingMinutes
} = require('./campaign_estimate');

const TURKEY_TIME_ZONE = 'Europe/Istanbul';
const NIGHT_PAUSE_REASON = 'night_pause';
const BATCH_PAUSE_REASON = 'batch_pause';
const LONG_PAUSE_REASON = 'long_pause';
const TIMED_PAUSE_REASONS = new Set([BATCH_PAUSE_REASON, LONG_PAUSE_REASON, NIGHT_PAUSE_REASON]);
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 10;
const VALIDATION_STATUS = recipientManager.VALIDATION_STATUS || {
    EXISTS: 'exists',
    NOT_FOUND: 'not_found',
    UNKNOWN: 'unknown'
};
const STATUS_SKIPPED_COOLDOWN = 'skipped_cooldown';
const STATUS_NOT_ON_WHATSAPP = 'not_on_whatsapp';
const STATUS_SUPPRESSED = 'suppressed';
const STATUS_VALIDATION_UNKNOWN = 'validation_unknown';
const DEFAULT_VALIDATION_UNKNOWN_STREAK_LIMIT = 10;

function messageHash(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

const defaultDelay = ms => new Promise(res => setTimeout(res, ms));
const messengerLogger = componentLogger('messenger');

// Campaign state in memory
let activeCampaigns = new Map();

function getHumanDelay(min, max) {
    const r = Math.random();
    if (r < 0.8) {
        return Math.floor(Math.random() * (max - min) * 0.4 + min) * 1000;
    } else {
        return Math.floor(Math.random() * (max - min) + min) * 1000;
    }
}

function isTerminallyInterrupted(campaignId) {
    return ['stopped', 'finished'].includes(activeCampaigns.get(campaignId)?.status);
}

async function interruptibleDelay(campaignId, ms, options = {}) {
    const sleep = options.sleep || defaultDelay;
    const pollMs = Math.max(25, Number.parseInt(options.stopPollMs || '250', 10));
    const scale = Number.isFinite(Number(options.delayScale)) ? Number(options.delayScale) : 1;
    const deadline = Date.now() + Math.max(0, Number(ms || 0) * scale);

    while (!isTerminallyInterrupted(campaignId)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return true;
        await sleep(Math.min(pollMs, remaining));
    }

    return false;
}

function scaledDelayMs(ms, options = {}) {
    const scale = Number.isFinite(Number(options.delayScale)) ? Number(options.delayScale) : 1;
    return Math.max(0, Number(ms || 0) * scale);
}

function safeCount(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseFutureTimestamp(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
}

function remainingTimedPause(initialStatus) {
    if (!TIMED_PAUSE_REASONS.has(initialStatus?.pause_reason)) return null;
    const pauseUntil = parseFutureTimestamp(initialStatus.pause_until);
    return pauseUntil ? { reason: initialStatus.pause_reason, until: pauseUntil } : null;
}

function zonedParts(date = new Date(), timeZone = TURKEY_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour,
        minute: values.minute,
        second: values.second
    };
}

function localDatePlusDays(parts, days) {
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate()
    };
}

function dateFromZonedParts(parts, timeZone = TURKEY_TIME_ZONE) {
    const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
    const guess = new Date(desiredUtc);
    const actual = zonedParts(guess, timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    return new Date(desiredUtc - (actualUtc - desiredUtc));
}

function nightPauseInfo(now = new Date()) {
    const parts = zonedParts(now, TURKEY_TIME_ZONE);
    const minuteOfDay = (parts.hour * 60) + parts.minute + (parts.second / 60);
    const startMinute = NIGHT_START_HOUR * 60;
    const endMinute = NIGHT_END_HOUR * 60;
    if (minuteOfDay >= startMinute) {
        const nextDay = localDatePlusDays(parts, 1);
        return {
            active: true,
            until: dateFromZonedParts({ ...nextDay, hour: NIGHT_END_HOUR, minute: 0, second: 0 }),
            currentHour: parts.hour
        };
    }
    if (minuteOfDay < endMinute) {
        return {
            active: true,
            until: dateFromZonedParts({ year: parts.year, month: parts.month, day: parts.day, hour: NIGHT_END_HOUR, minute: 0, second: 0 }),
            currentHour: parts.hour
        };
    }
    return { active: false, until: null, currentHour: parts.hour };
}

function formatPauseMinutes(minutes) {
    const value = Math.max(1, Number.parseInt(minutes, 10) || DEFAULT_LONG_PAUSE_MINUTES);
    if (value >= 60 && value % 60 === 0) return `${value / 60} saat`;
    return `${value} dk`;
}

function pauseTitle(reason, minutes = DEFAULT_LONG_PAUSE_MINUTES) {
    if (reason === LONG_PAUSE_REASON) return `${formatPauseMinutes(minutes)} bekleme sınırına geldiniz.`;
    if (reason === NIGHT_PAUSE_REASON) return 'Günlük gönderim başlama saatine kadar bekleniyor.';
    return 'Zorunlu mola başladı.';
}

function recipientDisplayName(contact = {}) {
    const fullName = `${contact.name || ''} ${contact.surname || ''}`.trim();
    if (fullName && fullName !== 'Bilinmeyen') return fullName;
    if (contact.name && contact.name !== 'Bilinmeyen') return contact.name;
    return 'Müşterimiz';
}

function buildMediaPayload(media, caption, options = {}) {
    if (media.type === 'image') {
        return { image: { url: media.path }, caption };
    }

    const payload = { video: { url: media.path }, caption };
    if (!shouldGenerateVideoThumbnail(options)) {
        payload.jpegThumbnail = Buffer.alloc(0);
    }
    return payload;
}

async function sendBulkWithProgress(sock, contacts, message, socket, delayRange, mediaFiles = [], campaignId, userSettings = {}) {
    const [min, max] = delayRange || [20, 90];
    const batchSize = Math.max(1, Number.parseInt(userSettings.batchSize ?? DEFAULT_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE);
    const batchPauseMinutes = Math.max(0, Number.parseInt(userSettings.batchPauseMinutes ?? DEFAULT_BATCH_PAUSE_MINUTES, 10) || DEFAULT_BATCH_PAUSE_MINUTES);
    const longPauseSize = Math.max(1, Number.parseInt(userSettings.longPauseSize ?? DEFAULT_LONG_PAUSE_SIZE, 10) || DEFAULT_LONG_PAUSE_SIZE);
    const longPauseMinutes = Math.max(0, Number.parseInt(userSettings.longPauseMinutes ?? DEFAULT_LONG_PAUSE_MINUTES, 10) || DEFAULT_LONG_PAUSE_MINUTES);
    const campaignStore = userSettings.campaignStore || null;
    const tenantId = userSettings.tenantId || 'default';
    const nowProvider = typeof userSettings.now === 'function' ? userSettings.now : () => new Date();
    const overrideCooldownSet = new Set(Array.isArray(userSettings.overrideCooldown) ? userSettings.overrideCooldown : []);
    const msgHash = messageHash(message);
    const delayOptions = {
        sleep: userSettings.sleep,
        stopPollMs: userSettings.stopPollMs,
        delayScale: userSettings.delayScale
    };
    const validationDelayRange = Array.isArray(userSettings.validationDelayRange)
        ? userSettings.validationDelayRange
        : [2, 5];
    const validationUnknownStreakLimit = Math.max(
        1,
        Number.parseInt(userSettings.validationUnknownStreakLimit || DEFAULT_VALIDATION_UNKNOWN_STREAK_LIMIT, 10)
            || DEFAULT_VALIDATION_UNKNOWN_STREAK_LIMIT
    );
    const estimateFor = (remaining) => ({
        estimate_remaining_minutes: estimateRemainingMinutes({
            remaining,
            sentCount,
            delayRange: [min, max],
            batchSize,
            batchPauseMinutes,
            longPauseSize,
            longPauseMinutes
        })
    });
    let initialStatus = userSettings.initialStatus || null;
    if (!initialStatus && campaignStore?.getRunStatus) {
        try {
            initialStatus = await campaignStore.getRunStatus(campaignId);
        } catch (err) {
            messengerLogger.warn({ err, campaignId }, 'campaign_initial_status_read_failed');
        }
    }

    const initialTimedPause = remainingTimedPause(initialStatus);
    const totalCount = safeCount(initialStatus?.total) || contacts.length;
    let sentCount = safeCount(initialStatus?.sent_count);
    let failedCount = safeCount(initialStatus?.failed_count);
    let skippedCount = safeCount(initialStatus?.skipped_count);
    let cooldownSkippedCount = safeCount(initialStatus?.cooldown_skipped_count);
    let notOnWhatsAppCount = safeCount(initialStatus?.not_on_whatsapp_count);
    let suppressedCount = safeCount(initialStatus?.suppressed_count);
    let validationUnknownCount = safeCount(initialStatus?.validation_unknown_count);
    let processedCount = Math.min(totalCount, safeCount(initialStatus?.processed));
    const progressFor = (processed) => totalCount > 0 ? Math.min(100, Math.round((processed / totalCount) * 100)) : 0;
    let consecutiveFailCount = 0;
    let consecutiveValidationUnknownCount = 0;
    let endedEarly = false;
    let endedEarlyReason = null;
    let endedEarlyMessage = null;
    const skippedReport = Array.isArray(userSettings.initialSkippedReport)
        ? userSettings.initialSkippedReport.map(item => ({
            name: item?.name || '',
            phone: item?.phone || '',
            reason: item?.reason || 'WhatsApp yok'
        }))
        : [];
    
    activeCampaigns.set(campaignId, {
        id: campaignId,
        status: 'running',
        total: totalCount,
        processed: processedCount,
        sent: sentCount,
        failed: failedCount,
        skipped: skippedCount,
        cooldownSkipped: cooldownSkippedCount,
        notOnWhatsApp: notOnWhatsAppCount,
        suppressed: suppressedCount,
        validationUnknown: validationUnknownCount,
        logs: [],
        progress: progressFor(processedCount)
    });

    const persist = async (operation, { critical = false } = {}) => {
        if (!operation) return;
        try {
            await operation;
        } catch (err) {
            messengerLogger.error({ err, campaignId }, 'campaign_state_persist_failed');
            if (critical) throw err;
        }
    };

    await persist(campaignStore?.setRunStatus(campaignId, 'running'), { critical: true });
    await persist(recipientManager.cleanup(tenantId));

    const emitProgress = (extra = {}) => {
        const campaign = activeCampaigns.get(campaignId);
        if (campaign) {
            campaign.processed = processedCount;
            campaign.sent = sentCount;
            campaign.failed = failedCount;
            campaign.skipped = skippedCount;
            campaign.cooldownSkipped = cooldownSkippedCount;
            campaign.notOnWhatsApp = notOnWhatsAppCount;
            campaign.suppressed = suppressedCount;
            campaign.validationUnknown = validationUnknownCount;
            campaign.progress = progressFor(processedCount);
            activeCampaigns.set(campaignId, { ...campaign, ...extra });
        }
        if (!socket) return;
        const pct = progressFor(processedCount);
        socket.emit('campaign-progress', {
            processed: processedCount,
            total: totalCount,
            sent: sentCount,
            failed: failedCount,
            skipped: skippedCount,
            cooldown_skipped: cooldownSkippedCount,
            not_on_whatsapp: notOnWhatsAppCount,
            suppressed: suppressedCount,
            validation_unknown: validationUnknownCount,
            progress: pct,
            ...extra
        });
    };

    const addLog = async (type, message, progress, meta = {}, options = {}) => {
        const campaign = activeCampaigns.get(campaignId);
        if(campaign) {
            campaign.logs.push({ type, message, timestamp: Date.now() });
            if(progress !== undefined) campaign.progress = progress;
            if (meta.done) campaign.done = true;
            activeCampaigns.set(campaignId, campaign);
        }
        if (options.persist !== false) {
            await persist(campaignStore?.addLog(campaignId, type, message, progress, meta));
        }
        if(socket) socket.emit('log', { type, message, progress, ...meta });
    };

    const recordRecipientResult = async (result) => {
        if (!campaignStore?.recordRecipientResult) return false;
        await persist(campaignStore.recordRecipientResult(campaignId, {
            tenantId,
            ...result
        }), { critical: true });
        return true;
    };

    const waitForTimedPause = async (reason, pauseUntilValue, remainingContacts, options = {}) => {
        const pauseUntilMs = Number.isFinite(Number(pauseUntilValue)) ? Number(pauseUntilValue) : Date.parse(pauseUntilValue || '');
        if (!Number.isFinite(pauseUntilMs)) return true;
        const pauseUntil = new Date(pauseUntilMs).toISOString();
        const remainingMs = Math.max(0, pauseUntilMs - Date.now());
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
        const title = options.message || pauseTitle(reason);
        const progressMeta = {
            ...estimateFor(remainingContacts),
            pause_until: pauseUntil,
            pause_reason: reason,
            phase: reason
        };
        if (reason === BATCH_PAUSE_REASON) {
            progressMeta.batch_pause_until = pauseUntil;
            progressMeta.batch_pause_minutes = remainingMinutes;
        }
        if (reason === LONG_PAUSE_REASON) {
            progressMeta.long_pause_until = pauseUntil;
            progressMeta.long_pause_minutes = remainingMinutes;
        }
        if (reason === NIGHT_PAUSE_REASON) {
            progressMeta.night_pause_until = pauseUntil;
        }

        await persist(campaignStore?.updateRuntimeState?.(campaignId, {
            pause_until: pauseUntil,
            pause_reason: reason,
            wait_until: null,
            current_recipient_name: null,
            current_recipient_phone: null
        }), { critical: true });
        await addLog('wait', title, progressFor(processedCount), progressMeta);
        emitProgress({ ...progressMeta, wait_until: null });
        const completed = await interruptibleDelay(campaignId, remainingMs, { ...delayOptions, delayScale: 1 });
        if (!completed) return;
        await persist(campaignStore?.updateRuntimeState?.(campaignId, {
            pause_until: null,
            pause_reason: null
        }), { critical: true });
        await addLog('info', 'Mola tamamlandı. Gönderim devam ediyor.', progressFor(processedCount), {
            pause_until: null,
            pause_reason: null,
            batch_pause_until: null,
            long_pause_until: null,
            night_pause_until: null,
            phase: 'running'
        });
        emitProgress({
            phase: 'running',
            pause_until: null,
            pause_reason: null,
            batch_pause_until: null,
            long_pause_until: null,
            night_pause_until: null
        });
        return true;
    };

    const waitForNightPauseIfNeeded = async (remainingContacts) => {
        if (userSettings.disableNightMode) return true;
        const info = nightPauseInfo(nowProvider());
        if (!info.active) return true;
        messengerLogger.warn({ campaignId, tenantId, currentHour: info.currentHour, pauseUntil: info.until.toISOString() }, 'campaign_paused_night_mode');
        const campaign = activeCampaigns.get(campaignId);
        if (campaign) {
            campaign.status = 'running';
            activeCampaigns.set(campaignId, campaign);
        }
        return waitForTimedPause(
            NIGHT_PAUSE_REASON,
            info.until.toISOString(),
            remainingContacts,
            { message: 'Günlük gönderim başlama saatine kadar bekleniyor.' }
        );
    };

    const waitAfterValidationMiss = async (remainingContacts) => {
        if (remainingContacts <= 0) return true;
        const [validationMin, validationMax] = validationDelayRange;
        const waitMs = getHumanDelay(
            Math.max(1, Number.parseInt(validationMin, 10) || 2),
            Math.max(2, Number.parseInt(validationMax, 10) || 5)
        );
        return interruptibleDelay(campaignId, waitMs, delayOptions);
    };

    if (initialTimedPause) {
        const completed = await waitForTimedPause(
            initialTimedPause.reason,
            initialTimedPause.until,
            contacts.length,
            { message: `Mola devam ediyor. ${pauseTitle(initialTimedPause.reason)}` }
        );
        if (!completed) return;
    } else {
        await persist(campaignStore?.updateRuntimeState?.(campaignId, {
            pause_until: null,
            pause_reason: null,
            wait_until: null,
            current_recipient_name: null,
            current_recipient_phone: null
        }), { critical: true });
    }

    const preparedMedia = [];
    if (mediaFiles && mediaFiles.length > 0) {
        await addLog('info', `${mediaFiles.length} medya gönderim için hazırlanıyor...`);
        for (const file of mediaFiles) {
            const type = file.mimetype?.startsWith('image/') ? 'image' : file.mimetype?.startsWith('video/') ? 'video' : null;
            if (!type) {
                await addLog('error', `Desteklenmeyen medya türü atlandı: ${file.name || file.path}`);
                continue;
            }

            const storageBaseDir = uploadStorageBaseDir(path.resolve(__dirname, '..'));
            const uploadsDir = path.resolve(storageBaseDir, 'uploads');
            const absolutePath = path.resolve(storageBaseDir, file.path);
            if (!absolutePath.startsWith(uploadsDir + path.sep) || !fs.existsSync(absolutePath)) {
                await addLog('error', `Medya dosyası bulunamadı: ${file.name || file.path}`);
                continue;
            }

            preparedMedia.push({ type, path: absolutePath, name: file.name || path.basename(file.path) });
        }

        if (preparedMedia.length > 0) {
            messengerLogger.info({ campaignId, tenantId, preparedCount: preparedMedia.length, requestedCount: mediaFiles.length }, 'campaign_media_prepared');
            await addLog('success', `${preparedMedia.length} medya gönderime hazır.`);
        } else if (mediaFiles.length > 0) {
            await addLog('error', `❌ ${mediaFiles.length} görsel disk üzerinde bulunamadı. Görselleri tekrar yükleyip kampanyayı yeniden başlatın.`, undefined, { done: true, sentCount: 0, skippedReport: [] });
            db.addSystemEvent(tenantId, 'media_missing', 'error',
                `Kampanya ${campaignId}: ${mediaFiles.length} medya dosyası disk üzerinde bulunamadı.`,
                { campaign_id: campaignId, media_count: mediaFiles.length })
                .catch(() => {});
            await persist(campaignStore?.setRunStatus(campaignId, 'paused'));
            activeCampaigns.delete(campaignId);
            return;
        }
    }

    for (let i = 0; i < contacts.length; i++) {
        const campaignState = activeCampaigns.get(campaignId);
        if (!campaignState || isTerminallyInterrupted(campaignId)) {
            const message = campaignState?.status === 'finished'
                ? '🛑 Kampanya bitirildi. Bu kampanyadan tekrar mesaj gönderilmeyecek.'
                : '🛑 Gönderim durduruldu.';
            await addLog('error', message);
            break;
        }

        const nightPauseCompleted = await waitForNightPauseIfNeeded(contacts.length - i);
        if (!nightPauseCompleted) break;

        if (consecutiveFailCount >= 5) {
            await addLog('error', '🛑 Çok fazla ardışık hata! Ban riskine karşı kampanya güvenlik nedeniyle durduruldu.');
            messengerLogger.error({ campaignId, tenantId, failCount: consecutiveFailCount }, 'campaign_stopped_consecutive_errors');
            db.addSystemEvent(tenantId, 'error_burst', 'error',
                `Kampanya ${campaignId}: 5 ardışık hata tespit edildi, ban riskine karşı durduruldu.`,
                { campaign_id: campaignId, fail_count: consecutiveFailCount })
                .catch(() => {});
            endedEarly = true;
            break;
        }

        if (isTerminallyInterrupted(campaignId)) {
            await addLog('error', '🛑 Gönderim durduruldu.');
            break;
        }

        const contact = contacts[i];
        let phone = String(contact.phone).replace(/[^0-9]/g, '');
        
        if (phone.length === 10 && phone.startsWith('5')) phone = '90' + phone;
        if (phone.length === 11 && phone.startsWith('05')) phone = '90' + phone.substring(1);
        if (!phone.includes('@s.whatsapp.net')) phone = `${phone}@s.whatsapp.net`;

        const currentProgress = progressFor(processedCount);

        const normalizedForOverride = phone.replace('@s.whatsapp.net', '');
        if (await db.isSuppressedRecipient(normalizedForOverride, tenantId)) {
            messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId }, 'message_skipped_suppressed');
            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const logMessage = `⏭️ Atlandı (Manuel dışlandı): ${contact.name || normalizedForOverride}`;
            const recorded = await recordRecipientResult({
                contact,
                status: STATUS_SUPPRESSED,
                error: 'Manuel olarak gönderim dışı bırakıldı',
                log: {
                    type: 'warn',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: {}
                }
            });
            if (!recorded) {
                await persist(campaignStore?.markRecipient(campaignId, contact, STATUS_SUPPRESSED, 'Manuel olarak gönderim dışı bırakıldı'), { critical: true });
            }
            skippedCount++;
            suppressedCount++;
            processedCount = nextProcessedCount;
            skippedReport.push({ name: contact.name || '', phone: contact.phone || normalizedForOverride, reason: 'Manuel gönderim dışı' });
            await addLog('warn', logMessage, progressFor(processedCount), {}, { persist: !recorded });
            emitProgress({ phase: 'suppressed' });
            continue;
        }

        const inCooldown = await recipientManager.isInCooldown(phone, tenantId);
        if (inCooldown && !overrideCooldownSet.has(normalizedForOverride)) {
            const expiresAt = await recipientManager.getCooldownExpiresAt(phone, tenantId);
            const expiresStr = expiresAt
                ? expiresAt.toLocaleString('tr-TR', { timeZone: process.env.TZ || 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
                : '24 saat sonra';
            messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, expiresAt }, 'message_skipped_cooldown');
            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const logMessage = `⏭️ Atlandı (Cooldown): ${contact.name || phone} — tekrar gönderilebilir: ${expiresStr}`;
            const recorded = await recordRecipientResult({
                contact,
                status: STATUS_SKIPPED_COOLDOWN,
                error: 'Cooldown aktif',
                log: {
                    type: 'wait',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: {}
                }
            });
            if (!recorded) {
                await persist(campaignStore?.markRecipient(campaignId, contact, STATUS_SKIPPED_COOLDOWN, 'Cooldown aktif'), { critical: true });
            }
            skippedCount++;
            cooldownSkippedCount++;
            processedCount = nextProcessedCount;
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: `Cooldown — ${expiresStr}'e kadar` });
            await addLog('wait', logMessage, progressFor(processedCount), {}, { persist: !recorded });
            emitProgress({ phase: 'skipped' });
            continue;
        }

        const nameLabel = recipientDisplayName(contact);

        await persist(campaignStore?.updateRuntimeState?.(campaignId, {
            current_recipient_name: nameLabel,
            current_recipient_phone: normalizedForOverride,
            wait_until: null
        }));
        await addLog('process', `[${Math.min(processedCount + 1, totalCount)}/${totalCount}] Gönderiliyor: ${nameLabel}`, currentProgress, {
            ...estimateFor(contacts.length - i),
            phase: 'sending',
            current_recipient_name: nameLabel,
            current_recipient_phone: normalizedForOverride,
            wait_until: null
        });
        emitProgress({
            phase: 'sending',
            current_recipient_name: nameLabel,
            current_recipient_phone: normalizedForOverride,
            wait_until: null
        });

        const validation = await recipientManager.validateOnWhatsApp(sock, phone);
        if (validation?.status === VALIDATION_STATUS.NOT_FOUND) {
            messengerLogger.warn({ phone: normalizedForOverride, campaignId, tenantId, reason: validation.reason }, 'message_skipped_not_on_whatsapp');
            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const logMetadata = {
                ...estimateFor(contacts.length - i - 1),
                phase: STATUS_NOT_ON_WHATSAPP
            };
            const logMessage = `❌ WhatsApp yok doğrulandı: ${phone}`;
            const recorded = await recordRecipientResult({
                contact,
                status: STATUS_NOT_ON_WHATSAPP,
                error: 'WhatsApp kullanıcısı değil',
                log: {
                    type: 'error',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: logMetadata
                }
            });
            if (!recorded) {
                await persist(campaignStore?.markRecipient(campaignId, contact, STATUS_NOT_ON_WHATSAPP, 'WhatsApp kullanıcısı değil'), { critical: true });
            }
            skippedCount++;
            notOnWhatsAppCount++;
            processedCount = nextProcessedCount;
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: 'WhatsApp yok' });
            await addLog('error', logMessage, progressFor(processedCount), logMetadata, { persist: !recorded });
            emitProgress({ phase: STATUS_NOT_ON_WHATSAPP });
            const completed = await waitAfterValidationMiss(contacts.length - i - 1);
            if (!completed) break;
            continue;
        }

        if (validation?.status !== VALIDATION_STATUS.EXISTS) {
            const reason = validation?.reason || 'unknown_response';
            consecutiveValidationUnknownCount++;
            validationUnknownCount++;
            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const recipientError = `WhatsApp doğrulaması belirsiz: ${reason}`;
            const logMetadata = {
                ...estimateFor(contacts.length - i - 1),
                phase: STATUS_VALIDATION_UNKNOWN,
                validation_unknown_count: validationUnknownCount,
                validation_unknown_streak: consecutiveValidationUnknownCount,
                validation_reason: reason
            };
            const logMessage = `⚠️ Doğrulama belirsiz: ${nameLabel}. Gönderilmeyenler listesine ayrıldı; diğer numaralara geçilecek.`;
            const recorded = await recordRecipientResult({
                contact,
                status: STATUS_VALIDATION_UNKNOWN,
                error: recipientError,
                log: {
                    type: 'wait',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: logMetadata
                }
            });
            if (!recorded) {
                await persist(campaignStore?.markRecipient(campaignId, contact, STATUS_VALIDATION_UNKNOWN, recipientError), { critical: true });
            }
            processedCount = nextProcessedCount;
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: `Doğrulama belirsiz: ${reason} — gönderilmeyenler listesinde` });
            messengerLogger.warn({
                phone: normalizedForOverride,
                campaignId,
                tenantId,
                reason,
                consecutiveValidationUnknownCount
            }, 'message_validation_unknown');
            await addLog('wait', logMessage, progressFor(processedCount), logMetadata, { persist: !recorded });
            emitProgress({
                phase: STATUS_VALIDATION_UNKNOWN,
                validation_reason: reason
            });

            if (consecutiveValidationUnknownCount >= validationUnknownStreakLimit) {
                endedEarly = true;
                endedEarlyReason = STATUS_VALIDATION_UNKNOWN;
                endedEarlyMessage = `${consecutiveValidationUnknownCount} ardışık WhatsApp doğrulaması belirsiz kaldı. Kampanya yanlış atlama riskine karşı duraklatıldı.`;
                await addLog('error', `🛑 ${endedEarlyMessage}`, progressFor(processedCount), {
                    phase: STATUS_VALIDATION_UNKNOWN,
                    validation_unknown_count: validationUnknownCount
                });
                break;
            }

            const completed = await waitAfterValidationMiss(contacts.length - i - 1);
            if (!completed) break;
            continue;
        }
        consecutiveValidationUnknownCount = 0;

        const finalMsg = message ? renderTemplate(message, { ...contact, name: nameLabel }, { choiceMode: 'random' }).text : '';

        try {
            await sock.sendPresenceUpdate('composing', phone);
            await interruptibleDelay(campaignId, userSettings.typingDelayMs ?? (Math.floor(Math.random() * 4000) + 2000), delayOptions);
            if (isTerminallyInterrupted(campaignId)) break;
            const nightPauseCompleted = await waitForNightPauseIfNeeded(contacts.length - i);
            if (!nightPauseCompleted || isTerminallyInterrupted(campaignId)) break;
            await sock.sendPresenceUpdate('paused', phone);

            let capturedMessageId = null;

            if (preparedMedia.length > 0) {
                for (let j = 0; j < preparedMedia.length; j++) {
                    const media = preparedMedia[j];
                    const payload = buildMediaPayload(media, j === 0 ? finalMsg : undefined);

                    const sendResult = await sock.sendMessage(phone, payload);
                    if (j === 0 && sendResult?.key?.id) capturedMessageId = sendResult.key.id;
                    const completed = await interruptibleDelay(campaignId, getHumanDelay(2, 5), delayOptions);
                    if (!completed) break;
                }
                if (isTerminallyInterrupted(campaignId)) break;
            } else {
                const sendResult = await sock.sendMessage(phone, { text: finalMsg });
                if (sendResult?.key?.id) capturedMessageId = sendResult.key.id;
            }

            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const runtimeState = {
                current_recipient_name: null,
                current_recipient_phone: null,
                last_recipient_name: nameLabel,
                last_recipient_phone: normalizedForOverride
            };
            const logMetadata = {
                ...estimateFor(contacts.length - i - 1),
                phase: 'sent',
                last_recipient_name: nameLabel,
                last_recipient_phone: normalizedForOverride
            };
            const logMessage = `✅ İletildi: ${nameLabel} (${sentCount + 1}/${totalCount})`;
            const recorded = await recordRecipientResult({
                contact,
                status: 'sent',
                messageId: capturedMessageId,
                sendLog: { phone, msgHash },
                runtimeState,
                log: {
                    type: 'success',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: logMetadata
                }
            });
            if (!recorded) {
                if (capturedMessageId) {
                    db.setRecipientMessageId(campaignId, phone, capturedMessageId)
                        .catch(err => messengerLogger.warn({ err, campaignId, phone }, 'message_id_save_failed'));
                }
                await recipientManager.logSend(phone, tenantId, msgHash);
                await persist(campaignStore?.markRecipient(campaignId, contact, 'sent'), { critical: true });
            }
            const dailyCount = await recipientManager.getDailyCount(tenantId);
            sentCount++;
            processedCount = nextProcessedCount;
            consecutiveFailCount = 0;
            consecutiveValidationUnknownCount = 0;
            if (!recorded) {
                await persist(campaignStore?.updateRuntimeState?.(campaignId, runtimeState));
            }
            await addLog('success', logMessage, progressFor(processedCount), logMetadata, { persist: !recorded });
            messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, sentCount }, 'message_sent');
            emitProgress({
                phase: 'sent',
                last_recipient_name: nameLabel,
                last_recipient_phone: normalizedForOverride
            });

            const hasMoreContacts = i < contacts.length - 1;
            const reachedLongPause = longPauseMinutes > 0 && longPauseSize > 0 && sentCount > 0 && sentCount % longPauseSize === 0;
            const reachedBatchPause = batchPauseMinutes > 0 && batchSize > 0 && sentCount > 0 && sentCount % batchSize === 0;
            if (hasMoreContacts && (reachedLongPause || reachedBatchPause)) {
                const pauseReason = reachedLongPause ? LONG_PAUSE_REASON : BATCH_PAUSE_REASON;
                const pauseMinutes = reachedLongPause ? longPauseMinutes : batchPauseMinutes;
                const pauseMs = pauseMinutes * 60 * 1000;
                const pauseUntil = new Date(Date.now() + scaledDelayMs(pauseMs, delayOptions)).toISOString();
                const pauseMessage = reachedLongPause
                    ? `${longPauseSize} gönderim tamamlandı. ${pauseTitle(LONG_PAUSE_REASON, longPauseMinutes)}`
                    : `${batchSize} gönderim tamamlandı. ${batchPauseMinutes} dk sonra devam edecek.`;
                messengerLogger.info({ campaignId, tenantId, pauseReason, batchSize, batchPauseMinutes, longPauseSize, longPauseMinutes, dailyCount, sentCount }, 'campaign_timed_pause_started');
                const completed = await waitForTimedPause(
                    pauseReason,
                    pauseUntil,
                    contacts.length - i - 1,
                    { message: pauseMessage }
                );
                if (!completed) break;
            }

        } catch (err) {
            failedCount++;
            consecutiveFailCount++;
            consecutiveValidationUnknownCount = 0;
            const nextProcessedCount = Math.min(totalCount, processedCount + 1);
            const runtimeState = {
                current_recipient_name: null,
                current_recipient_phone: null
            };
            const logMetadata = {
                error_stack: err.stack || null,
                phase: 'failed',
                current_recipient_name: nameLabel,
                current_recipient_phone: normalizedForOverride
            };
            const logMessage = `❌ Hata: ${err.message}. Gönderilmeyenler listesine ayrıldı; diğer numaralara geçilecek.`;
            const recorded = await recordRecipientResult({
                contact,
                status: 'failed',
                error: err,
                runtimeState,
                log: {
                    type: 'error',
                    message: logMessage,
                    progress: progressFor(nextProcessedCount),
                    metadata: logMetadata
                }
            });
            if (!recorded) {
                await persist(campaignStore?.markRecipient(campaignId, contact, 'failed', err), { critical: true });
            }
            processedCount = nextProcessedCount;
            if (!recorded) {
                await persist(campaignStore?.updateRuntimeState?.(campaignId, runtimeState));
            }
            await addLog('error', logMessage, progressFor(processedCount), logMetadata, { persist: !recorded });
            messengerLogger.error({ err, phone: normalizedForOverride, campaignId, tenantId, attemptCount: contact.attempt_count }, 'message_failed');
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: `Hata: ${err.message} — gönderilmeyenler listesinde` });
            emitProgress({
                phase: 'failed',
                current_recipient_name: nameLabel,
                current_recipient_phone: normalizedForOverride
            });
        }

        if (i < contacts.length - 1 && !isTerminallyInterrupted(campaignId)) {
            const waitTime = getHumanDelay(min, max);
            const waitUntil = new Date(Date.now() + scaledDelayMs(waitTime, delayOptions)).toISOString();
            const waitSeconds = Math.max(0, Math.round(waitTime / 1000));
            await persist(campaignStore?.updateRuntimeState?.(campaignId, {
                wait_until: waitUntil,
                current_recipient_name: null,
                current_recipient_phone: null
            }));
            await addLog('wait', `⏳ ${waitSeconds}sn bekleniyor...`, progressFor(processedCount), {
                ...estimateFor(contacts.length - i - 1),
                wait_until: waitUntil,
                wait_seconds: waitSeconds,
                phase: 'inter_message_wait'
            });
            emitProgress({
                phase: 'inter_message_wait',
                wait_until: waitUntil,
                wait_seconds: waitSeconds
            });
            const completed = await interruptibleDelay(campaignId, waitTime, delayOptions);
            if (!completed) break;
            await persist(campaignStore?.updateRuntimeState?.(campaignId, { wait_until: null }));
            emitProgress({ phase: 'running', wait_until: null });
        }
    }
    
    // İşlem tamamen bitince
    const finalState = activeCampaigns.get(campaignId);
    if(finalState && !['stopped', 'finished'].includes(finalState.status) && !endedEarly) {
        finalState.status = 'completed';
        finalState.processed = totalCount;
        finalState.sent = sentCount;
        finalState.failed = failedCount;
        finalState.skipped = skippedCount;
        finalState.cooldownSkipped = cooldownSkippedCount;
        finalState.notOnWhatsApp = notOnWhatsAppCount;
        finalState.validationUnknown = validationUnknownCount;
        finalState.progress = 100;
        activeCampaigns.set(campaignId, finalState);
        await persist(campaignStore?.setRunStatus(campaignId, 'completed'), { critical: true });
        const notSentCount = Math.max(0, totalCount - sentCount);
        const doneMessage = sentCount === 0
            ? `⚠️ Hiç mesaj gönderilemedi. ${notSentCount} kişi atlandı veya başarısız oldu.`
            : notSentCount > 0
                ? `${sentCount} kişiye gönderildi, ${notSentCount} kişi atlandı veya başarısız oldu.`
                : 'Gönderiler tamamlandı.';
        await addLog('success', doneMessage, 100, {
            done: true,
            sentCount,
            totalCount,
            skippedReport,
            validationUnknownCount,
            notOnWhatsAppCount,
            cooldownSkippedCount
        });
    } else if (finalState && !['stopped', 'finished'].includes(finalState.status)) {
        finalState.status = 'paused';
        finalState.sent = sentCount;
        finalState.failed = failedCount;
        finalState.skipped = skippedCount;
        finalState.cooldownSkipped = cooldownSkippedCount;
        finalState.notOnWhatsApp = notOnWhatsAppCount;
        finalState.validationUnknown = validationUnknownCount;
        activeCampaigns.set(campaignId, finalState);
        const pauseMetadata = {};
        if (endedEarlyMessage) pauseMetadata.error = endedEarlyMessage;
        if (endedEarlyReason) {
            pauseMetadata.pause_reason = endedEarlyReason;
            pauseMetadata.pause_until = null;
        }
        await persist(campaignStore?.setRunStatus(campaignId, 'paused', pauseMetadata), { critical: true });
        emitProgress({ status: 'paused', phase: endedEarlyReason || 'paused' });
        if (endedEarlyMessage) {
            await addLog('error', endedEarlyMessage, progressFor(processedCount), {
                sentCount,
                totalCount,
                skippedReport,
                validationUnknownCount,
                notOnWhatsAppCount,
                cooldownSkippedCount,
                phase: endedEarlyReason
            });
        }
    } else if (finalState && finalState.status === 'stopped') {
        await persist(campaignStore?.setRunStatus(campaignId, 'stopped'), { critical: true });
    } else if (finalState && finalState.status === 'finished') {
        await persist(campaignStore?.setRunStatus(campaignId, 'finished'), { critical: true });
    }
}

function stopCampaign(campaignId) {
    const campaign = activeCampaigns.get(campaignId);
    if(campaign) {
        campaign.status = 'stopped';
        activeCampaigns.set(campaignId, campaign);
    }
}

function finishCampaign(campaignId) {
    const campaign = activeCampaigns.get(campaignId);
    if(campaign) {
        campaign.status = 'finished';
        activeCampaigns.set(campaignId, campaign);
    }
}

function stopAllCampaigns() {
    for (const campaignId of activeCampaigns.keys()) {
        stopCampaign(campaignId);
    }
}

function getCampaignStatus(campaignId) {
    return activeCampaigns.get(campaignId) || null;
}

module.exports = { sendBulkWithProgress, stopCampaign, finishCampaign, stopAllCampaigns, getCampaignStatus, buildMediaPayload };
