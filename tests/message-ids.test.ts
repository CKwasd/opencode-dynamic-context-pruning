import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import {
    assignMessageRefs,
    formatMessageRef,
    MESSAGE_REF_MAX_INDEX,
    parseMessageRef,
} from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession resets message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-9998", "m9998")
    state.messageIds.byRawId.set("old-message-9999", "m9999")
    state.messageIds.byRef.set("m9998", "old-message-9998")
    state.messageIds.byRef.set("m9999", "old-message-9999")
    state.messageIds.nextRef = 9999

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0001")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0002")
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 3)
})

test("message refs keep counting past 9999 instead of throwing", () => {
    assert.equal(MESSAGE_REF_MAX_INDEX, Number.MAX_SAFE_INTEGER)
    assert.equal(formatMessageRef(9999), "m9999")
    assert.equal(formatMessageRef(10000), "m10000")
    assert.equal(formatMessageRef(123456), "m123456")
    assert.equal(parseMessageRef("m10000"), 10000)
    assert.equal(parseMessageRef("m123456"), 123456)
    assert.equal(parseMessageRef("m0001"), 1)
    // Still rejected: too short to be a padded ref, or not an index at all.
    assert.equal(parseMessageRef("m123"), null)
    assert.equal(parseMessageRef("b3"), null)
    assert.throws(() => formatMessageRef(0))
})
