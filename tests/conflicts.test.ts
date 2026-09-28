import assert from "node:assert/strict"
import test from "node:test"
import { COMPRESSED_BLOCK_HEADER } from "../lib/compress/state"
import { CONFLICT_LEDGER_MAX, detectConflicts, recordConflicts } from "../lib/conflicts"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

void Logger

function msg(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 }, sessionID: "s1" },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function withBlock(ids: string[], active = true): SessionState {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active,
        deactivatedByUser: false,
        compressedTokens: 900,
        summaryTokens: 100,
        durationMs: 5,
        topic: "early work",
        startId: ids[0]!,
        endId: ids[ids.length - 1]!,
        anchorMessageId: ids[0]!,
        compressMessageId: ids[ids.length - 1]!,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [...ids],
        directToolIds: [],
        effectiveMessageIds: [...ids],
    } as never)
    if (active) state.prune.messages.activeBlockIds.add(1)
    return state
}

test("a fully covered block raises nothing", () => {
    const state = withBlock(["m1", "m2", "m3"])
    const events = detectConflicts(state, [msg("m1", "a"), msg("m2", "b"), msg("m3", "c")])
    assert.deepEqual(events, [])
})

test("a block whose messages vanished is reported", () => {
    // This is what host compaction does to us: the summary survives, the
    // originals it points at do not.
    const state = withBlock(["m1", "m2", "m3"])
    const events = detectConflicts(state, [msg("m1", "a")])
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, "orphaned-block")
    assert.match(events[0]!.detail, /2 are no longer in the conversation/)
    assert.match(events[0]!.detail, /summary is still readable/)
})

test("an inactive block is not reported", () => {
    // Its contents are not being served, so there is nothing to warn about.
    const state = withBlock(["m1", "m2"], false)
    assert.deepEqual(detectConflicts(state, [msg("m1", "a")]), [])
})

test("the block header in the input means a second compressor", () => {
    // DCP substitutes the header into the array it sends, so it should never
    // appear in what the host hands back.
    const state = withBlock(["m1"])
    const events = detectConflicts(state, [msg("m1", `prefix ${COMPRESSED_BLOCK_HEADER} tail`)])
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, "foreign-compression")
    assert.match(events[0]!.detail, /keep exactly one/)
})

test("a clean conversation is silent", () => {
    const state = withBlock(["m1", "m2"])
    assert.deepEqual(detectConflicts(state, [msg("m1", "plain"), msg("m2", "text")]), [])
})

test("a persistent condition stays one entry and keeps its first sighting", () => {
    const state = withBlock(["m1", "m2", "m3"])
    const first = recordConflicts(state, detectConflicts(state, [msg("m1", "a")]), [])
    assert.equal(first.length, 1)

    const second = recordConflicts(state, detectConflicts(state, [msg("m1", "a")]), first)
    assert.equal(second.length, 1, "a condition seen every turn is still one entry")
    assert.equal(second[0]!.since, first[0]!.since, "the first sighting is the one kept")
})

test("the ring is bounded, keeping the newest", () => {
    const state = createSessionState("compact")
    // All at once: the ring holds the conditions observed in one pass, so
    // feeding them one at a time is a single condition each time.
    const events = Array.from({ length: CONFLICT_LEDGER_MAX + 8 }, (_, i) => ({
        kind: "orphaned-block" as const,
        since: i,
        detail: `block ${i} ("t") covers 1 message(s) but 1 are no longer in the conversation.`,
    }))

    const ring = recordConflicts(state, events, [])
    assert.equal(ring.length, CONFLICT_LEDGER_MAX)
    // The newest survive; the oldest are dropped.
    assert.match(ring[ring.length - 1]!.detail, /block 27/)
    assert.ok(
        !ring.some((event) => /block 0 \(/.test(event.detail)),
        "the earliest conditions are the ones discarded",
    )
})

test("a conflict clears when the condition goes away", () => {
    // Not a stale entry: the next clean request rewrites the ring to empty.
    const state = withBlock(["m1", "m2", "m3"])
    const withConflict = recordConflicts(state, detectConflicts(state, [msg("m1", "a")]), [])
    assert.equal(withConflict.length, 1)
    const afterRecovery = recordConflicts(
        state,
        detectConflicts(state, [msg("m1", "a"), msg("m2", "b"), msg("m3", "c")]),
        withConflict,
    )
    assert.deepEqual(afterRecovery, [])
})
