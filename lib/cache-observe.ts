import {
    MAX_FOLDS,
    MAX_SAMPLES,
    detectNewFolds,
    pushBounded,
    readCacheSample,
    settleFold,
    samplesBetween,
} from "./cache-ledger"
import type { SessionState, WithParts } from "./state"

/**
 * One pass of the ledger. Called from the request path, so it reads the cache
 * counters off the newest assistant message and compares one high-water mark.
 * No subscription, no walking the conversation.
 *
 * A fold is settled when the *next* fold appears, because until then we do not
 * know how long the cache took to recover, and that window is the whole cost.
 */
export function recordCacheEconomics(state: SessionState, messages: WithParts[]): void {
    const newFolds = detectNewFolds(state, state.cacheLedgerSeenBlockId)

    if (newFolds.length > 0) {
        // Close out the previous fold over the window that just ended.
        if (state.cacheLedgerSeenBlockId > 0) {
            const previous = state.prune.messages.blocksById.get(state.cacheLedgerSeenBlockId)
            if (previous) {
                const window = samplesBetween(
                    state.cacheSamples,
                    state.cacheLedgerSeenBlockId,
                    newFolds[0]!.blockId,
                )
                state.foldEconomics = pushBounded(
                    state.foldEconomics,
                    settleFold(
                        {
                            blockId: previous.blockId,
                            compressed: previous.compressedTokens,
                            summary: previous.summaryTokens,
                            topic: previous.topic,
                        },
                        window,
                    ),
                    MAX_FOLDS,
                )
            }
        }
        state.cacheLedgerSeenBlockId = newFolds[newFolds.length - 1]!.blockId
    }

    const sample = readCacheSample(messages, state.cacheLedgerSeenBlockId)
    if (sample) {
        state.cacheSamples = pushBounded(state.cacheSamples, sample, MAX_SAMPLES)
    }
}
