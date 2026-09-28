import { tool } from "@opencode-ai/plugin"
import type { RecallConfig } from "../config"
import type { ToolContext } from "../compress/types"
import type { IdFormat } from "../message-ids"
import { formatBlockRef, parseBlockRef, formatMessageRef } from "../message-ids"
import { formatTokenCount } from "../ui/utils"
import { countAllMessageTokens, countTokens } from "../token-utils"
import { saveSessionState } from "../state"
import { fetchSessionMessages } from "../compress/search"
import type { WithParts } from "../state"

// A retrieval tool that returns whole messages can hand back more than the
// compression it replaced. Codex's retrieval tools take the smaller of the host
// truncation budget and their own cap, and describe the cap in the schema; the
// limits below are this side of that, and they are settable under `recall` so a
// user can tighten them without a rebuild. A read that would exceed the budget
// is refused rather than shortened: a silently cut answer is indistinguishable
// from a complete one.
export const DEFAULT_LIMITS = {
    maxSearchResults: 10,
    maxCharsPerItem: 240,
    maxReadTokens: 4000,
    resultTokenBudget: 10_000,
    maxQueryTerms: 12,
    maxQueryChars: 200,
} as const

export interface RecallLimits {
    maxSearchResults: number
    maxCharsPerItem: number
    maxReadTokens: number
    resultTokenBudget: number
    maxQueryTerms: number
    maxQueryChars: number
}

export function resolveRecallLimits(config?: RecallConfig): RecallLimits {
    const positive = (value: number | undefined, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) && value > 0
            ? Math.floor(value)
            : fallback
    return {
        maxSearchResults: positive(config?.maxSearchResults, DEFAULT_LIMITS.maxSearchResults),
        maxCharsPerItem: positive(config?.maxCharsPerItem, DEFAULT_LIMITS.maxCharsPerItem),
        maxReadTokens: positive(config?.maxReadTokens, DEFAULT_LIMITS.maxReadTokens),
        resultTokenBudget: positive(config?.resultTokenBudget, DEFAULT_LIMITS.resultTokenBudget),
        maxQueryTerms: positive(config?.maxQueryTerms, DEFAULT_LIMITS.maxQueryTerms),
        maxQueryChars: positive(config?.maxQueryChars, DEFAULT_LIMITS.maxQueryChars),
    }
}

/** Thrown for a request the tool will not silently narrow on the model's behalf. */
export class RecallError extends Error {}
// A three-character cut is as short as a term can get and still be worth
// searching: "key", "api", "git" and "sql" are all real queries. That leaves
// function words in, and they match nearly every message, so they are listed
// instead of excluded by length.
export const MIN_QUERY_TERM_LENGTH = 3

const QUERY_STOPWORDS = new Set([
    "about",
    "above",
    "after",
    "again",
    "against",
    "also",
    "and",
    "any",
    "are",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "can",
    "could",
    "did",
    "does",
    "doing",
    "done",
    "down",
    "during",
    "each",
    "either",
    "else",
    "even",
    "ever",
    "every",
    "few",
    "for",
    "from",
    "further",
    "get",
    "gets",
    "getting",
    "give",
    "given",
    "gives",
    "had",
    "has",
    "have",
    "having",
    "her",
    "here",
    "hers",
    "him",
    "his",
    "how",
    "into",
    "its",
    "itself",
    "just",
    "like",
    "made",
    "make",
    "makes",
    "many",
    "more",
    "most",
    "much",
    "must",
    "myself",
    "need",
    "needs",
    "not",
    "now",
    "off",
    "once",
    "one",
    "only",
    "onto",
    "other",
    "our",
    "ours",
    "out",
    "over",
    "own",
    "per",
    "same",
    "shall",
    "she",
    "should",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "theirs",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "thus",
    "too",
    "under",
    "until",
    "used",
    "uses",
    "using",
    "very",
    "was",
    "way",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "whose",
    "why",
    "will",
    "with",
    "within",
    "without",
    "would",
    "you",
    "your",
    "yours",
])

/**
 * Record what a retrieval put back into the context, and persist.
 *
 * Without this the only way to judge whether retrieval is worth having is
 * reasoning: a single compression saves on the order of 99,000 tokens, and
 * nothing says how much of that a search undid. The counter is the measurement.
 */
async function recordRetrieved(ctx: ToolContext, toolCtx: unknown, text: string): Promise<void> {
    const sessionID = (toolCtx as { sessionID?: string }).sessionID
    if (!sessionID) return
    const tokens = countTokens(text)
    if (tokens <= 0) return

    const stats = ctx.state.stats
    stats.retrievedTokenCounter = (stats.retrievedTokenCounter ?? 0) + tokens
    stats.totalRetrievedTokens = (stats.totalRetrievedTokens ?? 0) + tokens
    try {
        await saveSessionState(ctx.state, ctx.logger)
    } catch {
        // Losing the count is not worth failing a retrieval over.
    }
}

/**
 * Examples in the format this session actually uses.
 *
 * Naming both forms invites a model to try the other one and fail: a compact
 * session only accepts @42@, and a model shown "m0042" as an example will try
 * it. Observed in a sandbox trial, where a model burned two calls on m0678 and
 * m678 before reading the error.
 */
function refExamples(format: IdFormat, index = 42): string {
    return format === "compact"
        ? `@${index}@ or @b${index}@`
        : `m${index.toString().padStart(4, "0")} or b${index}`
}

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
            `List this session's compression blocks: reference (${refExamples(
                ctx.state.idFormat,
            )}), topic, size, and whether the block is still active. ` +
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
                    `(~${formatTokenCount(block.summaryTokens)} summary, ` +
                    `${block.directMessageIds.length} messages, ` +
                    `saved ${formatTokenCount(block.compressedTokens)})`
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
    const limits = resolveRecallLimits(ctx.config.recall)

    function resolveRef(wanted: string): string | { block: string[] } {
        const blockId = parseBlockRef(wanted, ctx.state.idFormat)
        if (blockId !== null) {
            const block = ctx.state.prune.messages.blocksById.get(blockId)
            if (!block) throw new RecallError(`${wanted}: no compressed block with that reference.`)
            const refs = block.effectiveMessageIds
                .map((id) => ctx.state.messageIds.byRawId.get(id))
                .filter((entry): entry is string => Boolean(entry))
            if (refs.length === 0) {
                throw new RecallError(`${wanted}: block "${block.topic}" has no readable messages.`)
            }
            return { block: refs }
        }
        const rawId = ctx.state.messageIds.byRef.get(wanted)
        if (!rawId) throw new RecallError(`${wanted}: no message with that reference.`)
        return rawId
    }

    async function render(
        rawId: string,
        maxChars: number,
        sessionID: string,
        offset: number,
    ): Promise<string> {
        const messages = await fetchSessionMessages(ctx.client, sessionID)
        const message = messages.find((entry) => entry.info.id === rawId)
        if (!message) return "(no longer in the session history)"
        const text = messageText(message)
        const start = offset > 0 ? Math.min(offset, text.length) : 0
        const slice = text.slice(start, start + maxChars)
        const consumed = start + slice.length
        return [
            `(${message.info.role}, ~${formatTokenCount(countAllMessageTokens(message))})`,
            consumed < text.length
                ? markTruncation(
                      slice,
                      `showing ${consumed} of ${text.length} characters. Continue with offset=${consumed}.`,
                  )
                : slice,
        ].join("\n")
    }

    return tool({
        description:
            `Read one or more original messages by reference, for example ${refExamples(
                ctx.state.idFormat,
            )}. ` +
            "A block reference lists the messages that block covers. " +
            `The whole call returns at most ${limits.maxReadTokens} tokens. ` +
            "Original messages are never deleted by compression, so anything you can see a reference to is still there.",
        args: {
            refs: tool.schema
                .array(tool.schema.string())
                .describe("One or more message references, e.g. @1@ or m0042"),
            offset: tool.schema
                .number()
                .optional()
                .describe("Character offset to resume from when a message was cut short"),
            limit: tool.schema
                .number()
                .optional()
                .describe(`Token cap for the whole call, up to ${limits.maxReadTokens}`),
        },
        async execute({ refs, limit, offset }, toolCtx) {
            const sessionID = (toolCtx as unknown as { sessionID?: string }).sessionID
            if (!sessionID) return "read_item needs a session."

            const wanted = (Array.isArray(refs) ? refs : [refs]).map((r) => String(r).trim())
            if (wanted.length === 0) return "read_item needs at least one reference."

            const cap = Math.min(
                limits.maxReadTokens,
                typeof limit === "number" && limit > 0 ? Math.floor(limit) : limits.maxReadTokens,
            )
            const maxChars = cap * 4 // ~4 characters per token
            const perRef = Math.max(1, Math.floor(maxChars / wanted.length))

            const parts: string[] = []
            let readAnything = false
            for (const ref of wanted) {
                try {
                    const resolved = resolveRef(ref)
                    if (typeof resolved === "string") {
                        readAnything = true
                        parts.push(
                            `--- ${ref}\n${await render(resolved, perRef, sessionID, offset ?? 0)}`,
                        )
                    } else {
                        parts.push(
                            `--- ${ref}\nBlock covers ${resolved.block.length} message(s): ` +
                                resolved.block.slice(0, 20).join(", ") +
                                (resolved.block.length > 20 ? ", ..." : "") +
                                "\nPass one of these to read_item to read it.",
                        )
                    }
                } catch (error) {
                    const known = [...ctx.state.messageIds.byRef.keys()].slice(0, 12)
                    parts.push(
                        error instanceof RecallError
                            ? `--- ${error.message}` +
                                  (known.length > 0 ? ` Known references: ${known.join(", ")}` : "")
                            : `--- ${ref}: ${String(error)}`,
                    )
                }
            }
            const output = parts.join("\n")
            const tokens = countTokens(output)
            if (tokens > limits.resultTokenBudget) {
                // Say what to set, not just that it is too big. The budget is per
                // call and the limit is per reference, so the split is knowable
                // and a model that only has to copy a number gets there in one
                // try instead of halving its way down.
                const perRef = Math.max(1, Math.floor(limits.resultTokenBudget / wanted.length))
                return [
                    `Refusing: ~${tokens} tokens exceeds the ${limits.resultTokenBudget} token limit for one read_item call.`,
                    `Read ${wanted.length} reference(s) at about ${perRef} tokens each:`,
                    `  read_item with refs: [${wanted.map((r) => `"${r}"`).join(", ")}] and limit: ${perRef}.`,
                    "To page through the rest of a message, add offset to resume where the last one stopped.",
                ].join("\n")
            }
            // A call that only reported errors retrieved nothing, and the counter
            // exists to measure what came back.
            if (readAnything) await recordRetrieved(ctx, toolCtx, output)
            return output
        },
    })
}

interface RecallMatch {
    ref: string
    role: string
    blockRefs: string[]
    tokens: number
    /** How many query terms this message contains. */
    hitTerms: number
    snippet: string
}

/**
 * Split a query into the terms worth searching for.
 *
 * A model passes keywords, not sentences. "ARCHIVE-CANARY-7749 OFFSET_TABLE
 * region kilo base hook" is a reasonable thing to type and it will never appear
 * verbatim in any message, so matching the whole string finds nothing. Very
 * short terms are dropped because they match everything.
 */
export function parseQueryTerms(query: string): string[] {
    const terms = query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.\-/]+/u)
        .map((term) => term.replace(/^["']|["']$/g, ""))
        .filter((term) => term.length >= MIN_QUERY_TERM_LENGTH && !QUERY_STOPWORDS.has(term))

    return [...new Set(terms)]
}

export function findRecallMatches(
    state: ToolContext["state"],
    query: string,
    idFormat: IdFormat,
    messages: WithParts[],
    maxResults: number = DEFAULT_LIMITS.maxSearchResults,
    maxCharsPerItem: number = DEFAULT_LIMITS.maxCharsPerItem,
): RecallMatch[] {
    const terms = parseQueryTerms(query)
    if (terms.length === 0) return []

    const blockByMessageId = new Map<string, number[]>()
    for (const block of state.prune.messages.blocksById.values()) {
        for (const messageId of block.effectiveMessageIds) {
            const list = blockByMessageId.get(messageId)
            if (list) list.push(block.blockId)
            else blockByMessageId.set(messageId, [block.blockId])
        }
    }

    const found: RecallMatch[] = []
    for (const message of messages) {
        const rawId = message.info.id
        const ref = state.messageIds.byRawId.get(rawId)
        if (!ref) continue

        const text = messageText(message)
        const haystack = text.toLowerCase()

        let hitTerms = 0
        let firstIndex = -1
        for (const term of terms) {
            const at = haystack.indexOf(term)
            if (at === -1) continue
            hitTerms += 1
            if (firstIndex === -1 || at < firstIndex) firstIndex = at
        }
        if (hitTerms === 0) continue

        const from = Math.max(0, firstIndex - maxCharsPerItem / 3)
        const blockIds = blockByMessageId.get(rawId) ?? []
        found.push({
            ref,
            role: message.info.role,
            blockRefs: blockIds.map((blockId) => formatBlockRef(blockId, idFormat)),
            tokens: countAllMessageTokens(message),
            hitTerms,
            snippet:
                (from > 0 ? "..." : "") +
                text.slice(from, from + maxCharsPerItem).replace(/\s+/g, " ") +
                (from + maxCharsPerItem < text.length ? "..." : ""),
        })
    }

    // Best match first, and the head of the conversation before its tail.
    found.sort((a, b) => b.hitTerms - a.hitTerms || a.ref.localeCompare(b.ref))
    return found.slice(0, maxResults)
}

export function renderRecallResult(matches: RecallMatch[], terms: string[] = []): string {
    const header =
        matches.length === 0
            ? "No matches in the original messages."
            : `Found ${matches.length} matching message(s). This is a list of references, not their content:`

    const lines = [header]
    for (const match of matches) {
        lines.push(
            // The unit matters: a bare "~678" next to a reference reads as part
            // of the identifier, and a model in a sandbox trial took it for the
            // message index and built "m0678" out of it.
            `  ${match.ref}  ${match.role}  ~${formatTokenCount(match.tokens)}` +
                `  (${match.hitTerms}/${terms.length || match.hitTerms} terms)` +
                (match.blockRefs.length > 0 ? `  in ${match.blockRefs.join(", ")}` : "") +
                `\n    ${match.snippet}`,
        )
    }

    if (terms.length > 0) {
        const hit = new Set<string>()
        for (const match of matches) {
            for (const term of terms) {
                if (match.snippet.toLowerCase().includes(term)) hit.add(term)
            }
        }
        const missed = terms.filter((term) => !hit.has(term))
        if (missed.length > 0) {
            lines.push(`No message contains: ${missed.join(", ")}`)
        }
    }

    if (matches.length > 0) {
        lines.push(
            "",
            "Pass a reference to read_item to get the full message. Nothing has been added to the context yet.",
        )
    }
    return lines.join("\n")
}

export function createRecallTool(ctx: ToolContext) {
    const limits = resolveRecallLimits(ctx.config.recall)
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
            const terms = parseQueryTerms(query)
            const matches = findRecallMatches(
                ctx.state,
                query,
                ctx.state.idFormat,
                messages,
                limits.maxSearchResults,
                limits.maxCharsPerItem,
            )
            const output = renderRecallResult(matches, terms)
            await recordRetrieved(ctx, toolCtx, output)
            return output
        },
    })
}

export { formatMessageRef }
