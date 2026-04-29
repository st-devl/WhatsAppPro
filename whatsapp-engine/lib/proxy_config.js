function parseTrustProxy(value = process.env.TRUST_PROXY) {
    const raw = String(value ?? 'false').trim();
    if (!raw) return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    const numeric = Number.parseInt(raw, 10);
    if (String(numeric) === raw && numeric >= 0) return numeric;

    return raw;
}

module.exports = { parseTrustProxy };
