import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { assignMessageRefs } from "../lib/message-ids"
import {
    createReadItemTool,
    createRecallTool,
    DEFAULT_LIMITS,
    resolveRecallLimits,
} from "../lib/recall"
import type { PluginConfig } from "../lib/config"
import type { PromptStore } from "../lib/prompts/store"

const logger = new Logger(false)
const prompts = {} as PromptStore
const toolCtx = { sessionID: "ses_1" } as never

function message(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 }, sessionID: "ses_1" },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function ctxWith(
    state: ReturnType<typeof createSessionState>,
    history: WithParts[],
    recall: Record<string, number> = {},
) {
    return {
        state,
        logger,
        config: { commands: { enabled: true }, recall } as unknown as PluginConfig,
        prompts,
        client: { session: { messages: async () => ({ data: history }) } },
    }
}

function block(over: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 4000,
        summaryTokens: 300,
        durationMs: 5,
        topic: "Offsets",
        startId: "@1@",
        endId: "@2@",
        anchorMessageId: "a1",
        compressMessageId: "c1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1", "m2"],
        directToolIds: [],
        effectiveMessageIds: ["m1", "m2"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "s",
        ...over,
    }
}

test("limits come from the config, with the documented defaults as fallback", () => {
    assert.deepEqual(
        resolveRecallLimits({
            maxSearchResults: 3,
            maxCharsPerItem: 50,
            maxReadTokens: 900,
            resultTokenBudget: 800,
            maxQueryTerms: 2,
            maxQueryChars: 10,
        }),
        {
            maxSearchResults: 3,
            maxCharsPerItem: 50,
            maxReadTokens: 900,
            resultTokenBudget: 800,
            maxQueryTerms: 2,
            maxQueryChars: 10,
        },
    )
    assert.deepEqual(resolveRecallLimits({} as never), DEFAULT_LIMITS)
})

test("a nonsense limit falls back rather than disabling the tool", () => {
    const l = resolveRecallLimits({
        maxReadTokens: 0,
        maxSearchResults: -5,
        resultTokenBudget: Number.NaN,
    } as never)
    assert.equal(l.maxReadTokens, DEFAULT_LIMITS.maxReadTokens)
    assert.equal(l.maxSearchResults, DEFAULT_LIMITS.maxSearchResults)
    assert.equal(l.resultTokenBudget, DEFAULT_LIMITS.resultTokenBudget)
})

test("several references are read in one call", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "first body"), message("m2", "second body")]
    assignMessageRefs(state, history)

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute(
            { refs: ["m0001", "m0002"] },
            toolCtx,
        ),
    )
    assert.match(out, /--- m0001\n[\s\S]*first body/)
    assert.match(out, /--- m0002\n[\s\S]*second body/)
    assert.match(createReadItemTool(ctxWith(state, history)).description, /one or more/)
})

test("a call over the result budget is refused, not shortened", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "a".repeat(6000)), message("m2", "b".repeat(6000))]
    assignMessageRefs(state, history)
    // A read cap that fits, inside a total budget that does not.
    const ctx = ctxWith(state, history, { maxReadTokens: 4000, resultTokenBudget: 200 })

    const out = String(await createReadItemTool(ctx).execute({ refs: ["m0001", "m0002"] }, toolCtx))
    assert.match(out, /Refusing/)
    assert.match(out, /exceeds the 200 token limit/)
    assert.doesNotMatch(out, /aaaa/)
    // It has to say what to set: a model that only has to copy a number should
    // not have to halve its way down.
    assert.match(out, /limit: 100/)
    assert.match(out, /"m0001", "m0002"/)
    assert.match(out, /offset/)
})

test("one bad reference does not sink the good ones", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "good body")]
    assignMessageRefs(state, history)

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute(
            { refs: ["m9999", "m0001"] },
            toolCtx,
        ),
    )
    assert.match(out, /good body/)
    assert.match(out, /m9999: no message with that reference/)
    assert.match(out, /Known references: m0001/)
})

test("a block reference still lists its messages", async () => {
    const state = createSessionState("compact")
    const history = [message("m1", "a"), message("m2", "b")]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(2, block({ blockId: 2, effectiveMessageIds: ["m1", "m2"] }))

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute({ refs: ["@b2@"] }, toolCtx),
    )
    assert.match(out, /Block covers 2 message\(s\): @1@, @2@/)
})

test("offset paging still resumes a cut message", async () => {
    const state = createSessionState("xml")
    const long = "x".repeat(5000)
    const history = [message("m1", long)]
    assignMessageRefs(state, history)
    const tool = createReadItemTool(ctxWith(state, history, { maxReadTokens: 50 }))

    const first = String(await tool.execute({ refs: ["m0001"] }, toolCtx))
    const at = Number(first.match(/Continue with offset=(\d+)/)![1])
    assert.ok(at > 0)
    const second = String(await tool.execute({ refs: ["m0001"], offset: at }, toolCtx))
    // 5000 characters at 200 per call needs many calls, so the offset hint
    // legitimately stays. What must change is the text itself.
    assert.notEqual(second, first)
    assert.ok(second.includes("xxxx"), "the remainder should still be content")
})

test("the search obeys a configured result count", async () => {
    const state = createSessionState("xml")
    const history = Array.from({ length: 12 }, (_, i) => message(`m${i}`, `needle ${i}`))
    for (const m of history) assignMessageRefs(state, [m])

    const tool = createRecallTool(ctxWith(state, history, { maxSearchResults: 4 }))
    const out = String(await tool.execute({ query: "needle" }, toolCtx))
    const rows = out.split("\n").filter((l) => /m00\d\d\s+assistant/.test(l))
    assert.equal(rows.length, 4)
})
