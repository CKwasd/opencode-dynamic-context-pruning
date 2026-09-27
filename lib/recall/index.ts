import { tool } from "@opencode-ai/plugin"
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
// constants below are this side of that. Truncation is marked rather than
// silent, and read_item takes an offset so a model that only wanted the first
// part of a long message can still have it.
export const READ_ITEM_MAX_TOKENS = 4000
export const RECALL_MAX_RESULTS = 10
export const RECALL_MAX_SNIPPET_CHARS = 240
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
            `Read one original message by its reference, for example ${refExamples(
                ctx.state.idFormat,
            )}. ` +
            "A block reference lists the messages that block covers. " +
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

            const wanted = ref.trim()

            // Block references are what the model sees most, and asking for one
            // here used to be a dead end: only message refs are ever registered
            // in byRef. Name the block's messages instead of refusing.
            const blockId = parseBlockRef(wanted, ctx.state.idFormat)
            if (blockId !== null) {
                const block = ctx.state.prune.messages.blocksById.get(blockId)
                if (!block) return `No compressed block ${wanted} in this session.`
                const refs = block.effectiveMessageIds
                    .map((id) => ctx.state.messageIds.byRawId.get(id))
                    .filter((entry): entry is string => Boolean(entry))
                if (refs.length === 0) {
                    return `Block ${wanted} ("${block.topic}") has no readable messages.`
                }
                return [
                    `Block ${wanted} ("${block.topic}", ${block.active ? "active" : "inactive"}) covers ${refs.length} message(s):`,
                    ...refs.slice(0, 20).map((entry) => `  ${entry}`),
                    refs.length > 20 ? `  ... and ${refs.length - 20} more` : "",
                    "",
                    "Pass one of these references to read_item to read it.",
                ]
                    .filter(Boolean)
                    .join("\n")
            }

            const rawId = ctx.state.messageIds.byRef.get(wanted)
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

            const output = [
                `${ref}  (${message.info.role}, ~${formatTokenCount(countAllMessageTokens(message), true)})`,
                truncated
                    ? markTruncation(
                          slice,
                          `truncated at ${READ_ITEM_MAX_TOKENS} tokens, ${text.length - consumed} characters left. Continue with offset=${consumed}.`,
                      )
                    : slice,
            ].join("\n")
            await recordRetrieved(ctx, toolCtx, output)
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
    maxResults = RECALL_MAX_RESULTS,
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

        const from = Math.max(0, firstIndex - RECALL_MAX_SNIPPET_CHARS / 3)
        const blockIds = blockByMessageId.get(rawId) ?? []
        found.push({
            ref,
            role: message.info.role,
            blockRefs: blockIds.map((blockId) => formatBlockRef(blockId, idFormat)),
            tokens: countAllMessageTokens(message),
            hitTerms,
            snippet:
                (from > 0 ? "..." : "") +
                text.slice(from, from + RECALL_MAX_SNIPPET_CHARS).replace(/\s+/g, " ") +
                (from + RECALL_MAX_SNIPPET_CHARS < text.length ? "..." : ""),
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
            `  ${match.ref}  ${match.role}  ~${formatTokenCount(match.tokens, true)}` +
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
            const matches = findRecallMatches(ctx.state, query, ctx.state.idFormat, messages)
            const output = renderRecallResult(matches, terms)
            await recordRetrieved(ctx, toolCtx, output)
            return output
        },
    })
}

export { formatMessageRef }
