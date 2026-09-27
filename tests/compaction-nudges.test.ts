import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"

test("compaction replays existing nudges without changing the cached prefix or adding anchors", () => {
    const state = createSessionState("compact")
    const logger = new Logger(false)
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: 0,
            maxContextLimit: 1,
            nudgeFrequency: 1,
            summaryBuffer: false,
        },
    } as PluginConfig
    const prompts = {
        contextLimitNudge: "<dcp-system-reminder>NUDGE_KEEP</dcp-system-reminder>",
        turnNudge: "",
        iterationNudge: "",
    } as RuntimePrompts
    const user = {
        info: {
            id: "msg_user",
            role: "user",
            time: { created: 1 },
            model: { providerID: "lab", modelID: "model" },
        },
        parts: [{ type: "text", text: "Original question" }],
    }
    const raw = [
        user,
        {
            info: {
                id: "msg_answer",
                role: "assistant",
                time: { created: 2 },
                tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Original answer" }],
        },
    ] as WithParts[]
    const primary = structuredClone(raw)
    injectCompressNudges(state, config, logger, primary, prompts)
    assert.match(JSON.stringify(primary), /NUDGE_KEEP/)
    const anchors = structuredClone(state.nudges)
    const compact = structuredClone([
        ...raw,
        { ...user, info: { ...user.info, id: "msg_later" } },
    ]) as WithParts[]
    injectCompressNudges(state, config, logger, compact, prompts, undefined, false)
    assert.deepEqual(compact.slice(0, raw.length), primary)
    assert.deepEqual(state.nudges, anchors)
    assert.doesNotMatch(JSON.stringify(compact.at(-1)), /NUDGE_KEEP/)
})



test("dropping back under minContextLimit clears every anchor set, not just the soft ones", () => {
    const state = createSessionState("compact")
    const logger = new Logger(false)
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: 50_000,
            maxContextLimit: 100_000,
            nudgeFrequency: 1,
            summaryBuffer: false,
        },
    } as PluginConfig
    const prompts = {
        contextLimitNudge: "",
        turnNudge: "",
        iterationNudge: "",
    } as RuntimePrompts
    const messages = [
        {
            info: {
                id: "msg_user",
                role: "user",
                time: { created: 1 },
                model: { providerID: "lab", modelID: "model" },
            },
            parts: [{ type: "text", text: "Original question" }],
        },
        {
            info: {
                id: "msg_assistant",
                role: "assistant",
                time: { created: 2 },
                model: { providerID: "lab", modelID: "model" },
                tokens: { input: 900_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Done" }],
        },
    ] as unknown as WithParts[]

    // Over both thresholds: the context-limit anchor gets populated.
    injectCompressNudges(state, config, logger, messages, prompts)
    assert.equal(state.nudges.contextLimitAnchors.size, 1)

    // Usage falls for a reason unrelated to a compress call (model switch, host
    // compaction, /dcp sweep). No compress tool part is involved.
    const assistant = messages[1]!.info as { tokens: { input: number } }
    assistant.tokens.input = 10
    injectCompressNudges(state, config, logger, messages, prompts)

    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
    assert.equal(state.nudges.iterationNudgeAnchors.size, 0)
})
