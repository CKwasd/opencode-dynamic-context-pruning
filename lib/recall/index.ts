import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "../compress/types"
import type { IdFormat } from "../message-ids"
import { formatBlockRef, formatMessageRef } from "../message-ids"
import { formatTokenCount } from "../ui/utils"
import { countAllMessageTokens } from "../token-utils"
import { fetchSessionMessages } from "../compress/search"
import type { WithParts } from "../state"

// A retrieval tool that returns whole messages can hand back more than the
// compression it replaced. Codex's retrieval tools take the smaller of the host
// truncation budget and their own cap, and describe the cap in the schema; the
// constants below are this side of that. Truncation is marked rather than
// silent, and read_item takes an offset so a model that only wanted the first
// part of a long message can still have it.
export const READ_ITEM_MAX_TOKENS = 4000
export const RECALL_MAX_RESULTS = 10
export const RECALL_MAX_SNIPPET_CHARS = 240

export function messageText(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const chunks: string[] = []
    for (const part of parts) {
        const p = part as {
            type?: string
            text?: unknown
            tool?: string
            state?: { output?: unknown }
        }
        if (p.type === "text" && typeof p.text === "string") {
            chunks.push(p.text)
        } else if (p.type === "tool" && typeof p.tool === "string") {
            const output = p.state?.output
            if (typeof output === "string") chunks.push(`[${p.tool}] ${output}`)
            else if (output !== undefined) chunks.push(`[${p.tool}] ${JSON.stringify(output)}`)
        }
    }
    return chunks.join("\n")
}

export function markTruncation(text: string, note: string): string {
    return text.length > 0 ? `${text}\n\n[${note}]` : text
}

export function createListBlocksTool(ctx: ToolContext) {
    return tool({
        description:
            "List this session's compression blocks: reference, topic, size, and whether the block is still active. " +
            "Use it to find out what has been compressed before asking for anything back. Read-only.",
        args: {},
        async execute(_input, toolCtx) {
            void toolCtx
            const blocks = [...ctx.state.prune.messages.blocksById.values()].sort(
                (a, b) => a.blockId - b.blockId,
            )
            if (blocks.length === 0) return "No compressed blocks in this session yet."

            const lines = blocks.map((block) => {
                const state = block.active ? "active" : "inactive"
                return (
                    `${formatBlockRef(block.blockId, ctx.state.idFormat)}  ${state}  ${block.topic}  ` +
                    `(~${formatTokenCount(block.summaryTokens, true)} summary, ` +
                    `${block.directMessageIds.length} messages, ` +
                    `saved ${formatTokenCount(block.compressedTokens, true)})`
                )
            })
            return [
                `${blocks.length} compressed block(s):`,
                ...lines,
                "",
                "Use recall to search across them, or read_item with a message reference.",
            ].join("\n")
        },
    })
}

export function createReadItemTool(ctx: ToolContext) {
    return tool({
        description:
            "Read one original message by its reference, for example m0042 or @42@. " +
            `Returns at most ${READ_ITEM_MAX_TOKENS} tokens; pass offset to continue. ` +
            "Original messages are never deleted by compression, so anything you can see a reference to is still there.",
        args: {
            ref: tool.schema.string().describe("Message reference, e.g. m0042 or @42@"),
            offset: tool.schema
                .number()
                .optional()
                .describe("Character offset to resume from when a message was truncated"),
        },
        async execute({ ref, offset }, toolCtx) {
            const sessionID = (toolCtx as unknown as { sessionID?: string }).sessionID
            if (!sessionID) return "read_item needs a session."

            const rawId = ctx.state.messageIds.byRef.get(ref.trim())
            if (!rawId) {
                const known = [...ctx.state.messageIds.byRef.keys()].slice(0, 10)
                return [
                    `No message with reference ${ref}.`,
                    known.length > 0
                        ? `References in this session include: ${known.join(", ")}`
                        : "No message references have been assigned yet.",
                ].join("\n")
            }

            const messages = await fetchSessionMessages(ctx.client, sessionID)
            const message = messages.find((entry) => entry.info.id === rawId)
            if (!message) {
                return `Message ${ref} is no longer in the session history.`
            }

            const text = messageText(message)
            const start = typeof offset === "number" && offset > 0 ? offset : 0
            // ~4 characters per token is the usual English ratio; the cap is a
            // guard on the returned size, not an exact tokenizer.
            const maxChars = READ_ITEM_MAX_TOKENS * 4
            const slice = text.slice(start, start + maxChars)
            const consumed = start + slice.length
            const truncated = consumed < text.length

            return [
                `${ref}  (${message.info.role}, ~${formatTokenCount(countAllMessageTokens(message), true)})`,
                truncated
                    ? markTruncation(
                          slice,
                          `truncated at ${READ_ITEM_MAX_TOKENS} tokens, ${text.length - consumed} characters left. Continue with offset=${consumed}.`,
                      )
                    : slice,
            ].join("\n")
        },
    })
}

interface RecallMatch {
    ref: string
    role: string
    blockRefs: string[]
    tokens: number
    snippet: string
}

export function findRecallMatches(
    state: ToolContext["state"],
    query: string,
    idFormat: IdFormat,
    messages: WithParts[],
    maxResults = RECALL_MAX_RESULTS,
): RecallMatch[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return []

    const blockByMessageId = new Map<string, number[]>()
    for (const block of state.prune.messages.blocksById.values()) {
        for (const messageId of block.effectiveMessageIds) {
            const list = blockByMessageId.get(messageId)
            if (list) list.push(block.blockId)
            else blockByMessageId.set(messageId, [block.blockId])
        }
    }

    const matches: RecallMatch[] = []
    for (const message of messages) {
        const rawId = message.info.id
        const ref = state.messageIds.byRawId.get(rawId)
        if (!ref) continue

        const text = messageText(message)
        const index = text.toLowerCase().indexOf(needle)
        if (index === -1) continue

        const from = Math.max(0, index - RECALL_MAX_SNIPPET_CHARS / 3)
        const blockIds = blockByMessageId.get(rawId) ?? []
        matches.push({
            ref,
            role: message.info.role,
            blockRefs: blockIds.map((blockId) => formatBlockRef(blockId, idFormat)),
            tokens: countAllMessageTokens(message),
            snippet:
                (from > 0 ? "..." : "") +
                text.slice(from, from + RECALL_MAX_SNIPPET_CHARS).replace(/\s+/g, " ") +
                (from + RECALL_MAX_SNIPPET_CHARS < text.length ? "..." : ""),
        })
        if (matches.length >= maxResults) break
    }

    return matches
}

export function renderRecallResult(matches: RecallMatch[]): string {
    if (matches.length === 0) return "No matches in the original messages."

    return [
        `Found ${matches.length} matching message(s). This is a list of references, not their content:`,
        ...matches.map(
            (match) =>
                `  ${match.ref}  ${match.role}  ~${formatTokenCount(match.tokens, true)}` +
                (match.blockRefs.length > 0 ? `  in ${match.blockRefs.join(", ")}` : "") +
                `\n    ${match.snippet}`,
        ),
        "",
        "Pass a reference to read_item to get the full message. Nothing has been added to the context yet.",
    ].join("\n")
}

export function createRecallTool(ctx: ToolContext) {
    return tool({
        description:
            "Search this session's original messages for a keyword. Returns references and short snippets only, " +
            "never the full content, so a search cannot undo the compression that made it necessary. " +
            "Pass a reference to read_item to retrieve what you actually need.",
        args: {
            query: tool.schema.string().describe("Keyword or phrase to search for"),
        },
        async execute({ query }, toolCtx) {
            const sessionID = (toolCtx as unknown as { sessionID?: string }).sessionID
            if (!sessionID) return "recall needs a session."

            const messages = await fetchSessionMessages(ctx.client, sessionID)
            const matches = findRecallMatches(ctx.state, query, ctx.state.idFormat, messages)
            return renderRecallResult(matches)
        },
    })
}

export { formatMessageRef }
