import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { assignMessageRefs } from "../lib/message-ids"
import {
    createListBlocksTool,
    findRecallMatches,
    parseQueryTerms,
    renderRecallResult,
} from "../lib/recall"
import type { PluginConfig } from "../lib/config"
import type { PromptStore } from "../lib/prompts/store"

const logger = new Logger(false)
const prompts = {} as PromptStore
const config = { commands: { enabled: true } } as unknown as PluginConfig

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

// A model in a sandbox trial read "~678" off a recall line, took it for the
// message index, and asked read_item for "m0678" -- a reference that does not
// exist in a compact session. The digits came from here and the m prefix from
// the tool description. A figure without a unit reads as part of the
// identifier printed beside it.

test("recall labels the size, so it cannot be read as part of a reference", () => {
    const state = createSessionState("xml")
    const history = [message("m1", `findme ${"a".repeat(2700)}`)]
    assignMessageRefs(state, history)

    const matches = findRecallMatches(state, "findme", "xml", history)
    assert.equal(matches.length, 1)
    const out = renderRecallResult(matches, parseQueryTerms("findme"))

    const line = out.split("\n").find((l) => l.includes("m0001")) ?? ""
    assert.ok(line, "the matching row should be present")
    assert.match(line, /~\d+(\.\d+)?K? tokens/)
    // Strip the labelled figures; any tilde left would be an unlabelled one.
    // A negative lookahead is not usable here: \d+ backtracks to a shorter
    // match, so "~173 tokens" also matches "~\d+(?! tokens)" as "~17".
    assert.doesNotMatch(line.replace(/~\d+(\.\d+)?K? tokens/g, ""), /~/)
})

test("list_blocks labels both of its sizes", async () => {
    const state = createSessionState("compact")
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 4000,
        summaryTokens: 1200,
        durationMs: 5,
        topic: "Offsets",
        startId: "@1@",
        endId: "@2@",
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
    }
    state.prune.messages.blocksById.set(1, block)

    const out = String(
        await createListBlocksTool(ctxWith(state)).execute({}, { sessionID: "ses_1" } as never),
    )
    assert.match(out, /~1\.2K tokens summary/)
    assert.match(out, /saved 4K tokens/)
    assert.doesNotMatch(out.replace(/~\d+(\.\d+)?K? (summary|tokens)/g, ""), /~/)
})
