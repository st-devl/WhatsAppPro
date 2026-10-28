let _socket = null;

function _initSocketListeners(sock) {
    sock.on('connect_error', () => setPanelConnectionError('Sunucu bağlantısı kurulamadı'));
    sock.on('connect', () => {
        refreshActiveCampaignSnapshot({ hydrateLogs: true }).catch(() => {});
    });
    sock.on('qr', qr => {
        const canvas = document.getElementById('qr-canvas');
        canvas.classList.remove('hidden');
        document.getElementById('qr-loading').classList.add('hidden');
        document.getElementById('connected-check').classList.add('hidden');
        setWhatsAppUiStatus('disconnected', 'QR BEKLENİYOR');
        const renderQr = () => {
            if (!window.QRCode) return setTimeout(renderQr, 250);
            QRCode.toCanvas(canvas, qr, { width: 180, margin: 1 });
        };
        renderQr();
    });
    sock.on('status', status => setWhatsAppUiStatus(status));
    sock.on('campaign-started', data => {
        setActiveCampaignId(data?.campaignId || data?.status?.id || getActiveCampaignId());
        hydratedCampaignLogsForId = null;
        setCampaignControls('running');
        renderCampaignProgress(data?.status || {});
    });
    sock.on('campaign-progress', data => {
        renderCampaignProgress(data || {});
        if (data?.status) setCampaignControls(data.status);
    });
    sock.on('log', data => {
        const logs = document.getElementById('logs');
        const div = document.createElement('div');
        const colorClass = data.type === 'error' ? 'text-red-300' : (data.type === 'success' ? 'text-secondary-fixed-dim' : (['wait', 'warn'].includes(data.type) ? 'text-amber-300' : 'text-slate-300'));
        div.className = colorClass;
        div.innerText = `> ${data.message}`;
        logs.prepend(div);
        while (logs.children.length > 300) logs.removeChild(logs.lastChild);

        const hasCountdownState = data.wait_until !== undefined
            || data.pause_until !== undefined
            || data.batch_pause_until !== undefined
            || data.long_pause_until !== undefined
            || data.night_pause_until !== undefined;
        if (data.progress !== undefined && !hasCountdownState) {
            document.getElementById('prog-box').classList.remove('hidden');
            document.getElementById('prog-bar').style.width = `${data.progress}%`;
            document.getElementById('prog-text').innerText = `${Math.round(data.progress)}%`;
            document.getElementById('prog-count').innerText = data.message;
        }
        if (data.estimate_remaining_minutes !== undefined) updateCampaignEstimate(data.estimate_remaining_minutes);
        if (data.pause_until !== undefined) updateBatchPauseCountdown(data.pause_until, data.pause_reason);
        if (data.batch_pause_until !== undefined) updateBatchPauseCountdown(data.batch_pause_until, 'batch_pause');
        if (data.long_pause_until !== undefined) updateBatchPauseCountdown(data.long_pause_until, 'long_pause');
        if (data.night_pause_until !== undefined) updateBatchPauseCountdown(data.night_pause_until, 'night_pause');
        if (data.wait_until !== undefined) updateInterMessageCountdown(data.wait_until);
        if (data.current_recipient_name || data.last_recipient_name) updateRecipientDisplay(data);

        if (data.done) {
            document.getElementById('prog-box').classList.remove('hidden');
            document.getElementById('prog-bar').style.width = '100%';
            document.getElementById('prog-text').innerText = '100%';
            document.getElementById('prog-count').innerText = data.message;
            updateCampaignEstimate(0);
            updateBatchPauseCountdown(null);
            updateInterMessageCountdown(null);
            setCampaignControls('completed');
            if (data.sentCount === 0) {
                showToast(data.message, 'error');
            } else {
                showCampaignCompleteModal(data.skippedReport || [], data.message);
            }
            return;
        }

        if (data.message.toLocaleLowerCase('tr-TR').includes('durduruldu')) {
            setCampaignControls('stopped');
        }
        if (data.message.toLocaleLowerCase('tr-TR').includes('bitirildi')) {
            setCampaignControls('finished');
        }
    });
}

function getSocket() {
    if (_socket) return _socket;
    if (!window.io) {
        setPanelConnectionError('Socket.IO yüklenemedi');
        return null;
    }
    _socket = io({ timeout: 10000, reconnectionDelayMax: 5000 });
    _initSocketListeners(_socket);
    return _socket;
}
const unsavedContactsDraftKey = 'whatsappc.unsavedContacts.v1';
const API_BASE = window.WhasAppCApi.API_BASE;
const appState = window.WhasAppCState;
const ui = window.WhasAppCUI;
const messageRenderer = window.WhasAppCMessageRenderer;
let batchPauseCountdownTimer = null;
let interMessageCountdownTimer = null;
let campaignStatusPollTimer = null;
let campaignStatusPollInFlight = false;
let hydratedCampaignLogsForId = null;
let currentFrontendRevision = null;
let releaseWatcherTimer = null;
let selectedContactPhones = new Set();
let suppressedRecipients = [];
let suppressedPhoneSet = new Set();
let suppressedRecipientsLoaded = false;
let lastCampaignDetailedReport = null;
appState.expose([
    'currentContacts',
    'visibleContacts',
    'templates',
    'mediaFiles',
    'groups',
    'activeGroupId',
    'selectedCampaignGroupIds',
    'contactFilterQuery'
], window);

const navActive = 'text-secondary font-bold border-b-2 border-secondary py-1 text-sm font-headline tracking-wide';
const navInactive = 'text-slate-500 font-medium hover:bg-slate-100 transition-colors px-3 py-1 rounded-lg text-sm';

function setPanelConnectionError(message) {
    const btn = document.getElementById('send-btn');
    const indicator = document.getElementById('conn-indicator');
    const txt = document.getElementById('qr-status-text');
    const badge = document.getElementById('status-badge');
    const detail = document.getElementById('connection-detail');
    indicator.className = 'w-2 h-2 rounded-full bg-error mr-2';
    txt.innerText = message;
    badge.innerText = 'BAĞLANTI HATASI';
    badge.className = 'text-error font-bold text-xs uppercase';
    if (detail) {
        detail.innerText = 'Sunucu bağlantısı yok';
        detail.className = 'text-xs font-bold text-error';
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined text-lg">error</span> SUNUCU BAĞLANTISI YOK';
}

function unwrapApiPayload(payload) {
    return window.WhasAppCApi.unwrapApiPayload(payload);
}

function apiErrorMessage(payload, fallback) {
    return window.WhasAppCApi.apiErrorMessage(payload, fallback);
}

function apiMeta(payload) {
    return window.WhasAppCApi.apiMeta(payload);
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
    return window.WhasAppCApi.fetchJson(url, options, timeoutMs);
}

async function fetchApiEnvelope(url, options = {}, timeoutMs = 8000) {
    return window.WhasAppCApi.fetchEnvelope(url, options, timeoutMs);
}

function releaseRevision(versionData = {}) {
    const version = versionData.version || '0.0.0';
    const revision = versionData.frontend_revision || versionData.frontendRevision;
    if (revision) return revision;
    return `${version}-${versionData.commit || 'unknown'}`;
}

function renderVersion(versionData = {}) {
    const element = document.getElementById('sys-version');
    if (!element) return;
    const version = versionData.version || '0.0.0';
    const shortCommit = versionData.short_commit || String(versionData.commit || '').slice(0, 7);
    element.innerText = shortCommit && shortCommit !== 'unknown'
        ? `v${version} · ${shortCommit}`
        : `v${version}`;
}

async function fetchVersion() {
    return fetchJson(`${API_BASE}/version`, {}, 5000);
}

async function initReleaseVersion() {
    const versionData = await fetchVersion().catch(() => ({ version: '0.0.0', commit: 'unknown' }));
    currentFrontendRevision = releaseRevision(versionData);
    renderVersion(versionData);
}

function showReleaseUpdate(versionData = {}) {
    const banner = document.getElementById('release-update-banner');
    const text = document.getElementById('release-update-text');
    if (!banner) return;
    if (text) text.innerText = `Yeni sürüm yayında: v${versionData.version || '0.0.0'}`;
    banner.classList.remove('hidden');
}

function startReleaseWatcher() {
    if (releaseWatcherTimer) clearInterval(releaseWatcherTimer);
    releaseWatcherTimer = setInterval(async () => {
        try {
            const versionData = await fetchVersion();
            const nextRevision = releaseRevision(versionData);
            if (currentFrontendRevision && nextRevision !== currentFrontendRevision) {
                showReleaseUpdate(versionData);
                clearInterval(releaseWatcherTimer);
                releaseWatcherTimer = null;
            }
        } catch (err) {
            console.warn('Sürüm kontrolü yapılamadı', err);
        }
    }, 60000);
}

function setActionButton(id, visible) {
    const button = document.getElementById(id);
    if (!button) return;
    button.classList.toggle('hidden', !visible);
    button.classList.toggle('flex', visible);
}

function getActiveCampaignId() {
    return appState.get('activeCampaignId');
}

function setActiveCampaignId(campaignId) {
    appState.set('activeCampaignId', campaignId || null);
}

function setCampaignControls(status) {
    const running = ['running', 'sending'].includes(status);
    const resumable = ['paused', 'stopped'].includes(status);
    const retryable = ['paused', 'stopped', 'completed'].includes(status);
    const finishable = ['queued', 'running', 'sending', 'paused', 'stopped', 'completed'].includes(status);
    setActionButton('send-btn', !running);
    setActionButton('stop-btn', running);
    setActionButton('resume-btn', resumable && !!getActiveCampaignId());
    setActionButton('retry-btn', retryable && !!getActiveCampaignId());
    setActionButton('retry-skipped-btn', retryable && !!getActiveCampaignId());
    setActionButton('finish-campaign-btn', finishable && !!getActiveCampaignId());
}

function formatEstimateMinutes(minutes) {
    const value = Number(minutes || 0);
    if (!Number.isFinite(value) || value <= 0) return 'TAHMİN: --';
    if (value < 60) return `TAHMİN: ${Math.ceil(value)} DK`;
    const hours = Math.floor(value / 60);
    const rest = Math.ceil(value % 60);
    return rest > 0 ? `TAHMİN: ${hours} SA ${rest} DK` : `TAHMİN: ${hours} SA`;
}

function estimateMinutesForContacts(total) {
    const count = Math.max(0, Number(total || 0));
    if (count === 0) return 0;
    const minDelay = Number.parseInt(document.getElementById('min-delay')?.value || '20', 10);
    const maxDelay = Number.parseInt(document.getElementById('max-delay')?.value || '90', 10);
    const averageDelay = ((Number.isFinite(minDelay) ? minDelay : 20) + (Number.isFinite(maxDelay) ? maxDelay : 90)) / 2;
    const batchPauseSeconds = Math.floor(Math.max(0, count - 1) / 50) * 15 * 60;
    const longPauseSeconds = Math.floor(Math.max(0, count - 1) / 250) * 65 * 60;
    return Math.max(1, Math.ceil(((count * (averageDelay + 3)) + batchPauseSeconds + longPauseSeconds) / 60));
}

function updateCampaignEstimate(minutes) {
    const element = document.getElementById('prog-eta');
    if (element) element.innerText = formatEstimateMinutes(minutes);
}

function numericCount(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.innerText = value;
}

function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDurationWords(ms) {
    const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours} saat ${minutes} dakika`;
    if (hours > 0) return `${hours} saat`;
    return `${Math.max(1, minutes)} dakika`;
}

function futureDeadline(value) {
    const timestamp = new Date(value || '').getTime();
    return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
}

function campaignStateMessage(data = {}) {
    const sent = numericCount(data.sent ?? data.sent_count, 0);
    const dailyLimit = numericCount(data.daily_limit ?? data.dailyLimit, 0);
    const error = String(data.error || '').trim();
    if (data.pause_reason === 'daily_limit' || error.toLocaleLowerCase('tr-TR').includes('günlük limit')) {
        return dailyLimit > 0
            ? `Günlük limit doldu (${sent}/${dailyLimit})`
            : 'Günlük limit doldu';
    }
    if (error) return error;
    return '';
}

function updateInterMessageCountdown(untilIso) {
    const element = document.getElementById('prog-next-delay');
    if (!element) return;
    const countElement = document.getElementById('prog-count');
    if (interMessageCountdownTimer) {
        clearInterval(interMessageCountdownTimer);
        interMessageCountdownTimer = null;
    }

    if (!untilIso) {
        element.innerText = 'BEKLEME: --';
        if (countElement?.dataset.liveCountdown === 'wait') delete countElement.dataset.liveCountdown;
        return;
    }

    const until = new Date(untilIso).getTime();
    if (!Number.isFinite(until)) {
        element.innerText = 'BEKLEME: --';
        return;
    }

    const render = () => {
        const remainingMs = until - Date.now();
        if (remainingMs <= 0) {
            element.innerText = 'BEKLEME: 0:00';
            if (countElement) countElement.innerText = 'Sonraki gönderim: 0:00';
            clearInterval(interMessageCountdownTimer);
            interMessageCountdownTimer = null;
            return;
        }
        const formatted = formatCountdown(remainingMs);
        element.innerText = `BEKLEME: ${formatted}`;
        if (countElement) {
            countElement.dataset.liveCountdown = 'wait';
            countElement.innerText = `Sonraki gönderim: ${formatted}`;
        }
    };

    render();
    interMessageCountdownTimer = setInterval(render, 1000);
}

function updateRecipientDisplay(data = {}) {
    const hasCurrent = Object.prototype.hasOwnProperty.call(data, 'current_recipient_name');
    const hasLast = Object.prototype.hasOwnProperty.call(data, 'last_recipient_name');
    const currentName = String(data.current_recipient_name || '').trim();
    const lastName = String(data.last_recipient_name || '').trim();
    const element = document.getElementById('prog-last-recipient');
    if (!element) return;
    if (currentName) {
        element.innerText = `GÖNDERİLİYOR: ${currentName}`;
        return;
    }
    if (lastName) {
        element.innerText = `SON GÖNDERİLEN: ${lastName}`;
        return;
    }
    if (hasCurrent || hasLast) {
        element.innerText = 'SON GÖNDERİLEN: --';
    }
}

function renderCampaignProgress(data = {}) {
    const total = numericCount(data.total ?? data.total_count, 0);
    const processed = numericCount(data.processed, 0);
    const sent = numericCount(data.sent ?? data.sent_count, 0);
    const failed = numericCount(data.failed ?? data.failed_count, 0);
    const skipped = numericCount(data.skipped ?? data.skipped_count, 0);
    const validationUnknown = numericCount(data.validation_unknown ?? data.validation_unknown_count, 0);
    const rawProgress = data.progress !== undefined
        ? numericCount(data.progress, 0)
        : (total > 0 ? (processed / total) * 100 : 0);
    const pct = Math.max(0, Math.min(100, Math.round(rawProgress)));

    document.getElementById('prog-box')?.classList.remove('hidden');
    const bar = document.getElementById('prog-bar');
    if (bar) bar.style.width = `${pct}%`;
    setText('prog-text', `${pct}%`);
    setText('prog-total', `TOPLAM: ${total}`);
    setText('prog-sent', `BAŞARILI: ${sent}`);
    setText('prog-failed', `HATALI: ${failed}`);
    setText('prog-skipped', `ATLANDI: ${skipped}`);
    setText('prog-validation', `BELİRSİZ: ${validationUnknown}`);

    const countElement = document.getElementById('prog-count');
    const waitDeadline = futureDeadline(data.wait_until);
    const pauseReason = data.pause_reason || (data.long_pause_until ? 'long_pause' : (data.night_pause_until ? 'night_pause' : (data.batch_pause_until ? 'batch_pause' : null)));
    const batchPauseDeadline = futureDeadline(data.batch_pause_until || data.long_pause_until || data.night_pause_until || data.pause_until);
    const stateMessage = campaignStateMessage(data);
    if (countElement) delete countElement.dataset.liveCountdown;
    if (data.phase === 'sending' && data.current_recipient_name) {
        setText('prog-count', `Gönderiliyor: ${data.current_recipient_name}`);
    } else if (stateMessage) {
        setText('prog-count', stateMessage);
    } else if (['batch_pause', 'long_pause', 'night_pause'].includes(data.phase) || batchPauseDeadline) {
        if (countElement) countElement.dataset.liveCountdown = 'batch_pause';
        setText('prog-count', `${processed}/${total} kişi işlendi`);
    } else if (data.phase === 'inter_message_wait' || waitDeadline) {
        if (countElement) countElement.dataset.liveCountdown = 'wait';
        setText('prog-count', `${processed}/${total} kişi işlendi`);
    } else if (data.status && data.status !== 'running') {
        setText('prog-count', `Son durum: ${STATUS_LABELS[data.status] || data.status}`);
    } else {
        setText('prog-count', `${processed}/${total} kişi işlendi`);
    }

    if (data.estimate_remaining_minutes !== undefined) updateCampaignEstimate(data.estimate_remaining_minutes);
    if (data.pause_until !== undefined) updateBatchPauseCountdown(data.pause_until, pauseReason);
    if (data.batch_pause_until !== undefined) updateBatchPauseCountdown(data.batch_pause_until, 'batch_pause');
    if (data.long_pause_until !== undefined) updateBatchPauseCountdown(data.long_pause_until, 'long_pause');
    if (data.night_pause_until !== undefined) updateBatchPauseCountdown(data.night_pause_until, 'night_pause');
    if (data.wait_until !== undefined) updateInterMessageCountdown(data.wait_until);
    updateRecipientDisplay(data);
}

function updateBatchPauseCountdown(untilIso, reason = 'batch_pause') {
    const element = document.getElementById('prog-batch-pause');
    if (!element) return;
    const countElement = document.getElementById('prog-count');
    if (batchPauseCountdownTimer) {
        clearInterval(batchPauseCountdownTimer);
        batchPauseCountdownTimer = null;
    }

    if (!untilIso) {
        element.innerText = 'MOLA: --';
        if (countElement?.dataset.liveCountdown === 'batch_pause') delete countElement.dataset.liveCountdown;
        return;
    }

    const until = new Date(untilIso).getTime();
    if (!Number.isFinite(until)) {
        element.innerText = 'MOLA: --';
        if (countElement?.dataset.liveCountdown === 'batch_pause') delete countElement.dataset.liveCountdown;
        return;
    }

    const render = () => {
        const remainingMs = until - Date.now();
        if (remainingMs <= 0) {
            element.innerText = 'MOLA: devam ediyor';
            if (countElement) {
                countElement.innerText = 'Mola süresi doldu, gönderim devam ediyor...';
                delete countElement.dataset.liveCountdown;
            }
            clearInterval(batchPauseCountdownTimer);
            batchPauseCountdownTimer = null;
            return;
        }
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
        const remainingWords = formatDurationWords(remainingMs);
        let message = `${remainingMinutes} dk sonra devam edecek`;
        let countMessage = `Zorunlu mola: ${message}`;
        if (reason === 'long_pause') {
            message = `65 dk bekleme sınırına geldiniz. Kalan: ${remainingWords}`;
            countMessage = `65 dk bekleme sınırına geldiniz. ${remainingWords} kaldı`;
        } else if (reason === 'night_pause') {
            message = `Günlük gönderim başlama saatine ${remainingWords} kaldı`;
            countMessage = message;
        }
        element.innerText = `MOLA: ${message} (${formatCountdown(remainingMs)})`;
        if (countElement) {
            countElement.dataset.liveCountdown = 'batch_pause';
            countElement.innerText = countMessage;
        }
    };

    render();
    batchPauseCountdownTimer = setInterval(render, 1000);
}

async function logout() {
    const button = document.getElementById('logout-btn');
    const label = document.getElementById('logout-label');
    const icon = document.getElementById('logout-icon');
    if (button) button.disabled = true;
    if (label) label.innerText = 'Çıkılıyor';
    if (icon) {
        icon.innerText = 'progress_activity';
        icon.classList.add('animate-spin');
    }

    try {
        const response = await fetch(`${API_BASE}/logout`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(data, 'Çıkış yapılamadı'));
        window.location.replace('/login.html');
    } catch (err) {
        showToast(err.message || 'Çıkış yapılamadı', 'error');
        if (button) button.disabled = false;
        if (label) label.innerText = 'Çıkış';
        if (icon) {
            icon.innerText = 'logout';
            icon.classList.remove('animate-spin');
        }
    }
}

function setWhatsAppUiStatus(status, detail = '') {
    const btn = document.getElementById('send-btn');
    const indicator = document.getElementById('conn-indicator');
    const txt = document.getElementById('qr-status-text');
    const badge = document.getElementById('status-badge');
    const connectionDetail = document.getElementById('connection-detail');
    const qrCanvas = document.getElementById('qr-canvas');
    const qrLoading = document.getElementById('qr-loading');
    const connectedCheck = document.getElementById('connected-check');

    if (status === 'connected') {
        indicator.className = 'w-2 h-2 rounded-full bg-secondary animate-pulse mr-2';
        txt.innerText = 'WhatsApp Connection';
        badge.innerText = 'CONNECTED';
        badge.className = 'text-secondary font-bold text-xs uppercase';
        if (connectionDetail) {
            connectionDetail.innerText = 'Ready to Send';
            connectionDetail.className = 'text-xs font-bold text-secondary';
        }
        qrCanvas.classList.add('hidden');
        qrLoading.classList.add('hidden');
        connectedCheck.classList.remove('hidden');
        connectedCheck.classList.add('flex');
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined text-lg" style="font-variation-settings: \'FILL\' 1;">play_arrow</span> BAŞLAT';
        return;
    }

    indicator.className = 'w-2 h-2 rounded-full bg-slate-400 animate-pulse mr-2';
    txt.innerText = detail || 'BAĞLI DEĞİL';
    badge.innerText = detail === 'QR BEKLENİYOR' ? 'QR BEKLENİYOR' : 'BAĞLI DEĞİL';
    badge.className = 'text-slate-500 font-bold text-xs uppercase';
    if (connectionDetail) {
        connectionDetail.innerText = detail === 'QR BEKLENİYOR' ? 'QR okutulmalı' : 'WhatsApp bağlı değil';
        connectionDetail.className = 'text-xs font-bold text-slate-500';
    }
    connectedCheck.classList.add('hidden');
    connectedCheck.classList.remove('flex');
    if (detail !== 'QR BEKLENİYOR') qrLoading.classList.remove('hidden');
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-lg">qr_code_2</span> ${detail === 'QR BEKLENİYOR' ? 'QR OKUTUN' : 'WHATSAPP BAĞLI DEĞİL'}`;
}

async function refreshRuntimeStatus() {
    try {
        const status = await fetchJson(`${API_BASE}/runtime-status`, {}, 5000);
        if (status.whatsapp === 'connected') {
            setWhatsAppUiStatus('connected');
        } else if (status.whatsapp === 'qr') {
            setWhatsAppUiStatus('disconnected', 'QR BEKLENİYOR');
        } else {
            setWhatsAppUiStatus('disconnected', 'BAĞLI DEĞİL');
        }
    } catch (err) {
        console.error('Runtime durumu alınamadı', err);
    }
}

function normalizePhone(phone) {
    let raw = String(phone || '').trim();
    if (/[eE][+-]?\d+/.test(raw)) return '';
    raw = raw.replace(/\.0+$/, '');
    let digits = raw.replace(/[^\d]/g, '');
    if (digits.startsWith('0090')) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith('5')) digits = `90${digits}`;
    if (digits.length === 11 && digits.startsWith('05')) digits = `90${digits.slice(1)}`;
    return digits;
}

function dedupeContacts(list) {
    const unique = [];
    const seen = new Set();
    for (const item of list || []) {
        const phone = normalizePhone(item?.phone);
        if (phone.length < 10 || seen.has(phone)) continue;
        seen.add(phone);
        const normalized = {
            name: String(item?.name || '').trim(),
            surname: String(item?.surname || '').trim(),
            phone
        };
        if (item?.id !== undefined && item?.id !== null) normalized.id = item.id;
        if (item?.group_id) normalized.group_id = item.group_id;
        if (item?.normalized_phone) normalized.normalized_phone = item.normalized_phone;
        if (item?.created_at) normalized.created_at = item.created_at;
        if (item?.updated_at) normalized.updated_at = item.updated_at;
        unique.push(normalized);
    }
    return unique;
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function getInitials(contact) {
    const full = `${contact?.name || ''} ${contact?.surname || ''}`.trim() || 'Kişi';
    return full.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toLocaleUpperCase('tr-TR');
}

function formatDate(value) {
    if (!value) return 'Kayıtlı grup';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Kayıtlı grup';
    return `Oluşturma: ${date.toLocaleDateString('tr-TR')}`;
}

function getManualCampaignContacts() {
    const input = document.getElementById('manual-campaign-numbers');
    if (!input) return [];
    return dedupeContacts(input.value.split(',').map(phone => ({ phone })));
}

function getGroupContactCount(group) {
    return Number(group?.contact_count ?? group?.contacts?.length ?? 0);
}

function getGroupSendableCount(group) {
    if (group?.sendable_count !== undefined && group?.sendable_count !== null) {
        return Number(group.sendable_count || 0);
    }
    const contacts = Array.isArray(group?.contacts) ? group.contacts : [];
    if (contacts.length > 0) {
        return contacts.filter(contact => !isSuppressedPhone(contact.phone)).length;
    }
    return getGroupContactCount(group);
}

function formatGroupCount(group) {
    return `${getGroupContactCount(group)} kişi / ${getGroupSendableCount(group)} gönderilebilir`;
}

function getCurrentContactSummaryLabel() {
    const activeGroup = groups.find(group => group.id === activeGroupId);
    const total = currentContacts.length;
    const sendable = activeGroup
        ? getGroupSendableCount(activeGroup)
        : currentContacts.filter(contact => !isSuppressedPhone(contact.phone)).length;
    return `${total} kişi / ${sendable} gönderilebilir`;
}

async function loadGroupContacts(groupId, options = {}) {
    const params = new URLSearchParams({
        limit: String(options.limit || 500),
        offset: String(options.offset || 0),
        sort: options.sort || 'id',
        direction: options.direction || 'asc'
    });
    if (options.search) params.set('search', options.search);

    const envelope = await fetchApiEnvelope(`${API_BASE}/groups/${encodeURIComponent(groupId)}/contacts?${params.toString()}`, {}, 12000);
    return {
        contacts: dedupeContacts(envelope.data || []),
        pagination: envelope.meta.pagination || { total: 0, has_more: false, next_offset: null }
    };
}

async function ensureGroupContactsLoaded(groupId) {
    const group = groups.find(item => item.id === groupId);
    if (!group) return [];
    if (group.contactsLoaded) return group.contacts || [];

    const allContacts = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
        const page = await loadGroupContacts(groupId, { limit: 500, offset });
        allContacts.push(...page.contacts);
        hasMore = !!page.pagination.has_more;
        offset = page.pagination.next_offset || allContacts.length;
    }

    group.contacts = dedupeContacts(allContacts);
    group.contactsLoaded = true;
    group.contact_count = group.contacts.length;
    if (group.sendable_count === undefined || group.sendable_count === null) {
        group.sendable_count = group.contacts.filter(contact => !isSuppressedPhone(contact.phone)).length;
    }
    return group.contacts;
}

async function getSelectedCampaignContacts() {
    try {
        await loadSuppressedRecipients();
    } catch (err) {
        console.warn('Gönderim dışı liste yüklenemedi:', err);
    }
    const selectedGroups = groups.filter(group => selectedCampaignGroupIds.has(group.id));
    await Promise.all(selectedGroups.map(group => ensureGroupContactsLoaded(group.id)));
    const groupContacts = selectedGroups.flatMap(group => group.contacts || []);
    return dedupeContacts([...groupContacts, ...getManualCampaignContacts()])
        .filter(contact => !isSuppressedPhone(contact.phone));
}

function setSuppressedRecipients(recipients = []) {
    suppressedRecipients = Array.isArray(recipients) ? recipients : [];
    suppressedPhoneSet = new Set(
        suppressedRecipients
            .filter(item => item?.active !== false)
            .map(item => normalizePhone(item.normalized_phone || item.phone))
            .filter(Boolean)
    );
    selectedContactPhones = new Set([...selectedContactPhones].filter(phone => !suppressedPhoneSet.has(phone)));
}

async function loadSuppressedRecipients(options = {}) {
    if (suppressedRecipientsLoaded && !options.force) return suppressedRecipients;
    const params = new URLSearchParams({
        limit: String(options.limit || 1000),
        offset: String(options.offset || 0)
    });
    const data = await fetchJson(`${API_BASE}/suppressed-recipients?${params.toString()}`, {}, 12000);
    setSuppressedRecipients(data?.recipients || []);
    suppressedRecipientsLoaded = true;
    return suppressedRecipients;
}

function isSuppressedPhone(phone) {
    return suppressedPhoneSet.has(normalizePhone(phone));
}

function selectableVisiblePhones() {
    const list = contactFilterQuery ? visibleContacts : currentContacts;
    return list
        .map(contact => normalizePhone(contact.phone))
        .filter(phone => phone && !suppressedPhoneSet.has(phone));
}

function selectedContactsForSuppression() {
    return currentContacts.filter(contact => {
        const phone = normalizePhone(contact.phone);
        return phone && selectedContactPhones.has(phone) && !suppressedPhoneSet.has(phone);
    });
}

function updateSuppressionControls() {
    const selectedCount = selectedContactsForSuppression().length;
    const button = document.getElementById('suppress-selected-btn');
    if (button) {
        button.disabled = selectedCount === 0;
        button.classList.toggle('opacity-50', selectedCount === 0);
        button.classList.toggle('cursor-not-allowed', selectedCount === 0);
        const label = button.querySelector('[data-role="label"]');
        if (label) label.textContent = selectedCount > 0 ? `Gönderimden Çıkar (${selectedCount})` : 'Gönderimden Çıkar';
    }

    const selectAll = document.getElementById('contacts-select-all');
    if (selectAll) {
        const phones = selectableVisiblePhones();
        const selectedVisible = phones.filter(phone => selectedContactPhones.has(phone));
        selectAll.checked = phones.length > 0 && selectedVisible.length === phones.length;
        selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < phones.length;
        selectAll.disabled = phones.length === 0;
    }
}

function toggleContactSelection(phone, checked) {
    const normalized = normalizePhone(phone);
    if (!normalized || suppressedPhoneSet.has(normalized)) return;
    if (checked) selectedContactPhones.add(normalized);
    else selectedContactPhones.delete(normalized);
    updateSuppressionControls();
}

function toggleVisibleContactSelection(checked) {
    selectableVisiblePhones().forEach(phone => {
        if (checked) selectedContactPhones.add(phone);
        else selectedContactPhones.delete(phone);
    });
    updateContactsTable();
}

async function suppressContacts(contacts, reason = 'Manuel olarak gönderim dışı bırakıldı') {
    const normalizedContacts = dedupeContacts(contacts || []).filter(contact => !isSuppressedPhone(contact.phone));
    if (normalizedContacts.length === 0) return;
    try {
        await fetchJson(`${API_BASE}/suppressed-recipients`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contacts: normalizedContacts,
                reason
            })
        }, 12000);
        selectedContactPhones = new Set();
        await loadSuppressedRecipients({ force: true });
        await loadGroups();
        updateContactsTable();
        updateCampaignTargetSummary();
        showToast(`${normalizedContacts.length} numara gönderim dışı bırakıldı`, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function suppressSelectedContacts() {
    suppressContacts(selectedContactsForSuppression());
}

async function unsuppressPhones(phones = []) {
    const normalizedPhones = Array.from(new Set((phones || []).map(normalizePhone).filter(Boolean)));
    if (normalizedPhones.length === 0) return;
    try {
        await fetchJson(`${API_BASE}/suppressed-recipients/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phones: normalizedPhones })
        }, 12000);
        await loadSuppressedRecipients({ force: true });
        await loadGroups();
        updateContactsTable();
        updateCampaignTargetSummary();
        showToast('Numara tekrar gönderime alındı', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function updateCampaignTargetSummary() {
    const selectedGroupsTotal = groups
        .filter(group => selectedCampaignGroupIds.has(group.id))
        .reduce((sum, group) => sum + getGroupSendableCount(group), 0);
    const total = selectedGroupsTotal + getManualCampaignContacts().length;
    const selectedCount = selectedCampaignGroupIds.size;
    const countEl = document.getElementById('campaign-selected-count');
    if (countEl) countEl.innerText = `Toplam ${total} numara seçildi`;

    const manualCountEl = document.getElementById('manual-campaign-count');
    if (manualCountEl) {
        const manualCount = getManualCampaignContacts().length;
        manualCountEl.innerText = `Virgül ile ayırın. ${manualCount} manuel numara hazır. ${selectedCount} grup seçili.`;
    }
    const totalEl = document.getElementById('prog-total');
    if (totalEl) totalEl.innerText = `TOPLAM: ${total}`;
    updateCampaignEstimate(estimateMinutesForContacts(total));
}

function toggleCampaignGroup(groupId, checked) {
    if (checked) selectedCampaignGroupIds.add(groupId);
    else selectedCampaignGroupIds.delete(groupId);
    renderCampaignGroupChecklist();
}

function renderCampaignGroupChecklist() {
    const container = document.getElementById('campaign-group-list');
    if (!container) return;

    selectedCampaignGroupIds = new Set([...selectedCampaignGroupIds].filter(id => groups.some(group => group.id === id)));

    if (groups.length === 0) {
        container.innerHTML = '<div class="p-4 rounded-lg bg-surface-container-low text-[10px] font-bold text-slate-400 uppercase tracking-widest">Henüz kayıtlı grup yok</div>';
        updateCampaignTargetSummary();
        return;
    }

    container.innerHTML = groups.map(group => {
        const countLabel = formatGroupCount(group);
        const checked = selectedCampaignGroupIds.has(group.id);
        return `
            <label class="flex items-center justify-between p-3 rounded-lg border ${checked ? 'bg-secondary/5 border-secondary/20' : 'border-transparent hover:bg-slate-50 hover:border-slate-100'} transition-all cursor-pointer">
                <div class="flex items-center gap-3 min-w-0">
                    <input class="rounded border-slate-300 text-secondary focus:ring-secondary" type="checkbox" data-action="toggle-campaign-group" data-group-id="${escapeHtml(group.id)}" ${checked ? 'checked' : ''}>
                    <span class="text-sm font-medium text-slate-700 truncate" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
                </div>
                <span class="text-xs text-slate-400 font-bold whitespace-nowrap">${escapeHtml(countLabel)}</span>
            </label>
        `;
    }).join('');
    updateCampaignTargetSummary();
}

function updateManualCampaignCount() {
    updateCampaignTargetSummary();
}

function saveUnsavedContactsDraft() {
    try {
        if (activeGroupId || currentContacts.length === 0) {
            localStorage.removeItem(unsavedContactsDraftKey);
            return;
        }

        localStorage.setItem(unsavedContactsDraftKey, JSON.stringify({
            savedAt: new Date().toISOString(),
            contacts: dedupeContacts(currentContacts)
        }));
    } catch (err) {
        console.warn('Kaydedilmemiş kişi taslağı saklanamadı:', err);
    }
}

function clearUnsavedContactsDraft() {
    try {
        localStorage.removeItem(unsavedContactsDraftKey);
    } catch (err) {
        console.warn('Kaydedilmemiş kişi taslağı temizlenemedi:', err);
    }
}

function restoreUnsavedContactsDraft() {
    if (activeGroupId || currentContacts.length > 0) return false;

    try {
        const draft = JSON.parse(localStorage.getItem(unsavedContactsDraftKey) || 'null');
        const draftContacts = dedupeContacts(draft?.contacts || []);
        if (draftContacts.length === 0) {
            clearUnsavedContactsDraft();
            return false;
        }

        currentContacts = draftContacts;
        visibleContacts = currentContacts;
        document.getElementById('active-group-name').innerText = 'Kaydedilmemiş Liste';
        updateContactsTable();
        showToast('Kaydedilmemiş liste geri yüklendi. Kalıcı olması için grup adı verip kaydedin.', 'info');
        return true;
    } catch {
        clearUnsavedContactsDraft();
        return false;
    }
}

function handleManualNumbersInput(input) {
    const cleaned = input.value.replace(/[^\d,]/g, '').replace(/,{2,}/g, ',');
    if (input.value !== cleaned) {
        const cursorPosition = input.selectionStart;
        input.value = cleaned;
        input.setSelectionRange(Math.max(cursorPosition - 1, 0), Math.max(cursorPosition - 1, 0));
    }
    updateManualCampaignCount();
}

function switchTab(tab) {
    document.getElementById('view-campaign').classList.toggle('hidden', tab !== 'campaign');
    document.getElementById('view-contacts').classList.toggle('hidden', tab !== 'contacts');
    document.getElementById('view-users').classList.toggle('hidden', tab !== 'users');
    document.getElementById('view-reports').classList.toggle('hidden', tab !== 'reports');

    document.getElementById('tab-campaign').className = tab === 'campaign' ? navActive : navInactive;
    document.getElementById('tab-contacts').className = tab === 'contacts' ? navActive : navInactive;
    document.getElementById('tab-reports').className = tab === 'reports' ? navActive : navInactive;

    const tabUsers = document.getElementById('tab-users');
    if (tabUsers && !tabUsers.classList.contains('hidden')) {
        tabUsers.className = tab === 'users' ? navActive : navInactive;
    }

    document.getElementById('mobile-tab-campaign').className = tab === 'campaign' ? 'flex flex-col items-center justify-center text-secondary p-2' : 'flex flex-col items-center justify-center text-slate-400 p-2 opacity-60';
    document.getElementById('mobile-tab-contacts').className = tab === 'contacts' ? 'flex flex-col items-center justify-center text-secondary p-2' : 'flex flex-col items-center justify-center text-slate-400 p-2 opacity-60';
    const mobileTabReports = document.getElementById('mobile-tab-reports');
    if (mobileTabReports) mobileTabReports.className = tab === 'reports' ? 'flex flex-col items-center justify-center text-secondary p-2' : 'flex flex-col items-center justify-center text-slate-400 p-2 opacity-60';

    if (tab === 'contacts') {
        loadSuppressedRecipients()
            .then(updateContactsTable)
            .catch(err => {
                console.warn('Gönderim dışı liste yüklenemedi:', err);
                updateContactsTable();
            });
    }
    if (tab === 'users') loadUsers();
    if (tab === 'reports') loadReports();
}


function normalizeCampaignDetailedReport(reportOrSkipped = []) {
    if (Array.isArray(reportOrSkipped)) {
        return {
            unsent_recipients: reportOrSkipped.map(item => ({
                phone: item.phone || '',
                name: item.name || '',
                surname: item.surname || '',
                status: item.status || 'failed',
                attempt_count: Number(item.attempt_count || 0),
                last_error: item.reason || item.last_error || ''
            })),
            unavailable_recipients: [],
            sent_recipients: []
        };
    }
    const report = reportOrSkipped || {};
    return {
        ...report,
        unsent_recipients: Array.isArray(report.unsent_recipients) ? report.unsent_recipients : [],
        unavailable_recipients: Array.isArray(report.unavailable_recipients) ? report.unavailable_recipients : [],
        sent_recipients: Array.isArray(report.sent_recipients) ? report.sent_recipients : []
    };
}

function renderCampaignReportRows(tbodyId, rows = [], columns = []) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${columns.length}" class="px-3 py-8 text-center text-slate-400 font-bold uppercase tracking-wider">Kayıt yok</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(row => `
        <tr class="hover:bg-white/70">
            ${columns.map(column => column(row)).join('')}
        </tr>
    `).join('');
}

function renderCampaignDetailedReport(report, options = {}) {
    const detail = document.getElementById('campaign-detailed-report');
    if (!detail) return;
    const unsent = report.unsent_recipients || [];
    const unavailable = report.unavailable_recipients || [];
    const sent = report.sent_recipients || [];
    const shouldShow = options.forceDetailed || unsent.length > 0 || unavailable.length > 0 || sent.length > 0;
    detail.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;

    const nameCell = row => `<td class="px-3 py-2 text-slate-700 max-w-[140px] truncate" title="${escapeHtml(recipientDisplayNameFromRow(row))}">${escapeHtml(recipientDisplayNameFromRow(row))}</td>`;
    const phoneCell = row => `<td class="px-3 py-2 text-slate-600 font-mono whitespace-nowrap">${escapeHtml(String(row.phone || row.normalized_phone || ''))}</td>`;
    const attemptsCell = row => `<td class="px-3 py-2 text-center font-black text-slate-700">${Number(row.attempt_count || 0)}</td>`;

    renderCampaignReportRows('campaign-unsent-tbody', unsent, [
        nameCell,
        phoneCell,
        attemptsCell
    ]);
    renderCampaignReportRows('campaign-unavailable-tbody', unavailable, [
        nameCell,
        phoneCell,
        row => `<td class="px-3 py-2 text-slate-500 max-w-[140px] truncate" title="${escapeHtml(row.last_error || 'WhatsApp kullanıcısı değil')}">${escapeHtml(errorPreview(row.last_error || 'WhatsApp kullanıcısı değil', 70))}</td>`
    ]);
    renderCampaignReportRows('campaign-sent-tbody', sent, [
        nameCell,
        phoneCell,
        attemptsCell
    ]);

    setText('campaign-unsent-count', `${unsent.length} kayıt`);
    setText('campaign-unavailable-count', `${unavailable.length} kayıt`);
    setText('campaign-sent-count', `${sent.length} kayıt`);

    const unsentBtn = document.getElementById('campaign-block-unsent-btn');
    const unavailableBtn = document.getElementById('campaign-block-unavailable-btn');
    if (unsentBtn) {
        unsentBtn.disabled = unsent.length === 0;
        unsentBtn.onclick = () => suppressCampaignReportRecipients('unsent');
    }
    if (unavailableBtn) {
        unavailableBtn.disabled = unavailable.length === 0;
        unavailableBtn.onclick = () => suppressCampaignReportRecipients('unavailable');
    }
    const downloadBtn = document.getElementById('campaign-report-download-btn');
    if (downloadBtn) downloadBtn.onclick = () => downloadCampaignReportCSV(report);
}

function showCampaignCompleteModal(reportOrSkipped = [], summary = '', options = {}) {
    const summaryEl = document.getElementById('campaign-complete-summary');
    if (summaryEl && summary) summaryEl.textContent = summary;
    const titleEl = document.getElementById('campaign-complete-title');
    if (titleEl) titleEl.textContent = options.title || 'Gönderiler tamamlandı';
    const report = normalizeCampaignDetailedReport(reportOrSkipped);
    lastCampaignDetailedReport = report;
    renderCampaignDetailedReport(report, { forceDetailed: !!options.forceDetailed });

    document.getElementById('campaign-complete-modal').classList.remove('hidden');
    document.getElementById('campaign-complete-modal').classList.add('flex');
}

function campaignReportCsvRows(report) {
    const rows = [];
    const pushRows = (listName, items, reasonGetter = row => row.last_error || '') => {
        (items || []).forEach(row => {
            rows.push([
                listName,
                recipientDisplayNameFromRow(row),
                row.phone || row.normalized_phone || '',
                RECIPIENT_STATUS_LABELS[row.status] || row.status || '',
                String(Number(row.attempt_count || 0)),
                reasonGetter(row)
            ]);
        });
    };
    pushRows('Mesaj Ulaşmayanlar', report.unsent_recipients);
    pushRows('WhatsApp Kullanmayanlar', report.unavailable_recipients, row => row.last_error || 'WhatsApp kullanıcısı değil');
    pushRows('Başarılı Gönderimler', report.sent_recipients, () => '');
    return rows;
}

function downloadCampaignReportCSV(report) {
    const header = ['Liste', 'Ad Soyad', 'Numara', 'Durum', 'Deneme', 'Sebep'];
    const rows = campaignReportCsvRows(report).map(row => row.map(value => (
        `"${String(value || '').replace(/"/g, '""')}"`
    )).join(','));
    const csv = '\ufeff' + [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kampanya_raporu_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

async function suppressCampaignReportRecipients(type) {
    const report = lastCampaignDetailedReport || {};
    const rows = type === 'unavailable'
        ? report.unavailable_recipients || []
        : report.unsent_recipients || [];
    const contacts = dedupeContacts(rows.map(row => ({
        phone: row.phone || row.normalized_phone,
        name: row.name || '',
        surname: row.surname || ''
    })));
    if (contacts.length === 0) return showToast('Engellenecek numara yok', 'info');
    const confirmed = window.confirm(`${contacts.length} numara tüm rehberlerde gönderim dışı bırakılacak. Devam edilsin mi?`);
    if (!confirmed) return;
    await suppressContacts(
        contacts,
        type === 'unavailable'
            ? 'Kampanya raporundan WhatsApp kullanmayanlar engellendi'
            : 'Kampanya raporundan mesaj ulaşmayanlar engellendi'
    );
}

function downloadSkippedReportCSV(report) {
    const normalized = normalizeCampaignDetailedReport(report);
    if (Array.isArray(report)) {
        normalized.unsent_recipients = report.map(row => ({
            ...row,
            last_error: row.reason || row.last_error || ''
        }));
    }
    const header = 'Ad Soyad,Numara,Sebep';
    const rows = normalized.unsent_recipients.map(r => [
        `"${String(recipientDisplayNameFromRow(r)).replace(/"/g, '""')}"`,
        `"${String(r.phone || r.normalized_phone || '').replace(/"/g, '""')}"`,
        `"${String(r.last_error || '').replace(/"/g, '""')}"`
    ].join(','));
    const csv = '\ufeff' + [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gonderilemeyenler_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function resetCampaignUI() {
    document.getElementById('prog-box').classList.add('hidden');
    document.getElementById('prog-bar').style.width = '0%';
    document.getElementById('prog-text').innerText = '0%';
    document.getElementById('prog-count').innerText = '';
    updateCampaignEstimate(0);
    updateBatchPauseCountdown(null);
    updateInterMessageCountdown(null);
    setText('prog-last-recipient', 'SON GÖNDERİLEN: --');
    setActiveCampaignId(null);
    setCampaignControls('idle');
}

function closeCampaignCompleteModal() {
    document.getElementById('campaign-complete-modal').classList.add('hidden');
    document.getElementById('campaign-complete-modal').classList.remove('flex');
    document.getElementById('campaign-detailed-report').classList.add('hidden');
    ['campaign-unsent-tbody', 'campaign-unavailable-tbody', 'campaign-sent-tbody'].forEach(id => {
        const tbody = document.getElementById(id);
        if (tbody) tbody.innerHTML = '';
    });
    lastCampaignDetailedReport = null;
    resetCampaignUI();
}

function insertToken(token) {
    const input = document.getElementById('message');
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || input.value.length;
    input.value = input.value.slice(0, start) + token + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + token.length, start + token.length);
    updatePreview();
}

function setTemplateValidation(issues = []) {
    const element = document.getElementById('template-validation-message');
    if (!element) return;
    const hasIssues = Array.isArray(issues) && issues.length > 0;
    element.classList.toggle('hidden', !hasIssues);
    element.innerText = hasIssues ? issues[0].message : '';
}

function previewContact() {
    return { name: 'Sayın Ahmet', surname: 'Yılmaz' };
}

function validateMessageTemplateOrShow(text, sampleContact = previewContact()) {
    try {
        messageRenderer.renderTemplate(text, sampleContact, { choiceMode: 'first' });
        setTemplateValidation([]);
        return true;
    } catch (err) {
        const issues = err.details || [{ message: err.message || 'Mesaj şablonu geçersiz' }];
        setTemplateValidation(issues);
        showToast(issues[0].message, 'error');
        return false;
    }
}

function updatePreview() {
    const text = ui.getField('message') || 'Mesajınız...';
    try {
        const rendered = messageRenderer.renderTemplate(text, previewContact(), { choiceMode: 'first' });
        document.getElementById('mes-text').innerText = rendered.text || 'Mesajınız...';
        setTemplateValidation([]);
    } catch (err) {
        document.getElementById('mes-text').innerText = text;
        setTemplateValidation(err.details || [{ message: err.message || 'Mesaj şablonu geçersiz' }]);
    }
    const inner = document.getElementById('media-preview-inner');
    if (mediaFiles.length > 0) {
        inner.classList.remove('hidden');
        const mediaPath = escapeHtml(mediaFiles[0].path);
        if (mediaFiles[0].mimetype.startsWith('video/')) {
            inner.innerHTML = `<video src="/${mediaPath}" class="w-full rounded-md max-h-[200px] object-cover" controls></video>`;
        } else {
            inner.innerHTML = `<img src="/${mediaPath}" class="w-full rounded-md object-cover">`;
        }
    } else {
        inner.classList.add('hidden');
        inner.innerHTML = '';
    }
}

function setMediaUploadStatus(state, message) {
    const status = document.getElementById('media-upload-status');
    const spinner = document.getElementById('media-upload-spinner');
    const text = document.getElementById('media-upload-text');
    const button = document.getElementById('media-upload-btn');

    status.classList.toggle('hidden', state === 'idle');
    status.classList.toggle('flex', state !== 'idle');
    spinner.classList.toggle('hidden', state !== 'loading');
    text.innerText = message || '';
    text.className = 'text-[10px] font-bold uppercase tracking-widest ' + (state === 'error' ? 'text-error' : state === 'success' ? 'text-secondary' : 'text-slate-500');
    button.disabled = state === 'loading';
}

function renderMediaPreview() {
    document.getElementById('media-preview').innerHTML = mediaFiles.map((f, index) => {
        const mediaPath = escapeHtml(f.path);
        const preview = f.mimetype.startsWith('video/')
            ? '<div class="w-full h-full bg-white rounded-lg border border-outline-variant/20 flex items-center justify-center"><span class="material-symbols-outlined text-primary text-3xl">movie</span></div>'
            : `<img src="/${mediaPath}" class="w-full h-full object-cover rounded-lg" alt="Medya önizleme">`;

        return `
            <div class="aspect-square bg-white rounded-lg border border-outline-variant/20 relative group overflow-hidden">
                ${preview}
                <button type="button" data-action="remove-media" data-media-index="${index}" aria-label="Medyayı kaldır" class="absolute top-1 right-1 bg-error text-white w-6 h-6 rounded-full flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <span class="material-symbols-outlined text-[12px]">close</span>
                </button>
            </div>
        `;
    }).join('');
}

function removeMediaByIndex(index) {
    const file = mediaFiles[index];
    if (file) removeMedia(file.path);
}

async function removeMedia(mediaPath) {
    try {
        const res = await fetch(`${API_BASE}/upload-media`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: mediaPath })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Medya kaldırılamadı'));

        mediaFiles = unwrapApiPayload(data);
        renderMediaPreview();
        updatePreview();
        setMediaUploadStatus(mediaFiles.length > 0 ? 'success' : 'idle', mediaFiles.length > 0 ? `${mediaFiles.length} medya hazır` : '');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function uploadMedia(input) {
    if (!input.files || input.files.length === 0) return;

    const fd = new FormData();
    for (let f of input.files) fd.append('media', f);
    setMediaUploadStatus('loading', 'Medya yükleniyor...');

    try {
        const res = await fetch(`${API_BASE}/upload-media`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Medya yüklenemedi'));

        mediaFiles = unwrapApiPayload(data);
        renderMediaPreview();
        updatePreview();
        setMediaUploadStatus('success', `${mediaFiles.length} medya yüklendi`);
        setTimeout(() => setMediaUploadStatus('idle'), 3500);
    } catch (err) {
        setMediaUploadStatus('error', err.message);
        showToast(err.message, 'error');
    } finally {
        input.value = '';
    }
}

async function uploadExcel(input) {
    if (!input.files[0]) return;
    showToast('Excel yükleniyor...', 'info');
    const fd = new FormData();
    fd.append('excel', input.files[0]);
    input.value = '';
    try {
        const res = await fetch(`${API_BASE}/upload-excel`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
            showToast(apiErrorMessage(data, 'Excel yüklenemedi'), 'error');
            return;
        }
        const uploadData = unwrapApiPayload(data);
        const importedContacts = Array.isArray(uploadData) ? uploadData : (uploadData.contacts || []);
        const summary = Array.isArray(uploadData) ? null : uploadData.summary;
        const merged = dedupeContacts([...currentContacts, ...importedContacts]);
        const addedCount = merged.length - currentContacts.length;
        currentContacts = merged;
        visibleContacts = currentContacts;
        updateContactsTable();
        saveCurrentContactsToBackend();
        saveUnsavedContactsDraft();
        if (addedCount > 0) {
            const details = summary ? ` (${summary.duplicate || 0} duplicate, ${summary.invalid || 0} hatalı satır)` : '';
            const saveHint = activeGroupId ? '' : '. Kalıcı olması için grup olarak kaydedin';
            showToast(`${addedCount} yeni kişi yüklendi${details}${saveHint}`, 'success');
        } else {
            showToast('Yeni kişi eklenmedi. Numaralar zaten listede.', 'info');
        }
    } catch (e) {
        showToast('Bağlantı hatası: ' + e.message, 'error');
    }
}

function showToast(msg, type = 'info') {
    ui.showToast(msg, type);
}

function openGroupSaveModal() {
    if (currentContacts.length === 0) {
        showToast('Önce kişi ekleyin veya Excel yükleyin', 'error');
        return;
    }

    const activeGroup = groups.find(g => g.id === activeGroupId);
    const nameInput = document.getElementById('save-group-name');
    ui.setField('save-group-name', activeGroup ? activeGroup.name : '');
    document.getElementById('save-group-summary').innerText = `${currentContacts.length} kişi kaydedilecek.`;
    showModal('save-group-modal');
    setTimeout(() => nameInput.focus(), 30);
}

function closeGroupSaveModal() {
    hideModal('save-group-modal');
}

async function saveCurrentListAsGroup() {
    const groupName = ui.getField('save-group-name').trim();
    if (!groupName) {
        showToast('Grup adı zorunlu', 'error');
        return;
    }

    currentContacts = dedupeContacts(currentContacts);
    if (currentContacts.length === 0) {
        showToast('Kaydedilecek geçerli kişi yok', 'error');
        return;
    }

    const normalize = (value) => value.toLocaleLowerCase('tr-TR').trim();
    const existingGroup = groups.find(g => normalize(g.name) === normalize(groupName));
    let targetGroupId = null;

    try {
        if (existingGroup) {
            if (!confirm(`"${groupName}" grubu zaten var. Üzerine yazılsın mı?`)) return;
            targetGroupId = existingGroup.id;
        } else {
            const createRes = await fetch(`${API_BASE}/groups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: groupName })
            });
            const created = await createRes.json();
            if (!createRes.ok) throw new Error(apiErrorMessage(created, 'Grup oluşturulamadı'));
            targetGroupId = unwrapApiPayload(created).id;
        }

        const saveRes = await fetch(`${API_BASE}/groups/${targetGroupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contacts: currentContacts })
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(apiErrorMessage(saveData, 'Kişiler kaydedilemedi'));

        await loadGroups();
        await selectGroup(targetGroupId);
        selectedCampaignGroupIds.add(targetGroupId);
        renderCampaignGroupChecklist();
        closeGroupSaveModal();
        clearUnsavedContactsDraft();
        showToast(`"${groupName}" grubuna ${currentContacts.length} kişi kaydedildi`, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function openManualContactModal() {
    const target = document.getElementById('manual-target-group');
    const activeGroup = groups.find(group => group.id === activeGroupId);
    if (target) {
        if (activeGroup) {
            target.textContent = `Eklenecek grup: ${activeGroup.name}`;
            target.className = 'rounded-xl bg-emerald-50 text-emerald-700 px-4 py-3 text-xs font-bold';
        } else {
            target.textContent = 'Grup seçili değil: kişi geçici listeye eklenecek';
            target.className = 'rounded-xl bg-amber-50 text-amber-700 px-4 py-3 text-xs font-bold';
        }
    }
    showModal('manual-modal');
}

async function saveManualContact() {
    const fields = ui.readFields({ name: 'manual-name', phone: 'manual-phone' });
    const name = fields.name;
    const phone = normalizePhone(fields.phone);

    if (!name || phone.length < 10) {
        showToast('Geçerli ad ve telefon girin', 'error');
        return;
    }

    if (activeGroupId) {
        try {
            const res = await fetch(`${API_BASE}/groups/${activeGroupId}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, phone })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(apiErrorMessage(data, 'Kişi eklenemedi'));
            currentContacts = dedupeContacts([...currentContacts, unwrapApiPayload(data)]);
            visibleContacts = currentContacts;
            hideModal('manual-modal');
            await loadGroups();
            updateContactsTable();
            ui.clearFields(['manual-name', 'manual-phone']);
            showToast('Kişi eklendi', 'success');
            return;
        } catch (err) {
            showToast(err.message, 'error');
            return;
        }
    }

    const merged = dedupeContacts([...currentContacts, { name, phone }]);
    if (merged.length === currentContacts.length) {
        showToast('Bu numara zaten listede', 'info');
        return;
    }

    currentContacts = merged;
    visibleContacts = currentContacts;
    hideModal('manual-modal');
    updateContactsTable();
    saveCurrentContactsToBackend();
    saveUnsavedContactsDraft();
    ui.clearFields(['manual-name', 'manual-phone']);
    showToast('Kişi geçici listeye eklendi. Kalıcı olması için grup adı verip kaydedin.', 'info');
}

async function resetConnection() {
    if (confirm('Bağlantı sıfırlanacak. Sayfa yenilenecektir. Emin misiniz?')) {
        await fetch(`${API_BASE}/reset-session`, { method: 'POST' });
        window.location.reload();
    }
}

function downloadSample() { window.location.href = `${API_BASE}/download-sample`; }

function downloadCurrentContacts() { window.location.href = `${API_BASE}/contacts/export`; }

function clearList() {
    if (window.confirm('Tüm rehber silinecek. Emin misiniz?')) {
        currentContacts = [];
        visibleContacts = [];
        updateContactsTable();
        saveCurrentContactsToBackend();
        if (!activeGroupId) clearUnsavedContactsDraft();
    }
}

async function removeContact(index) {
    const contact = visibleContacts[index];
    if (!contact) return;

    if (activeGroupId && contact.id) {
        try {
            const res = await fetch(`${API_BASE}/groups/${activeGroupId}/contacts/${contact.id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(apiErrorMessage(data, 'Kişi silinemedi'));
            currentContacts = currentContacts.filter(item => String(item.id) !== String(contact.id));
            visibleContacts = contactFilterQuery ? visibleContacts.filter(item => String(item.id) !== String(contact.id)) : currentContacts;
            await loadGroups();
            updateContactsTable();
            showToast('Kişi silindi', 'success');
            return;
        } catch (err) {
            showToast(err.message, 'error');
            return;
        }
    }

    const targetPhone = normalizePhone(contact.phone);
    currentContacts = currentContacts.filter(item => normalizePhone(item.phone) !== targetPhone);
    visibleContacts = currentContacts;
    updateContactsTable();
    saveCurrentContactsToBackend();
    saveUnsavedContactsDraft();
}

function openEditContact(index) {
    const contact = visibleContacts[index];
    if (!contact) return;
    ui.setField('edit-contact-id', contact.id || '');
    ui.setField('edit-contact-index', String(index));
    ui.setField('edit-contact-name', contact.name || '');
    ui.setField('edit-contact-surname', contact.surname || '');
    ui.setField('edit-contact-phone', contact.phone || '');
    showModal('edit-contact-modal');
}

function closeEditContactModal() {
    hideModal('edit-contact-modal');
}

async function saveEditedContact() {
    const contactId = ui.getField('edit-contact-id');
    const index = Number.parseInt(ui.getField('edit-contact-index'), 10);
    const original = visibleContacts[index];
    const fields = ui.readFields({
        name: 'edit-contact-name',
        surname: 'edit-contact-surname',
        phone: 'edit-contact-phone'
    });
    const payload = {
        name: fields.name,
        surname: fields.surname,
        phone: normalizePhone(fields.phone)
    };

    if (!payload.phone || payload.phone.length < 10) {
        showToast('Geçerli telefon girin', 'error');
        return;
    }

    if (activeGroupId && contactId) {
        try {
            const res = await fetch(`${API_BASE}/groups/${activeGroupId}/contacts/${contactId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const updated = await res.json();
            if (!res.ok) throw new Error(apiErrorMessage(updated, 'Kişi güncellenemedi'));
            const updatedContact = unwrapApiPayload(updated);
            currentContacts = currentContacts.map(item => String(item.id) === String(contactId) ? updatedContact : item);
            visibleContacts = contactFilterQuery ? visibleContacts.map(item => String(item.id) === String(contactId) ? updatedContact : item) : currentContacts;
            closeEditContactModal();
            await loadGroups();
            updateContactsTable();
            showToast('Kişi güncellendi', 'success');
            return;
        } catch (err) {
            showToast(err.message, 'error');
            return;
        }
    }

    if (!original) return;
    currentContacts = currentContacts.map(item => normalizePhone(item.phone) === normalizePhone(original.phone) ? { ...item, ...payload } : item);
    visibleContacts = currentContacts;
    closeEditContactModal();
    updateContactsTable();
    saveCurrentContactsToBackend();
    saveUnsavedContactsDraft();
}

function updateContactsTable() {
    const list = contactFilterQuery ? visibleContacts : currentContacts;
    const activePhones = new Set(currentContacts.map(contact => normalizePhone(contact.phone)).filter(Boolean));
    selectedContactPhones = new Set([...selectedContactPhones].filter(phone => activePhones.has(phone) && !suppressedPhoneSet.has(phone)));
    document.getElementById('num-badge').innerText = getCurrentContactSummaryLabel();
    document.getElementById('contacts-pagination-label').innerText = `${list.length} / ${currentContacts.length} gösteriliyor`;
    if (currentContacts.length === 0) {
        ui.renderTableBody('contacts-table-body', {
            rows: [],
            emptyHtml: '<tr><td colspan="5" class="p-20 text-center text-slate-300 font-bold uppercase text-[10px]">Rehber Boş</td></tr>'
        });
        updateSuppressionControls();
        return;
    }
    if (list.length === 0) {
        ui.renderTableBody('contacts-table-body', {
            rows: [],
            emptyHtml: '<tr><td colspan="5" class="p-20 text-center text-slate-300 font-bold uppercase text-[10px]">Arama sonucu bulunamadı</td></tr>'
        });
        updateSuppressionControls();
        return;
    }
    ui.renderTableBody('contacts-table-body', {
        rows: list,
        rowRenderer: (c, i) => {
            const normalizedPhone = normalizePhone(c.phone);
            const suppressed = isSuppressedPhone(normalizedPhone);
            const selected = selectedContactPhones.has(normalizedPhone);
            return `
        <tr class="${suppressed ? 'bg-rose-50/30' : 'hover:bg-slate-50/50'} transition-colors">
            <td class="px-4 py-4 w-12">
                <input type="checkbox" class="rounded border-slate-300 text-rose-600 focus:ring-rose-500" data-action="toggle-contact-selection" data-phone="${escapeHtml(normalizedPhone)}" ${selected ? 'checked' : ''} ${suppressed ? 'disabled' : ''}>
            </td>
            <td class="px-6 py-4 text-sm text-slate-500 font-medium">${i + 1}</td>
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-xs font-bold text-emerald-600">${escapeHtml(getInitials(c))}</div>
                    <span class="text-sm font-semibold text-slate-900">${escapeHtml(`${c.name || ''} ${c.surname || ''}`.trim() || 'İsimsiz')}</span>
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex flex-col gap-1">
                    <span class="text-sm text-slate-600 font-mono">${escapeHtml(c.phone)}</span>
                    ${suppressed ? '<span class="text-[10px] font-bold uppercase tracking-wider text-rose-700">Gönderilmeyecek</span>' : ''}
                </div>
            </td>
            <td class="px-6 py-4 text-right">
                <div class="inline-flex items-center gap-1">
                    ${suppressed ? `
                    <button data-action="unsuppress-contact" data-phone="${escapeHtml(normalizedPhone)}" class="p-1.5 rounded-lg text-rose-500 hover:text-emerald-700 hover:bg-emerald-50 transition-all" title="Gönderime geri al">
                        <span class="material-symbols-outlined text-lg">settings_backup_restore</span>
                    </button>` : `
                    <button data-action="suppress-contact" data-contact-index="${i}" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 transition-all" title="Bu numaraya bir daha gönderme">
                        <span class="material-symbols-outlined text-lg">block</span>
                    </button>`}
                    <button data-action="edit-contact" data-contact-index="${i}" class="p-1.5 rounded-lg text-slate-400 hover:text-secondary hover:bg-secondary/5 transition-all" title="Kişiyi düzenle">
                        <span class="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button data-action="remove-contact" data-contact-index="${i}" class="p-1.5 rounded-lg text-slate-400 hover:text-error hover:bg-error/5 transition-all" title="Kişiyi sil">
                        <span class="material-symbols-outlined text-lg">delete</span>
                    </button>
                </div>
            </td>
        </tr>
        `;
        }
    });
    updateSuppressionControls();
}

function filterContacts(query) {
    const normalized = String(query || '').toLocaleLowerCase('tr-TR').trim();
    contactFilterQuery = normalized;
    if (!normalized) {
        visibleContacts = currentContacts;
    } else {
        visibleContacts = currentContacts.filter(contact => {
            const full = `${contact.name || ''} ${contact.surname || ''} ${contact.phone || ''}`.toLocaleLowerCase('tr-TR');
            return full.includes(normalized);
        });
    }
    updateContactsTable();
}

async function initTemplates() {
    try {
        templates = await fetchJson(`${API_BASE}/templates`);
        document.getElementById('template-select').innerHTML = '<option value="">ŞABLONLAR</option>' + templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    } catch (err) {
        templates = [];
        document.getElementById('template-select').innerHTML = '<option value="">ŞABLONLAR YÜKLENEMEDİ</option>';
        showToast('Şablonlar yüklenemedi: ' + err.message, 'error');
    }
}

function loadTemplate(id) {
    const t = templates.find(item => item.id == id);
    if (t) {
        document.getElementById('message').value = t.text;
        updatePreview();
    }
}

async function saveTemplate() {
    const name = ui.getField('template-name').trim();
    const text = ui.getField('message');
    if (!name || !text) {
        showToast('Şablon adı ve mesaj içeriği zorunlu', 'error');
        return;
    }
    if (!validateMessageTemplateOrShow(text)) return;
    const res = await fetch(`${API_BASE}/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(apiErrorMessage(data, 'Şablon kaydedilemedi'), 'error');
        return;
    }
    initTemplates();
    hideModal('template-modal');
    ui.clearFields(['template-name']);
    showToast('Şablon kaydedildi', 'success');
}

async function startCampaign(overrideCooldown = []) {
    const sock = getSocket();
    if (!sock) return alert('Sunucu bağlantısı kurulamadı. Sayfayı yenileyin veya sunucu loglarını kontrol edin.');
    if (!Array.isArray(overrideCooldown)) overrideCooldown = [];
    const text = ui.getField('message');
    let targetContacts = [];
    try {
        targetContacts = await getSelectedCampaignContacts();
    } catch (err) {
        showToast('Hedef kişiler yüklenemedi: ' + err.message, 'error');
        return;
    }

    if (targetContacts.length === 0) return alert('Hedef numara/grup boş olamaz.');
    if (!text && mediaFiles.length === 0) return alert('Mesaj içeriği veya en az bir görsel gereklidir.');
    if (text && !validateMessageTemplateOrShow(text, targetContacts[0] || previewContact())) return;

    if (overrideCooldown.length === 0) {
        try {
            const preflight = await fetchJson(`${API_BASE}/campaigns/preflight`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contacts: targetContacts, message: text })
            });
            const { sameMessage = [], differentMessage = [] } = preflight || {};
            console.info('[startCampaign] preflight', { sameMessage: sameMessage.length, differentMessage: differentMessage.length });
            if (sameMessage.length > 0 || differentMessage.length > 0) {
                showCooldownConfirmModal(sameMessage, differentMessage, targetContacts, text);
                return;
            }
        } catch (err) {
            console.warn('Preflight kontrolü başarısız:', err);
            showToast('Cooldown kontrolü başarısız: ' + (err?.message || err), 'error');
            return;
        }
    }

    setActiveCampaignId(null);
    setCampaignControls('running');
    renderCampaignProgress({
        total: targetContacts.length,
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        validation_unknown: 0,
        progress: 0,
        wait_until: null,
        pause_until: null,
        last_recipient_name: null
    });
    updateCampaignEstimate(estimateMinutesForContacts(targetContacts.length));

    const delayRange = [
        parseInt(document.getElementById('min-delay').value),
        parseInt(document.getElementById('max-delay').value)
    ];
    const dailyLimit = parseInt(document.getElementById('daily-limit').value);

    sock.emit('start-bulk', {
        contacts: targetContacts,
        message: text,
        delayRange,
        dailyLimit,
        overrideCooldown
    });
}

function showCooldownConfirmModal(sameMessage, differentMessage, targetContacts, text) {
    const sameSection = document.getElementById('cooldown-same-msg-section');
    const diffSection = document.getElementById('cooldown-diff-msg-section');

    if (sameMessage.length > 0) {
        document.getElementById('cooldown-same-count').textContent = sameMessage.length;
        document.getElementById('cooldown-same-list').innerHTML = sameMessage
            .map(r => `<div>${escapeHtml(r.name || r.phone)} <span class="text-slate-400">(${escapeHtml(r.phone)})</span> — <span class="text-amber-500">${escapeHtml(r.expiresAt)}'e kadar</span></div>`)
            .join('');
        sameSection.classList.remove('hidden');
    } else {
        sameSection.classList.add('hidden');
    }

    if (differentMessage.length > 0) {
        document.getElementById('cooldown-diff-count').textContent = differentMessage.length;
        document.getElementById('cooldown-diff-list').innerHTML = differentMessage
            .map(r => `<div>${escapeHtml(r.name || r.phone)} <span class="text-slate-400">(${escapeHtml(r.phone)})</span> — <span class="text-blue-500">${escapeHtml(r.expiresAt)}'e kadar</span></div>`)
            .join('');
        diffSection.classList.remove('hidden');
    } else {
        diffSection.classList.add('hidden');
    }

    document.getElementById('cooldown-override-same').checked = false;
    document.getElementById('cooldown-override-diff').checked = false;

    const modal = document.getElementById('cooldown-confirm-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    document.getElementById('cooldown-confirm-cancel-btn').onclick = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    };

    document.getElementById('cooldown-confirm-send-btn').onclick = () => {
        const overrides = [];
        if (document.getElementById('cooldown-override-same').checked) {
            sameMessage.forEach(r => overrides.push(r.normalizedPhone));
        }
        if (document.getElementById('cooldown-override-diff').checked) {
            differentMessage.forEach(r => overrides.push(r.normalizedPhone));
        }
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        startCampaign(overrides);
    };
}

function stopCampaign() {
    getSocket()?.emit('stop-bulk', { campaignId: getActiveCampaignId() });
}

async function finishCampaignPermanently() {
    const campaignId = getActiveCampaignId();
    if (!campaignId) return showToast('Bitirilecek kampanya bulunamadı', 'error');
    const confirmed = window.confirm('Bu kampanya bitirilecek. Bundan sonra kaldığın yerden devam et, tekrar dene veya atlananları dene ile bu kampanyadan mesaj gönderilmeyecek. Devam edilsin mi?');
    if (!confirmed) return;

    try {
        setActionButton('finish-campaign-btn', false);
        const data = await fetchJson(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, 15000);
        const campaign = data.campaign || data;
        setActiveCampaignId(campaign?.id || campaignId);
        renderCampaignProgress(campaign || { status: 'finished' });
        updateBatchPauseCountdown(null);
        updateInterMessageCountdown(null);
        setCampaignControls('finished');
        try {
            const report = await fetchJson(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/report`, {}, 15000);
            showCampaignCompleteModal(
                report,
                'Kampanya bitirildi. Aşağıda başarılı gönderimler, mesaj ulaşmayanlar ve WhatsApp kullanmayanlar listelendi.',
                { title: 'Kampanya raporu', forceDetailed: true }
            );
        } catch (reportErr) {
            showToast(reportErr.message || 'Kampanya raporu alınamadı', 'error');
        }
        showToast('Kampanya bitirildi. Bu kampanyadan tekrar mesaj gönderilmeyecek.', 'success');
    } catch (err) {
        showToast(err.message || 'Kampanya bitirilemedi', 'error');
        refreshActiveCampaignSnapshot({ hydrateLogs: false }).catch(() => {});
    }
}

function resumeCampaign() {
    const campaignId = getActiveCampaignId();
    if (!campaignId) return showToast('Devam ettirilecek kampanya bulunamadı', 'error');
    setCampaignControls('running');
    getSocket()?.emit('resume-bulk', { campaignId });
}

function retryCampaign() {
    const campaignId = getActiveCampaignId();
    if (!campaignId) return showToast('Tekrar gönderilecek kampanya bulunamadı', 'error');
    setCampaignControls('running');
    getSocket()?.emit('retry-bulk', { campaignId });
}

function retrySkippedCampaign() {
    const campaignId = getActiveCampaignId();
    if (!campaignId) return showToast('Tekrar denenecek kampanya bulunamadı', 'error');
    setCampaignControls('running');
    getSocket()?.emit('retry-skipped-bulk', { campaignId });
}

function toggleLogs() {
    const panel = document.getElementById('log-monitor');
    panel.classList.toggle('hidden');
    panel.classList.toggle('flex');
}

async function loadGroups() {
    try {
        const data = await fetchJson(`${API_BASE}/groups`);
        groups = Array.isArray(data) ? data : [];
        if (activeGroupId) {
            const active = groups.find(g => g.id === activeGroupId);
            if (active) {
                currentContacts = dedupeContacts(await ensureGroupContactsLoaded(active.id));
                visibleContacts = currentContacts;
                document.getElementById('active-group-name').innerText = active.name;
                updateContactsTable();
            } else {
                activeGroupId = null;
                currentContacts = [];
                visibleContacts = [];
                document.getElementById('active-group-name').innerText = 'Seçili Grup Yok';
                updateContactsTable();
            }
        }
        renderGroupsSidebar();
        restoreUnsavedContactsDraft();
    } catch (err) {
        groups = [];
        document.getElementById('groups-list').innerHTML = '<div class="p-4 text-center text-[10px] text-error font-bold uppercase tracking-widest">Gruplar yüklenemedi</div>';
        renderCampaignGroupChecklist();
        showToast('Gruplar yüklenemedi: ' + err.message, 'error');
    }
}

function renderGroupsSidebar() {
    const container = document.getElementById('groups-list');
    if (groups.length === 0) {
        container.innerHTML = '<div class="p-4 text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest">Henüz grup yok</div>';
    } else {
        container.innerHTML = groups.map(g => {
            const active = activeGroupId === g.id;
            const countLabel = formatGroupCount(g);
            return `
                <div data-action="select-group" data-group-id="${escapeHtml(g.id)}" class="${active ? 'bg-surface-container-lowest border-l-4 border-emerald-600 shadow-sm' : 'bg-transparent hover:bg-slate-200/50'} p-4 rounded-xl flex items-center justify-between group cursor-pointer transition-colors">
                    <div class="min-w-0">
                        <p class="text-sm ${active ? 'font-bold text-slate-900' : 'font-medium text-slate-700'} truncate" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</p>
                        <p class="text-[11px] text-slate-500">${formatDate(g.created_at || g.createdAt)}</p>
                        <p class="text-[11px] font-bold ${active ? 'text-emerald-700' : 'text-slate-600'}">${escapeHtml(countLabel)}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="delete-group" data-group-id="${escapeHtml(g.id)}" class="text-slate-400 hover:text-error opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all" title="Grubu sil">
                            <span class="material-symbols-outlined text-sm">close</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }
    renderCampaignGroupChecklist();
}

async function createGroup() {
    const name = prompt('Yeni grup adı (Örn: İş Arkadaşları):');
    if (!name || name.trim() === '') return;
    try {
        const res = await fetch(`${API_BASE}/groups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() })
        });
        const newGroup = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(newGroup, 'Grup oluşturulamadı'));
        const createdGroup = unwrapApiPayload(newGroup);
        groups.push(createdGroup);
        await selectGroup(createdGroup.id);
        selectedCampaignGroupIds.add(createdGroup.id);
        renderCampaignGroupChecklist();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteGroup(id) {
    if (!confirm('Bu grubu ve içindeki kişileri silmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`${API_BASE}/groups/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Grup silinemedi'));
        groups = groups.filter(g => g.id !== id);
        selectedCampaignGroupIds.delete(id);
        if (activeGroupId === id) {
            activeGroupId = null;
            currentContacts = [];
            visibleContacts = [];
            document.getElementById('active-group-name').innerText = 'Seçili Grup Yok';
            updateContactsTable();
        }
        renderGroupsSidebar();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function selectGroup(id) {
    saveUnsavedContactsDraft();
    activeGroupId = id;
    const group = groups.find(g => g.id === id);
    if (!group) {
        activeGroupId = null;
        currentContacts = [];
        visibleContacts = [];
        document.getElementById('active-group-name').innerText = 'Seçili Grup Yok';
        updateContactsTable();
        renderGroupsSidebar();
        return;
    }
    try {
        currentContacts = dedupeContacts(await ensureGroupContactsLoaded(group.id));
    } catch (err) {
        showToast('Kişiler yüklenemedi: ' + err.message, 'error');
        currentContacts = [];
    }
    visibleContacts = currentContacts;
    document.getElementById('active-group-name').innerText = group.name;
    updateContactsTable();
    renderGroupsSidebar();
}

async function saveCurrentContactsToBackend() {
    if (!activeGroupId) {
        saveUnsavedContactsDraft();
        return;
    }
    currentContacts = dedupeContacts(currentContacts);
    visibleContacts = currentContacts;
    try {
        const res = await fetch(`${API_BASE}/groups/${activeGroupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contacts: currentContacts })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Grup güncellenemedi'));
        await loadGroups();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderCampaignLogs(logs = [], campaignId = null) {
    const logContainer = document.getElementById('logs');
    if (!logContainer) return;
    logContainer.innerHTML = '';
    logs.slice(-300).forEach(log => {
        const div = document.createElement('div');
        div.className = log.type === 'error' ? 'text-red-300' : log.type === 'success' ? 'text-secondary-fixed-dim' : log.type === 'wait' ? 'text-amber-300' : 'text-slate-300';
        div.innerHTML = `[${new Date(log.timestamp).toLocaleTimeString()}] ${escapeHtml(log.message)}`;
        logContainer.appendChild(div);
    });
    logContainer.scrollTop = logContainer.scrollHeight;
    hydratedCampaignLogsForId = campaignId;
}

async function refreshActiveCampaignSnapshot(options = {}) {
    const { hydrateLogs = false } = options;
    if (campaignStatusPollInFlight) return null;
    campaignStatusPollInFlight = true;
    try {
        const data = await fetchJson(`${API_BASE}/campaign-status`);
        if (data.campaign && data.campaign.status !== 'completed') {
            setActiveCampaignId(data.campaign.id || getActiveCampaignId());
            setCampaignControls(data.campaign.status);
            renderCampaignProgress(data.campaign);

            const campaignId = data.campaign.id || null;
            if (hydrateLogs || hydratedCampaignLogsForId !== campaignId) {
                renderCampaignLogs(data.campaign.logs || [], campaignId);
            }
            return data.campaign;
        }

        if (data.campaign?.status === 'completed') {
            setActiveCampaignId(data.campaign.id || getActiveCampaignId());
            setCampaignControls('completed');
            renderCampaignProgress(data.campaign);
            updateBatchPauseCountdown(null);
            updateInterMessageCountdown(null);
        }
        return data.campaign || null;
    } catch (err) {
        console.error('Kampanya durumu alınamadı', err);
        return null;
    } finally {
        campaignStatusPollInFlight = false;
    }
}

async function checkActiveCampaign() {
    return refreshActiveCampaignSnapshot({ hydrateLogs: true });
}

function startCampaignStatusPolling() {
    if (campaignStatusPollTimer) clearInterval(campaignStatusPollTimer);
    campaignStatusPollTimer = setInterval(() => {
        if (_socket?.connected) return;
        const campaignId = getActiveCampaignId();
        const progressVisible = !document.getElementById('prog-box')?.classList.contains('hidden');
        if (!campaignId && !progressVisible) return;
        refreshActiveCampaignSnapshot({ hydrateLogs: false });
    }, 5000);
}

function updateDelayLabel() {
    const min = document.getElementById('min-delay').value || 0;
    const max = document.getElementById('max-delay').value || 0;
    const daily = document.getElementById('daily-limit').value || 0;
    document.getElementById('delay-range-label').innerText = `${min}s - ${max}s`;
    document.getElementById('daily-limit-label').innerText = daily;
}

function byId(id) {
    return document.getElementById(id);
}

function bindClick(id, handler) {
    const element = byId(id);
    if (element) element.addEventListener('click', handler);
}

function showModal(id) {
    ui.showModal(id);
}

function hideModal(id) {
    ui.hideModal(id);
}

function bindStaticControls() {
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });
    document.querySelectorAll('[data-insert-token]').forEach(button => {
        button.addEventListener('click', () => insertToken(button.dataset.insertToken));
    });
    document.querySelectorAll('[data-action="toggle-logs"]').forEach(button => {
        button.addEventListener('click', toggleLogs);
    });

    bindClick('logout-btn', logout);
    bindClick('reset-connection-btn', resetConnection);
    bindClick('open-template-modal-btn', () => showModal('template-modal'));
    bindClick('media-upload-btn', () => byId('media-input')?.click());
    bindClick('create-group-btn', createGroup);
    bindClick('excel-upload-card', () => byId('excel-input')?.click());
    bindClick('manual-open-card', openManualContactModal);
    bindClick('download-sample-card', downloadSample);
    bindClick('download-current-contacts-card', downloadCurrentContacts);
    bindClick('manual-cancel-btn', () => hideModal('manual-modal'));
    bindClick('manual-save-btn', saveManualContact);
    bindClick('edit-contact-cancel-btn', closeEditContactModal);
    bindClick('edit-contact-save-btn', saveEditedContact);
    bindClick('group-save-cancel-btn', closeGroupSaveModal);
    bindClick('group-save-confirm-btn', saveCurrentListAsGroup);
    bindClick('template-cancel-btn', () => hideModal('template-modal'));
    bindClick('template-save-btn', saveTemplate);
    bindClick('campaign-complete-close-btn', closeCampaignCompleteModal);
    bindClick('mobile-manual-open-btn', openManualContactModal);
    bindClick('release-refresh-btn', () => window.location.reload());

    byId('template-select')?.addEventListener('change', event => loadTemplate(event.target.value));
    byId('message')?.addEventListener('input', updatePreview);
    byId('media-input')?.addEventListener('change', event => uploadMedia(event.target));
    byId('manual-campaign-numbers')?.addEventListener('input', event => handleManualNumbersInput(event.target));
    byId('min-delay')?.addEventListener('input', updateDelayLabel);
    byId('max-delay')?.addEventListener('input', updateDelayLabel);
    byId('daily-limit')?.addEventListener('input', updateDelayLabel);
    byId('contact-search-input')?.addEventListener('input', event => filterContacts(event.target.value));
    byId('excel-input')?.addEventListener('change', event => uploadExcel(event.target));
    byId('contacts-select-all')?.addEventListener('change', event => toggleVisibleContactSelection(event.target.checked));
    bindClick('suppress-selected-btn', suppressSelectedContacts);
}

function bindDynamicControls() {
    byId('campaign-group-list')?.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-action="toggle-campaign-group"]');
        if (checkbox) toggleCampaignGroup(checkbox.dataset.groupId, checkbox.checked);
    });

    byId('media-preview')?.addEventListener('click', event => {
        const button = event.target.closest('[data-action="remove-media"]');
        if (button) removeMediaByIndex(Number(button.dataset.mediaIndex));
    });

    byId('contacts-table-body')?.addEventListener('click', event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const index = Number(button.dataset.contactIndex);
        if (button.dataset.action === 'suppress-contact') suppressContacts([visibleContacts[index]]);
        if (button.dataset.action === 'unsuppress-contact') unsuppressPhones([button.dataset.phone]);
        if (button.dataset.action === 'edit-contact') openEditContact(index);
        if (button.dataset.action === 'remove-contact') removeContact(index);
    });

    byId('contacts-table-body')?.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-action="toggle-contact-selection"]');
        if (!checkbox) return;
        toggleContactSelection(checkbox.dataset.phone, checkbox.checked);
    });

    byId('groups-list')?.addEventListener('click', event => {
        const actionTarget = event.target.closest('[data-action]');
        if (!actionTarget) return;
        const groupId = actionTarget.dataset.groupId;
        if (actionTarget.dataset.action === 'delete-group') {
            event.stopPropagation();
            deleteGroup(groupId);
            return;
        }
        if (actionTarget.dataset.action === 'select-group') selectGroup(groupId);
    });
}

function initializeDashboard() {
    bindStaticControls();
    bindDynamicControls();
    document.getElementById('clear-list-btn').addEventListener('click', clearList);
    document.getElementById('send-btn').addEventListener('click', () => startCampaign());
    document.getElementById('stop-btn').addEventListener('click', stopCampaign);
    document.getElementById('finish-campaign-btn').addEventListener('click', finishCampaignPermanently);
    document.getElementById('resume-btn').addEventListener('click', resumeCampaign);
    document.getElementById('retry-btn').addEventListener('click', retryCampaign);
    document.getElementById('retry-skipped-btn').addEventListener('click', retrySkippedCampaign);
    document.getElementById('save-group-name').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentListAsGroup();
    });
    setWhatsAppUiStatus('disconnected', 'BAĞLI DEĞİL');
    updateDelayLabel();
    initReleaseVersion().then(startReleaseWatcher);
    initTemplates();
    loadSuppressedRecipients().then(() => {
        updateContactsTable();
        updateCampaignTargetSummary();
    }).catch(err => console.warn('Gönderim dışı liste yüklenemedi:', err));
    loadGroups();
    refreshRuntimeStatus();
    checkUserRole();
    setInterval(refreshRuntimeStatus, 15000);
    setTimeout(checkActiveCampaign, 1000);
    startCampaignStatusPolling();
    setTimeout(getSocket, 3000);
}

// -- USER MANAGEMENT --
async function checkUserRole() {
    try {
        const res = await fetchJson(`${API_BASE}/check-auth`);
        if (res.authenticated && res.user) {
            const roleMap = {
                'super_admin': 'Süper Admin',
                'owner': 'Kurucu',
                'admin': 'Yönetici',
                'user': 'Üye'
            };
            const roleName = roleMap[res.user.role] || 'Üye';
            const displayName = res.user.display_name || res.user.email.split('@')[0];
            
            const badge = document.getElementById('user-role-badge');
            if (badge) {
                badge.innerText = `${displayName} - ${roleName}`;
            }

            if (res.user.role === 'super_admin' || res.user.role === 'owner') {
                const tabUsers = document.getElementById('tab-users');
                if (tabUsers) tabUsers.classList.remove('hidden');
            }
        }
    } catch (err) {
        console.error('Auth kontrolü hatası', err);
    }
}

async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Yükleniyor...</td></tr>';

    try {
        const data = await fetchJson(`${API_BASE}/users`);
        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Kayıtlı kullanıcı yok</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(user => `
            <tr>
                <td class="px-4 py-3 text-sm font-medium text-slate-900">${escapeHtml(user.display_name || user.tenant_id)}</td>
                <td class="px-4 py-3 text-sm text-slate-600">${escapeHtml(user.email)}</td>
                <td class="px-4 py-3 text-sm">
                    <span class="px-2 py-1 rounded bg-slate-100 text-[10px] font-bold text-slate-600 uppercase tracking-widest">${escapeHtml(user.role)}</span>
                </td>
                <td class="px-4 py-3 text-right">
                    <button onclick="deleteUser('${user.id}')" class="text-error hover:text-error/80 p-1 transition-colors" title="Sil">
                        <span class="material-symbols-outlined text-sm">delete</span>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-error font-bold uppercase text-xs">Hata: ${escapeHtml(err.message)}</td></tr>`;
    }
}

async function handleCreateUser(e) {
    e.preventDefault();

    const name = document.getElementById('new-user-name').value;
    const email = document.getElementById('new-user-email').value;
    const password = document.getElementById('new-user-password').value;

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">refresh</span> Ekleniyor...';

    try {
        await fetchJson(`${API_BASE}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: name, email, password })
        });

        showToast('Kullanıcı başarıyla eklendi', 'success');
        e.target.reset();
        loadUsers();
    } catch (err) {
        showToast(err.message || 'Kullanıcı eklenemedi', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function deleteUser(userId) {
    if (!confirm('Bu kullanıcıyı silmek istediğinize emin misiniz? (Tenant verileri otomatik silinmez)')) return;

    try {
        await fetchJson(`${API_BASE}/users/${userId}`, { method: 'DELETE' });
        showToast('Kullanıcı silindi', 'success');
        loadUsers();
    } catch (err) {
        showToast(err.message || 'Kullanıcı silinemedi', 'error');
    }
}

document.getElementById('create-user-form')?.addEventListener('submit', handleCreateUser);
document.getElementById('refresh-users-btn')?.addEventListener('click', loadUsers);

// ── Reports Tab ──────────────────────────────────────────────────────────────

const STATUS_LABELS = {
    completed: 'Tamamlandı', running: 'Devam Ediyor', paused: 'Duraklatıldı', stopped: 'Durduruldu',
    finished: 'Bitirildi', queued: 'Kuyrukta'
};
const STATUS_COLORS = {
    completed: 'text-secondary', running: 'text-blue-600', paused: 'text-amber-600',
    stopped: 'text-error', finished: 'text-slate-900', queued: 'text-slate-500'
};
const RECIPIENT_STATUS_LABELS = {
    sent: 'Başarılı',
    failed: 'Hatalı',
    pending: 'Bekleyen',
    skipped: 'Atlandı',
    skipped_cooldown: 'Cooldown',
    not_on_whatsapp: 'WhatsApp yok',
    suppressed: 'Manuel dışlandı',
    validation_unknown: 'Doğrulama belirsiz'
};
const RECIPIENT_STATUS_COLORS = {
    sent: 'bg-secondary/10 text-secondary',
    failed: 'bg-error/10 text-error',
    pending: 'bg-slate-100 text-slate-600',
    skipped: 'bg-amber-50 text-amber-700',
    skipped_cooldown: 'bg-amber-50 text-amber-700',
    not_on_whatsapp: 'bg-rose-50 text-rose-700',
    suppressed: 'bg-rose-50 text-rose-700',
    validation_unknown: 'bg-blue-50 text-blue-700'
};
const SEV_COLORS = {
    info: 'text-blue-600 bg-blue-50', warn: 'text-amber-700 bg-amber-50', error: 'text-error bg-error/5'
};
const EVENT_COLORS = {
    whatsapp_connected: 'text-green-600', whatsapp_disconnected: 'text-red-600',
    qr_generated: 'text-blue-600', session_invalid_loop: 'text-orange-600 font-bold',
    reconnect_paused: 'text-red-600', error_burst: 'text-red-600', media_missing: 'text-amber-600',
    server_started: 'text-slate-600',
    campaign_started: 'text-blue-600', campaign_resumed: 'text-blue-600',
    campaign_retry_started: 'text-amber-600', campaign_retry_skipped_started: 'text-amber-600',
    campaign_completed: 'text-green-600', campaign_paused: 'text-amber-600',
    campaign_stopped: 'text-red-600', campaign_finished: 'text-slate-900'
};

function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function loadReports() {
    await Promise.all([
        loadReportSummary(),
        loadUnavailableWhatsAppRecipients(),
        loadFailedRecipientsReport(),
        loadSystemEvents()
    ]);
}

async function loadReportSummary() {
    try {
        const data = await fetchJson(`${API_BASE}/reports/summary`);
        const s = data || {};
        document.getElementById('report-total-campaigns').textContent = s.total_campaigns ?? '—';
        document.getElementById('report-total-sent').textContent = s.total_sent ?? '—';
        document.getElementById('report-total-failed').textContent = s.total_failed ?? '—';
        const byStatus = s.by_status || {};
        document.getElementById('report-by-status').innerHTML = Object.entries(byStatus)
            .map(([k, v]) => `<span class="font-bold">${STATUS_LABELS[k] || k}:</span> ${v}`)
            .join('<br>');

        const tbody = document.getElementById('reports-campaigns-tbody');
        const campaigns = s.recent_campaigns || [];
        if (!campaigns.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Kampanya bulunamadı</td></tr>';
            return;
        }
        tbody.innerHTML = campaigns.map(c => `
            <tr class="hover:bg-slate-50/50 transition-colors">
                <td class="px-4 py-3 font-mono text-[10px] text-slate-400">${c.id.slice(0, 8)}…</td>
                <td class="px-4 py-3"><span class="text-xs font-bold ${STATUS_COLORS[c.status] || 'text-slate-500'}">${STATUS_LABELS[c.status] || c.status}</span></td>
                <td class="px-4 py-3 text-xs font-bold text-secondary">${c.sent_count}</td>
                <td class="px-4 py-3 text-xs font-bold text-error">${c.failed_count}</td>
                <td class="px-4 py-3 text-xs text-slate-500">${c.total_count}</td>
                <td class="px-4 py-3 text-xs text-slate-400">${fmtDate(c.updated_at)}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="openCampaignDetail('${c.id}')" class="text-xs font-bold text-primary hover:text-primary/70 transition-colors px-3 py-1 rounded-lg bg-primary/5 hover:bg-primary/10">Detay</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        document.getElementById('report-by-status').textContent = 'Yüklenemedi';
    }
}

async function loadSystemEvents() {
    const severity = document.getElementById('sysevt-severity-filter')?.value || '';
    const eventType = document.getElementById('sysevt-type-filter')?.value || '';
    const container = document.getElementById('sysevt-list');
    try {
        const params = new URLSearchParams({ limit: 100 });
        if (severity) params.set('severity', severity);
        if (eventType) params.set('event_type', eventType);
        const data = await fetchJson(`${API_BASE}/system-events?${params}`);
        const events = data?.events || [];
        if (!events.length) {
            container.innerHTML = '<div class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Kayıtlı olay yok</div>';
            return;
        }
        container.innerHTML = events.map(ev => `
            <div class="px-6 py-3 flex items-start gap-3 hover:bg-slate-50/50">
                <span class="text-[9px] font-bold px-2 py-0.5 rounded-full mt-0.5 flex-shrink-0 ${SEV_COLORS[ev.severity] || 'text-slate-500 bg-slate-100'}">${(ev.severity || '').toUpperCase()}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold text-slate-700 leading-tight">${escapeHtml(ev.message || '—')}</p>
                    <p class="text-[9px] mt-0.5"><span class="font-bold ${EVENT_COLORS[ev.event_type] || 'text-slate-500'}">${ev.event_type || '—'}</span> · <span class="text-slate-400">${fmtDate(ev.created_at)}</span></p>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<div class="p-8 text-center text-error font-bold uppercase text-xs">Yüklenemedi</div>';
    }
}

function recipientDisplayNameFromRow(row = {}) {
    return `${row.name || ''} ${row.surname || ''}`.trim() || row.name || '—';
}

function errorPreview(value, length = 100) {
    return String(value || '').split('\n')[0].slice(0, length);
}

async function loadUnavailableWhatsAppRecipients() {
    const tbody = document.getElementById('unavailable-whatsapp-tbody');
    if (!tbody) return;
    try {
        const data = await fetchJson(`${API_BASE}/unavailable-whatsapp?limit=100`);
        const recipients = data?.recipients || [];
        if (!recipients.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Kayıt yok</td></tr>';
            return;
        }
        tbody.innerHTML = recipients.map(item => `
            <tr class="hover:bg-slate-50/50 transition-colors">
                <td class="px-4 py-3 text-xs font-bold text-slate-700">${escapeHtml(recipientDisplayNameFromRow(item))}</td>
                <td class="px-4 py-3 text-xs font-mono text-slate-600">${escapeHtml(item.display_phone || item.normalized_phone || '')}</td>
                <td class="px-4 py-3 text-xs text-slate-500 max-w-[180px] truncate" title="${escapeHtml(item.reason || '')}">${escapeHtml(item.reason || 'WhatsApp yok')}</td>
                <td class="px-4 py-3 text-xs text-slate-400">${fmtDate(item.last_detected_at || item.updated_at)}</td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-error font-bold uppercase text-xs">Yüklenemedi</td></tr>';
    }
}

async function loadFailedRecipientsReport() {
    const tbody = document.getElementById('failed-recipients-tbody');
    if (!tbody) return;
    try {
        const data = await fetchJson(`${API_BASE}/failed-recipients?limit=100`);
        const recipients = data?.recipients || [];
        if (!recipients.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-300 font-bold uppercase text-xs">Kayıt yok</td></tr>';
            return;
        }
        tbody.innerHTML = recipients.map(item => `
            <tr class="hover:bg-slate-50/50 transition-colors">
                <td class="px-4 py-3 text-xs font-bold text-slate-700">${escapeHtml(recipientDisplayNameFromRow(item))}</td>
                <td class="px-4 py-3 text-xs font-mono text-slate-600">${escapeHtml(item.phone || item.normalized_phone || '')}</td>
                <td class="px-4 py-3 text-xs"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${RECIPIENT_STATUS_COLORS[item.status] || 'bg-slate-100 text-slate-600'}">${escapeHtml(RECIPIENT_STATUS_LABELS[item.status] || item.status || '—')}</span></td>
                <td class="px-4 py-3 text-xs text-center font-black text-error">${Number(item.attempt_count || 0)}</td>
                <td class="px-4 py-3 text-xs text-slate-500 max-w-[240px] truncate" title="${escapeHtml(item.last_error || '')}">${escapeHtml(errorPreview(item.last_error, 120) || '—')}</td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-error font-bold uppercase text-xs">Yüklenemedi</td></tr>';
    }
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function openCampaignDetail(campaignId) {
    const modal = document.getElementById('campaign-detail-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('campaign-detail-id').textContent = campaignId;
    document.getElementById('cdet-status').textContent = '—';
    document.getElementById('cdet-sent').textContent = '—';
    document.getElementById('cdet-failed').textContent = '—';
    document.getElementById('cdet-total').textContent = '—';
    document.getElementById('cdet-logs').innerHTML = '<span class="text-slate-400">Yükleniyor...</span>';
    document.getElementById('cdet-failed-section').classList.add('hidden');
    document.getElementById('cdet-skipped-section').classList.add('hidden');
    document.getElementById('cdet-recipient-stats').classList.add('hidden');

    try {
        const data = await fetchJson(`${API_BASE}/campaigns/${campaignId}/report`);
        const r = data || {};
        const run = r.run;
        document.getElementById('cdet-status').textContent = STATUS_LABELS[run.status] || run.status;
        document.getElementById('cdet-sent').textContent = run.sent_count ?? 0;
        document.getElementById('cdet-failed').textContent = run.failed_count ?? 0;
        document.getElementById('cdet-total').textContent = run.total_count ?? 0;

        const statsSection = document.getElementById('cdet-recipient-stats');
        const statsBody = document.getElementById('cdet-recipient-stats-body');
        const stats = r.recipient_stats || {};
        if (Object.keys(stats).length > 0) {
            statsBody.innerHTML = Object.entries(stats)
                .map(([k, v]) => `<span class="px-3 py-1 rounded-full text-xs font-bold ${RECIPIENT_STATUS_COLORS[k] || 'bg-slate-100 text-slate-600'}">${RECIPIENT_STATUS_LABELS[k] || k}: ${v}</span>`)
                .join('');
            statsSection.classList.remove('hidden');
        }

        const failedSection = document.getElementById('cdet-failed-section');
        const failedTbody = document.getElementById('cdet-failed-tbody');
        const failed = r.failed_recipients || [];
        if (failed.length > 0) {
            failedTbody.innerHTML = failed.map(f => `
                <tr><td class="px-3 py-1.5">${escapeHtml(recipientDisplayNameFromRow(f))}</td><td class="px-3 py-1.5 font-mono">${escapeHtml(f.phone || '')}</td><td class="px-3 py-1.5 text-center font-black text-error">${Number(f.attempt_count || 0)}</td><td class="px-3 py-1.5 text-error/80 max-w-[180px] truncate" title="${escapeHtml(f.last_error || '')}">${escapeHtml(errorPreview(f.last_error, 80))}</td></tr>
            `).join('');
            failedSection.classList.remove('hidden');
        }

        const skippedSection = document.getElementById('cdet-skipped-section');
        const skippedTbody = document.getElementById('cdet-skipped-tbody');
        const skipped = r.skipped_recipients || [];
        if (skipped.length > 0) {
            skippedTbody.innerHTML = skipped.map(item => `
                <tr>
                    <td class="px-3 py-1.5">${escapeHtml(item.name || '—')}</td>
                    <td class="px-3 py-1.5 font-mono">${escapeHtml(item.phone || '')}</td>
                    <td class="px-3 py-1.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${RECIPIENT_STATUS_COLORS[item.status] || 'bg-slate-100 text-slate-600'}">${escapeHtml(RECIPIENT_STATUS_LABELS[item.status] || item.status || '—')}</span></td>
                    <td class="px-3 py-1.5 text-slate-500 max-w-[220px] truncate" title="${escapeHtml(item.last_error || '')}">${escapeHtml((item.last_error || '').split('\n')[0].slice(0, 100))}</td>
                </tr>
            `).join('');
            skippedSection.classList.remove('hidden');
        }

        const logsEl = document.getElementById('cdet-logs');
        const logs = r.logs || [];
        if (!logs.length) {
            logsEl.innerHTML = '<span class="text-slate-400">Log yok</span>';
        } else {
            const LOG_COLORS = { error: 'text-red-400', success: 'text-green-400', wait: 'text-amber-300', process: 'text-blue-300', info: 'text-slate-300' };
            logsEl.innerHTML = logs.map(l => `<div class="${LOG_COLORS[l.type] || 'text-slate-300'}">${escapeHtml(l.message)}</div>`).join('');
        }
    } catch (err) {
        document.getElementById('cdet-logs').innerHTML = `<span class="text-error">${escapeHtml(err.message)}</span>`;
    }
}

document.getElementById('campaign-detail-close-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('campaign-detail-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
});
document.getElementById('campaign-detail-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.classList.add('hidden');
        e.currentTarget.classList.remove('flex');
    }
});
document.getElementById('refresh-reports-btn')?.addEventListener('click', loadReports);
document.getElementById('unavailable-whatsapp-refresh-btn')?.addEventListener('click', loadUnavailableWhatsAppRecipients);
document.getElementById('failed-recipients-refresh-btn')?.addEventListener('click', loadFailedRecipientsReport);
document.getElementById('sysevt-refresh-btn')?.addEventListener('click', loadSystemEvents);
document.getElementById('sysevt-severity-filter')?.addEventListener('change', loadSystemEvents);
document.getElementById('sysevt-type-filter')?.addEventListener('change', loadSystemEvents);

initializeDashboard();
switchTab('campaign');
