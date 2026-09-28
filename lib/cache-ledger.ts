import type { SessionState, WithParts } from "./state"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

/** One request's cache observation. */
export interface CacheSample {
    at: number
    /** Prompt tokens the provider was asked to process. */
    input: number
    /** Of those, how many it served from its prefix cache. */
    cached: number
    output: number
    /** input - cached. What the provider had to re-process. */
    miss: number
    /** cached / input, as a fraction. */
    hitPct: number
    /** The highest block id already accounted for when this sample arrived. */
    lastBlockId: number
}

/** What one fold cost and what it saved. */
export interface FoldEconomics {
    blockId: number
    topic: string
    /** Tokens the fold removed from the context. */
    compressed: number
    /** Tokens the summary takes up in its place. */
    summary: number
    /** Hit rate of the first request after the fold, as a fraction. */
    firstHitPct: number | undefined
    /** Requests observed between this fold and the next one. */
    turns: number
    /** Context tokens those requests would have carried without the fold. */
    avoided: number
    /** Tokens the provider had to re-process because of the fold. */
    repaid: number
    /** avoided - repaid. Negative means the fold did not pay for itself. */
    netSaved: number
}

const MAX_FOLDS = 20
const MAX_SAMPLES = 64

/**
 * Read the cache counters off the newest assistant message that actually
 * reported usage. The host writes usage per assistant turn, so this is a
 * reverse scan of a short array, not a walk of the conversation.
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
        const output = info.tokens?.output || 0
        if (output <= 0) continue

        const input = info.tokens?.input || 0
        const cached = info.tokens?.cache?.read || 0
        const miss = Math.max(0, input - cached)

        return {
            at,
            input,
            cached,
            output,
            miss,
            hitPct: input > 0 ? cached / input : 0,
            lastBlockId,
        }
    }

    return undefined
}

/**
 * Folds are detected by the high-water mark on block id rather than by an
 * event. DCP is what executes the fold, so nothing can slip past this, and it
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

/**
 * Settles a fold once the next one opens.
 *
 * `avoided` is what those turns would have carried had the fold not happened;
 * `repaid` is what the provider actually had to re-process instead. The
 * difference is the fold's real contribution, which is not the same as the
 * token count it removed -- a fold that invalidates the prefix cache can cost
 * more than it saves, and that is exactly what is not visible without this.
 */
export function settleFold(
    fold: { blockId: number; compressed: number; summary: number; topic: string },
    samples: CacheSample[],
): FoldEconomics {
    const firstHitPct = samples[0]?.hitPct
    const repaid = samples.reduce((total, sample) => total + sample.miss, 0)
    const savedPerTurn = Math.max(0, fold.compressed - fold.summary)

    return {
        blockId: fold.blockId,
        topic: fold.topic,
        compressed: fold.compressed,
        summary: fold.summary,
        firstHitPct,
        turns: samples.length,
        avoided: samples.reduce((total, sample) => total + sample.input, 0),
        repaid,
        // Both sides are input tokens, so they compare directly: what the fold
        // kept out of the context, minus what the provider had to re-process
        // because the fold moved the prefix.
        netSaved: samples.length * savedPerTurn - repaid,
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

export function pushBounded<T>(list: T[], item: T, max: number): T[] {
    const next = [...list, item]
    return next.length > max ? next.slice(next.length - max) : next
}

export { MAX_FOLDS, MAX_SAMPLES }
