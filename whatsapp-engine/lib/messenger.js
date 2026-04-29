const recipientManager = require('./recipient_manager');
const path = require('path');
const fs = require('fs-extra');
const { renderTemplate } = require('../shared/message_renderer');
const { componentLogger } = require('./logger');
const {
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_BATCH_SIZE,
    estimateRemainingMinutes
} = require('./campaign_estimate');

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
    const now = new Date();
    const hour = now.getHours();
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
    let endedEarly = false;
    
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

            const absolutePath = path.resolve(__dirname, '..', file.path);
            if (!absolutePath.startsWith(path.resolve(__dirname, '..', 'uploads') + path.sep) || !fs.existsSync(absolutePath)) {
                await addLog('error', `Medya dosyası bulunamadı: ${file.name || file.path}`);
                continue;
            }

            preparedMedia.push({ type, path: absolutePath, name: file.name || path.basename(file.path) });
        }

        if (preparedMedia.length > 0) {
            await addLog('success', `${preparedMedia.length} medya gönderime hazır.`);
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
            await addLog('wait', '🌙 Gece yasağı devrede (22:00-09:00). Kampanya duraklatıldı. Sabah 09:00\'da manuel olarak devam ettirin.');
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
            endedEarly = true;
            break;
        }

        if (failCount >= 5) {
            await addLog('error', '🛑 Çok fazla ardışık hata! Ban riskine karşı kampanya güvenlik nedeniyle durduruldu.');
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

        if (await recipientManager.isInCooldown(phone, tenantId)) {
            await addLog('wait', `⏭️ Atlandı (Cooldown): ${phone} için son 24 saat içinde gönderim yapılmış.`);
            await persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'Cooldown aktif'), { critical: true });
            continue;
        }

        const nameLabel = contact.name && contact.name !== 'Bilinmeyen' ? contact.name : 'Müşterimiz';
        const currentProgress = ((i + 1) / contacts.length) * 100;
        
        await addLog('process', `[${i + 1}/${contacts.length}] İşleniyor: ${nameLabel}`, currentProgress, estimateFor(contacts.length - i));
        
        if(campaignState) {
             campaignState.processed = i + 1;
        }

        const exists = await recipientManager.validateOnWhatsApp(sock, phone);
        if (!exists) {
            await addLog('error', `❌ Atlandı: ${phone} numaralı kullanıcı WhatsApp kullanmıyor.`);
            await persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'WhatsApp kullanıcısı değil'), { critical: true });
            continue;
        }

        const finalMsg = renderTemplate(message, { ...contact, name: nameLabel }, { choiceMode: 'random' }).text;

        try {
            await sock.sendPresenceUpdate('composing', phone);
            await interruptibleDelay(campaignId, userSettings.typingDelayMs ?? (Math.floor(Math.random() * 4000) + 2000), delayOptions);
            if (isStopped(campaignId)) break;
            await sock.sendPresenceUpdate('paused', phone);

            if (preparedMedia.length > 0) {
                for (let j = 0; j < preparedMedia.length; j++) {
                    const media = preparedMedia[j];
                    const payload = media.type === 'image'
                        ? { image: { url: media.path } }
                        : { video: { url: media.path } };

                    if (j === 0) payload.caption = finalMsg;
                    await sock.sendMessage(phone, payload);
                    const completed = await interruptibleDelay(campaignId, getHumanDelay(2, 5), delayOptions);
                    if (!completed) break;
                }
                if (isStopped(campaignId)) break;
            } else {
                await sock.sendMessage(phone, { text: finalMsg });
            }

            await recipientManager.logSend(phone, tenantId);
            await persist(campaignStore?.markRecipient(campaignId, contact, 'sent'), { critical: true });
            const dailyCount = await recipientManager.getDailyCount(tenantId);
            await addLog('success', `✅ İletildi: ${nameLabel} (${dailyCount}/${dailyLimit})`, currentProgress, estimateFor(contacts.length - i - 1));
            failCount = 0;

            const hasMoreContacts = i < contacts.length - 1;
            const reachedBatchPause = batchPauseMinutes > 0 && batchSize > 0 && dailyCount > 0 && dailyCount % batchSize === 0;
            if (hasMoreContacts && reachedBatchPause && dailyCount < dailyLimit) {
                const pauseMs = batchPauseMinutes * 60 * 1000;
                const pauseUntil = new Date(Date.now() + pauseMs).toISOString();
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
            await persist(campaignStore?.markRecipient(campaignId, contact, 'failed', err.message), { critical: true });
            await addLog('error', `❌ Hata: ${err.message}`);
        }

        if (i < contacts.length - 1 && activeCampaigns.get(campaignId)?.status !== 'stopped') {
            const waitTime = getHumanDelay(min, max);
            await addLog('wait', `⏳ ${waitTime/1000}sn bekleniyor...`, undefined, estimateFor(contacts.length - i - 1));
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
        await addLog('success', 'Gönderiler tamamlandı.', 100, { done: true });
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
