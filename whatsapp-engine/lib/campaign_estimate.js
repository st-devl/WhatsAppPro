const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_PAUSE_MINUTES = 15;
const DEFAULT_LONG_PAUSE_SIZE = 250;
const DEFAULT_LONG_PAUSE_MINUTES = 65;

function averageDelaySeconds(runOrInput = {}) {
    const minMs = Number(runOrInput.delay_min_ms || 0);
    const maxMs = Number(runOrInput.delay_max_ms || 0);
    if (minMs > 0 && maxMs > 0) return ((minMs + maxMs) / 2) / 1000;

    const delayRange = Array.isArray(runOrInput.delayRange) ? runOrInput.delayRange : [];
    const minSec = Number.parseInt(delayRange[0], 10);
    const maxSec = Number.parseInt(delayRange[1], 10);
    if (Number.isFinite(minSec) && Number.isFinite(maxSec) && minSec > 0 && maxSec > 0) {
        return (minSec + maxSec) / 2;
    }

    return 55;
}

function estimateRemainingSeconds(input = {}) {
    const remaining = Math.max(0, Number.parseInt(input.remaining, 10) || 0);
    if (remaining === 0) return 0;

    const sentCount = Math.max(0, Number.parseInt(input.sentCount ?? input.sent_count ?? 0, 10) || 0);
    const countPauses = (size) => {
        const parsed = Number.parseInt(size, 10);
        if (!Number.isFinite(parsed) || parsed <= 0 || remaining <= 0) return 0;
        return Math.floor((sentCount + remaining - 1) / parsed) - Math.floor(sentCount / parsed);
    };
    const batchSize = Number.parseInt(input.batchSize ?? input.batch_size ?? DEFAULT_BATCH_SIZE, 10);
    const batchPauseMinutes = Number.parseInt(input.batchPauseMinutes ?? input.batch_pause_minutes ?? DEFAULT_BATCH_PAUSE_MINUTES, 10);
    const longPauseSize = Number.parseInt(input.longPauseSize ?? input.long_pause_size ?? DEFAULT_LONG_PAUSE_SIZE, 10);
    const longPauseMinutes = Number.parseInt(input.longPauseMinutes ?? input.long_pause_minutes ?? DEFAULT_LONG_PAUSE_MINUTES, 10);
    const batchPauseCount = batchSize > 0 && batchPauseMinutes > 0 ? countPauses(batchSize) : 0;
    const longPauseCount = longPauseSize > 0 && longPauseMinutes > 0 ? countPauses(longPauseSize) : 0;
    const overlappingPauseCount = batchSize > 0 && longPauseSize > 0 && longPauseSize % batchSize === 0
        ? longPauseCount
        : 0;
    const perRecipientSeconds = averageDelaySeconds(input) + 3;
    const batchPauseSeconds = Math.max(0, batchPauseCount - overlappingPauseCount) * batchPauseMinutes * 60;
    const longPauseSeconds = longPauseCount * longPauseMinutes * 60;
    return Math.max(60, Math.round((remaining * perRecipientSeconds) + batchPauseSeconds + longPauseSeconds));
}

function estimateRemainingMinutes(input = {}) {
    const seconds = estimateRemainingSeconds(input);
    return seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 0;
}

module.exports = {
    DEFAULT_BATCH_SIZE,
    DEFAULT_BATCH_PAUSE_MINUTES,
    DEFAULT_LONG_PAUSE_SIZE,
    DEFAULT_LONG_PAUSE_MINUTES,
    averageDelaySeconds,
    estimateRemainingSeconds,
    estimateRemainingMinutes
};
