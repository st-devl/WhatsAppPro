const recipientManager = require('./recipient_manager');
const path = require('path');
const fs = require('fs-extra');

const delay = ms => new Promise(res => setTimeout(res, ms));

// Campaign state in memory
let activeCampaigns = new Map();

function personalizeMessage(text, name) {
    let processed = text.replace(/{{ad}}/g, name);
    processed = processed.trim().replace(/\s+/g, ' ');
    return processed;
}

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

async function sendBulkWithProgress(sock, contacts, message, socket, delayRange, mediaFiles = [], campaignId, userSettings = {}) {
    const [min, max] = delayRange || [20, 90];
    const dailyLimit = userSettings.dailyLimit || 50;
    const campaignStore = userSettings.campaignStore || null;
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

    const persist = (operation) => {
        if (!operation) return;
        Promise.resolve(operation).catch(err => {
            console.error('Campaign state kalıcılaştırma hatası:', err);
        });
    };

    persist(campaignStore?.setRunStatus(campaignId, 'running'));

    const addLog = (type, message, progress, meta = {}) => {
        const campaign = activeCampaigns.get(campaignId);
        if(campaign) {
            campaign.logs.push({ type, message, timestamp: Date.now() });
            if(progress !== undefined) campaign.progress = progress;
            if (meta.done) campaign.done = true;
            activeCampaigns.set(campaignId, campaign);
        }
        persist(campaignStore?.addLog(campaignId, type, message, progress, meta));
        if(socket) socket.emit('log', { type, message, progress, ...meta });
    };

    const preparedMedia = [];
    if (mediaFiles && mediaFiles.length > 0) {
        addLog('info', `${mediaFiles.length} medya gönderim için hazırlanıyor...`);
        for (const file of mediaFiles) {
            const type = file.mimetype?.startsWith('image/') ? 'image' : file.mimetype?.startsWith('video/') ? 'video' : null;
            if (!type) {
                addLog('error', `Desteklenmeyen medya türü atlandı: ${file.name || file.path}`);
                continue;
            }

            const absolutePath = path.resolve(__dirname, '..', file.path);
            if (!absolutePath.startsWith(path.resolve(__dirname, '..', 'uploads') + path.sep) || !fs.existsSync(absolutePath)) {
                addLog('error', `Medya dosyası bulunamadı: ${file.name || file.path}`);
                continue;
            }

            preparedMedia.push({ type, path: absolutePath, name: file.name || path.basename(file.path) });
        }

        if (preparedMedia.length > 0) {
            addLog('success', `${preparedMedia.length} medya gönderime hazır.`);
        }
    }

    for (let i = 0; i < contacts.length; i++) {
        const sentToday = recipientManager.getDailyCount();
        const campaignState = activeCampaigns.get(campaignId);
        if (!campaignState || campaignState.status === 'stopped') {
            addLog('error', '🛑 Gönderim durduruldu.');
            break;
        }

        if (isNightMode()) {
            addLog('wait', '🌙 Gece yasağı devrede (22:00-09:00). Gönderim duraklatıldı. Sabah devam edilecek.');
            while (isNightMode() && activeCampaigns.get(campaignId)?.status !== 'stopped') {
                await delay(60000); 
            }
            if (activeCampaigns.get(campaignId)?.status === 'stopped') break;
        }

        if (sentToday >= dailyLimit) {
            addLog('error', `🚫 Günlük limite ulaşıldı (${dailyLimit}). Güvenlik gereği bugünlük durduruldu.`);
            endedEarly = true;
            break;
        }

        if (failCount >= 5) {
            addLog('error', '🛑 Çok fazla ardışık hata! Ban riskine karşı kampanya güvenlik nedeniyle durduruldu.');
            endedEarly = true;
            break;
        }

        if (i > 0) {
            if (i % 40 === 0) {
                const longBreak = Math.floor(Math.random() * (45 - 20 + 1) + 20);
                addLog('wait', `☕ Uzun mola zamanı (40 mesajda bir). ${longBreak} dakika bekleniyor...`);
                await delay(longBreak * 60000);
            } else if (i % 12 === 0) {
                const shortBreak = Math.floor(Math.random() * (8 - 3 + 1) + 3);
                addLog('wait', `🥤 Kısa mola (12 mesajda bir). ${shortBreak} dakika bekleniyor...`);
                await delay(shortBreak * 60000);
            }
        }

        const contact = contacts[i];
        let phone = String(contact.phone).replace(/[^0-9]/g, '');
        
        if (phone.length === 10 && phone.startsWith('5')) phone = '90' + phone;
        if (phone.length === 11 && phone.startsWith('05')) phone = '90' + phone.substring(1);
        if (!phone.includes('@s.whatsapp.net')) phone = `${phone}@s.whatsapp.net`;

        if (recipientManager.isInCooldown(phone)) {
            addLog('wait', `⏭️ Atlandı (Cooldown): ${phone} için son 24 saat içinde gönderim yapılmış.`);
            persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'Cooldown aktif'));
            continue;
        }

        const nameLabel = contact.name && contact.name !== 'Bilinmeyen' ? contact.name : 'Müşterimiz';
        const currentProgress = ((i + 1) / contacts.length) * 100;
        
        addLog('process', `[${i + 1}/${contacts.length}] İşleniyor: ${nameLabel}`, currentProgress);
        
        if(campaignState) {
             campaignState.processed = i + 1;
        }

        const exists = await recipientManager.validateOnWhatsApp(sock, phone);
        if (!exists) {
            addLog('error', `❌ Atlandı: ${phone} numaralı kullanıcı WhatsApp kullanmıyor.`);
            persist(campaignStore?.markRecipient(campaignId, contact, 'skipped', 'WhatsApp kullanıcısı değil'));
            continue;
        }

        const finalMsg = personalizeMessage(message, nameLabel);

        try {
            await sock.sendPresenceUpdate('composing', phone);
            await delay(Math.floor(Math.random() * 4000) + 2000);
            await sock.sendPresenceUpdate('paused', phone);

            if (preparedMedia.length > 0) {
                for (let j = 0; j < preparedMedia.length; j++) {
                    const media = preparedMedia[j];
                    const payload = media.type === 'image'
                        ? { image: { url: media.path } }
                        : { video: { url: media.path } };

                    if (j === 0) payload.caption = finalMsg;
                    await sock.sendMessage(phone, payload);
                    await delay(getHumanDelay(2, 5)); 
                }
            } else {
                await sock.sendMessage(phone, { text: finalMsg });
            }

            await recipientManager.logSend(phone);
            persist(campaignStore?.markRecipient(campaignId, contact, 'sent'));
            addLog('success', `✅ İletildi: ${nameLabel} (${recipientManager.getDailyCount()}/${dailyLimit})`);

        } catch (err) {
            failCount++;
            persist(campaignStore?.markRecipient(campaignId, contact, 'failed', err.message));
            addLog('error', `❌ Hata: ${err.message}`);
        }

        if (i < contacts.length - 1 && activeCampaigns.get(campaignId)?.status !== 'stopped') {
            const waitTime = getHumanDelay(min, max);
            addLog('wait', `⏳ ${waitTime/1000}sn bekleniyor...`);
            await delay(waitTime);
        }
    }
    
    // İşlem tamamen bitince
    const finalState = activeCampaigns.get(campaignId);
    if(finalState && finalState.status !== 'stopped' && !endedEarly) {
        finalState.status = 'completed';
        finalState.processed = finalState.total;
        finalState.progress = 100;
        activeCampaigns.set(campaignId, finalState);
        persist(campaignStore?.setRunStatus(campaignId, 'completed'));
        addLog('success', 'Gönderiler tamamlandı.', 100, { done: true });
    } else if (finalState && finalState.status !== 'stopped') {
        finalState.status = 'paused';
        activeCampaigns.set(campaignId, finalState);
        persist(campaignStore?.setRunStatus(campaignId, 'paused'));
    } else if (finalState && finalState.status === 'stopped') {
        persist(campaignStore?.setRunStatus(campaignId, 'stopped'));
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
