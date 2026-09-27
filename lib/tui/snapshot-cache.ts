/**
 * Cache behind the session panel. The panel used to take one snapshot when it
 * opened and then sit there showing stale numbers, so every server notice must
 * drop the entry for the session it belongs to.
 */
export interface SnapshotCache<T> {
    get(sessionID: string): T | undefined
    /** Stores a result. Ignored if one is already cached, to avoid a late
     * response from an invalidated fetch overwriting fresher data. */
    put(sessionID: string, value: T): void
    /** True when a fetch is worth starting. False while one is in flight. */
    shouldFetch(sessionID: string): boolean
    /** Marks a fetch as started; pair with endFetch in a finally block. */
    beginFetch(sessionID: string): void
    endFetch(sessionID: string): void
    /** Drops one session, or all of them when called with no id. */
    invalidate(sessionID?: string): void
}

export function createSnapshotCache<T>(): SnapshotCache<T> {
    const entries = new Map<string, T>()
    const inFlight = new Set<string>()

    return {
        get: (sessionID) => entries.get(sessionID),
        put: (sessionID, value) => {
            if (!entries.has(sessionID)) entries.set(sessionID, value)
        },
        shouldFetch: (sessionID) => !entries.has(sessionID) && !inFlight.has(sessionID),
        beginFetch: (sessionID) => {
            inFlight.add(sessionID)
        },
        endFetch: (sessionID) => {
            inFlight.delete(sessionID)
        },
        invalidate: (sessionID) => {
            if (sessionID) entries.delete(sessionID)
            else entries.clear()
        },
    }
}
