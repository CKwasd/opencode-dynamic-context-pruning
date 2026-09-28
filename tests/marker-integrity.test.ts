import assert from "node:assert/strict"
import test from "node:test"
import { rangePrompt } from "../lib/prompts/compress-range"
import { messagePrompt } from "../lib/prompts/compress-message"
import { COMPRESSED_BLOCK_HEADER } from "../lib/compress/state"
import { markerIntegrityNote } from "../lib/prompts/guidance"

test("both compress prompts state the marker contract", () => {
    for (const prompt of [rangePrompt(), messagePrompt(), rangePrompt("compact")]) {
        assert.match(prompt, /MARKER INTEGRITY/)
        assert.match(prompt, /NEVER emit that line yourself/)
    }
})

test("the note names the exact shape the tool returns", () => {
    const note = markerIntegrityNote()
    assert.ok(
        note.includes(COMPRESSED_BLOCK_HEADER),
        "must name the real header so the model recognises it",
    )
    // The observed failure is the model writing the tool's own result line.
    assert.match(note, /Compressed N messages into/)
})

test("the note tells the model how to verify instead", () => {
    const note = markerIntegrityNote()
    assert.match(note, /list_blocks/)
    assert.match(note, /proves nothing/)
})

test("both compress prompts ask for a silent call", () => {
    for (const prompt of [rangePrompt(), messagePrompt()]) {
        assert.match(prompt, /Execute these calls silently/)
    }
})

test("the note is identical in every id format", () => {
    // The header does not change with the ref format, so the contract must not
    // either: a format-dependent marker rule is one more thing to keep in sync.
    assert.equal(markerIntegrityNote(), markerIntegrityNote())
    assert.ok(!rangePrompt("compact").includes('"@b1@"'))
})
