import assert from "node:assert/strict"
import test from "node:test"
import { createSnapshotCache } from "../lib/tui/snapshot-cache"

test("a miss is worth fetching, a hit is not", () => {
    const cache = createSnapshotCache<number>()
    assert.equal(cache.shouldFetch("a"), true)
    cache.put("a", 1)
    assert.equal(cache.shouldFetch("a"), false)
    assert.equal(cache.get("a"), 1)
})

test("concurrent renders do not start a second fetch for the same session", () => {
    const cache = createSnapshotCache<number>()
    assert.equal(cache.shouldFetch("a"), true)
    cache.beginFetch("a")
    assert.equal(cache.shouldFetch("a"), false, "second render must not refetch")
    cache.endFetch("a")
    assert.equal(cache.shouldFetch("a"), true, "a failed fetch must be retryable")
})

test("sessions do not share entries", () => {
    const cache = createSnapshotCache<number>()
    cache.put("a", 1)
    cache.put("b", 2)
    assert.equal(cache.get("a"), 1)
    assert.equal(cache.get("b"), 2)
})

test("invalidate drops one session and leaves the rest", () => {
    const cache = createSnapshotCache<number>()
    cache.put("a", 1)
    cache.put("b", 2)
    cache.invalidate("a")
    assert.equal(cache.get("a"), undefined)
    assert.equal(cache.get("b"), 2)
    assert.equal(cache.shouldFetch("a"), true)
})

test("invalidate with no id drops everything", () => {
    const cache = createSnapshotCache<number>()
    cache.put("a", 1)
    cache.put("b", 2)
    cache.invalidate()
    assert.equal(cache.get("a"), undefined)
    assert.equal(cache.get("b"), undefined)
})

test("a late response cannot overwrite fresher data", () => {
    const cache = createSnapshotCache<number>()
    // A notice lands while the first fetch is still in flight.
    cache.beginFetch("a")
    cache.put("a", 100)
    cache.invalidate("a")
    cache.put("a", 200)
    // The stale first response finally arrives.
    cache.put("a", 1)
    assert.equal(cache.get("a"), 200)
})
