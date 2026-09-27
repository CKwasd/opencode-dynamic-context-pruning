import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState } from "../lib/state"
import {
    effectiveFilePatterns,
    modifiedPathPatterns,
    refreshModifiedPaths,
} from "../lib/protected-paths"
import { isToolProtected } from "../lib/protected-patterns"

const logger = new Logger(false)

function config(overrides: Partial<PluginConfig["experimental"]> = {}): PluginConfig {
    return {
        protectedFilePatterns: ["**/protected.ts"],
        experimental: { protectModifiedFiles: true, ...overrides },
    } as PluginConfig
}

test("a repo-relative path becomes a pattern that matches any spelling of it", () => {
    const [pattern] = modifiedPathPatterns([{ path: "src/core/offset.h", status: "modified" }])
    assert.equal(pattern, "**/src/core/offset.h")
    for (const spelling of [
        "src/core/offset.h",
        "C:\\work\\repo\\src\\core\\offset.h",
        "/home/me/repo/src/core/offset.h",
    ]) {
        assert.ok(
            isToolProtected("read", { filePath: spelling }, [], [pattern]),
            `should protect ${spelling}`,
        )
    }
})

test("a deleted file is not protected: there is nothing left to read", () => {
    assert.deepEqual(modifiedPathPatterns([{ path: "src/gone.ts", status: "deleted" }]), [])
})

test("path traversal and empty paths are dropped", () => {
    assert.deepEqual(
        modifiedPathPatterns([
            { path: "../outside.ts", status: "modified" },
            { path: "a/../../b.ts", status: "modified" },
            { path: "", status: "modified" },
        ]),
        [],
    )
})

test("duplicate spellings of one file collapse to one pattern", () => {
    assert.deepEqual(
        modifiedPathPatterns([
            { path: "src/a.ts", status: "modified" },
            { path: "src\\a.ts", status: "added" },
        ]),
        ["**/src/a.ts"],
    )
})

test("configured patterns still apply alongside modified ones", () => {
    const state = createSessionState()
    state.modifiedPathPatterns = ["**/src/core/offset.h"]
    const patterns = effectiveFilePatterns(state, config())
    assert.ok(patterns.includes("**/protected.ts"))
    assert.ok(patterns.includes("**/src/core/offset.h"))
    assert.ok(isToolProtected("read", { filePath: "x/protected.ts" }, [], patterns))
    assert.ok(isToolProtected("read", { filePath: "src/core/offset.h" }, [], patterns))
    assert.ok(!isToolProtected("read", { filePath: "src/other.ts" }, [], patterns))
})

test("with nothing modified, the configured list is returned unchanged", () => {
    const state = createSessionState()
    assert.deepEqual(effectiveFilePatterns(state, config()), ["**/protected.ts"])
})

test("the fetch is skipped when the option is off", async () => {
    const state = createSessionState()
    let called = 0
    await refreshModifiedPaths(state, config({ protectModifiedFiles: false }), logger, async () => {
        called += 1
        return [{ path: "src/a.ts", status: "modified" }]
    })
    assert.equal(called, 0)
    assert.deepEqual(state.modifiedPathPatterns, [])
})

test("a second call inside the interval does not refetch", async () => {
    const state = createSessionState()
    let called = 0
    const fetch = async () => {
        called += 1
        return [{ path: "src/a.ts", status: "modified" }]
    }
    await refreshModifiedPaths(state, config(), logger, fetch)
    await refreshModifiedPaths(state, config(), logger, fetch)
    assert.equal(called, 1)
    assert.deepEqual(state.modifiedPathPatterns, ["**/src/a.ts"])
})

test("a failing fetch keeps the previous set rather than dropping protection", async () => {
    const state: SessionState = createSessionState()
    state.modifiedPathPatterns = ["**/src/keep.ts"]
    state.modifiedPathsFetchedAt = 0
    await refreshModifiedPaths(state, config(), logger, async () => {
        throw new Error("not a repository")
    })
    assert.deepEqual(state.modifiedPathPatterns, ["**/src/keep.ts"])
})

test("a repository with no changes protects nothing extra", async () => {
    const state = createSessionState()
    await refreshModifiedPaths(state, config(), logger, async () => [])
    assert.deepEqual(state.modifiedPathPatterns, [])
    assert.deepEqual(effectiveFilePatterns(state, config()), ["**/protected.ts"])
})
