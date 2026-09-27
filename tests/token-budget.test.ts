import assert from "node:assert/strict"
import test from "node:test"
import { formatTokenBudgetLine } from "../lib/token-budget"

const plain = (n: number) => `${n}`

test("the figure is measured against the compaction boundary, not the window", () => {
    assert.equal(
        formatTokenBudgetLine(
            { currentTokens: 40_000, maxContextLimit: 100_000, minContextLimit: 25_000 },
            plain,
        ),
        "Context: 40000 used, 60000 until compaction.",
    )
})

test("an unknown boundary yields no line rather than a partial one", () => {
    assert.equal(
        formatTokenBudgetLine(
            { currentTokens: 40_000, maxContextLimit: undefined, minContextLimit: 25_000 },
            plain,
        ),
        undefined,
    )
})

test("no usage reported yet yields no line", () => {
    assert.equal(
        formatTokenBudgetLine(
            { currentTokens: 0, maxContextLimit: 100_000, minContextLimit: 25_000 },
            plain,
        ),
        undefined,
    )
})

test("past the boundary the line says so instead of going negative", () => {
    assert.equal(
        formatTokenBudgetLine(
            { currentTokens: 130_000, maxContextLimit: 100_000, minContextLimit: 25_000 },
            plain,
        ),
        "Context: 130000 used, past the 100000 limit.",
    )
})

test("sitting exactly on the boundary has no room left", () => {
    assert.equal(
        formatTokenBudgetLine(
            { currentTokens: 100_000, maxContextLimit: 100_000, minContextLimit: 25_000 },
            plain,
        ),
        "Context: 100000 used, past the 100000 limit.",
    )
})

test("the default formatter compacts large numbers", () => {
    assert.equal(
        formatTokenBudgetLine({
            currentTokens: 87_000,
            maxContextLimit: 190_000,
            minContextLimit: 47_500,
        }),
        "Context: 87K used, 103K until compaction.",
    )
})
