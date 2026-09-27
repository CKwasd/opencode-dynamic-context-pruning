import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { createSessionState } from "../lib/state"

// A host that reports no window, and a host that reports a wrong one, both used
// to leave the percentages unresolvable and the thresholds pinned to constants
// the config could not see.

function usage(cacheRead: number) {
    return [
        {
            info: {
                role: "assistant",
                time: { created: 1 },
                tokens: { input: 0, output: 1, reasoning: 0, cache: { read: cacheRead, write: 0 } },
            },
        },
    ] as never[]
}

function configWith(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: "25%",
            maxContextLimit: "80%",
            modelContextLimit: undefined,
            nudgeFrequency: 1,
            summaryBuffer: false,
            ...overrides,
        },
    } as PluginConfig
}

test("without a window anywhere the old constants still apply", () => {
    const state = createSessionState("compact")
    assert.equal(state.modelContextLimit, undefined)
    const config = configWith()

    // 100k / 50k are the built-in pair.
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(120_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(60_000)), {
        overMaxLimit: false,
        overMinLimit: true,
    })
})

test("a configured window is used when the host reports none", () => {
    const state = createSessionState("compact")
    assert.equal(state.modelContextLimit, undefined)
    const config = configWith({ modelContextLimit: 1_000_000 })

    // 80% of 950k is 760k, 25% is 237.5k.
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(800_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(700_000)), {
        overMaxLimit: false,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(200_000)), {
        overMaxLimit: false,
        overMinLimit: false,
    })
})

test("the host wins over the configured window", () => {
    const state = createSessionState("compact")
    state.modelContextLimit = 200_000
    const config = configWith({ modelContextLimit: 1_000_000 })

    // 80% of 190k is 152k. Under the configured 950k window this would be
    // nowhere near the max, so crossing it proves the host took precedence.
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(160_000)), {
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(100_000)), {
        overMaxLimit: false,
        overMinLimit: true,
    })
})

test("a nonsense configured window falls back to the constants", () => {
    for (const bad of [0, -1]) {
        const state = createSessionState("compact")
        const config = configWith({ modelContextLimit: bad })
        assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(120_000)), {
            overMaxLimit: true,
            overMinLimit: true,
        })
    }
})

test("an absolute threshold ignores the configured window entirely", () => {
    const state = createSessionState("compact")
    const config = configWith({ modelContextLimit: 1_000_000, maxContextLimit: 90_000 })
    // 90,000 is taken as given. Against the configured 1M window, 25% is
    // 237,500, so anything under that is also under the min.
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(95_000)), {
        overMaxLimit: true,
        overMinLimit: false,
    })
    assert.deepEqual(isContextOverLimits(config, state, "lab", "m", usage(80_000)), {
        overMaxLimit: false,
        overMinLimit: false,
    })
})
