import assert from "node:assert/strict"
import test from "node:test"
import {
    CONTEXT_WINDOW,
    detectNewFolds,
    readCacheSample,
    samplesBefore,
    samplesBetween,
    settleFold,
} from "../lib/cache-ledger"
import { recordCacheEconomics } from "../lib/cache-observe"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { formatStatsMessage } from "../lib/commands/stats"

function assistant(id: string, input: number, cached: number, output = 50): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            time: { created: 1 },
            sessionID: "s1",
            tokens: { input, output, reasoning: 0, cache: { read: cached, write: 0 } },
        },
        parts: [{ type: "text", text: "reply" }],
    } as unknown as WithParts
}

function withBlock(id: number, compressed: number, summary: number): SessionState {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(id, {
        blockId: id,
        runId: id,
        active: true,
        deactivatedByUser: false,
        compressedTokens: compressed,
        summaryTokens: summary,
        durationMs: 5,
        topic: `t${id}`,
        startId: "a",
        endId: "b",
        anchorMessageId: "a",
        compressMessageId: "b",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
    } as never)
    state.prune.messages.activeBlockIds.add(id)
    return state
}

function addBlock(state: SessionState, id: number, compressed: number, summary: number): void {
    state.prune.messages.blocksById.set(id, {
        ...state.prune.messages.blocksById.get(1)!,
        blockId: id,
        compressedTokens: compressed,
        summaryTokens: summary,
    })
}

test("a message with no reported usage yields no sample", () => {
    assert.equal(readCacheSample([], 0), undefined)
    assert.equal(readCacheSample([assistant("a", 0, 0, 0)], 0), undefined)
})

test("cache read is added to input, not subtracted from it", () => {
    // The host reports them as separate contributions: 83% of turns in this
    // project's own history report more cache.read than input, and DCP's
    // getCurrentTokenUsage adds them. Treating read as a subset produced
    // hit rates over 100% and a negative miss.
    const sample = readCacheSample([assistant("a", 149, 8832)], 3)
    assert.ok(sample)
    assert.equal(sample.fresh, 149)
    assert.equal(sample.cached, 8832)
    assert.equal(sample.total, 8981)
    assert.ok(Math.abs(sample.hitPct - 8832 / 8981) < 1e-9)
    assert.ok(sample.hitPct <= 1, "a hit rate cannot exceed the prompt")
})

test("cache writes count as fresh tokens", () => {
    const message = assistant("a", 100, 900)
    ;(message.info as unknown as Record<string, unknown>).tokens = {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 900, write: 40 },
    }
    const sample = readCacheSample([message], 0)
    assert.ok(sample)
    assert.equal(sample.fresh, 140)
    assert.equal(sample.total, 1040)
})

test("folds are found by the high-water mark, not by an event", () => {
    const state = withBlock(1, 100, 10)
    addBlock(state, 2, 200, 20)
    addBlock(state, 3, 300, 30)
    const found = detectNewFolds(state, 1)
    assert.deepEqual(
        found.map((fold) => fold.blockId),
        [2, 3],
    )
})

test("the window and the before-window are separated by the fold", () => {
    const sample = (blockId: number, total: number) => ({
        at: blockId,
        fresh: 10,
        cached: total - 10,
        total,
        hitPct: (total - 10) / total,
        lastBlockId: blockId,
    })
    const samples = [sample(1, 1000), sample(1, 1000), sample(2, 400), sample(2, 400)]

    assert.equal(samplesBefore(samples, 2).length, 2, "the two before block 2")
    assert.equal(samplesBetween(samples, 2, -1).length, 2, "the two at block 2")
    assert.equal(samplesBetween(samples, 1, 2).length, 2)
})

test("a fold that shrinks the prompt reports a positive net", () => {
    // Before: 5000 prompt per request. After: 2000. Over 4 requests that is
    // 3000 x 4.
    const sample = (total: number) => ({
        at: 1,
        fresh: 100,
        cached: total - 100,
        total,
        hitPct: 0.9,
        lastBlockId: 1,
    })
    const before = [sample(5000), sample(5000), sample(5000), sample(5000)]
    const after = [sample(2000), sample(2000), sample(2000), sample(2000)]

    const fold = settleFold(
        { blockId: 1, compressed: 2000, summary: 400, topic: "work" },
        after,
        before,
    )
    assert.equal(fold.avgBefore, 5000)
    assert.equal(fold.avgAfter, 2000)
    assert.equal(fold.deltaPerTurn, 3000)
    assert.equal(fold.netSaved, 12000)
    assert.equal(fold.turns, 4)
})

test("a fold that does not shrink the prompt reports a negative net", () => {
    const sample = (total: number) => ({
        at: 1,
        fresh: 100,
        cached: total - 100,
        total,
        hitPct: 0.5,
        lastBlockId: 1,
    })
    const fold = settleFold(
        { blockId: 1, compressed: 150, summary: 100, topic: "small" },
        [sample(9000), sample(9000)],
        [sample(7000), sample(7000)],
    )
    assert.ok(fold.netSaved < 0, `expected a loss, got ${fold.netSaved}`)
    assert.equal(fold.netSaved, -4000)
})

test("the before window is capped so one busy stretch cannot dominate it", () => {
    assert.ok(CONTEXT_WINDOW > 0 && CONTEXT_WINDOW <= 32)
    const sample = (total: number) => ({
        at: 1,
        fresh: 1,
        cached: total - 1,
        total,
        hitPct: 0.5,
        lastBlockId: 1,
    })
    const long = Array.from({ length: CONTEXT_WINDOW * 3 }, () => sample(100))
    const fold = settleFold(
        { blockId: 1, compressed: 10, summary: 1, topic: "t" },
        [sample(50)],
        long,
    )
    // The average over the whole run and over the last CONTEXT_WINDOW are the
    // same here, which is the point: the older samples are not what is read.
    assert.equal(fold.avgBefore, 100)
})

test("a fold is settled only once the next one opens", () => {
    const state = withBlock(1, 2000, 400)
    recordCacheEconomics(state, [assistant("a", 3000, 2000)])
    assert.equal(state.cacheLedgerSeenBlockId, 1)
    assert.equal(state.foldEconomics.length, 0, "its window is still open")

    recordCacheEconomics(state, [assistant("a", 3000, 2000), assistant("b", 3000, 2600)])
    assert.equal(state.foldEconomics.length, 0)

    addBlock(state, 2, 500, 50)
    recordCacheEconomics(state, [
        assistant("a", 3000, 2000),
        assistant("b", 3000, 2600),
        assistant("c", 1000, 800),
    ])
    assert.equal(state.foldEconomics.length, 1)
    assert.equal(state.foldEconomics[0]!.blockId, 1)
    assert.equal(state.cacheLedgerSeenBlockId, 2)
})

test("stats reports the folds, including an unprofitable one", () => {
    const text = formatStatsMessage(
        1000,
        100,
        2,
        4,
        50,
        { totalTokens: 5000, totalTools: 10, totalMessages: 40, sessionCount: 3 },
        0,
        [
            {
                blockId: 1,
                topic: "good",
                compressed: 2000,
                summary: 400,
                firstHitPct: 0.8,
                turns: 4,
                avgBefore: 5000,
                avgAfter: 2000,
                deltaPerTurn: 3000,
                netSaved: 12000,
            },
            {
                blockId: 2,
                topic: "bad",
                compressed: 150,
                summary: 100,
                firstHitPct: 0.5,
                turns: 2,
                avgBefore: 7000,
                avgAfter: 9000,
                deltaPerTurn: -2000,
                netSaved: -4000,
            },
        ],
    )

    assert.match(text, /Fold economics/)
    // Newest first, so the most recent fold is on top.
    assert.ok(text.indexOf("block 2") < text.indexOf("block 1"), "newest fold first")
    assert.match(text, /block 1: \+12K tokens over 4 turn\(s\)/)
    assert.match(text, /block 2: -4K tokens over 2 turn\(s\)/)
    assert.match(text, /Net:\s+\+8K tokens\s+\(2 fold\(s\) settled\)/)
    // The prompt sizes, so the number can be checked rather than trusted.
    assert.match(text, /prompt\/turn 5K tokens -> 2K tokens/)
    assert.match(text, /prompt\/turn 7K tokens -> 9K tokens/)
})
