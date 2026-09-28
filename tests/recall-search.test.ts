import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { assignMessageRefs } from "../lib/message-ids"
import {
    createReadItemTool,
    createRecallTool,
    findRecallMatches,
    parseQueryTerms,
    renderRecallResult,
    maxSearchResults,
    DEFAULT_LIMITS,
} from "../lib/recall"
import type { PluginConfig } from "../lib/config"
import type { PromptStore } from "../lib/prompts/store"

const logger = new Logger(false)
const prompts = {} as PromptStore
const config = { commands: { enabled: true } } as unknown as PluginConfig

function block(over: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 4000,
        summaryTokens: 300,
        durationMs: 10,
        topic: "Canary",
        startId: "m0001",
        endId: "m0009",
        anchorMessageId: "a1",
        compressMessageId: "c1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1"],
        directToolIds: [],
        effectiveMessageIds: ["m1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "s",
        ...over,
    }
}

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

const toolCtx = { sessionID: "ses_1" } as never

// The exact string a real model passed during the sandbox trial. It found
// nothing, because the query was matched as one substring.
const REAL_QUERY = "ARCHIVE-CANARY-7749 OFFSET_TABLE region kilo base hook"

test("a multi-word query is split into terms", () => {
    assert.deepEqual(parseQueryTerms(REAL_QUERY), [
        "archive-canary-7749",
        "offset_table",
        "region",
        "kilo",
        "base",
        "hook",
    ])
})

test("terms too short to be useful are dropped", () => {
    // "the" and "from" are function words; "auth" and "flow" are not.
    assert.deepEqual(parseQueryTerms("a the of x auth flow"), ["auth", "flow"])
    // Short but searchable terms survive.
    assert.deepEqual(parseQueryTerms("api key git sql"), ["api", "key", "git", "sql"])
})

test("quotes around a term are stripped, not treated as separators", () => {
    assert.deepEqual(parseQueryTerms('"authentication flow" middleware'), [
        "authentication",
        "flow",
        "middleware",
    ])
})

test("a multi-word query finds the message, which the old single-substring match missed", () => {
    const state = createSessionState("xml")
    const body =
        '// ARCHIVE-CANARY-7749\nexport const OFFSET_TABLE = { region: "kilo", base: "0xb4a0", hook: "0x11e88" }'
    const history = [message("m1", body), message("m2", "unrelated offset chatter")]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(7, block({ blockId: 7, effectiveMessageIds: ["m1"] }))

    const matches = findRecallMatches(state, REAL_QUERY, "xml", history)
    // The distractor holds "offset" but not "offset_table", so it is not a match.
    assert.equal(matches.length, 1)
    assert.equal(matches[0].ref, "m0001")
    assert.equal(matches[0].hitTerms, 6)
})

test("a message matching more terms outranks one matching fewer", () => {
    const state = createSessionState("xml")
    const history = [
        message("m1", "kilo appears once"),
        message("m2", "kilo and base and hook and region all here"),
    ]
    assignMessageRefs(state, history)
    const matches = findRecallMatches(state, "kilo base hook region", "xml", history)
    assert.equal(matches[0].ref, "m0002")
})

test("the result names the terms that matched nothing, so the model can retry", () => {
    const state = createSessionState("xml")
    const history = [message("m1", "kilo appears here")]
    assignMessageRefs(state, history)
    const matches = findRecallMatches(state, "kilo kubernetes", "xml", history)
    const rendered = renderRecallResult(matches, parseQueryTerms("kilo kubernetes"))
    assert.match(rendered, /No message contains: kubernetes/)
})

test("an all-noise query reports nothing and says which terms were used", () => {
    const state = createSessionState("xml")
    const history = [message("m1", "content")]
    assignMessageRefs(state, history)
    assert.deepEqual(findRecallMatches(state, "a the of", "xml", history), [])
})

test("recall is still capped after the ranking change", () => {
    const state = createSessionState("xml")
    const history: WithParts[] = []
    for (let i = 0; i < 50; i++) {
        const m = message(`m${i}`, `found ${i}`)
        history.push(m)
        assignMessageRefs(state, [m])
    }
    assert.equal(
        findRecallMatches(state, "found", "xml", history).length,
        DEFAULT_LIMITS.maxSearchResults,
    )
})

test("read_item with a block reference lists that block's messages", async () => {
    const state = createSessionState("compact")
    const history = [message("m1", "body"), message("m2", "more")]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(
        2,
        block({ blockId: 2, effectiveMessageIds: ["m1", "m2"], topic: "Canary" }),
    )

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute({ refs: ["@b2@"] }, toolCtx),
    )
    assert.match(out, /Block covers 2 message\(s\): @1@, @2@/)
    assert.match(out, /@1@/)
    assert.match(out, /@2@/)
    assert.match(out, /Pass one of these to read_item/)
})

test("read_item with an unknown block says so", async () => {
    const state = createSessionState("xml")
    const out = String(
        await createReadItemTool(ctxWith(state, [])).execute({ refs: ["b9"] }, toolCtx),
    )
    assert.match(out, /b9: no compressed block with that reference/)
})

test("the wire path answers the real query", async () => {
    const state = createSessionState("xml")
    const body = '// ARCHIVE-CANARY-7749\nexport const OFFSET_TABLE = { region: "kilo" }'
    const history = [message("m1", body)]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(9, block({ blockId: 9, effectiveMessageIds: ["m1"] }))

    const out = String(
        await createRecallTool(ctxWith(state, history)).execute({ query: REAL_QUERY }, toolCtx),
    )
    assert.match(out, /m0001/)
    assert.match(out, /in b9/)
})
