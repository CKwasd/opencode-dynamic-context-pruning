import assert from "node:assert/strict"
import test from "node:test"
import { detectNewFolds, readCacheSample, settleFold, samplesBetween } from "../lib/cache-ledger"
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

test("a message with no reported usage yields no sample", () => {
    assert.equal(readCacheSample([], 0), undefined)
    const state = withBlock(1, 100, 10)
    assert.equal(readCacheSample([assistant("a", 0, 0, 0)], 0), undefined)
    assert.ok(state)
})

test("the newest assistant message with usage is the sample", () => {
    const sample = readCacheSample([assistant("a", 8000, 4000), assistant("b", 9000, 8500)], 3)
    assert.ok(sample)
    assert.equal(sample.input, 9000)
    assert.equal(sample.cached, 8500)
    assert.equal(sample.miss, 500)
    assert.equal(sample.lastBlockId, 3)
    assert.ok(Math.abs(sample.hitPct - 8500 / 9000) < 1e-9)
})

test("miss is clamped at zero rather than going negative", () => {
    // Some providers report cache.read above input when a prefix is shared
    // across requests. A negative miss would silently inflate the savings.
    const sample = readCacheSample([assistant("a", 100, 250)], 0)
    assert.ok(sample)
    assert.equal(sample.miss, 0)
})

test("folds are found by the high-water mark, not by an event", () => {
    const state = withBlock(1, 100, 10)
    for (const [id, compressed, summary] of [
        [2, 200, 20],
        [3, 300, 30],
    ] as const) {
        state.prune.messages.blocksById.set(id, {
            ...state.prune.messages.blocksById.get(1)!,
            blockId: id,
            compressedTokens: compressed,
            summaryTokens: summary,
        })
    }
    const found = detectNewFolds(state, 1)
    assert.deepEqual(
        found.map((fold) => fold.blockId),
        [2, 3],
    )
})

test("a fold's window is the turns up to the next fold", () => {
    const samples = [
        { at: 1, input: 100, cached: 90, output: 1, miss: 10, hitPct: 0.9, lastBlockId: 1 },
        { at: 2, input: 100, cached: 20, output: 1, miss: 80, hitPct: 0.2, lastBlockId: 1 },
        { at: 3, input: 100, cached: 95, output: 1, miss: 5, hitPct: 0.95, lastBlockId: 1 },
        { at: 4, input: 100, cached: 50, output: 1, miss: 50, hitPct: 0.5, lastBlockId: 2 },
    ]
    const window = samplesBetween(samples, 1, 2)
    assert.equal(window.length, 3, "the sample at block 2 belongs to the next fold")
    assert.equal(window[0]!.at, 1)
    assert.equal(window[2]!.at, 3)
})

test("net saved is context kept out minus cache repaid", () => {
    // Two turns, 2000 tokens removed, 400 spent on the summary, 600 repaid to
    // the provider: 2 * 1600 - 600 = 2600.
    const samples = [
        { at: 1, input: 3000, cached: 2400, output: 1, miss: 600, hitPct: 0.8, lastBlockId: 1 },
        { at: 2, input: 3000, cached: 3000, output: 1, miss: 0, hitPct: 1, lastBlockId: 1 },
    ]
    const fold = settleFold({ blockId: 1, compressed: 2000, summary: 400, topic: "work" }, samples)
    assert.equal(fold.turns, 2)
    assert.equal(fold.repaid, 600)
    assert.equal(fold.firstHitPct, 0.8)
    assert.equal(fold.netSaved, 2 * 1600 - 600)
})

test("a fold that costs more than it saves reports a negative net", () => {
    // The number this exists to produce. A fold can remove a lot of context and
    // still be a loss if it invalidates the prefix for many turns.
    // A small fold that still knocks the prefix cache out for several turns:
    // 50 tokens kept out per turn against 1000 re-processed per turn.
    const samples = Array.from({ length: 6 }, () => ({
        at: 1,
        input: 1000,
        cached: 0,
        output: 1,
        miss: 1000,
        hitPct: 0,
        lastBlockId: 1,
    }))
    const fold = settleFold({ blockId: 1, compressed: 150, summary: 100, topic: "small" }, samples)
    assert.ok(fold.netSaved < 0, `expected a loss, got ${fold.netSaved}`)
    assert.equal(fold.netSaved, 6 * 50 - 6000)
})

test("a fold is settled only once the next one opens", () => {
    const state = withBlock(1, 2000, 400)
    // Turn 1: block 1 exists, so the first observation attributes to it.
    recordCacheEconomics(state, [assistant("a", 3000, 2400)])
    assert.equal(state.cacheLedgerSeenBlockId, 1)
    assert.equal(state.foldEconomics.length, 0, "nothing to settle yet")

    // Turn 2: still block 1, a second sample in its window.
    recordCacheEconomics(state, [assistant("a", 3000, 2400), assistant("b", 3000, 3000)])
    assert.equal(state.foldEconomics.length, 0)

    // Turn 3: block 2 appears, which closes block 1's window.
    withBlock(2, 500, 50)
    state.prune.messages.blocksById.set(2, {
        ...state.prune.messages.blocksById.get(1)!,
        blockId: 2,
    })
    recordCacheEconomics(state, [
        assistant("a", 3000, 2400),
        assistant("b", 3000, 3000),
        assistant("c", 1000, 500),
    ])

    assert.equal(state.foldEconomics.length, 1)
    const settled = state.foldEconomics[0]!
    assert.equal(settled.blockId, 1)
    assert.equal(settled.compressed, 2000)
    assert.equal(settled.turns, 2)
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
                turns: 2,
                avoided: 6000,
                repaid: 600,
                netSaved: 2600,
            },
            {
                blockId: 2,
                topic: "bad",
                compressed: 1500,
                summary: 100,
                firstHitPct: 0,
                turns: 6,
                avoided: 6000,
                repaid: 6000,
                netSaved: -2400,
            },
        ],
    )

    assert.match(text, /Fold economics/)
    // Newest first, so the most recent fold is on top.
    assert.ok(text.indexOf("block 2") < text.indexOf("block 1"), "newest fold first")
    assert.match(text, /block 1: \+2\.6K tokens over 2 turn\(s\)/)
    assert.match(text, /block 2: -2\.4K tokens over 6 turn\(s\)/)
    assert.match(text, /Net:\s+\+200 tokens\s+\(2 fold\(s\) settled\)/)
    // The unprofitable fold has to be visible, or the number means nothing.
    assert.ok(!/2\.4K saved/.test(text))
})
