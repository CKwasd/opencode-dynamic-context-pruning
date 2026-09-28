import assert from "node:assert/strict"
import test from "node:test"
import { formatTokenBudgetLine } from "../lib/token-budget"

const plain = (n: number) => `${n}`

function thresholds(over: Partial<Parameters<typeof formatTokenBudgetLine>[0]> = {}) {
    return {
        currentTokens: 40_000,
        windowLimit: 100_000,
        maxContextLimit: 100_000,
        minContextLimit: 25_000,
        summaryTokens: 0,
        ...over,
    }
}

test("the figure is measured against the model's real window", () => {
    assert.equal(
        formatTokenBudgetLine(thresholds(), plain),
        "Context: 40000 used, 60000 left of 100000.",
    )
})

test("an unknown window yields no line rather than a partial one", () => {
    assert.equal(formatTokenBudgetLine(thresholds({ windowLimit: undefined })), undefined)
})

test("no usage reported yet yields no line", () => {
    assert.equal(formatTokenBudgetLine(thresholds({ currentTokens: 0 })), undefined)
})

test("past the window the line says so instead of going negative", () => {
    assert.equal(
        formatTokenBudgetLine(thresholds({ currentTokens: 130_000 }), plain),
        "Context: 130000 used, past the 100000 window.",
    )
})

test("sitting exactly on the window has no room left", () => {
    assert.equal(
        formatTokenBudgetLine(thresholds({ currentTokens: 100_000 }), plain),
        "Context: 100000 used, past the 100000 window.",
    )
})

test("the default formatter compacts large numbers", () => {
    assert.equal(
        formatTokenBudgetLine(
            thresholds({ currentTokens: 87_000, windowLimit: 190_000, summaryTokens: 13_000 }),
        ),
        "Context: 87K used, 103K left of 190K. Summaries occupy 13K of it.",
    )
})

// The bug this fixes: maxContextLimit is the window widened by summaryBuffer,
// right for the nudge threshold and wrong to report. Subtracting from it told
// the model it had summarySize tokens of room the host had already counted.

test("summary overhead is not counted as extra room", () => {
    const window = 1_048_576
    const summary = 13_587
    const t = thresholds({
        currentTokens: 500_000,
        windowLimit: window,
        maxContextLimit: window + summary,
        summaryTokens: summary,
    })
    const line = formatTokenBudgetLine(t, plain) ?? ""
    assert.match(line, /548576 left of 1048576/)
    assert.doesNotMatch(line, /562163/)
})

test("summary overhead is still reported, as occupancy not headroom", () => {
    const line =
        formatTokenBudgetLine(
            thresholds({ currentTokens: 500_000, windowLimit: 1_000_000, summaryTokens: 13_000 }),
            plain,
        ) ?? ""
    assert.match(line, /Summaries occupy 13000 of it/)
})

test("no summary line when nothing is compressed", () => {
    const line = formatTokenBudgetLine(thresholds(), plain) ?? ""
    assert.doesNotMatch(line, /Summaries occupy/)
})

