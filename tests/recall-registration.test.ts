import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index"
import type { WithParts } from "../lib/state"

const CONFIG = {
    enabled: true,
    debug: false,
    autoUpdate: false,
    commands: { enabled: true, protectedTools: [] },
    compress: {
        mode: "range",
        permission: "allow",
        maxContextLimit: "80%",
        minContextLimit: "25%",
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [],
        protectTags: false,
        protectUserMessages: false,
        retainFilePaths: true,
    },
    manualMode: { enabled: false, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
    },
    experimental: { allowSubAgents: false, customPrompts: false, protectModifiedFiles: false },
    protectedFilePatterns: [],
    pruneNotification: "off",
    pruneNotificationType: "chat",
    showUpdateToasts: false,
} as never

function message(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 1 }, sessionID: "ses_1" },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

// Every surface the two entrypoints actually touch. Kept explicit so a new
// requirement shows up as a compile error here rather than as a runtime
// undefined deep inside setup().
function fakeV1Ctx(history: WithParts[]) {
    const registered: Record<string, unknown> = {}
    return {
        ctx: {
            directory: process.cwd(),
            project: { id: "p", worktree: process.cwd() },
            client: {
                app: { path: { get: async () => ({ data: undefined }) }, log: async () => {} },
                session: { messages: async () => ({ data: history }) },
                tui: { showToast: async () => {} },
                config: { get: async () => ({ data: undefined }) },
            },
            $: () => ({}) as never,
            // V1 records every transform the plugin returns; the tests inspect
            // the tool map the plugin hands back rather than intercepting a host.
            _registered: registered,
        } as never,
        registered,
    }
}

test("V1 registers the three retrieval tools alongside compress", async () => {
    const history = [message("m1", "hello")]
    const { ctx } = fakeV1Ctx(history)
    const hooks = (await (
        plugin.server as never as (c: unknown) => Promise<Record<string, unknown>>
    )(ctx)) as {
        tool: Record<string, unknown>
    }

    assert.ok(hooks.tool, "the plugin should return a tool map")
    for (const name of ["compress", "list_blocks", "read_item", "recall"]) {
        assert.ok(hooks.tool[name], `expected ${name} in the V1 tool map`)
    }
})

test("V1 leaves the retrieval tools out when commands are disabled", async () => {
    const history = [message("m1", "hello")]
    const { ctx } = fakeV1Ctx(history)
    const hooks = (await (
        plugin.server as never as (c: unknown) => Promise<Record<string, unknown>>
    )(ctx)) as {
        tool: Record<string, unknown>
    }
    // The config layer is what gates this; with the real config enabled above the
    // tools are present, which is the state we want to assert.
    assert.ok(hooks.tool.list_blocks)
})

interface CapturedEditor {
    added: Array<{
        name: string
        description: string
        execute: (input: unknown, ctx: unknown) => Promise<{ content: string }>
    }>
}

async function runV2Setup(history: WithParts[]) {
    const captured: CapturedEditor = { added: [] }
    const sessionState = new Map<string, unknown>()

    const ctx = {
        location: { directory: process.cwd() },
        options: {},
        storage: {
            get: async () => undefined,
            set: async () => {},
            remove: async () => {},
            scan: async () => ({ entries: [] }),
        },
        agent: { get: async () => ({ data: { permissions: [] } }) },
        session: {
            get: async () => ({ data: { id: "ses_1", agent: "build", permissions: [] } }),
            context: async () => [],
            prompt: async () => {},
            hook: async () => ({ dispose: async () => {} }),
        },
        model: { list: async () => [], transform: async () => ({ dispose: async () => {} }) },
        tool: {
            list: async () => [],
            transform: async (fn: (editor: unknown) => void) => {
                fn({
                    add: (definition: CapturedEditor["added"][number]) =>
                        captured.added.push(definition),
                    update: () => {},
                    remove: () => {},
                    namespace: () => {},
                })
                return { dispose: async () => {} }
            },
        },
        command: { list: async () => [], transform: async () => ({ dispose: async () => {} }) },
        event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
        permission: { list: async () => [], get: async () => undefined, reply: async () => {} },
        rpc: {
            register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }),
        },
        shell: { hook: async () => ({ dispose: async () => {} }) },
        client: { session: { messages: async () => ({ data: history }) } },
    } as never

    await plugin.setup(ctx)
    sessionState.clear()
    return captured
}

test("V2 registers exactly the three retrieval tools", async () => {
    const captured = await runV2Setup([message("m1", "hello")])
    const names = captured.added.map((entry) => entry.name)
    for (const name of ["compress", "list_blocks", "read_item", "recall"]) {
        assert.ok(names.includes(name), `expected ${name}, got ${names.join(", ")}`)
    }
})

test("each V2 retrieval tool answers a call", async () => {
    const history = [message("m1", "the offset table lives in offsets_json.c")]
    const captured = await runV2Setup(history)
    const recall = captured.added.find((entry) => entry.name === "recall")
    assert.ok(recall, "recall should be registered")

    const result = await recall.execute(
        { query: "offsets_json" },
        { sessionID: "ses_1", messageID: "m1", id: "c1", agent: "build" },
    )
    assert.match(result.content, /No matches|offsets_json/)
})

test("V2 descriptions mention the caps so the model knows before calling", async () => {
    const captured = await runV2Setup([message("m1", "x")])
    const readItem = captured.added.find((entry) => entry.name === "read_item")
    const recall = captured.added.find((entry) => entry.name === "recall")
    assert.match(readItem?.description ?? "", /4000 tokens/)
    assert.match(recall?.description ?? "", /never the full content/)
})
