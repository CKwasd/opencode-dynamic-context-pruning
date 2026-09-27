import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import { filterCompressedRangesForTest as filterCompressedRanges } from "../lib/messages/prune"
import { formatBlockRef } from "../lib/message-ids"

const logger = new Logger(false)
const config = {
    compress: { mode: "range" },
} as PluginConfig

// isMessageWithInfo requires a non-empty sessionID, and getLastUserMessage
// skips anything it rejects. Without it the summary is never injected and the
// "healthy" cases would silently pass for the wrong reason.
function assistant(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", sessionID: "ses_test", time: { created: 1 } },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function user(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: "ses_test", time: { created: 1 } },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

/**
 * A block whose anchor sits after its range, mirroring how DCP stores it: the
 * summary is injected at the anchor, the messages it replaces come earlier.
 */
function setup(summary: unknown, active = true) {
    const state = createSessionState("xml")
    const blockId = 3
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: 1,
        active,
        deactivatedByUser: false,
        compressedTokens: 900,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "auth exploration",
        batchTopic: "auth exploration",
        startId: "m0001",
        endId: "m0003",
        anchorMessageId: "m0004",
        compressMessageId: "m0004",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m0001", "m0002", "m0003"],
        directToolIds: [],
        effectiveMessageIds: ["m0001", "m0002", "m0003"],
        effectiveToolIds: [],
        summary,
    } as never)
    state.prune.messages.activeByAnchorMessageId.set("m0004", blockId)
    for (const id of ["m0001", "m0002", "m0003"]) {
        state.prune.messages.byMessageId.set(id, {
            rawMessageId: id,
            activeBlockIds: [blockId],
            tokenCount: 300,
        } as never)
    }
    return { state, blockId }
}

const range = (): WithParts[] => [
    assistant("m0001", "ORIGINAL-A"),
    assistant("m0002", "ORIGINAL-B"),
    assistant("m0003", "ORIGINAL-C"),
    user("m0004", "carry on"),
]

function rendered(messages: WithParts[]): string {
    return messages
        .flatMap((m) => (Array.isArray(m.parts) ? m.parts : []))
        .map((p) => (p as { text?: string }).text ?? "")
        .join("|")
}

test("a healthy summary replaces the range with the summary text", () => {
    const { state } = setup(`about ${formatBlockRef(3, "xml")}: we read the auth module`)
    const messages = range()
    filterCompressedRanges(state, logger, config, messages)
    const out = rendered(messages)
    assert.ok(!out.includes("ORIGINAL-A"), "range content should be replaced")
    assert.ok(out.includes("auth module"), "summary should be present")
})

test("an empty summary keeps the original content instead of dropping it", () => {
    const { state } = setup("")
    const messages = range()
    filterCompressedRanges(state, logger, config, messages)
    const out = rendered(messages)
    for (const marker of ["ORIGINAL-A", "ORIGINAL-B", "ORIGINAL-C"]) {
        assert.ok(out.includes(marker), `${marker} must survive an unusable summary`)
    }
})

test("a non-string summary keeps the original content", () => {
    const { state } = setup({ not: "a string" })
    const messages = range()
    filterCompressedRanges(state, logger, config, messages)
    assert.ok(rendered(messages).includes("ORIGINAL-A"))
})

test("an inactive block keeps the original content", () => {
    const { state } = setup("a perfectly good summary", false)
    const messages = range()
    filterCompressedRanges(state, logger, config, messages)
    assert.ok(rendered(messages).includes("ORIGINAL-A"))
})

test("a missing block keeps the original content", () => {
    const { state } = setup("a perfectly good summary")
    state.prune.messages.blocksById.delete(3)
    const messages = range()
    filterCompressedRanges(state, logger, config, messages)
    assert.ok(rendered(messages).includes("ORIGINAL-A"))
})

test("one unusable block does not stop a healthy block from compressing", () => {
    const { state } = setup("")
    // A second, healthy block over a different range.
    state.prune.messages.blocksById.set(9, {
        ...(state.prune.messages.blocksById.get(3) as never),
        blockId: 9,
        anchorMessageId: "m0008",
        startId: "m0005",
        endId: "m0006",
        directMessageIds: ["m0005", "m0006"],
        effectiveMessageIds: ["m0005", "m0006"],
        summary: "healthy range summary",
    } as never)
    state.prune.messages.activeByAnchorMessageId.set("m0008", 9)
    for (const id of ["m0005", "m0006"]) {
        state.prune.messages.byMessageId.set(id, {
            rawMessageId: id,
            activeBlockIds: [9],
            tokenCount: 200,
        } as never)
    }

    const messages = [
        ...range(),
        assistant("m0005", "OTHER-A"),
        assistant("m0006", "OTHER-B"),
        user("m0008", "still going"),
    ]
    filterCompressedRanges(state, logger, config, messages)
    const out = rendered(messages)
    assert.ok(out.includes("ORIGINAL-A"), "the broken range stays")
    assert.ok(!out.includes("OTHER-A"), "the healthy range is still compressed")
    assert.ok(out.includes("healthy range summary"))
})
