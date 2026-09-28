import type { CompressMessageToolArgs, CompressRangeToolArgs } from "./types"

/** One complete entry, however the model chose to wrap it. */
function looksLikeRangeEntry(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    return typeof entry.startId === "string" && typeof entry.endId === "string"
}

function looksLikeMessageEntry(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    return typeof entry.messageId === "string"
}

function stripFences(text: string): string {
    const trimmed = text.trim()
    if (!trimmed.startsWith("```")) return trimmed
    return trimmed
        .replace(/^```[a-zA-Z]*\s*/, "")
        .replace(/```\s*$/, "")
        .trim()
}

/** Unwrap fences, and the JSON-string-inside-a-JSON-string some models emit. */
function decode(value: unknown): unknown {
    let current = value
    for (let pass = 0; pass < 2 && typeof current === "string"; pass++) {
        try {
            current = JSON.parse(stripFences(current))
        } catch {
            return current
        }
    }
    return current
}

function normalize(raw: unknown, looksLikeEntry: (value: unknown) => boolean, emptyTopic: string) {
    const value = decode(raw)

    if (Array.isArray(value)) {
        // The whole argument lost its wrapper and became the entry array.
        if (value.length > 0 && value.every(looksLikeEntry)) {
            return { topic: emptyTopic, content: value }
        }
        return value
    }
    if (typeof value !== "object" || value === null) return value

    const record = value as Record<string, unknown>
    if (Array.isArray(record.content)) return value
    // A single entry where the schema asked for an array of them.
    if (looksLikeEntry(record.content)) {
        return { ...record, content: [record.content] }
    }
    return value
}

/**
 * A model that retries one range tends to hand back the single entry on its
 * own: `content` becomes the object rather than a one-element array, the whole
 * argument becomes a bare array, or it arrives string-encoded through a chat
 * wire. Each of those is a shape slip, and without this the call dies with
 * "content is required and must be a non-empty array" -- which does not tell
 * the model what it did wrong, so it retries the same way and burns a turn.
 *
 * Anything that is not one of those shapes is returned untouched, so
 * validateArgs still reports it normally.
 */
export function normalizeCompressInput(raw: unknown): CompressRangeToolArgs {
    return normalize(raw, looksLikeRangeEntry, "compressed range") as CompressRangeToolArgs
}

export function normalizeCompressMessageInput(raw: unknown): CompressMessageToolArgs {
    return normalize(raw, looksLikeMessageEntry, "compressed messages") as CompressMessageToolArgs
}
