import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import { appendRetainedFilePaths, collectRetainedFilePaths } from "../lib/compress/file-paths"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"

const logger = new Logger(false)
const config = {
    manualMode: { automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: [],
    strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
    },
} as PluginConfig

function toolMessage(id: string, tool: string, input: unknown, callID = id): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 } },
        parts: [
            {
                type: "tool",
                tool,
                callID,
                state: { status: "completed", input, output: "ok" },
            },
        ],
    } as unknown as WithParts
}

function selectionFor(state: ReturnType<typeof createSessionState>, messages: WithParts[]) {
    syncToolCache(state, config, logger, messages)
    const context = buildSearchContext(state, messages)
    const first = context.rawMessages[0]
    const last = context.rawMessages[context.rawMessages.length - 1]
    const start = { kind: "message" as const, rawIndex: 0, messageId: first.info.id }
    const end = {
        kind: "message" as const,
        rawIndex: context.rawMessages.length - 1,
        messageId: last.info.id,
    }
    return { context, selection: resolveSelection(context, start, end) }
}

test("a repeatedly-read file missing from the summary is appended", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { filePath: "C:\\proj\\src\\core\\offset.h" }),
        toolMessage("m2", "read", { filePath: "C:\\proj\\src\\core\\offset.h" }),
        toolMessage("m3", "read", { filePath: "C:\\proj\\src\\core\\offset.h" }),
    ]
    const { context, selection } = selectionFor(state, messages)

    const retained = collectRetainedFilePaths("A summary that names nothing.", selection, context)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].reads, 3)
    assert.equal(retained[0].path, "C:\\proj\\src\\core\\offset.h")

    const out = appendRetainedFilePaths("A summary that names nothing.", selection, context)
    assert.match(out, /not named in the summary above/)
    assert.match(out, /C:\\proj\\src\\core\\offset\.h \(3x\)/)
})

test("a file the summary already names is not duplicated", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { filePath: "C:\\proj\\src\\core\\offset.h" }),
        toolMessage("m2", "read", { filePath: "C:\\proj\\src\\core\\offset.h" }),
    ]
    const { context, selection } = selectionFor(state, messages)

    // Summaries are narrative: they name a file by its short form, not the
    // absolute path the tool received.
    const summary = "Reviewed the offset table in src/core/offset.h and moved on."
    assert.deepEqual(collectRetainedFilePaths(summary, selection, context), [])
    assert.equal(appendRetainedFilePaths(summary, selection, context), summary)
})

test("a file read once is not retained", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { filePath: "C:\\proj\\once.ts" }),
        toolMessage("m2", "read", { filePath: "C:\\proj\\other.ts" }),
    ]
    const { context, selection } = selectionFor(state, messages)
    assert.deepEqual(collectRetainedFilePaths("summary", selection, context), [])
})

test("separator and case variants of one path count once", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { filePath: "C:\\Proj\\src\\A.ts" }),
        toolMessage("m2", "read", { filePath: "c:/proj/src/a.ts" }),
    ]
    const { context, selection } = selectionFor(state, messages)
    const retained = collectRetainedFilePaths("summary", selection, context)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].reads, 2)
})

test("V2 read tools use `path`, not `filePath`", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { path: "C:\\proj\\v2.ts" }),
        toolMessage("m2", "read", { path: "C:\\proj\\v2.ts" }),
    ]
    const { context, selection } = selectionFor(state, messages)
    const retained = collectRetainedFilePaths("summary", selection, context)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].path, "C:\\proj\\v2.ts")
})

test("Code Mode nested calls contribute their paths", () => {
    const state = createSessionState()
    const messages = [
        {
            info: { id: "m1", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "tool",
                    tool: "execute",
                    callID: "m1",
                    state: {
                        status: "completed",
                        input: { code: "await tools.read({path:'x'})" },
                        output: "ok",
                        metadata: {
                            toolCalls: [{ tool: "read", input: { path: "C:\\proj\\nested.ts" } }],
                        },
                    },
                },
            ],
        },
        {
            info: { id: "m2", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "tool",
                    tool: "execute",
                    callID: "m2",
                    state: {
                        status: "completed",
                        input: { code: "await tools.read({path:'x'})" },
                        output: "ok",
                        metadata: {
                            toolCalls: [{ tool: "read", input: { path: "C:\\proj\\nested.ts" } }],
                        },
                    },
                },
            ],
        },
    ] as unknown as WithParts[]

    const { context, selection } = selectionFor(state, messages)
    const retained = collectRetainedFilePaths("summary", selection, context)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].path, "C:\\proj\\nested.ts")
    assert.equal(retained[0].reads, 2)
})

test("the list is ordered by read count and capped", () => {
    const state = createSessionState()
    const messages = [] as WithParts[]
    // One hot file (30 reads) and 30 cold ones (2 reads each).
    for (let i = 0; i < 30; i++)
        messages.push(toolMessage(`hot${i}`, "read", { filePath: "hot.ts" }))
    for (let i = 0; i < 30; i++) {
        messages.push(toolMessage(`a${i}`, "read", { filePath: `cold${i}.ts` }))
        messages.push(toolMessage(`b${i}`, "read", { filePath: `cold${i}.ts` }))
    }
    const { context, selection } = selectionFor(state, messages)

    const retained = collectRetainedFilePaths("summary", selection, context)
    assert.equal(retained.length, 25, "MAX_PATHS total, hot file first")
    assert.equal(retained[0].path, "hot.ts")
    assert.equal(retained[0].reads, 30)
    for (let i = 1; i < retained.length; i++) {
        assert.ok(retained[i - 1].reads >= retained[i].reads, "descending by read count")
    }
})

test("a malformed tool input does not block compression", () => {
    const state = createSessionState()
    const messages = [
        toolMessage("m1", "read", { filePath: "C:\\proj\\a.ts" }),
        {
            info: { id: "m2", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "m2",
                    state: { status: "completed", input: null, output: "ok" },
                },
            ],
        } as unknown as WithParts,
        toolMessage("m3", "read", { filePath: "C:\\proj\\a.ts" }),
    ]
    const { context, selection } = selectionFor(state, messages)

    const summary = appendRetainedFilePaths("summary", selection, context)
    assert.match(summary, /C:\\proj\\a\.ts/)
})
