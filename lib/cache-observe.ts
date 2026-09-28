import {
    MAX_FOLDS,
    MAX_SAMPLES,
    detectNewFolds,
    pushBounded,
    readCacheSample,
    samplesBefore,
    samplesBetween,
    settleFold,
} from "./cache-ledger"
import type { SessionState, WithParts } from "./state"

/**
 * One pass of the ledger. Called from the request path, so it reads the cache
 * counters off the newest assistant message and compares one high-water mark.
 * No subscription, no walking the conversation.
 *
 * A fold is settled when the *next* one appears, because until then we do not
 * know how long the request size stayed changed, and that window is the whole
 * measurement.
 */
export function recordCacheEconomics(state: SessionState, messages: WithParts[]): void {
    const newFolds = detectNewFolds(state, state.cacheLedgerSeenBlockId)

    if (newFolds.length > 0) {
        const previousId = state.cacheLedgerSeenBlockId
        if (previousId > 0) {
            const previous = state.prune.messages.blocksById.get(previousId)
            if (previous) {
                const window = samplesBetween(state.cacheSamples, previousId, newFolds[0]!.blockId)
                const before = samplesBefore(state.cacheSamples, previousId)
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
                        before,
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
