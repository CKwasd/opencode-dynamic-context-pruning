import { getFilePathsFromParameters } from "../protected-patterns"
import type { SearchContext, SelectionResolution } from "./types"

// ponytail: hardcoded rather than configured -- W22 measured the useful threshold
// at "read more than once", and a range this large is already pathological.
// Raise MIN_READS if summaries start carrying long irrelevant file lists.
const MIN_READS = 2
// ponytail: hard cap. A 40-entry path list costs ~800 tokens; beyond that the
// list costs more than the raw reads it would save, so truncate by read count.
const MAX_PATHS = 25

function normalize(path: string): string {
    return path
        .replace(/[\\/]+/g, "/")
        .replace(/^\.\//, "")
        .toLowerCase()
}

function pathSegments(path: string): string[] {
    return path.split(/[\\/]+/).filter(Boolean)
}

// The summary is narrative, so it usually names a file by a short form
// ("src/core/offset.h") rather than the absolute path the tool received. Match
// on the deepest suffix that has enough segments to stay unambiguous.
function isMentioned(path: string, summaryLower: string): boolean {
    const segments = pathSegments(path)
    if (segments.length === 0) return true

    for (const depth of [3, 2]) {
        if (segments.length < depth) continue
        if (summaryLower.includes(segments.slice(-depth).join("/").toLowerCase())) {
            return true
        }
    }

    if (segments.length === 1) {
        return summaryLower.includes(segments[0].toLowerCase())
    }

    return false
}

export function collectRetainedFilePaths(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
): Array<{ path: string; reads: number }> {
    const summaryLower = summary.toLowerCase()
    const readsByPath = new Map<string, { path: string; reads: number }>()

    for (const messageId of selection.messageIds) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) continue
            if (!selection.toolIds.includes(part.callID)) continue

            // Code Mode nests the real calls under metadata; the outer input is
            // a bundle, so a path search over it finds nothing.
            const metadata = "metadata" in part.state ? part.state.metadata : undefined
            const nested =
                part.tool === "execute" && Array.isArray(metadata?.toolCalls)
                    ? metadata.toolCalls
                    : []

            for (const call of nested) {
                if (!call || typeof call.tool !== "string") continue
                for (const path of getFilePathsFromParameters(call.tool, call.input)) {
                    const key = normalize(path)
                    if (!key) continue
                    const existing = readsByPath.get(key)
                    if (existing) existing.reads += 1
                    else readsByPath.set(key, { path, reads: 1 })
                }
            }

            for (const path of getFilePathsFromParameters(part.tool, part.state.input)) {
                const key = normalize(path)
                if (!key) continue
                const existing = readsByPath.get(key)
                if (existing) existing.reads += 1
                else readsByPath.set(key, { path, reads: 1 })
            }
        }
    }

    return [...readsByPath.values()]
        .filter((entry) => entry.reads >= MIN_READS)
        .filter((entry) => !isMentioned(entry.path, summaryLower))
        .sort((a, b) => b.reads - a.reads || a.path.localeCompare(b.path))
        .slice(0, MAX_PATHS)
}

export function appendRetainedFilePaths(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
): string {
    let retained: Array<{ path: string; reads: number }>
    try {
        retained = collectRetainedFilePaths(summary, selection, searchContext)
    } catch {
        // A malformed tool input must never block a compression.
        return summary
    }

    if (retained.length === 0) return summary

    const heading = "\n\nFiles read repeatedly in this range and not named in the summary above:"
    const body = retained.map((entry) => `\n- ${entry.path} (${entry.reads}x)`).join("")
    return summary + heading + body
}
