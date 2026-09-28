import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { assignMessageRefs } from "../lib/message-ids"
import {
    createListBlocksTool,
    createReadItemTool,
    createRecallTool,
    findRecallMatches,
    renderRecallResult,
    messageText,
    maxSearchResults,
    maxReadTokens,
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
        topic: "Auth Exploration",
        startId: "m0001",
        endId: "m0009",
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

// sessionID is required: filterMessages drops anything without it, which is the
// same trap that made an earlier version of this suite test nothing at all.
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

test("list_blocks reports every block with its ref, topic and size", async () => {
    const state = createSessionState("xml")
    state.prune.messages.blocksById.set(1, block({ blockId: 1, topic: "Auth Exploration" }))
    state.prune.messages.blocksById.set(
        2,
        block({ blockId: 2, active: false, topic: "Offsets", compressedTokens: 900 }),
    )

    const out = String(await createListBlocksTool(ctxWith(state)).execute({}, toolCtx))
    assert.match(out, /2 compressed block\(s\)/)
    assert.match(out, /b1 {2}active {2}Auth Exploration/)
    assert.match(out, /b2 {2}inactive {2}Offsets/)
})

test("list_blocks uses the compact ref form when the session does", async () => {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(7, block({ blockId: 7 }))
    const out = String(await createListBlocksTool(ctxWith(state)).execute({}, toolCtx))
    assert.match(out, /@b7@/)
})

test("list_blocks on an empty session says so instead of returning nothing", async () => {
    const out = String(
        await createListBlocksTool(ctxWith(createSessionState("xml"))).execute({}, toolCtx),
    )
    assert.equal(out, "No compressed blocks in this session yet.")
})

test("read_item resolves a ref to the original message", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "the original text")]
    assignMessageRefs(state, history)

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute({ refs: ["m0001"] }, toolCtx),
    )
    assert.match(out, /the original text/)
})

test("read_item names the references that do exist when asked for a bad one", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "text")]
    assignMessageRefs(state, history)

    const out = String(
        await createReadItemTool(ctxWith(state, history)).execute({ refs: ["m9999"] }, toolCtx),
    )
    assert.match(out, /m9999: no message with that reference/)
    assert.match(out, /Known references: m0001/)
})

test("read_item truncates and says how to continue", async () => {
    const state = createSessionState("xml")
    const long = "x".repeat(DEFAULT_LIMITS.maxReadTokens * 4 + 500)
    const history = [message("m1", long)]
    assignMessageRefs(state, history)
    const tool = createReadItemTool(ctxWith(state, history))

    const first = String(await tool.execute({ refs: ["m0001"] }, toolCtx))
    assert.match(first, /Continue with offset=\d+/)
    const offset = Number(first.match(/offset=(\d+)/)![1])
    const second = String(await tool.execute({ refs: ["m0001"], offset }, toolCtx))
    assert.ok(!second.includes("Continue with offset"), "the remainder should fit")
})

test("recall returns references and snippets, never whole messages", () => {
    const state = createSessionState("xml")
    // Long enough that returning it whole would undo the compression that
    // made the search necessary.
    const filler = "x".repeat(4000)
    const body = `the authentication flow uses a middleware ${filler}`
    const history = [message("m1", body), message("m2", "unrelated offsets")]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(3, block({ blockId: 3, effectiveMessageIds: ["m1"] }))

    const matches = findRecallMatches(state, "authentication", "xml", history)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].ref, "m0001")
    assert.deepEqual(matches[0].blockRefs, ["b3"])
    assert.ok(matches[0].snippet.length < 400, "the snippet must be bounded")

    const rendered = renderRecallResult(matches)
    assert.match(rendered, /This is a list of references, not their content/)
    assert.match(rendered, /Nothing has been added to the context yet/)
    assert.ok(!rendered.includes(filler), "the message body must not be returned")
    assert.ok(rendered.length < 1000, "the whole result must stay small")
})

test("recall is case insensitive, and an empty or absent query finds nothing", () => {
    const state = createSessionState("xml")
    const history = [message("m1", "Authentication Flow")]
    assignMessageRefs(state, history)

    assert.equal(findRecallMatches(state, "authentication", "xml", history).length, 1)
    assert.equal(findRecallMatches(state, "kubernetes", "xml", history).length, 0)
    assert.equal(findRecallMatches(state, "   ", "xml", history).length, 0)
})

test("recall is capped", () => {
    const state = createSessionState("xml")
    const history: WithParts[] = []
    for (let i = 0; i < 50; i++) {
        const m = message(`m${i}`, `hit ${i}`)
        history.push(m)
        assignMessageRefs(state, [m])
    }
    assert.equal(
        findRecallMatches(state, "hit", "xml", history).length,
        DEFAULT_LIMITS.maxSearchResults,
    )
})

test("recall over the wire reaches the session history and names the block", async () => {
    const state = createSessionState("xml")
    const history = [message("m1", "the offset table lives in offsets_json.c")]
    assignMessageRefs(state, history)
    state.prune.messages.blocksById.set(2, block({ blockId: 2, effectiveMessageIds: ["m1"] }))

    const out = String(
        await createRecallTool(ctxWith(state, history)).execute({ query: "offsets_json" }, toolCtx),
    )
    assert.match(out, /m0001/)
    assert.match(out, /in b2/)
})

test("messageText includes tool output so a search can find it", () => {
    const withTool = {
        info: { id: "m1", role: "assistant", time: { created: 1 }, sessionID: "ses_1" },
        parts: [
            { type: "text", text: "before" },
            { type: "tool", tool: "read", state: { output: "file body here" } },
        ],
    } as unknown as WithParts
    assert.equal(messageText(withTool), "before\n[read] file body here")
})
