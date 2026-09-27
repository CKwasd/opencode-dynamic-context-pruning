import type { PluginConfig } from "./config"
import type { Logger } from "./logger"
import type { SessionState } from "./state"

const REFRESH_INTERVAL_MS = 30_000

export interface ModifiedFile {
    path: string
    status: string
}

/**
 * Tool inputs name a file however the model happened to write it: absolute,
 * relative, backslashes or slashes. The host reports modified files as
 * repo-relative paths, so comparing the two directly would miss most matches
 * and the protection would silently not apply.
 *
 * Prefixing the reported path with a double-star-and-slash (the same form
 * protectedFilePatterns documents) matches the same file at any depth. Two
 * files sharing a suffix under different roots both match, so this
 * over-protects rather than under-protects -- the safe direction for something
 * whose job is to not lose work.
 */
export function modifiedPathPatterns(entries: ModifiedFile[]): string[] {
    const patterns = new Set<string>()
    for (const entry of entries) {
        // A deleted file has no content left to protect.
        if (entry.status === "deleted") continue
        const path = entry.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "")
        if (!path || path.split("/").includes("..")) continue
        patterns.add(`**/${path}`)
    }
    return [...patterns]
}

/** The pattern list every protection check should use for this request. */
export function effectiveFilePatterns(state: SessionState, config: PluginConfig): string[] {
    if (state.modifiedPathPatterns.length === 0) return config.protectedFilePatterns
    return [...config.protectedFilePatterns, ...state.modifiedPathPatterns]
}

/**
 * Refresh the modified-file set, at most once per interval. Runs inside the
 * request path, so a failure keeps the previous set rather than dropping
 * protection for that turn.
 */
export async function refreshModifiedPaths(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    fetchStatus: () => Promise<ModifiedFile[]>,
): Promise<void> {
    if (!config.experimental.protectModifiedFiles) return

    const now = Date.now()
    if (now - state.modifiedPathsFetchedAt < REFRESH_INTERVAL_MS) return
    state.modifiedPathsFetchedAt = now

    try {
        const entries = await fetchStatus()
        const patterns = modifiedPathPatterns(entries)
        if (patterns.length !== state.modifiedPathPatterns.length) {
            logger.debug("Modified-file protection refreshed", {
                files: entries.length,
                patterns: patterns.length,
                paths: entries.map((entry) => `${entry.status}:${entry.path}`),
            })
        }
        state.modifiedPathPatterns = patterns
    } catch (error) {
        logger.debug("Could not read modified-file status", { error: String(error) })
    }
}
