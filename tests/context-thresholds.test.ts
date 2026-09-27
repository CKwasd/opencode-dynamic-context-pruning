import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { createSessionState } from "../lib/state"

// getCurrentTokenUsage only trusts an assistant message that reported output
// tokens, so every fixture below reports output: 1 and carries the load in the
// cache-read bucket.
function usage(cacheRead: number) {
    return [
        {
            info: {
                role: "assistant",
                time: { created: 1 },
                tokens: { input: 0, output: 1, reasoning: 0, cache: { read: cacheRead, write: 0 } },
            },
        },
    ] as any[]
}

function configWith(limits: Partial<PluginConfig["compress"]>): PluginConfig {
    return {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: "25%",
            maxContextLimit: "80%",
            nudgeFrequency: 1,
            summaryBuffer: false,
            ...limits,
        },
    } as PluginConfig
}

test("percent thresholds scale with the host's model context window", () => {
    const small = createSessionState("compact")
    small.modelContextLimit = 32_000 // 25% = 8k, 80% = 25.6k
    const large = createSessionState("compact")
    large.modelContextLimit = 200_000 // 25% = 50k, 80% = 160k

    // 26k: over a small window's min, under a large window's min.
    assert.deepEqual(isContextOverLimits(configWith({}), small, "lab", "m", usage(26_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(configWith({}), large, "lab", "m", usage(26_000)), {
        overMaxLimit: false,
        overMinLimit: false,
    })

    // 200k: over a large window's max, under a small window's max would be moot.
    assert.deepEqual(isContextOverLimits(configWith({}), large, "lab", "m", usage(200_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
})

test("absolute thresholds still work unchanged", () => {
    const state = createSessionState("compact")
    state.modelContextLimit = 1_000_000
    const config = configWith({ minContextLimit: 50_000, maxContextLimit: 100_000 })

    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(150_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(60_000)), {
        overMaxLimit: false,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(10_000)), {
        overMaxLimit: false,
        overMinLimit: false,
    })
})

test("a percent threshold without a known model window falls back to the absolute pair", () => {
    // The host never reported a context limit. Leaving both thresholds unset
    // would pin overMinLimit true and overMaxLimit false forever, so the old
    // absolute numbers return instead.
    const state = createSessionState("compact")
    assert.equal(state.modelContextLimit, undefined)
    const config = configWith({})

    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(120_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(60_000)), {
        overMaxLimit: false,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(10_000)), {
        overMaxLimit: false,
        overMinLimit: false,
    })
})

test("per-model overrides still win over the global percent thresholds", () => {
    const state = createSessionState("compact")
    state.modelContextLimit = 200_000
    const config = configWith({ modelMaxLimits: { "lab/small": "10%" } }) // 20k

    // 25k is 12.5% of the window: over the 10% per-model cap, under the 80% global one.
    assert.equal(
        isContextOverLimits(config, state, "lab", "small", usage(25_000)).overMaxLimit,
        true,
    )
    assert.equal(
        isContextOverLimits(config, state, "lab", "other", usage(25_000)).overMaxLimit,
        false,
    )
})

test("out-of-range percentages clamp instead of producing a broken limit", () => {
    const state = createSessionState("compact")
    state.modelContextLimit = 100_000
    const over = isContextOverLimits(
        configWith({ maxContextLimit: "150%", minContextLimit: "-10%" }),
        state,
        "lab",
        "m",
        usage(60_000),
    )
    // 150% clamps to the full window; -10% clamps to 0 so anything counts as over.
    assert.deepEqual(over, { overMaxLimit: false, overMinLimit: true })
})
