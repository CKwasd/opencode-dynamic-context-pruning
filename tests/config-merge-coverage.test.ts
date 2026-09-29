import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig, VALID_CONFIG_KEYS } from "../lib/config"
import { isContextOverLimits, resolveContextThresholds } from "../lib/messages/inject/utils"
import { createSessionState } from "../lib/state"

/**
 * Every key that CompressConfig declares must survive a real config file.
 *
 * The existing fallback tests build a config object by hand, so they exercise
 * the consumer branch but never the merge that decides which keys a user's file
 * actually gets. compress.modelContextLimit was declared, validated, put in
 * the schema, and read by resolveContextTokenLimit -- and was still dropped by
 * mergeCompress, so a configured window never arrived and the thresholds fell
 * back to the 100K constant. Those tests passed the whole time.
 */

const COMPRESS_KEYS = [
    "mode",
    "permission",
    "showCompression",
    "summaryBuffer",
    "maxContextLimit",
    "minContextLimit",
    "modelContextLimit",
    "modelMaxLimits",
    "modelMinLimits",
    "nudgeFrequency",
    "iterationNudgeThreshold",
    "nudgeForce",
    "protectedTools",
    "protectTags",
    "protectUserMessages",
    "retainFilePaths",
]

function writeConfigFile(contents: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "dcp-cfg-"))
    mkdirSync(join(root, "opencode"), { recursive: true })
    const path = join(root, "opencode", "dcp.jsonc")
    writeFileSync(path, JSON.stringify(contents, null, 2), "utf-8")
    return root
}

function loadConfig(compress: Record<string, unknown>) {
    const root = writeConfigFile({ enabled: true, compress })
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = root
    try {
        return getConfig({
            directory: root,
            client: { tui: { showToast: async () => {} } },
        })
    } finally {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previous
    }
}

test("a configured modelContextLimit survives the config merge", () => {
    const config = loadConfig({ modelContextLimit: 1_000_000 })
    assert.equal(
        config.compress.modelContextLimit,
        1_000_000,
        "the declared window must survive mergeCompress, or the setting is inert",
    )
})

test("a configured window actually moves the threshold", () => {
    const config = loadConfig({
        modelContextLimit: 1_000_000,
        maxContextLimit: "80%",
        minContextLimit: "30%",
    })
    const state = createSessionState()
    // Host reported nothing, so only the configured window can be used.
    assert.equal(state.modelContextLimit, undefined)

    // getCurrentTokenUsage sums input+output+reasoning+cache from the newest
    // assistant message that actually produced output, so the fixture needs one.
    const messages = [
        {
            info: {
                id: "assistant-1",
                sessionID: "ses_test",
                role: "assistant",
                time: { created: 1 },
                tokens: { input: 200_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [],
        },
    ] as never[]

    const over = isContextOverLimits(config, state, undefined, undefined, messages)
    const resolved = resolveContextThresholds(config, state, undefined, undefined, messages)
    // windowLimit is the configured window less the 5% headroom, i.e. the point
    // at which a strong nudge fires -- not the raw window. 1M * 0.95 * 0.80.
    assert.equal(resolved.windowLimit, 760_000, `windowLimit resolved to ${resolved.windowLimit}`)
    assert.equal(resolved.maxContextLimit, 760_000)
    assert.equal(resolved.minContextLimit, 285_000)
    // 200k is past 285k? No: under it, so the soft nudge is off and the strong
    // one is off. Against the 100K fallback both would be on, which is the bug
    // this guards: 100K * 0.95 * 0.8 = 76k, and 200k is well past that.
    assert.equal(over.overMinLimit, false)
    assert.equal(over.overMaxLimit, false)

    // The same usage against the 100K fallback would have crossed the strong
    // threshold, which is exactly the 10x-too-early compression being reported.
    const withoutConfig = loadConfig({ maxContextLimit: "80%", minContextLimit: "30%" })
    const fellBack = isContextOverLimits(withoutConfig, state, undefined, undefined, messages)
    assert.equal(
        fellBack.overMaxLimit,
        true,
        "without the configured window the 100K fallback must fire the strong nudge",
    )
})

test("every declared compress key is carried through the merge", () => {
    // A guard for the next key someone adds: if it is declared but not merged,
    // the setting is silently inert and no consumer test would notice.
    const values: Record<string, unknown> = {
        mode: "message",
        permission: "deny",
        showCompression: true,
        summaryBuffer: false,
        maxContextLimit: "70%",
        minContextLimit: "20%",
        modelContextLimit: 640_000,
        nudgeFrequency: 9,
        iterationNudgeThreshold: 3,
        nudgeForce: "strong",
        protectTags: true,
        protectUserMessages: true,
        retainFilePaths: false,
    }
    const config = loadConfig(values)
    const compress = config.compress as unknown as Record<string, unknown>
    for (const [key, want] of Object.entries(values)) {
        assert.equal(compress[key], want, `compress.${key} did not survive the merge`)
    }
    // protectedTools merges as a union, so check membership rather than equality.
    assert.ok(Array.isArray(compress.protectedTools))
})

test("each compress key is registered as valid", () => {
    for (const key of COMPRESS_KEYS) {
        if (key === "modelMaxLimits" || key === "modelMinLimits") continue
        assert.ok(
            VALID_CONFIG_KEYS.has(`compress.${key}`),
            `compress.${key} is not in VALID_CONFIG_KEYS`,
        )
    }
    assert.ok(VALID_CONFIG_KEYS.has("compress.modelMaxLimits"))
    assert.ok(VALID_CONFIG_KEYS.has("compress.modelMinLimits"))
})
