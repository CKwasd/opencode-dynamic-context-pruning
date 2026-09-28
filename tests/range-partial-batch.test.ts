import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext } from "../lib/compress/search"
import { resolveRanges } from "../lib/compress/range-utils"
import { Logger } from "../lib/logger"

const logger = new Logger(false)
const config = {
    manualMode: { automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: [],
    compress: { mode: "range" },
    strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
    },
} as never

function contextWith(count: number) {
    const state = createSessionState("compact")
    const messages = Array.from({ length: count }, (_, i) => {
        const id = `m${i + 1}`
        return {
            info: {
                id,
                role: i % 2 === 0 ? "user" : "assistant",
                time: { created: 1 },
                sessionID: "s1",
            },
            parts: [{ type: "text", text: `body of ${id}` }],
        } as unknown as WithParts
    })
    assignMessageRefs(state, messages)
    syncToolCache(state, config, logger, messages)
    return { state, context: buildSearchContext(state, messages) }
}

test("a bad ref does not discard its siblings' summaries", () => {
    const { state, context } = contextWith(6)
    const { plans, issues } = resolveRanges(
        {
            topic: "batch",
            content: [
                { startId: "@1@", endId: "@2@", summary: "good one" },
                { startId: "@99@", endId: "@99@", summary: "bad ref" },
                { startId: "@3@", endId: "@4@", summary: "good two" },
            ],
        },
        context,
        state,
    )

    // The whole point: the two summaries the model already paid for survive.
    assert.equal(plans.length, 2)
    assert.deepEqual(
        plans.map((plan) => plan.entry.summary),
        ["good one", "good two"],
    )
})

test("the rejected entry is named, not just counted", () => {
    const { state, context } = contextWith(6)
    const { issues } = resolveRanges(
        {
            topic: "batch",
            content: [
                { startId: "@1@", endId: "@2@", summary: "ok" },
                { startId: "@99@", endId: "@99@", summary: "bad" },
            ],
        },
        context,
        state,
    )

    assert.equal(issues.length, 1)
    assert.match(issues[0]!, /content\[1\]/)
    assert.match(issues[0]!, /@99@\.\.@99@/)
    // The model needs the reason to fix it, not just that something failed.
    assert.match(issues[0]!, /not available in the current conversation context/)
})

test("a fully bad batch still throws with every reason", () => {
    const { state, context } = contextWith(4)
    const { plans, issues } = resolveRanges(
        {
            topic: "batch",
            content: [
                { startId: "@77@", endId: "@77@", summary: "a" },
                { startId: "@78@", endId: "@79@", summary: "b" },
            ],
        },
        context,
        state,
    )
    assert.equal(plans.length, 0)
    assert.equal(issues.length, 2)
})

test("a clean batch reports no issues", () => {
    const { state, context } = contextWith(6)
    const { plans, issues } = resolveRanges(
        {
            topic: "batch",
            content: [{ startId: "@1@", endId: "@3@", summary: "ok" }],
        },
        context,
        state,
    )
    assert.equal(plans.length, 1)
    assert.deepEqual(issues, [])
})

test("a one-message range is legal", () => {
    // Worth pinning: a minimum-range guard was considered and rejected, because
    // ranges this small resolve fine and a floor would refuse work that works.
    const { state, context } = contextWith(3)
    const { plans, issues } = resolveRanges(
        { topic: "t", content: [{ startId: "@1@", endId: "@1@", summary: "s" }] },
        context,
        state,
    )
    assert.equal(plans.length, 1)
    assert.equal(plans[0]!.selection.messageIds.length, 1)
    assert.deepEqual(issues, [])
})
