import type { SessionState, WithParts } from "./state"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

/** One request's cache observation. */
export interface CacheSample {
    at: number
    /**
     * Prompt tokens the provider actually handled: fresh input plus the cache
     * writes it could not reuse. The host reports cache.read separately and it
     * is NOT a subset of input -- in this history 83% of turns report more
     * cache.read than input, and DCP's own getCurrentTokenUsage adds the two.
     */
    fresh: number
    /** Served from the provider's prefix cache. */
    cached: number
    /** fresh + cached, the prompt the provider was asked to process. */
    total: number
    /** cached / total, as a fraction. */
    hitPct: number
    /** The highest block id already accounted for when this sample arrived. */
    lastBlockId: number
}

/** What one fold did to the per-request prompt size. */
export interface FoldEconomics {
    blockId: number
    topic: string
    compressed: number
    summary: number
    /** Hit rate of the first request after the fold, as a fraction. */
    firstHitPct: number | undefined
    /** Requests observed after this fold, up to the next one. */
    turns: number
    /** Mean prompt per request over the window before the fold. */
    avgBefore: number
    /** Mean prompt per request over the window after it. */
    avgAfter: number
    /** avgBefore - avgAfter. Positive means each request got smaller. */
    deltaPerTurn: number
    /** deltaPerTurn x turns. Negative means the fold cost more than it saved. */
    netSaved: number
}

const MAX_FOLDS = 20
const MAX_SAMPLES = 96
/** Requests averaged on each side of a fold. */
export const CONTEXT_WINDOW = 20

/**
 * Read the cache counters off the newest assistant message that reported usage.
 * The host writes usage per assistant turn, so this is a short reverse scan
 * rather than a walk of the conversation.
 */
export function readCacheSample(
    messages: WithParts[],
    lastBlockId: number,
    at: number = Date.now(),
): CacheSample | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.info?.role !== "assistant") continue

        const info = message.info as AssistantMessage
        if ((info.tokens?.output || 0) <= 0) continue

        const cache = info.tokens?.cache
        const fresh = (info.tokens?.input || 0) + (cache?.write || 0)
        const cached = cache?.read || 0
        const total = fresh + cached

        return {
            at,
            fresh,
            cached,
            total,
            hitPct: total > 0 ? cached / total : 0,
            lastBlockId,
        }
    }

    return undefined
}

/**
 * Folds are detected by the high-water mark on block id rather than by an
 * event. DCP executes the fold itself, so nothing can slip past this, and it
 * costs one comparison per request instead of a subscription.
 */
export function detectNewFolds(
    state: SessionState,
    seenUpTo: number,
): Array<{ blockId: number; compressed: number; summary: number; topic: string }> {
    const found: Array<{ blockId: number; compressed: number; summary: number; topic: string }> = []
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.blockId <= seenUpTo) continue
        found.push({
            blockId: block.blockId,
            compressed: block.compressedTokens,
            summary: block.summaryTokens,
            topic: block.topic,
        })
    }
    return found.sort((a, b) => a.blockId - b.blockId)
}

function mean(values: number[]): number {
    if (values.length === 0) return 0
    return values.reduce((total, value) => total + value, 0) / values.length
}

/**
 * Settles a fold once the next one opens, because until then the window it is
 * responsible for is still open.
 *
 * The measurement is a comparison, not an attribution: what a request averaged
 * before the fold against what it averages after. Attributing each cache miss
 * to a cause is not available from inside a plugin -- knowing a cache expired
 * is the provider's knowledge, not ours -- and an approximation would look
 * precise while being a guess. What this does measure is the thing that
 * decides whether folding is worth doing: did the prompt get smaller.
 */
export function settleFold(
    fold: { blockId: number; compressed: number; summary: number; topic: string },
    window: CacheSample[],
    before: CacheSample[],
): FoldEconomics {
    const avgBefore = mean(before.slice(-CONTEXT_WINDOW).map((sample) => sample.total))
    const avgAfter = mean(window.map((sample) => sample.total))
    const deltaPerTurn = avgBefore - avgAfter

    return {
        blockId: fold.blockId,
        topic: fold.topic,
        compressed: fold.compressed,
        summary: fold.summary,
        firstHitPct: window[0]?.hitPct,
        turns: window.length,
        avgBefore,
        avgAfter,
        deltaPerTurn,
        netSaved: deltaPerTurn * window.length,
    }
}

/** The sample window that belongs to one fold: everything up to the next fold. */
export function samplesBetween(
    samples: CacheSample[],
    fromBlockId: number,
    toBlockId: number,
): CacheSample[] {
    return samples.filter(
        (sample) =>
            sample.lastBlockId >= fromBlockId && (toBlockId < 0 || sample.lastBlockId < toBlockId),
    )
}

/** The sample window before a fold, for the comparison. */
export function samplesBefore(samples: CacheSample[], blockId: number): CacheSample[] {
    return samples.filter((sample) => sample.lastBlockId < blockId)
}

export function pushBounded<T>(list: T[], item: T, max: number): T[] {
    const next = [...list, item]
    return next.length > max ? next.slice(next.length - max) : next
}

export { MAX_FOLDS, MAX_SAMPLES }
