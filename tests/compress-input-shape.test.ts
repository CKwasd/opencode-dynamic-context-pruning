import assert from "node:assert/strict"
import test from "node:test"
import {
    normalizeCompressInput,
    normalizeCompressMessageInput,
} from "../lib/compress/normalize-input"
import { validateArgs } from "../lib/compress/range-utils"

const RANGE = { startId: "@1@", endId: "@3@", summary: "the range" }
const MESSAGE = { messageId: "@1@", topic: "t", summary: "the message" }

test("a well-formed argument is returned untouched", () => {
    const args = { topic: "batch", content: [RANGE] }
    assert.equal(normalizeCompressInput(args), args)
})

test("a single entry where an array was expected is wrapped", () => {
    // What a model produces when it retries a single range.
    const out = normalizeCompressInput({ topic: "one", content: RANGE })
    assert.ok(Array.isArray(out.content))
    assert.equal(out.content.length, 1)
    assert.equal(out.content[0]!.startId, "@1@")
    assert.doesNotThrow(() => validateArgs(out))
})

test("a bare entry array becomes a full argument", () => {
    const out = normalizeCompressInput([RANGE, { ...RANGE, endId: "@5@" }])
    assert.equal(out.content.length, 2)
    assert.ok(out.topic.length > 0, "topic is required, so one is supplied")
    assert.doesNotThrow(() => validateArgs(out))
})

test("a fenced or string-encoded argument is decoded", () => {
    const fenced = "```json\n" + JSON.stringify({ topic: "x", content: [RANGE] }) + "\n```"
    assert.doesNotThrow(() => validateArgs(normalizeCompressInput(fenced)))

    // Some models emit a JSON string whose contents are themselves JSON.
    const doubled = JSON.stringify(JSON.stringify({ topic: "y", content: [RANGE] }))
    assert.doesNotThrow(() => validateArgs(normalizeCompressInput(doubled)))
})

test("a single entry survives all three slips at once", () => {
    // content as an object, the whole argument as a string, fences on top.
    const asString = "```\n" + JSON.stringify({ topic: "z", content: RANGE }) + "\n```"
    const out = normalizeCompressInput(asString)
    assert.doesNotThrow(() => validateArgs(out))
    assert.equal(out.content.length, 1)
})

test("a shape that is not a range slip is left for validateArgs to report", () => {
    // The point of returning these untouched: a genuinely missing field must
    // still produce the precise error, not be silently reshaped into something
    // that happens to validate.
    const missingSummary = { topic: "x", content: [{ startId: "@1@", endId: "@2@" }] }
    const out = normalizeCompressInput(missingSummary)
    assert.throws(() => validateArgs(out), /summary is required/)
})

test("an empty content array is not mistaken for a bare entry array", () => {
    const out = normalizeCompressInput({ topic: "x", content: [] })
    assert.ok(Array.isArray(out.content))
    assert.throws(() => validateArgs(out), /non-empty array/)
})

test("the message variant keys off messageId, not startId", () => {
    const out = normalizeCompressMessageInput({ topic: "m", content: MESSAGE })
    assert.ok(Array.isArray(out.content))
    assert.equal(out.content[0]!.messageId, "@1@")

    // A range entry is not a message entry, so it must not be picked up here.
    const notAMessage = normalizeCompressMessageInput({ topic: "m", content: RANGE })
    assert.deepEqual(notAMessage.content, RANGE)
})
