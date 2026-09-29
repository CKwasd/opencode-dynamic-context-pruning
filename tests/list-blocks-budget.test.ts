import assert from "node:assert/strict"
import test from "node:test"
import { createListBlocksTool } from "../lib/recall/index"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { PromptStore } from "../lib/prompts/store"

const logger = new Logger(false)

const config = {
    compress: {
        mode: "range",
        maxContextLimit: "80%",
        minContextLimit: "40%",
        summaryBuffer: true,
        modelContextLimit: 1000000,
    },
    recall: {},
} as unknown as PluginConfig

const prompts = {} as PromptStore
const execCtx = {
    sessionID: "s1",
    messageID: "m",
    callID: "c",
    directory: ".",
    worktree: ".",
} as never

function assistant(id: string, input: number, cached: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            time: { created: 1 },
            sessionID: "s1",
            tokens: { input, output: 50, reasoning: 0, cache: { read: cached, write: 0 } },
        },
        parts: [{ type: "text", text: "reply" }],
    } as unknown as WithParts
}

async function run(messages?: WithParts[], state?: SessionState): Promise<string> {
    const tool = createListBlocksTool({
        client: {},
        state: state ?? createSessionState("compact"),
        logger,
        config,
        prompts,
        messages,
    })
    return (await tool.execute({}, execCtx)) as string
}

test("the thresholds are reported so a model can calibrate against them", async () => {
    // The soft nudge carries no figure, so a model that has only seen it has
    // nothing to go on: one session estimated its own window as "200K level"
    // against an actual 950K.
    const out = await run([assistant("a1", 704_100, 0)])
    assert.match(out, /Context: ~704\.1K tokens in use\./)
    assert.match(out, /Compress above ~760K tokens\./)
    assert.match(out, /Reminders start at ~380K tokens\./)
})

test("a one million window resolves the percentages, not the 100K fallback", async () => {
    // 1M assumed, 95% usable = 950K, then 80% and 40% of that.
    const out = await run([assistant("a1", 400_000, 0)])
    assert.match(out, /Compress above ~760K tokens\./, "the 100K fallback must not win")
    assert.match(out, /Reminders start at ~380K tokens\./)
})

test("the compression trigger is not described as the total window", async () => {
    // windowLimit is the threshold, not a ceiling. Calling it "available"
    // would have the model give up room it still has.
    const out = await run([assistant("a1", 100_000, 0)])
    assert.ok(!/available/i.test(out), "must not claim a total window")
    assert.ok(!/used of/i.test(out), "must not imply a hard ceiling")
})

test("the block list still comes after the budget", async () => {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 5000,
        summaryTokens: 400,
        durationMs: 5,
        topic: "the work",
        startId: "a",
        endId: "b",
        anchorMessageId: "a",
        compressMessageId: "b",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["a", "b"],
        directToolIds: [],
        effectiveMessageIds: ["a", "b"],
    } as never)
    state.prune.messages.activeBlockIds.add(1)

    const out = await run([assistant("a1", 100_000, 0)], state)
    assert.ok(out.indexOf("Context:") < out.indexOf("compressed block(s)"))
    assert.match(out, /@b1@  active  the work/)
})

test("an empty session still reports the budget", async () => {
    const out = await run([assistant("a1", 100_000, 0)])
    assert.match(out, /No compressed blocks in this session yet\./)
    assert.match(out, /Context:/)
})

test("summary occupancy is reported when there is any", async () => {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 5000,
        summaryTokens: 400,
        durationMs: 5,
        topic: "t",
        startId: "a",
        endId: "b",
        anchorMessageId: "a",
        compressMessageId: "b",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["a"],
        directToolIds: [],
        effectiveMessageIds: ["a"],
    } as never)
    state.prune.messages.activeBlockIds.add(1)

    const out = await run([assistant("a1", 100_000, 0)], state)
    assert.match(out, /Summaries occupy 400 tokens of that\./)
})

test("without messages the budget is omitted rather than guessed", async () => {
    // The compress tools are built before the messages exist. Printing a
    // number that was never measured is worse than printing none.
    const out = await run(undefined)
    assert.equal(out, "No compressed blocks in this session yet.")
})

test("the description says what the tool is for now", async () => {
    const tool = createListBlocksTool({
        client: {},
        state: createSessionState("compact"),
        logger,
        config,
        prompts,
    })
    assert.match(tool.description, /how much room is left/)
})
