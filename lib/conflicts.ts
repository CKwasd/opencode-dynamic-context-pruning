import { COMPRESSED_BLOCK_HEADER } from "./compress/state"
import type { SessionState, WithParts } from "./state"

/**
 * Evidence that something other than DCP rewrote this conversation. Two
 * compressors on one conversation corrupt each other's message references, and
 * the symptom -- scrambled context -- shows up long after the cause.
 *
 * This is a diagnostic, not history, so it is a bounded ring.
 */
export type ConflictKind = "orphaned-block" | "foreign-compression"

export interface ConflictEvent {
    kind: ConflictKind
    /** When it was first seen, so a persistent condition stays one entry. */
    since: number
    detail: string
}

export const CONFLICT_LEDGER_MAX = 20

/**
 * An active block whose source messages are no longer in the host's array.
 * DCP can still print the summary, but the originals it points at are gone --
 * `read_item` and range reads over that block cannot return them. This is what
 * host compaction does to us.
 */
function orphanedBlocks(state: SessionState, presentMessageIds: Set<string>): ConflictEvent[] {
    const events: ConflictEvent[] = []

    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || block.effectiveMessageIds.length === 0) continue

        const missing = block.effectiveMessageIds.filter((id) => !presentMessageIds.has(id))
        if (missing.length === 0) continue

        events.push({
            kind: "orphaned-block",
            since: Date.now(),
            detail:
                `block ${blockId} ("${block.topic}") covers ${block.effectiveMessageIds.length} message(s)` +
                ` but ${missing.length} are no longer in the conversation.` +
                ` Its summary is still readable; the originals are not.`,
        })
    }

    return events
}

/**
 * DCP substitutes the block header into the array it sends, so it never appears
 * in what the host hands back. Finding it in the input means a second DCP
 * instance, or another compressor reusing the same marker, is also running.
 */
function foreignCompression(messages: WithParts[]): ConflictEvent[] {
    let found = 0
    for (const message of messages) {
        const parts = Array.isArray(message?.parts) ? message.parts : []
        for (const part of parts) {
            if (part?.type !== "text" || typeof part.text !== "string") continue
            if (part.text.includes(COMPRESSED_BLOCK_HEADER)) {
                found += 1
                break
            }
        }
    }

    return found === 0
        ? []
        : [
              {
                  kind: "foreign-compression",
                  since: Date.now(),
                  detail:
                      `${found} message(s) already contain "${COMPRESSED_BLOCK_HEADER}"` +
                      ` before DCP substituted anything. A second compressor is writing to this session;` +
                      ` keep exactly one, or the message references will be corrupted.`,
              },
          ]
}

export function detectConflicts(state: SessionState, messages: WithParts[]): ConflictEvent[] {
    const presentMessageIds = new Set<string>()
    for (const message of messages) {
        if (typeof message?.info?.id === "string") presentMessageIds.add(message.info.id)
    }

    return [...foreignCompression(messages), ...orphanedBlocks(state, presentMessageIds)]
}

/**
 * The currently observed conditions, not a log of them. A conflict that has
 * been resolved disappears from the panel rather than sitting there describing
 * a problem that is gone -- a stale warning is worse than none.
 *
 * A condition that persists across requests keeps its original `since`, so
 * "how long has this been happening" is still answerable.
 */
export function recordConflicts(
    state: SessionState,
    events: ConflictEvent[],
    existing: ConflictEvent[],
): ConflictEvent[] {
    void state
    if (events.length === 0) return []

    const priorByKey = new Map<string, ConflictEvent>()
    for (const event of existing) priorByKey.set(conflictKey(event), event)

    const merged = events.map((event) => {
        // The detail embeds counts that can shift, so the key is built from the
        // stable part; anything else would look like a new condition.
        const prior = priorByKey.get(conflictKey(event))
        return prior ? { ...event, since: prior.since } : event
    })

    return merged.slice(-CONFLICT_LEDGER_MAX)
}

function conflictKey(event: ConflictEvent): string {
    if (event.kind === "orphaned-block") {
        const block = /block (\d+)/.exec(event.detail)
        return `${event.kind}:${block?.[1] ?? event.detail.slice(0, 24)}`
    }
    return event.kind
}
