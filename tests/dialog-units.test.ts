import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// A Metric whose value comes from formatTokenCount without compact already
// ends in " tokens", so pairing it with hint="tokens" printed the unit twice:
// "~3.2K tokenstokens". It went unnoticed because /dcp stats used to render
// into a toast rather than the dialog where these rows live.

const here = dirname(fileURLToPath(import.meta.url))
const dialogs = readFileSync(join(here, "..", "lib", "tui", "dialogs.tsx"), "utf8")
const panel = readFileSync(join(here, "..", "lib", "tui", "panel.tsx"), "utf8")

const METRIC = /<Metric[\s\S]{0,400}?\/>/g

function rowsWithDoubleUnit(source: string, file: string): string[] {
    return [...source.matchAll(METRIC)]
        .map((m) => m[0])
        .filter(
            (row) =>
                /formatTokenCount\((?![^)]*,\s*true)[^)]*\)/.test(row) && /hint="tokens"/.test(row),
        )
        .map((row) => `${file}: ${row.replace(/\s+/g, " ")}`)
}

const bad = [
    ...rowsWithDoubleUnit(dialogs, "dialogs.tsx"),
    ...rowsWithDoubleUnit(panel, "panel.tsx"),
]

test('no Metric pairs a unit-bearing value with hint="tokens"', () => {
    assert.deepEqual(bad, [], 'formatTokenCount already appends " tokens" unless compact is passed')
})

test("the panel keeps its compact form, which is correct", () => {
    // compact drops the suffix, so the hint supplies the unit exactly once.
    assert.match(panel, /formatTokenCount\(total, true\)[\s\S]{0,80}?hint="tokens"/)
})
