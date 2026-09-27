export function formatDuration(ms: number): string {
    const safeMs = Math.max(0, Math.round(ms))
    if (safeMs < 1000) return `${safeMs} ms`

    const totalSeconds = safeMs / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`

    const wholeSeconds = Math.floor(totalSeconds)
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    const seconds = wholeSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    return `${minutes}m ${seconds}s`
}

/**
 * Compression ratio, honestly rendered.
 *
 * The old version clamped the result up to 1, which turned a 0.82:1 -- a
 * summary larger than the range it replaced, so the context grew -- into a
 * cheerful "1:1". Losing tokens is the entire point of compressing, so a ratio
 * below one is the one number that must never be rounded away.
 */
export function formatRatio(inputTokens: number, outputTokens: number): string {
    if (inputTokens <= 0) return "0:1"
    if (outputTokens <= 0) return "∞:1"
    if (outputTokens > inputTokens) {
        return `${(inputTokens / outputTokens).toFixed(2)}:1 (grew)`
    }
    return `${Math.max(1, Math.round(inputTokens / outputTokens))}:1`
}

export function pct(value: number, total: number): string {
    if (total <= 0) return "0.0%"
    return `${((value / total) * 100).toFixed(1)}%`
}
