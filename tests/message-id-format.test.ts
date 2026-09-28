import assert from "node:assert/strict"
import test from "node:test"
import { VALID_CONFIG_KEYS, getInvalidConfigKeys } from "../lib/config"
import { createSessionState } from "../lib/state"
import { formatMessageRef, formatBlockRef, parseMessageRef } from "../lib/message-ids"

test("the key is recognised, so it does not warn as unknown", () => {
    assert.ok(VALID_CONFIG_KEYS.has("experimental.messageIdFormat"))
    assert.deepEqual(getInvalidConfigKeys({ experimental: { messageIdFormat: "xml" } }), [])
    assert.deepEqual(getInvalidConfigKeys({ experimental: { messageIdFormat: "compact" } }), [])
})

test("the default matches what V2 used unconditionally", () => {
    // createSessionState("compact") was hardcoded at three call sites, so an
    // unset key must keep producing the compact refs rather than silently
    // changing every reference in existing sessions.
    const state = createSessionState("compact")
    assert.equal(state.idFormat, "compact")
    assert.equal(formatMessageRef(4, state.idFormat), "@4@")
    assert.equal(formatBlockRef(1, state.idFormat), "@b1@")
})

test("both formats round-trip through the parser", () => {
    for (const format of ["xml", "compact"] as const) {
        for (const index of [1, 4, 42, 9999]) {
            const ref = formatMessageRef(index, format)
            assert.equal(
                parseMessageRef(ref, format),
                index,
                `${ref} should parse back to ${index} in ${format}`,
            )
        }
    }
})

test("a compact ref does not parse as xml, or the reverse", () => {
    // This is what makes the setting worth having: after a switch, a reference
    // held from before must fail rather than quietly resolve to a different
    // message, because that would attribute a summary to the wrong range.
    assert.equal(parseMessageRef("@4@", "xml"), null)
    assert.equal(parseMessageRef("m0004", "compact"), null)
})

test("state reports the format it was created with", () => {
    assert.equal(createSessionState("xml").idFormat, "xml")
    assert.equal(createSessionState("compact").idFormat, "compact")
})
