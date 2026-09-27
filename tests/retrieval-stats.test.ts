import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { createReadItemTool, createRecallTool } from "../lib/recall"
import { formatStatsMessage } from "../lib/commands/stats"
import type { PluginConfig } from "../lib/config"
import type { PromptStore } from "../lib/prompts/store"

const logger = new Logger(false)
const prompts = {} as PromptStore
const config = { commands: { enabled: true } } as unknown as PluginConfig
const toolCtx = { sessionID: "ses_1" } as never

function message(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 }, sessionID: "ses_1" },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function ctxWith(state: ReturnType<typeof createSessionState>, history: WithParts[] = []) {
    return {
        state,
        logger,
        config,
        prompts,
        client: { session: { messages: async () => ({ data: history }) } },
    }
}

test("read_item records what it put back", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "a".repeat(4000))]
    assignMessageRefs(state, history)

    assert.equal(state.stats.totalRetrievedTokens ?? 0, 0)
    const out = await createReadItemTool(ctxWith(state, history)).execute({ ref: "m0001" }, toolCtx)
    assert.ok(String(out).length > 1000)
    assert.ok(
        (state.stats.totalRetrievedTokens ?? 0) > 0,
        "the retrieval must be counted, that is the whole point",
    )
})

test("read_item counts each call, and the running total matches the sum", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "b".repeat(2000))]
    assignMessageRefs(state, history)
    const tool = createReadItemTool(ctxWith(state, history))

    await tool.execute({ ref: "m0001" }, toolCtx)
    const first = state.stats.totalRetrievedTokens ?? 0
    await tool.execute({ ref: "m0001" }, toolCtx)
    const second = state.stats.totalRetrievedTokens ?? 0

    assert.ok(second > first, "a second retrieval adds to the total")
    assert.equal(state.stats.retrievedTokenCounter, second)
})

test("a failed lookup counts nothing", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "content")]
    assignMessageRefs(state, history)

    await createReadItemTool(ctxWith(state, history)).execute({ ref: "m9999" }, toolCtx)
    assert.equal(state.stats.totalRetrievedTokens ?? 0, 0)
})

test("recall records its own output", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "the offset table lives in offsets_json.c")]
    assignMessageRefs(state, history)

    await createRecallTool(ctxWith(state, history)).execute({ query: "offsets_json" }, toolCtx)
    assert.ok((state.stats.totalRetrievedTokens ?? 0) > 0)
})

const allTime = {
    totalTokens: 100_000,
    totalRetrievedTokens: 4_000,
    totalTools: 10,
    totalMessages: 20,
    sessionCount: 1,
}

test("the stats text reports retrieval for the session and all time", () => {
    const out = formatStatsMessage(50_000, 2_000, 5, 8, 900, allTime, 1_500)
    assert.match(out, /Tokens saved: {4}~100K tokens/)
    assert.match(out, /Retrieved: {8}~1\.5K tokens put back/)
    assert.match(out, /Tokens retrieved: ~4K tokens/)
})

test("an absent retrieval shows no row rather than a zero", () => {
    const out = formatStatsMessage(50_000, 2_000, 5, 8, 900, {
        ...allTime,
        totalRetrievedTokens: 0,
    })
    assert.doesNotMatch(out, /Retrieved:/)
    assert.doesNotMatch(out, /Tokens retrieved:/)
})
