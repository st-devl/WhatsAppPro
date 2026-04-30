const socket = window.io ? io({ timeout: 10000, reconnectionDelayMax: 5000 }) : null;
const unsavedContactsDraftKey = 'whatsappc.unsavedContacts.v1';
const API_BASE = window.WhasAppCApi.API_BASE;
const appState = window.WhasAppCState;
const ui = window.WhasAppCUI;
const messageRenderer = window.WhasAppCMessageRenderer;
let batchPauseCountdownTimer = null;
let currentFrontendRevision = null;
let releaseWatcherTimer = null;
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
    setActionButton('send-btn', !running);
    setActionButton('stop-btn', running);
    setActionButton('resume-btn', resumable && !!getActiveCampaignId());
    setActionButton('retry-btn', retryable && !!getActiveCampaignId());
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
    const batchPauseSeconds = Math.floor(Math.max(0, count - 1) / 50) * 40 * 60;
    return Math.max(1, Math.ceil(((count * (averageDelay + 3)) + batchPauseSeconds) / 60));
}

function updateCampaignEstimate(minutes) {
    const element = document.getElementById('prog-eta');
    if (element) element.innerText = formatEstimateMinutes(minutes);
}

function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateBatchPauseCountdown(untilIso) {
    const element = document.getElementById('prog-batch-pause');
    if (!element) return;
    if (batchPauseCountdownTimer) {
        clearInterval(batchPauseCountdownTimer);
        batchPauseCountdownTimer = null;
    }

    if (!untilIso) {
        element.innerText = 'MOLA: --';
        return;
    }

    const until = new Date(untilIso).getTime();
    if (!Number.isFinite(until)) {
        element.innerText = 'MOLA: --';
        return;
    }

    const render = () => {
        const remainingMs = until - Date.now();
        if (remainingMs <= 0) {
            element.innerText = 'MOLA: BAŞLIYOR';
            clearInterval(batchPauseCountdownTimer);
            batchPauseCountdownTimer = null;
            return;
        }
        element.innerText = `MOLA: ${formatCountdown(remainingMs)}`;
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
    let digits = String(phone || '').replace(/[^\d]/g, '');
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
    return group.contacts;
}

async function getSelectedCampaignContacts() {
    const selectedGroups = groups.filter(group => selectedCampaignGroupIds.has(group.id));
    await Promise.all(selectedGroups.map(group => ensureGroupContactsLoaded(group.id)));
    const groupContacts = selectedGroups.flatMap(group => group.contacts || []);
    return dedupeContacts([...groupContacts, ...getManualCampaignContacts()]);
}

function updateCampaignTargetSummary() {
    const selectedGroupsTotal = groups
        .filter(group => selectedCampaignGroupIds.has(group.id))
        .reduce((sum, group) => sum + getGroupContactCount(group), 0);
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
        const count = getGroupContactCount(group);
        const checked = selectedCampaignGroupIds.has(group.id);
        return `
            <label class="flex items-center justify-between p-3 rounded-lg border ${checked ? 'bg-secondary/5 border-secondary/20' : 'border-transparent hover:bg-slate-50 hover:border-slate-100'} transition-all cursor-pointer">
                <div class="flex items-center gap-3 min-w-0">
                    <input class="rounded border-slate-300 text-secondary focus:ring-secondary" type="checkbox" data-action="toggle-campaign-group" data-group-id="${escapeHtml(group.id)}" ${checked ? 'checked' : ''}>
                    <span class="text-sm font-medium text-slate-700 truncate" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
                </div>
                <span class="text-xs text-slate-400 font-bold whitespace-nowrap">${count} Kişi</span>
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
    document.getElementById('tab-campaign').className = tab === 'campaign' ? navActive : navInactive;
    document.getElementById('tab-contacts').className = tab === 'contacts' ? navActive : navInactive;
    document.getElementById('mobile-tab-campaign').className = tab === 'campaign' ? 'flex flex-col items-center justify-center text-secondary p-2' : 'flex flex-col items-center justify-center text-slate-400 p-2 opacity-60';
    document.getElementById('mobile-tab-contacts').className = tab === 'contacts' ? 'flex flex-col items-center justify-center text-secondary p-2' : 'flex flex-col items-center justify-center text-slate-400 p-2 opacity-60';
    if (tab === 'contacts') updateContactsTable();
}

if (!socket) {
    setPanelConnectionError('Socket.IO yüklenemedi');
}

socket?.on('connect_error', () => {
    setPanelConnectionError('Sunucu bağlantısı kurulamadı');
});

socket?.on('qr', qr => {
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

socket?.on('status', status => setWhatsAppUiStatus(status));

socket?.on('campaign-started', data => {
    setActiveCampaignId(data?.campaignId || data?.status?.id || getActiveCampaignId());
    setCampaignControls('running');
    updateCampaignEstimate(data?.status?.estimate_remaining_minutes);
    updateBatchPauseCountdown(null);
    if (data?.status?.progress !== undefined) {
        document.getElementById('prog-box').classList.remove('hidden');
        document.getElementById('prog-bar').style.width = `${data.status.progress}%`;
        document.getElementById('prog-text').innerText = `${Math.round(data.status.progress)}%`;
    }
});

socket?.on('log', data => {
    const logs = document.getElementById('logs');
    const div = document.createElement('div');
    const colorClass = data.type === 'error' ? 'text-red-300' : (data.type === 'success' ? 'text-secondary-fixed-dim' : (data.type === 'wait' ? 'text-amber-300' : 'text-slate-300'));
    div.className = colorClass;
    div.innerText = `> ${data.message}`;
    logs.prepend(div);
    while (logs.children.length > 300) logs.removeChild(logs.lastChild);

    if (data.progress !== undefined) {
        document.getElementById('prog-box').classList.remove('hidden');
        document.getElementById('prog-bar').style.width = `${data.progress}%`;
        document.getElementById('prog-text').innerText = `${Math.round(data.progress)}%`;
        document.getElementById('prog-count').innerText = data.message;
    }
    if (data.estimate_remaining_minutes !== undefined) updateCampaignEstimate(data.estimate_remaining_minutes);
    if (data.batch_pause_until !== undefined) updateBatchPauseCountdown(data.batch_pause_until);

    if (data.done) {
        document.getElementById('prog-box').classList.remove('hidden');
        document.getElementById('prog-bar').style.width = '100%';
        document.getElementById('prog-text').innerText = '100%';
        document.getElementById('prog-count').innerText = data.message;
        updateCampaignEstimate(0);
        updateBatchPauseCountdown(null);
        setCampaignControls('completed');
        showCampaignCompleteModal();
        return;
    }

    if (data.message.toLocaleLowerCase('tr-TR').includes('durduruldu')) {
        setCampaignControls('stopped');
    }
});

function showCampaignCompleteModal() {
    document.getElementById('campaign-complete-modal').classList.remove('hidden');
    document.getElementById('campaign-complete-modal').classList.add('flex');
}

function closeCampaignCompleteModal() {
    document.getElementById('campaign-complete-modal').classList.add('hidden');
    document.getElementById('campaign-complete-modal').classList.remove('flex');
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
    ui.setField('save-group-name', ui.getField('quick-group-name').trim() || (activeGroup ? activeGroup.name : ''));
    document.getElementById('save-group-summary').innerText = `${currentContacts.length} kişi kaydedilecek.`;
    showModal('save-group-modal');
    setTimeout(() => nameInput.focus(), 30);
}

function saveInlineGroupName() {
    openGroupSaveModal();
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
        ui.clearFields(['quick-group-name']);
        clearUnsavedContactsDraft();
        showToast(`"${groupName}" grubuna ${currentContacts.length} kişi kaydedildi`, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
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
            const group = groups.find(g => g.id === activeGroupId);
            if (group) {
                group.contacts = [...currentContacts];
                group.contactsLoaded = true;
                group.contact_count = currentContacts.length;
            }
            hideModal('manual-modal');
            updateContactsTable();
            renderGroupsSidebar();
            renderCampaignGroupChecklist();
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
            const group = groups.find(g => g.id === activeGroupId);
            if (group) {
                group.contacts = [...currentContacts];
                group.contactsLoaded = true;
                group.contact_count = currentContacts.length;
            }
            updateContactsTable();
            renderGroupsSidebar();
            renderCampaignGroupChecklist();
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
            const group = groups.find(g => g.id === activeGroupId);
            if (group) {
                group.contacts = [...currentContacts];
                group.contactsLoaded = true;
                group.contact_count = currentContacts.length;
            }
            closeEditContactModal();
            updateContactsTable();
            renderGroupsSidebar();
            renderCampaignGroupChecklist();
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
    document.getElementById('num-badge').innerText = currentContacts.length;
    document.getElementById('contacts-pagination-label').innerText = `${list.length} / ${currentContacts.length} gösteriliyor`;
    if (currentContacts.length === 0) {
        ui.renderTableBody('contacts-table-body', {
            rows: [],
            emptyHtml: '<tr><td colspan="4" class="p-20 text-center text-slate-300 font-bold uppercase text-[10px]">Rehber Boş</td></tr>'
        });
        return;
    }
    if (list.length === 0) {
        ui.renderTableBody('contacts-table-body', {
            rows: [],
            emptyHtml: '<tr><td colspan="4" class="p-20 text-center text-slate-300 font-bold uppercase text-[10px]">Arama sonucu bulunamadı</td></tr>'
        });
        return;
    }
    ui.renderTableBody('contacts-table-body', {
        rows: list,
        rowRenderer: (c, i) => `
        <tr class="hover:bg-slate-50/50 transition-colors">
            <td class="px-6 py-4 text-sm text-slate-500 font-medium">${i + 1}</td>
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-xs font-bold text-emerald-600">${escapeHtml(getInitials(c))}</div>
                    <span class="text-sm font-semibold text-slate-900">${escapeHtml(`${c.name || ''} ${c.surname || ''}`.trim() || 'İsimsiz')}</span>
                </div>
            </td>
            <td class="px-6 py-4 text-sm text-slate-600 font-mono">${escapeHtml(c.phone)}</td>
            <td class="px-6 py-4 text-right">
                <div class="inline-flex items-center gap-1">
                    <button data-action="edit-contact" data-contact-index="${i}" class="p-1.5 rounded-lg text-slate-400 hover:text-secondary hover:bg-secondary/5 transition-all" title="Kişiyi düzenle">
                        <span class="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button data-action="remove-contact" data-contact-index="${i}" class="p-1.5 rounded-lg text-slate-400 hover:text-error hover:bg-error/5 transition-all" title="Kişiyi sil">
                        <span class="material-symbols-outlined text-lg">delete</span>
                    </button>
                </div>
            </td>
        </tr>
        `
    });
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

async function startCampaign() {
    if (!socket) return alert('Sunucu bağlantısı kurulamadı. Sayfayı yenileyin veya sunucu loglarını kontrol edin.');
    const text = ui.getField('message');
    let targetContacts = [];
    try {
        targetContacts = await getSelectedCampaignContacts();
    } catch (err) {
        showToast('Hedef kişiler yüklenemedi: ' + err.message, 'error');
        return;
    }

    if (!text || targetContacts.length === 0) return alert('Mesaj içeriği ve hedef numara/grup boş olamaz.');
    if (!validateMessageTemplateOrShow(text, targetContacts[0] || previewContact())) return;
    setActiveCampaignId(null);
    setCampaignControls('running');
    document.getElementById('prog-box').classList.remove('hidden');
    updateCampaignEstimate(estimateMinutesForContacts(targetContacts.length));
    updateBatchPauseCountdown(null);

    const delayRange = [
        parseInt(document.getElementById('min-delay').value),
        parseInt(document.getElementById('max-delay').value)
    ];
    const dailyLimit = parseInt(document.getElementById('daily-limit').value);

    socket.emit('start-bulk', {
        contacts: targetContacts,
        message: text,
        delayRange,
        dailyLimit
    });
}

function stopCampaign() {
    if (!socket) return;
    socket.emit('stop-bulk', { campaignId: getActiveCampaignId() });
}

function resumeCampaign() {
    const campaignId = getActiveCampaignId();
    if (!socket || !campaignId) return showToast('Devam ettirilecek kampanya bulunamadı', 'error');
    setCampaignControls('running');
    socket.emit('resume-bulk', { campaignId });
}

function retryCampaign() {
    const campaignId = getActiveCampaignId();
    if (!socket || !campaignId) return showToast('Retry edilecek kampanya bulunamadı', 'error');
    setCampaignControls('running');
    socket.emit('retry-bulk', { campaignId });
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
            return `
                <div data-action="select-group" data-group-id="${escapeHtml(g.id)}" class="${active ? 'bg-surface-container-lowest border-l-4 border-emerald-600 shadow-sm' : 'bg-transparent hover:bg-slate-200/50'} p-4 rounded-xl flex items-center justify-between group cursor-pointer transition-colors">
                    <div class="min-w-0">
                        <p class="text-sm ${active ? 'font-bold text-slate-900' : 'font-medium text-slate-700'} truncate" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</p>
                        <p class="text-[11px] text-slate-500">${formatDate(g.created_at || g.createdAt)}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="${active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'} text-[10px] font-bold px-2 py-0.5 rounded-full">${getGroupContactCount(g)}</span>
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

async function checkActiveCampaign() {
    try {
        const data = await fetchJson(`${API_BASE}/campaign-status`);
        if (data.campaign) {
            setActiveCampaignId(data.campaign.id || getActiveCampaignId());
            setCampaignControls(data.campaign.status);
            document.getElementById('prog-box').classList.remove('hidden');
            document.getElementById('prog-bar').style.width = `${data.campaign.progress}%`;
            document.getElementById('prog-text').innerText = `${Math.round(data.campaign.progress)}%`;
            updateCampaignEstimate(data.campaign.estimate_remaining_minutes);
            updateBatchPauseCountdown(null);
            document.getElementById('prog-count').innerText = data.campaign.status === 'running'
                ? 'Kampanya devam ediyor...'
                : `Son durum: ${data.campaign.status}`;

            const logContainer = document.getElementById('logs');
            logContainer.innerHTML = '';
            data.campaign.logs.slice(-300).forEach(log => {
                const div = document.createElement('div');
                div.className = log.type === 'error' ? 'text-red-300' : log.type === 'success' ? 'text-secondary-fixed-dim' : log.type === 'wait' ? 'text-amber-300' : 'text-slate-300';
                div.innerHTML = `[${new Date(log.timestamp).toLocaleTimeString()}] ${escapeHtml(log.message)}`;
                logContainer.appendChild(div);
            });
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    } catch (err) {
        console.error('Kampanya durumu alınamadı', err);
    }
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
    bindClick('manual-open-card', () => showModal('manual-modal'));
    bindClick('download-sample-card', downloadSample);
    bindClick('save-inline-group-btn', saveInlineGroupName);
    bindClick('manual-cancel-btn', () => hideModal('manual-modal'));
    bindClick('manual-save-btn', saveManualContact);
    bindClick('edit-contact-cancel-btn', closeEditContactModal);
    bindClick('edit-contact-save-btn', saveEditedContact);
    bindClick('group-save-cancel-btn', closeGroupSaveModal);
    bindClick('group-save-confirm-btn', saveCurrentListAsGroup);
    bindClick('template-cancel-btn', () => hideModal('template-modal'));
    bindClick('template-save-btn', saveTemplate);
    bindClick('campaign-complete-close-btn', closeCampaignCompleteModal);
    bindClick('mobile-manual-open-btn', () => showModal('manual-modal'));
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
        if (button.dataset.action === 'edit-contact') openEditContact(index);
        if (button.dataset.action === 'remove-contact') removeContact(index);
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
    document.getElementById('send-btn').addEventListener('click', startCampaign);
    document.getElementById('stop-btn').addEventListener('click', stopCampaign);
    document.getElementById('resume-btn').addEventListener('click', resumeCampaign);
    document.getElementById('retry-btn').addEventListener('click', retryCampaign);
    document.getElementById('save-group-name').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentListAsGroup();
    });
    document.getElementById('quick-group-name').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveInlineGroupName();
    });
    setWhatsAppUiStatus('disconnected', 'BAĞLI DEĞİL');
    updateDelayLabel();
    initReleaseVersion().then(startReleaseWatcher);
    initTemplates();
    loadGroups();
    refreshRuntimeStatus();
    setInterval(refreshRuntimeStatus, 15000);
    setTimeout(checkActiveCampaign, 1000);
}

initializeDashboard();
switchTab('campaign');
