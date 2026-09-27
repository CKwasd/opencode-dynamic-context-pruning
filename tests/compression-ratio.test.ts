import assert from "node:assert/strict"
import test from "node:test"
import { formatRatio } from "../lib/tui/format"

// The clamp in the old version turned 0.82:1 into "1:1". A compression that
// made the context bigger is the one outcome worth surfacing, and it is exactly
// the one that was hidden.

test("a real saving still reads as a whole-number ratio", () => {
    assert.equal(formatRatio(100_000, 20_000), "5:1")
    assert.equal(formatRatio(100_000, 1_000), "100:1")
    assert.equal(formatRatio(100_000, 99_000), "1:1")
})

test("a summary larger than the range it replaced is not rounded away", () => {
    const out = formatRatio(28_100, 34_300)
    assert.match(out, /^0\.82:1/)
    assert.match(out, /grew/)
    assert.notEqual(out, "1:1")
})

test("edge cases still render", () => {
    assert.equal(formatRatio(0, 100), "0:1")
    assert.equal(formatRatio(100, 0), "∞:1")
})
