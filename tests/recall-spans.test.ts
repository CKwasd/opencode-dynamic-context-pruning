import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { findRecallMatches, renderRecallResult } from "../lib/recall/index"

const logger = new Logger(false)
const config = {
    manualMode: { automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: [],
    strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
    },
} as PluginConfig

function message(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 }, sessionID: "s1" },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

/** A session where messages 2..4 are folded into block 1. */
function folded(idFormat: "xml" | "compact") {
    const state = createSessionState(idFormat)
    const messages = [
        message("raw-1", "opening"),
        message("raw-2", "needle lives here"),
        message("raw-3", "middle of the block"),
        message("raw-4", "also inside the block"),
        message("raw-5", "closing"),
    ]
    assignMessageRefs(state, messages)
    syncToolCache(state, config, logger, messages)

    const block = state.prune.messages.blocksById.get(1)
    state.prune.messages.blocksById.set(1, {
        ...(block ?? {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 20,
            durationMs: 5,
            topic: "t",
            startId: "raw-2",
            endId: "raw-4",
            anchorMessageId: "raw-2",
            compressMessageId: "raw-5",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
        }),
        blockId: 1,
        effectiveMessageIds: ["raw-2", "raw-3", "raw-4"],
    })

    return { state, messages }
}

for (const idFormat of ["xml", "compact"] as const) {
    test(`a recall hit inside a block reports that block's span (${idFormat})`, () => {
        const { state, messages } = folded(idFormat)
        const matches = findRecallMatches(state, "needle", idFormat, messages, 10, 200)
        assert.equal(matches.length, 1)

        const rendered = renderRecallResult(matches, ["needle"])
        // The block id alone says "something is in here". The span says where,
        // which is what a range read has to aim at.
        assert.match(rendered, /\d+ msgs\]/)
        assert.match(rendered, /3 msgs\]/)
        const span = matches[0]!.blocks[0]!
        assert.ok(span.first && span.last)
        assert.equal(span.messages, 3)
    })
}

test("the span endpoints are in message order, not ref text order", () => {
    // Compact refs are not fixed width, so "@10@" sorts before "@9@" as text.
    // The span must still read low-to-high.
    const { state, messages } = folded("compact")
    const matches = findRecallMatches(state, "needle", "compact", messages, 10, 200)
    const span = matches[0]!.blocks[0]!
    const low = Number(span.first!.replace(/\D/g, ""))
    const high = Number(span.last!.replace(/\D/g, ""))
    assert.ok(low < high, `${span.first} should precede ${span.last}`)
    assert.equal(low, 2)
    assert.equal(high, 4)
})

test("a message with no block still renders, just without a span", () => {
    const { state, messages } = folded("xml")
    const outside = findRecallMatches(state, "opening", "xml", messages, 10, 200)
    assert.equal(outside.length, 1)
    assert.deepEqual(outside[0]!.blocks, [])
    const rendered = renderRecallResult(outside, ["opening"])
    assert.match(rendered, /m0001/)
    assert.ok(!rendered.includes("msgs]"))
})
