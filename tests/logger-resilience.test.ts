import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Logger } from "../lib/logger"

function withTempLogDir<T>(enabled: boolean, run: (logger: Logger) => Promise<T>): Promise<T> {
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousDataHome = process.env.XDG_DATA_HOME
    const root = mkdtempSync(join(tmpdir(), "dcp-log-"))
    process.env.XDG_CONFIG_HOME = root
    process.env.XDG_DATA_HOME = root
    return run(new Logger(enabled)).finally(() => {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
    })
}

function todayLog(logger: Logger): string {
    const stamp = new Date().toISOString().split("T")[0]
    // logDir is <config home>/opencode/logs/dcp/daily
    const root = process.env.XDG_CONFIG_HOME
    assert.ok(root)
    return join(root, "opencode", "logs", "dcp", "daily", `${stamp}.log`)
}

test("a value whose toJSON returns undefined is dropped, not thrown", async () => {
    await withTempLogDir(true, async (logger) => {
        const hostile = {
            toJSON() {
                return undefined
            },
        }
        await assert.doesNotReject(() => logger.info("hostile value", { bad: hostile }))

        const line = readFileSync(todayLog(logger), "utf-8")
        assert.match(line, /hostile value\n$/)
        assert.equal(line.trim().split("\n").length, 1)
    })
})

test("a circular value is dropped, not thrown", async () => {
    await withTempLogDir(true, async (logger) => {
        const cyclic: Record<string, unknown> = { name: "loop" }
        cyclic.self = cyclic
        await assert.doesNotReject(() => logger.info("cyclic value", { bad: cyclic }))

        const line = readFileSync(todayLog(logger), "utf-8")
        assert.match(line, /cyclic value\n$/)
    })
})

test("a hostile value does not cost the rest of the line its fields", async () => {
    await withTempLogDir(true, async (logger) => {
        await logger.info("survivors", {
            bad: {
                toJSON() {
                    return undefined
                },
            },
            good: "kept",
        })

        const line = readFileSync(todayLog(logger), "utf-8")
        assert.match(line, /survivors \| good=kept\n$/)
    })
})

test("concurrent writes do not tear lines apart", async () => {
    const calls = 200
    await withTempLogDir(true, async (logger) => {
        // Callers never await info/debug, so these all race on the same file.
        await Promise.all(Array.from({ length: calls }, (_, i) => logger.info("concurrent", { i })))

        const lines = readFileSync(todayLog(logger), "utf-8").split("\n").filter(Boolean)
        assert.equal(lines.length, calls)
        for (let i = 0; i < calls; i++) {
            assert.match(lines[i]!, /^\d{4}-\d{2}-\d{2}T\S+ INFO\s+\S+: concurrent \| i=\d+$/)
        }
    })
})

test("a disabled logger writes nothing and resolves", async () => {
    await withTempLogDir(false, async (logger) => {
        await Promise.all([logger.info("quiet", { i: 1 }), logger.debug("quiet", { i: 2 })])
        assert.throws(() => readFileSync(todayLog(logger), "utf-8"), /ENOENT/)
    })
})
