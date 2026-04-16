(function apiClientBootstrap(window) {
    const API_BASE = '/api/v1';

    function unwrapApiPayload(payload) {
        if (
            payload &&
            typeof payload === 'object' &&
            Object.prototype.hasOwnProperty.call(payload, 'data') &&
            Object.prototype.hasOwnProperty.call(payload, 'code')
        ) {
            return payload.data;
        }
        return payload;
    }

    function apiErrorMessage(payload, fallback) {
        if (!payload || typeof payload !== 'object') return fallback;
        return payload.error || payload.message || fallback;
    }

    function apiMeta(payload) {
        return payload && typeof payload === 'object' && payload.meta ? payload.meta : {};
    }

    async function request(url, options = {}, timeoutMs = 8000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
            const payload = await response.json();
            if (!response.ok) throw new Error(apiErrorMessage(payload, `${url} isteği başarısız`));
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchJson(url, options = {}, timeoutMs = 8000) {
        return unwrapApiPayload(await request(url, options, timeoutMs));
    }

    async function fetchEnvelope(url, options = {}, timeoutMs = 8000) {
        const payload = await request(url, options, timeoutMs);
        return {
            data: unwrapApiPayload(payload),
            meta: apiMeta(payload),
            code: payload?.code
        };
    }

    window.WhasAppCApi = {
        API_BASE,
        unwrapApiPayload,
        apiErrorMessage,
        apiMeta,
        fetchJson,
        fetchEnvelope
    };
})(window);
