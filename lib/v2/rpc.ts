import { tool } from "@opencode-ai/plugin"

const z = tool.schema
const session = z.object({ sessionID: z.string() })
const stats = z.object({
    sessionTokens: z.number(),
    sessionSummaryTokens: z.number(),
    sessionDurationMs: z.number(),
    sessionRetrievedTokens: z.number(),
    sessionTools: z.number(),
    sessionMessages: z.number(),
    allTime: z.object({
        totalTokens: z.number(),
        totalRetrievedTokens: z.number(),
        totalTools: z.number(),
        totalMessages: z.number(),
        sessionCount: z.number(),
    }),
})
const conflict = z.object({
    kind: z.enum(["orphaned-block", "foreign-compression"]),
    since: z.number(),
    detail: z.string(),
})

const context = z.object({
    system: z.number(),
    user: z.number(),
    assistant: z.number(),
    tools: z.number(),
    toolCount: z.number(),
    toolsInContextCount: z.number(),
    prunedTokens: z.number(),
    prunedToolCount: z.number(),
    prunedMessageCount: z.number(),
    total: z.number(),
})

// One event carries every user-facing string DCP already formats. V1 delivered
// these through client.tui.showToast and an ignored session.prompt; V2 has
// neither on the plugin side, so the TUI plugin renders them instead.
const notice = z.object({
    sessionID: z.string().optional(),
    title: z.string(),
    text: z.string(),
    level: z.enum(["info", "warning", "error"]),
    surface: z.enum(["toast", "chat"]),
})

export const rpc = {
    id: "dcp",
    methods: {
        status: { input: z.object({}), output: z.object({ enabled: z.boolean() }) },
        snapshot: {
            input: session,
            output: z.object({
                manualMode: z.boolean(),
                canCompress: z.boolean(),
                blockedReason: z.string().optional(),
                context,
                stats,
                conflicts: z.array(conflict),
            }),
        },
        manual: { input: session.extend({ enabled: z.boolean() }), output: z.object({}) },
    },
    events: { notice: { schema: notice } },
} as const
