const recipientManager = require('./recipient_manager');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { renderTemplate } = require('../shared/message_renderer');
const { componentLogger } = require('./logger');
const { uploadStorageBaseDir } = require('./upload_middleware');
const db = require('./db');
const {
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_BATCH_SIZE,
    estimateRemainingMinutes
} = require('./campaign_estimate');

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

function isNightMode() {
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'Europe/Istanbul', hour: 'numeric', hour12: false }));
    return hour >= 22 || hour < 9;
}

function isStopped(campaignId) {
    return activeCampaigns.get(campaignId)?.status === 'stopped';
}

async function interruptibleDelay(campaignId, ms, options = {}) {
    const sleep = options.sleep || defaultDelay;
    const pollMs = Math.max(25, Number.parseInt(options.stopPollMs || '250', 10));
    const scale = Number.isFinite(Number(options.delayScale)) ? Number(options.delayScale) : 1;
    const deadline = Date.now() + Math.max(0, Number(ms || 0) * scale);

    while (!isStopped(campaignId)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return true;
        await sleep(Math.min(pollMs, remaining));
    }

    return false;
}

async function sendBulkWithProgress(sock, contacts, message, socket, delayRange, mediaFiles = [], campaignId, userSettings = {}) {
    const [min, max] = delayRange || [20, 90];
    const dailyLimit = userSettings.dailyLimit || 50;
    const batchSize = Math.max(1, Number.parseInt(userSettings.batchSize ?? DEFAULT_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE);
    const batchPauseMinutes = Math.max(0, Number.parseInt(userSettings.batchPauseMinutes ?? DEFAULT_BATCH_PAUSE_MINUTES, 10) || DEFAULT_BATCH_PAUSE_MINUTES);
    const campaignStore = userSettings.campaignStore || null;
    const tenantId = userSettings.tenantId || 'default';
    const overrideCooldownSet = new Set(Array.isArray(userSettings.overrideCooldown) ? userSettings.overrideCooldown : []);
    const msgHash = messageHash(message);
    const delayOptions = {
        sleep: userSettings.sleep,
        stopPollMs: userSettings.stopPollMs,
        delayScale: userSettings.delayScale
    };
    const estimateFor = (remaining) => ({
        estimate_remaining_minutes: estimateRemainingMinutes({
            remaining,
            delayRange: [min, max],
            batchSize,
            batchPauseMinutes
        })
    });
    let failCount = 0;
    let sentCount = 0;
    let endedEarly = false;
    const skippedReport = [];
    
    activeCampaigns.set(campaignId, {
        id: campaignId,
        status: 'running',
        total: contacts.length,
        processed: 0,
        logs: [],
        progress: 0
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

    const emitProgress = (processed, total, sent, failed) => {
        if (!socket) return;
        const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
        socket.emit('campaign-progress', { processed, total, sent, failed, progress: pct });
    };

    const addLog = async (type, message, progress, meta = {}) => {
        const campaign = activeCampaigns.get(campaignId);
        if(campaign) {
            campaign.logs.push({ type, message, timestamp: Date.now() });
            if(progress !== undefined) campaign.progress = progress;
            if (meta.done) campaign.done = true;
            activeCampaigns.set(campaignId, campaign);
        }
        await persist(campaignStore?.addLog(campaignId, type, message, progress, meta));
        if(socket) socket.emit('log', { type, message, progress, ...meta });
    };

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
        const sentToday = await recipientManager.getDailyCount(tenantId);
        const campaignState = activeCampaigns.get(campaignId);
        if (!campaignState || campaignState.status === 'stopped') {
            await addLog('error', '🛑 Gönderim durduruldu.');
            break;
        }

        if (!userSettings.disableNightMode && isNightMode()) {
            const currentHour = Number(new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'Europe/Istanbul', hour: 'numeric', hour12: false }));
            await addLog('wait', '🌙 Gece yasağı devrede (22:00-09:00). Kampanya duraklatıldı. Sabah 09:00\'da manuel olarak devam ettirin.');
            messengerLogger.warn({ campaignId, tenantId, currentHour }, 'campaign_paused_night_mode');
            const campaign = activeCampaigns.get(campaignId);
            if (campaign) {
                campaign.status = 'paused';
                activeCampaigns.set(campaignId, campaign);
            }
            await persist(campaignStore?.setRunStatus(campaignId, 'paused'), { critical: true });
            endedEarly = true;
            break;
        }

        if (sentToday >= dailyLimit) {
            await addLog('error', `🚫 Günlük limite ulaşıldı (${dailyLimit}). Güvenlik gereği bugünlük durduruldu.`);
            messengerLogger.warn({ campaignId, tenantId, sentToday, dailyLimit }, 'campaign_stopped_daily_limit');
            endedEarly = true;
            break;
        }

        if (failCount >= 5) {
            await addLog('error', '🛑 Çok fazla ardışık hata! Ban riskine karşı kampanya güvenlik nedeniyle durduruldu.');
            messengerLogger.error({ campaignId, tenantId, failCount }, 'campaign_stopped_consecutive_errors');
            db.addSystemEvent(tenantId, 'error_burst', 'error',
                `Kampanya ${campaignId}: 5 ardışık hata tespit edildi, ban riskine karşı durduruldu.`,
                { campaign_id: campaignId, fail_count: failCount })
                .catch(() => {});
            endedEarly = true;
            break;
        }

        if (isStopped(campaignId)) {
            await addLog('error', '🛑 Gönderim durduruldu.');
            break;
        }

        const contact = contacts[i];
        let phone = String(contact.phone).replace(/[^0-9]/g, '');
        
        if (phone.length === 10 && phone.startsWith('5')) phone = '90' + phone;
        if (phone.length === 11 && phone.startsWith('05')) phone = '90' + phone.substring(1);
        if (!phone.includes('@s.whatsapp.net')) phone = `${phone}@s.whatsapp.net`;

        const currentProgress = ((i + 1) / contacts.length) * 100;

        const normalizedForOverride = phone.replace('@s.whatsapp.net', '');
        const inCooldown = await recipientManager.isInCooldown(phone, tenantId);
        if (inCooldown && !overrideCooldownSet.has(normalizedForOverride)) {
            const expiresAt = await recipientManager.getCooldownExpiresAt(phone, tenantId);
            const expiresStr = expiresAt
                ? expiresAt.toLocaleString('tr-TR', { timeZone: process.env.TZ || 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
                : '24 saat sonra';
            await addLog('wait', `⏭️ Atlandı (Cooldown): ${contact.name || phone} — tekrar gönderilebilir: ${expiresStr}`, currentProgress);
            messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, expiresAt }, 'message_skipped_cooldown');
            await persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'Cooldown aktif'), { critical: true });
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: `Cooldown — ${expiresStr}'e kadar` });
            emitProgress(i + 1, contacts.length, sentCount, failCount);
            continue;
        }

        const nameLabel = contact.name && contact.name !== 'Bilinmeyen' ? contact.name : 'Müşterimiz';

        await addLog('process', `[${i + 1}/${contacts.length}] İşleniyor: ${nameLabel}`, currentProgress, estimateFor(contacts.length - i));

        if(campaignState) {
             campaignState.processed = i + 1;
        }

        const exists = await recipientManager.validateOnWhatsApp(sock, phone);
        if (!exists) {
            await addLog('error', `❌ Atlandı: ${phone} numaralı kullanıcı WhatsApp kullanmıyor.`, currentProgress);
            messengerLogger.warn({ phone: normalizedForOverride, campaignId, tenantId }, 'message_skipped_not_on_whatsapp');
            await persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'WhatsApp kullanıcısı değil'), { critical: true });
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: 'WhatsApp yok' });
            emitProgress(i + 1, contacts.length, sentCount, failCount);
            continue;
        }

        const finalMsg = message ? renderTemplate(message, { ...contact, name: nameLabel }, { choiceMode: 'random' }).text : '';

        try {
            await sock.sendPresenceUpdate('composing', phone);
            await interruptibleDelay(campaignId, userSettings.typingDelayMs ?? (Math.floor(Math.random() * 4000) + 2000), delayOptions);
            if (isStopped(campaignId)) break;
            await sock.sendPresenceUpdate('paused', phone);

            let capturedMessageId = null;

            if (preparedMedia.length > 0) {
                for (let j = 0; j < preparedMedia.length; j++) {
                    const media = preparedMedia[j];
                    const payload = media.type === 'image'
                        ? { image: { url: media.path } }
                        : { video: { url: media.path } };

                    if (j === 0 && finalMsg) payload.caption = finalMsg;
                    const sendResult = await sock.sendMessage(phone, payload);
                    if (j === 0 && sendResult?.key?.id) capturedMessageId = sendResult.key.id;
                    const completed = await interruptibleDelay(campaignId, getHumanDelay(2, 5), delayOptions);
                    if (!completed) break;
                }
                if (isStopped(campaignId)) break;
            } else {
                const sendResult = await sock.sendMessage(phone, { text: finalMsg });
                if (sendResult?.key?.id) capturedMessageId = sendResult.key.id;
            }

            if (capturedMessageId) {
                db.setRecipientMessageId(campaignId, phone, capturedMessageId)
                    .catch(err => messengerLogger.warn({ err, campaignId, phone }, 'message_id_save_failed'));
            }

            await recipientManager.logSend(phone, tenantId, msgHash);
            await persist(campaignStore?.markRecipient(campaignId, contact, 'sent'), { critical: true });
            const dailyCount = await recipientManager.getDailyCount(tenantId);
            sentCount++;
            failCount = 0;
            await addLog('success', `✅ İletildi: ${nameLabel} (${dailyCount}/${dailyLimit})`, currentProgress, estimateFor(contacts.length - i - 1));
            messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, sentCount }, 'message_sent');
            emitProgress(i + 1, contacts.length, sentCount, failCount);

            const hasMoreContacts = i < contacts.length - 1;
            const reachedBatchPause = batchPauseMinutes > 0 && batchSize > 0 && dailyCount > 0 && dailyCount % batchSize === 0;
            if (hasMoreContacts && reachedBatchPause && dailyCount < dailyLimit) {
                const pauseMs = batchPauseMinutes * 60 * 1000;
                const pauseUntil = new Date(Date.now() + pauseMs).toISOString();
                messengerLogger.info({ campaignId, tenantId, batchSize, batchPauseMinutes, dailyCount }, 'campaign_batch_pause_started');
                await addLog('wait', `${batchSize} gönderim tamamlandı. ${batchPauseMinutes} dk zorunlu mola başladı.`, undefined, {
                    ...estimateFor(contacts.length - i - 1),
                    batch_pause_until: pauseUntil,
                    batch_pause_minutes: batchPauseMinutes
                });
                const completed = await interruptibleDelay(campaignId, pauseMs, delayOptions);
                if (!completed) break;
            }

        } catch (err) {
            failCount++;
            await persist(campaignStore?.markRecipient(campaignId, contact, 'failed', err), { critical: true });
            await addLog('error', `❌ Hata: ${err.message}`, currentProgress, { error_stack: err.stack || null });
            messengerLogger.error({ err, phone: normalizedForOverride, campaignId, tenantId, attemptCount: contact.attempt_count }, 'message_failed');
            skippedReport.push({ name: contact.name || '', phone: contact.phone || phone, reason: `Hata: ${err.message}` });
            emitProgress(i + 1, contacts.length, sentCount, failCount);
        }

        if (i < contacts.length - 1 && activeCampaigns.get(campaignId)?.status !== 'stopped') {
            const waitTime = getHumanDelay(min, max);
            await addLog('wait', `⏳ ${Math.round(waitTime/1000)}sn bekleniyor...`, currentProgress, estimateFor(contacts.length - i - 1));
            await interruptibleDelay(campaignId, waitTime, delayOptions);
        }
    }
    
    // İşlem tamamen bitince
    const finalState = activeCampaigns.get(campaignId);
    if(finalState && finalState.status !== 'stopped' && !endedEarly) {
        finalState.status = 'completed';
        finalState.processed = finalState.total;
        finalState.progress = 100;
        activeCampaigns.set(campaignId, finalState);
        await persist(campaignStore?.setRunStatus(campaignId, 'completed'), { critical: true });
        const skippedCount = contacts.length - sentCount;
        const doneMessage = sentCount === 0
            ? `⚠️ Hiç mesaj gönderilemedi. ${skippedCount} kişi atlandı (cooldown veya WhatsApp dışı).`
            : skippedCount > 0
                ? `${sentCount} kişiye gönderildi, ${skippedCount} kişi atlandı.`
                : 'Gönderiler tamamlandı.';
        await addLog('success', doneMessage, 100, { done: true, sentCount, totalCount: contacts.length, skippedReport });
    } else if (finalState && finalState.status !== 'stopped') {
        finalState.status = 'paused';
        activeCampaigns.set(campaignId, finalState);
        await persist(campaignStore?.setRunStatus(campaignId, 'paused'), { critical: true });
    } else if (finalState && finalState.status === 'stopped') {
        await persist(campaignStore?.setRunStatus(campaignId, 'stopped'), { critical: true });
    }
}

function stopCampaign(campaignId) {
    const campaign = activeCampaigns.get(campaignId);
    if(campaign) {
        campaign.status = 'stopped';
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

module.exports = { sendBulkWithProgress, stopCampaign, stopAllCampaigns, getCampaignStatus };
