(function uiHelpersBootstrap(window, document) {
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function showModal(id) {
        document.getElementById(id)?.classList.remove('hidden');
    }

    function hideModal(id) {
        document.getElementById(id)?.classList.add('hidden');
    }

    function getField(id) {
        return document.getElementById(id)?.value || '';
    }

    function setField(id, value = '') {
        const field = document.getElementById(id);
        if (field) field.value = value;
    }

    function clearFields(ids = []) {
        ids.forEach(id => setField(id, ''));
    }

    function readFields(fields = {}) {
        return Object.entries(fields).reduce((result, [key, id]) => {
            result[key] = getField(id).trim();
            return result;
        }, {});
    }

    function renderTableBody(id, options = {}) {
        const tbody = document.getElementById(id);
        if (!tbody) return;
        const rows = Array.isArray(options.rows) ? options.rows : [];
        if (rows.length === 0) {
            tbody.innerHTML = options.emptyHtml || '';
            return;
        }
        tbody.innerHTML = rows.map((row, index) => options.rowRenderer(row, index)).join('');
    }

    function showToast(message, type = 'info') {
        const colors = {
            info: 'bg-white text-primary border-primary/10',
            success: 'bg-white text-primary border-secondary/20',
            error: 'bg-white text-primary border-error/20'
        };
        const icons = { info: 'info', success: 'cloud_done', error: 'error' };
        const iconColors = {
            info: 'text-primary bg-primary/10',
            success: 'text-secondary bg-secondary/10',
            error: 'text-error bg-error/10'
        };
        const toast = document.createElement('div');
        toast.className = `fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] ${colors[type] || colors.info} shadow-2xl border px-6 py-4 rounded-2xl flex items-center gap-4 max-w-[calc(100vw-2rem)]`;
        toast.innerHTML = `
            <div class="w-10 h-10 ${iconColors[type] || iconColors.info} rounded-full flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1;">${icons[type] || icons.info}</span>
            </div>
            <div>
                <h5 class="text-xs font-bold">${type === 'error' ? 'İşlem Hatası' : type === 'success' ? 'İşlem Başarılı' : 'Bilgilendirme'}</h5>
                <p class="text-[10px] text-slate-500">${escapeHtml(message)}</p>
            </div>
            <button class="ml-2 text-slate-300 hover:text-slate-500" type="button"><span class="material-symbols-outlined text-lg">close</span></button>
        `;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    window.WhasAppCUI = {
        escapeHtml,
        showModal,
        hideModal,
        getField,
        setField,
        clearFields,
        readFields,
        renderTableBody,
        showToast
    };
})(window, document);
