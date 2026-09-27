import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { createListBlocksTool, createReadItemTool } from "../lib/recall"
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

// A sandbox trial: the description offered "m0042 or @42@", and a model in a
// compact session spent two calls on m0678 and m678 before reading the error.

test("a compact session is offered only compact references", () => {
    const state = createSessionState("compact")
    const history = [message("m1", "x")]
    assignMessageRefs(state, history)

    const readItem = createReadItemTool(ctxWith(state, history))
    assert.match(readItem.description, /@42@ or @b42@/)
    assert.doesNotMatch(readItem.description, /\bm0042\b/)

    const listBlocks = createListBlocksTool(ctxWith(state, history))
    assert.doesNotMatch(listBlocks.description, /\bm0042\b/)
})

test("an xml session is offered only xml references", () => {
    const state = createSessionState("xml")
    const history = [message("m1", "x")]
    assignMessageRefs(state, history)

    const readItem = createReadItemTool(ctxWith(state, history))
    assert.match(readItem.description, /m0042 or b42/)
    assert.doesNotMatch(readItem.description, /@42@/)
})

test("a model reading the description cannot invent a cross-format ref", async () => {
    const state = createSessionState("compact")
    const history = [message("m1", "the body")]
    assignMessageRefs(state, history)
    const tool = createReadItemTool(ctxWith(state, history))

    // The failure the old description invited.
    const wrong = String(await tool.execute({ ref: "m0001" }, toolCtx))
    assert.match(wrong, /No message with reference m0001/)
    assert.match(wrong, /References in this session include: @1@/)

    // And the example the description does give works.
    const right = String(await tool.execute({ ref: "@1@" }, toolCtx))
    assert.match(right, /the body/)
})
