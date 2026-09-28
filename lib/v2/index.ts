import type { Plugin } from "@opencode/plugin"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { createCompressMessageTool, createCompressRangeTool } from "../compress"
import { createListBlocksTool, createReadItemTool, createRecallTool } from "../recall"
import { attachCompressionDuration } from "../compress/state"
import { createCommandExecuteHandler, createSystemPromptHandler } from "../hooks"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
} from "../state"
import { assignMessageRefs } from "../message-ids"
import { applyPendingManualTrigger } from "../commands/manual"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    injectExtendedSubAgentResults,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { countTokens } from "../token-utils"
import { matchesGlob } from "../protected-patterns"
import { refreshModifiedPaths } from "../protected-paths"
import { history, project } from "./messages"
import { analyzeContextTokens } from "../commands/context"
import { buildStatsReport } from "../commands/stats"
import { rpc } from "./rpc"

// Extension point for model-invisible V2 reports. Never use synthetic() here:
// its text would enter the model's context, unlike V1 ignored messages.
export interface DcpNotice {
    title: string
    text: string
    level: "info" | "warning" | "error"
    surface: "toast" | "chat"
}

type NoticeEmitter = (data: {
    sessionID?: string
    title: string
    text: string
    level: DcpNotice["level"]
    surface: DcpNotice["surface"]
}) => void

export async function report(
    logger: Logger,
    notice: DcpNotice,
    emit?: NoticeEmitter,
    sessionID?: string,
) {
    logger.debug("V2 report", { sessionID, ...notice })
    emit?.(sessionID ? { ...notice, sessionID } : notice)
}

export async function setup(ctx: Plugin.Context) {
    const warnings = {
        tui: {
            showToast: async (input: { body: { message: string } }) => {
                console.warn(`DCP: ${input.body.message}`)
            },
        },
    }
    const config = getConfig({ directory: ctx.location.directory, client: warnings })
    // Read once: the three createSessionState() calls below each used the
    // literal, so the reference format had no single place to change.
    const idFormat = config.experimental.messageIdFormat
    if (!config.enabled) {
        await ctx.rpc.register(
            { ...rpc, methods: { status: rpc.methods.status } },
            { status: async () => ({ enabled: false }) },
        )
        return
    }
    const logger = new Logger(config.debug)
    const prompts = new PromptStore(
        logger,
        ctx.location.directory,
        config.experimental.customPrompts,
        "compact",
    )
    const sessions = new Map<string, SessionState>()
    const queues = new Map<string, Promise<unknown>>()
    const limits = new Map<string, number>()
    // Assigned once ctx.rpc.register resolves. Reads happen through publish() so
    // notifications raised before registration simply stay log-only.
    let emit: NoticeEmitter | undefined
    const aliases: Record<string, string> = {
        task: "subagent",
        bash: "shell",
        apply_patch: "patch",
    }
    for (const list of [
        config.compress.protectedTools,
        config.commands.protectedTools,
        config.strategies.deduplication.protectedTools,
        config.strategies.purgeErrors.protectedTools,
    ]) {
        for (const name of [...list])
            if (aliases[name] && !list.includes(aliases[name]!)) list.push(aliases[name]!)
    }

    function serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const pending = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation)
        queues.set(sessionID, pending)
        void pending
            .finally(() => {
                if (queues.get(sessionID) === pending) queues.delete(sessionID)
            })
            .catch(() => {})
        return pending
    }

    const publish = (sessionID: string | undefined, notice: DcpNotice) =>
        report(logger, notice, emit, sessionID)

    const client = {
        session: {
            get: async ({ path }: { path: { id: string } }) => ({
                data: await ctx.session.get({ sessionID: path.id }),
            }),
            messages: async ({ path }: { path: { id: string } }) => {
                const [entries, session] = await Promise.all([
                    ctx.session.context({ sessionID: path.id }),
                    ctx.session.get({ sessionID: path.id }),
                ])
                return { data: history(entries, session) }
            },
            // V1 posted ignored prompts here so notifications land in the
            // transcript without reaching the model. V2 has no equivalent and
            // must not use synthetic(), so surface it to the user instead.
            prompt: async (input: {
                path: { id: string }
                body: { parts: Array<{ text: string }> }
            }) =>
                publish(input.path.id, {
                    title: "DCP",
                    text: input.body.parts.map((part) => part.text).join("\n"),
                    level: "info",
                    surface: "chat",
                }),
        },
        tui: {
            showToast: async (input: {
                body: { title?: string; message: string; variant?: string }
            }) =>
                publish(undefined, {
                    title: input.body.title ?? "DCP",
                    text: input.body.message,
                    level:
                        input.body.variant === "error"
                            ? "error"
                            : input.body.variant === "warning"
                              ? "warning"
                              : "info",
                    surface: "toast",
                }),
        },
    }

    async function load(sessionID: string, agentID?: string) {
        const [session, entries] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.context({ sessionID }),
        ])
        const selected =
            agentID ??
            session.agent ??
            entries.findLast((entry) => entry.type === "assistant")?.agent
        if (!selected) throw new Error("DCP commands require a session with a selected agent")
        const { data: agent } = await ctx.agent.get({ agentID: selected })
        let state = sessions.get(sessionID)
        if (!state) {
            state = createSessionState(idFormat)
            sessions.set(sessionID, state)
        }
        const messages = history(entries, session)
        await ensureSessionInitialized(
            client,
            state,
            sessionID,
            logger,
            messages,
            config.manualMode.enabled,
        )
        await checkSession(client, state, logger, messages, config.manualMode.enabled)
        const rule = [...agent.permissions, ...(session.permissions ?? [])].findLast(
            (rule) => matchesGlob("compress", rule.action) && matchesGlob("*", rule.resource),
        )
        state.compressPermission =
            config.compress.permission === "deny"
                ? "deny"
                : rule?.effect === "deny"
                  ? "deny"
                  : config.compress.permission === "ask" || rule?.effect === "ask"
                    ? "ask"
                    : "allow"
        return { state, entries, session, messages }
    }

    const retrievalContext = (state: SessionState) => ({
        client,
        state,
        logger,
        config,
        prompts,
    })

    function allowed(state: SessionState) {
        if (state.isSubAgent && !config.experimental.allowSubAgents)
            throw new Error("DCP compression is disabled in subagents")
        if (state.compressPermission === "deny") throw new Error("DCP compression is denied")
        if (state.compressPermission === "ask")
            throw new Error(
                "DCP: compress permission 'ask' is not supported by OpenCode V2's public plugin API yet. Compression was not performed.",
            )
    }

    await ctx.model.transform((editor) => {
        limits.clear()
        for (const model of editor.list())
            limits.set(`${model.providerID}/${model.id}`, model.limit.context)
    })
    for (const kind of ["context", "compaction"] as const)
        await ctx.session.hook(kind, (event) =>
            serial(event.sessionID, async () => {
                const { state, entries, session, messages } = await load(
                    event.sessionID,
                    event.agent,
                )
                if (state.isSubAgent && !config.experimental.allowSubAgents) {
                    delete event.tools.compress
                    return
                }
                if (state.compressPermission === "deny") delete event.tools.compress
                state.modelContextLimit = limits.get(`${event.model.providerID}/${event.model.id}`)
                state.systemPromptTokens = countTokens(
                    event.system.map((part) => part.text).join("\n"),
                )
                const view = project(event.messages, entries, {
                    ...session,
                    agent: event.agent,
                    model: event.model,
                })
                stripHallucinations(view.messages, state.idFormat)
                assignMessageRefs(state, view.messages)
                // Compaction may select only a prefix; block origins can be in the retained tail.
                syncCompressionBlocks(state, logger, messages)
                await refreshModifiedPaths(state, config, logger, async () =>
                    (
                        await ctx.vcs.status({
                            location: { directory: ctx.location.directory },
                        })
                    ).data.map((entry) => ({ path: entry.file, status: entry.status })),
                )
                syncToolCache(state, config, logger, view.messages)
                buildToolIdList(state, view.messages)
                prune(state, logger, config, view.messages, view.summaryBase)
                await injectExtendedSubAgentResults(
                    client,
                    state,
                    logger,
                    view.messages,
                    config.experimental.allowSubAgents,
                )
                const priorities = buildPriorityMap(config, state, view.messages)
                prompts.reload()
                injectCompressNudges(
                    state,
                    config,
                    logger,
                    view.messages,
                    prompts.getRuntimePrompts(),
                    priorities,
                    kind === "context",
                )
                injectMessageIds(state, config, view.messages, priorities)
                applyPendingManualTrigger(state, view.messages, logger)
                event.messages = view.restore()
                const system = { system: event.system.map((part) => part.text) }
                await createSystemPromptHandler(
                    state,
                    logger,
                    config,
                    prompts,
                )(
                    {
                        sessionID: event.sessionID,
                        model: { limit: { context: state.modelContextLimit ?? 0 } },
                    },
                    system,
                )
                event.system = system.system.map((text, index) => ({
                    ...event.system[index],
                    type: "text",
                    text,
                }))
                await logger.saveContext(event.sessionID, view.messages)
            }),
        )

    if (config.compress.permission !== "deny") {
        const define = (state: SessionState): ToolDefinition =>
            (config.compress.mode === "message"
                ? createCompressMessageTool
                : createCompressRangeTool)({ client, state, logger, config, prompts })
        const definition = define(createSessionState(idFormat))
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "compress",
                description: definition.description,
                input: tool.schema.object(definition.args),
                options: { codemode: false, permission: "compress" },
                execute: (input, context) =>
                    serial(context.sessionID, async () => {
                        const { state } = await load(context.sessionID, context.agent)
                        allowed(state)
                        const started = Date.now()
                        const legacy = define(state)
                        const content = await legacy.execute(input, {
                            sessionID: context.sessionID,
                            messageID: context.messageID,
                            callID: context.id,
                            agent: context.agent,
                            directory: ctx.location.directory,
                            worktree: ctx.location.directory,
                            abort: new AbortController().signal,
                            ask: async () => allowed(state),
                            metadata: ({ title }: { title?: string }) => {
                                void context.progress({ title })
                            },
                        } as Parameters<typeof legacy.execute>[1])
                        attachCompressionDuration(
                            state.prune.messages,
                            context.messageID,
                            context.id,
                            Date.now() - started,
                        )
                        await saveSessionState(state, logger)
                        // Both shared compression executors return text; the V1 helper's
                        // public return type also permits unrelated attachment results.
                        return { content: content as string }
                    }),
            }),
        )

        if (config.commands.enabled) {
            const factories = {
                list_blocks: createListBlocksTool,
                read_item: createReadItemTool,
                recall: createRecallTool,
            }
            // Description and args are read off a throwaway state; the executor
            // is rebuilt per call against the session's live state, the same way
            // the compress tool above does it.
            const specs = Object.entries(factories).map(([name, make]) => {
                const proto = make(retrievalContext(createSessionState(idFormat)))
                return { name, make, description: proto.description, args: proto.args }
            })

            await ctx.tool.transform((editor) => {
                for (const spec of specs) {
                    editor.add({
                        name: spec.name,
                        description: spec.description,
                        input: tool.schema.object(spec.args),
                        options: { codemode: false },
                        execute: (input, context) =>
                            serial(context.sessionID, async () => {
                                const { state } = await load(context.sessionID, context.agent)
                                const impl = spec.make(retrievalContext(state))
                                const result = await impl.execute(
                                    input as never,
                                    {
                                        sessionID: context.sessionID,
                                        messageID: context.messageID,
                                        callID: context.id,
                                        agent: context.agent,
                                        directory: ctx.location.directory,
                                        worktree: ctx.location.directory,
                                        abort: new AbortController().signal,
                                    } as never,
                                )
                                return { content: String(result) }
                            }),
                    })
                }
            })
        }
    }
    if (config.commands.enabled)
        await ctx.command.transform((editor) => {
            for (const name of ["dcp", "dcp-compress"])
                editor.add({
                    name,
                    description: name === "dcp" ? "DCP commands" : "Trigger DCP manual compression",
                    execute: async (invocation) => {
                        const prompt = await serial(invocation.sessionID, async () => {
                            const { state } = await load(invocation.sessionID)
                            const permission =
                                state.compressPermission ?? config.compress.permission
                            if (
                                name === "dcp-compress" ||
                                invocation.prompt.text.trim().split(/\s+/)[0] === "compress"
                            )
                                allowed(state)
                            const output = { parts: [] }
                            await createCommandExecuteHandler(
                                client,
                                state,
                                logger,
                                config,
                                ctx.location.directory,
                                { global: { compress: permission }, agents: {} },
                            )(
                                {
                                    command: name,
                                    sessionID: invocation.sessionID,
                                    arguments: invocation.prompt.text,
                                },
                                output,
                            )
                            state.compressPermission = permission
                            // The V1 handler writes its report into `output.parts`;
                            // V2 discards that, so hand it to the user instead of
                            // dropping /dcp context|stats|sweep|manual output.
                            const text = (output.parts as Array<{ text?: unknown }>)
                                .map((part) => (typeof part?.text === "string" ? part.text : ""))
                                .join("\n")
                                .trim()
                            if (text)
                                publish(invocation.sessionID, {
                                    title: "DCP",
                                    text,
                                    level: "info",
                                    surface: "chat",
                                })
                            const pending = state.pendingManualTrigger
                            if (!pending) return
                            allowed(state)
                            state.pendingManualTrigger = null
                            return pending.prompt
                        })
                        if (prompt)
                            await ctx.session.prompt({
                                sessionID: invocation.sessionID,
                                text: prompt,
                                delivery: invocation.delivery,
                            })
                    },
                })
        })
    const registration = await ctx.rpc.register(rpc, {
        status: async () => ({ enabled: config.commands.enabled }),
        snapshot: ({ sessionID }) =>
            serial(sessionID, async () => {
                const { state, messages } = await load(sessionID)
                syncCompressionBlocks(state, logger, messages)
                return {
                    manualMode: !!state.manualMode,
                    canCompress:
                        state.compressPermission === "allow" &&
                        (!state.isSubAgent || config.experimental.allowSubAgents),
                    ...(state.compressPermission === "ask"
                        ? {
                              blockedReason:
                                  "Permission 'ask' is not supported by the V2 plugin API yet.",
                          }
                        : {}),
                    context: analyzeContextTokens(state, messages),
                    stats: await buildStatsReport(state, logger),
                }
            }),
        manual: ({ sessionID, enabled }) =>
            serial(sessionID, async () => {
                const { state } = await load(sessionID)
                state.manualMode = enabled ? "active" : false
                await saveSessionState(state, logger)
                return {}
            }),
    })
    emit = (data) => {
        void registration.events.emit("notice", data).catch((cause) => {
            logger.debug("notice emit failed", { error: String(cause) })
        })
    }
    logger.info("DCP V2 initialized")
    return () => {
        emit = undefined
        sessions.clear()
        limits.clear()
    }
}
