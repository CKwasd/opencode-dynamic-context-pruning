import { COMPRESSED_BLOCK_HEADER } from "../compress/state"

/**
 * A line shaped like "Compressed 7 messages into [Compressed conversation
 * section]." is the compress tool's own result, not something you write.
 *
 * A model under context pressure has been observed emitting that shape as plain
 * assistant text, 17 times over two hours, while its real context usage climbed
 * from 30% to 89% because nothing had been folded. Writing the line fakes a
 * state change that did not happen. Emitted only when the marker is actually
 * visible in the conversation, since there is nothing to imitate otherwise.
 */
export function markerIntegrityNote(): string {
    return `MARKER INTEGRITY
A line shaped like "Compressed N messages into ${COMPRESSED_BLOCK_HEADER}." is the compress tool's own result. It is not something you write.

- NEVER emit that line yourself. Writing one pretends a compression happened when none did, and it wastes the context the compression was supposed to free.
- To compress, call the compress tool. To check whether a compression landed, call list_blocks and confirm the block count went up. A confirmation line you wrote yourself proves nothing.
- The same goes for the ${COMPRESSED_BLOCK_HEADER} header: it marks stored block content and only appears after a real compression.

Execute these calls silently: no announcement before the call, and no completion summary or status line after it. When the tool returns, continue the task directly.`
}

/**
 * A large single rewrite replaces the cached prefix with a summary, so the
 * provider misses on the next request. Folding a smaller, later range leaves
 * the stable prefix alone.
 */
export function tailBiasedGuidance(): string {
    return `PREFIX PRESERVATION
Prefer a smaller range biased toward the recent tail, and leave the stable prefix -- the earliest messages -- intact.

A single large rewrite changes the shape of the whole request and costs the provider's prefix cache on the next turn. Several small tail-biased folds keep that prefix alive and make the transition gentle. Only reach back to the earliest messages when they are genuinely the compressible part.`
}

/**
 * The nudge is an instruction, and a model under pressure treats an
 * instruction as something to acknowledge: "I need to compress NOW. Let me
 * compress the recent work (m0374-m0389)." That spends context to say nothing
 * and reads as if compression is under way when no tool has been called.
 *
 * The silence clause in markerIntegrityNote covers the opposite case -- a model
 * that narrates around a call it actually made. This covers the one before it.
 */
export function silentCallNote(): string {
    return `CALL SILENTLY
This instruction is not for repeating. Do not write a plan, do not announce which range you will compress, and do not narrate the call. Call the tool.

Restating it spends context to say nothing. The nudge exists to trigger a call, not a reply.`
}
