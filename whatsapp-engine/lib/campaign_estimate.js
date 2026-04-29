const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_PAUSE_MINUTES = 40;

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

    const batchSize = Number.parseInt(input.batchSize ?? input.batch_size ?? DEFAULT_BATCH_SIZE, 10);
    const batchPauseMinutes = Number.parseInt(input.batchPauseMinutes ?? input.batch_pause_minutes ?? DEFAULT_BATCH_PAUSE_MINUTES, 10);
    const pauseCount = batchSize > 0 && batchPauseMinutes > 0 ? Math.floor((remaining - 1) / batchSize) : 0;
    const perRecipientSeconds = averageDelaySeconds(input) + 3;
    const batchPauseSeconds = pauseCount * batchPauseMinutes * 60;
    return Math.max(60, Math.round((remaining * perRecipientSeconds) + batchPauseSeconds));
}

function estimateRemainingMinutes(input = {}) {
    const seconds = estimateRemainingSeconds(input);
    return seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 0;
}

module.exports = {
    DEFAULT_BATCH_SIZE,
    DEFAULT_BATCH_PAUSE_MINUTES,
    averageDelaySeconds,
    estimateRemainingSeconds,
    estimateRemainingMinutes
};
