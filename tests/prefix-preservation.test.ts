import assert from "node:assert/strict"
import test from "node:test"
import { rangePrompt } from "../lib/prompts/compress-range"
import { messagePrompt } from "../lib/prompts/compress-message"
import { tailBiasedGuidance } from "../lib/prompts/guidance"

test("both compress prompts ask for a smaller, tail-biased range", () => {
    for (const prompt of [rangePrompt(), messagePrompt()]) {
        assert.match(prompt, /PREFIX PRESERVATION/)
        assert.match(prompt, /biased toward the recent tail/)
        assert.match(prompt, /stable prefix/)
    }
})

test("the guidance says why, not just what", () => {
    // A rule without a reason gets dropped the first time it conflicts with a
    // model's own idea of a good range.
    const note = tailBiasedGuidance()
    assert.match(note, /prefix cache/)
    assert.match(note, /Several small tail-biased folds/)
})

test("it still allows reaching back when the early messages are the point", () => {
    assert.match(tailBiasedGuidance(), /Only reach back to the earliest messages/)
})

test("the section does not vary with the ref format", () => {
    assert.ok(rangePrompt("compact").includes(tailBiasedGuidance()))
    assert.ok(rangePrompt("xml").includes(tailBiasedGuidance()))
})
