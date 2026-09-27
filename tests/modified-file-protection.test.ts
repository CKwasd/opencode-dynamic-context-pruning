import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { effectiveFilePatterns } from "../lib/protected-paths"

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

function read(id: string, filePath: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 } },
        parts: [
            {
                type: "tool",
                tool: "read",
                callID: id,
                state: {
                    status: "completed",
                    input: { filePath },
                    output: `content of ${filePath}`,
                },
            },
        ],
    } as unknown as WithParts
}

async function protectedSection(
    modified: string[],
): Promise<{ section: string; selection: never; context: never }> {
    const state = createSessionState()
    state.modifiedPathPatterns = modified
    const messages = [
        read("call-dirty", "C:\\repo\\work\\dirty.ts"),
        read("call-clean", "C:\\repo\\work\\clean.ts"),
    ]
    syncToolCache(state, config, logger, messages)
    const context = buildSearchContext(state, messages)
    const selection = resolveSelection(
        context,
        { kind: "message", rawIndex: 0, messageId: "call-dirty" },
        { kind: "message", rawIndex: 1, messageId: "call-clean" },
    )
    const summary = await appendProtectedTools(
        {},
        state,
        false,
        "SUMMARY",
        selection,
        context,
        config.strategies.deduplication.protectedTools,
        effectiveFilePatterns(state, config),
    )
    const heading = "protected tools were used in this conversation as well:"
    const section = summary.includes(heading) ? (summary.split(heading)[1] ?? "") : ""
    return { section, selection: undefined as never, context: undefined as never }
}

test("a modified file's tool output survives into the summary", async () => {
    const { section } = await protectedSection(["**/work/dirty.ts"])
    assert.ok(section.length > 0, "the protected section should exist")
    assert.match(section, /work\\dirty\.ts/)
    assert.match(section, /content of C:\\repo\\work\\dirty\.ts/)
})

test("a clean file in the same range is not protected", async () => {
    const { section } = await protectedSection(["**/work/dirty.ts"])
    assert.ok(
        !section.includes("clean.ts"),
        "a file git does not report as modified must not be protected",
    )
})

test("with nothing modified, no section is produced at all", async () => {
    const { section } = await protectedSection([])
    assert.equal(section, "")
})

test("protection follows git state, not a fixed list", async () => {
    const before = await protectedSection(["**/work/clean.ts"])
    assert.ok(!before.section.includes("dirty.ts"))
    assert.ok(before.section.includes("clean.ts"))

    const after = await protectedSection(["**/work/dirty.ts"])
    assert.ok(after.section.includes("dirty.ts"))
    assert.ok(!after.section.includes("clean.ts"))
})
