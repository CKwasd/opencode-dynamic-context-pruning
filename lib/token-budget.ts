import type { ContextThresholds } from "./messages/inject/utils"
import { formatTokenCount } from "./ui/utils"

/**
 * One line telling the model how much room is left, for the nudge that only
 * fires once the strong threshold is already crossed.
 *
 * The figure is measured against the compaction boundary rather than the model
 * window: the useful question is how much work fits before DCP starts pushing
 * for compression, not how large the advertised window is. Codex draws the same
 * line once compaction is near, for the same reason.
 *
 * Returns undefined rather than a partial figure. A budget line that omits one
 * of the two numbers is harder to act on than no line.
 */
export function formatTokenBudgetLine(
    thresholds: ContextThresholds,
    format: (tokens: number) => string = (tokens) => formatTokenCount(tokens, true),
): string | undefined {
    const { currentTokens, maxContextLimit } = thresholds
    if (maxContextLimit === undefined || currentTokens <= 0) {
        return undefined
    }

    const remaining = maxContextLimit - currentTokens
    if (remaining <= 0) {
        return `Context: ${format(currentTokens)} used, past the ${format(maxContextLimit)} limit.`
    }

    return `Context: ${format(currentTokens)} used, ${format(remaining)} until compaction.`
}
