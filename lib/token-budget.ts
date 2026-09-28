import type { ContextThresholds } from "./messages/inject/utils"
import { formatTokenCount } from "./ui/utils"

/**
 * One line telling the model how much room is left, for the nudge that only
 * fires once the strong threshold is already crossed.
 *
 * Measured against the model's real window, not the nudge threshold. The
 * threshold is the window widened by the summary buffer, which is right for
 * deciding when to push and wrong for reporting: the host already counts
 * active summaries inside the usage it reports, so subtracting from a widened
 * window tells the model it has summarySize tokens of room that do not exist.
 *
 * The summary overhead is still shown, as its own clause, because it is real --
 * it just occupies the window rather than adding to it.
 *
 * Returns undefined rather than a partial figure. A budget line that omits one
 * of the two numbers is harder to act on than no line.
 */
export function formatTokenBudgetLine(
    thresholds: ContextThresholds,
    format: (tokens: number) => string = (tokens) => formatTokenCount(tokens, true),
): string | undefined {
    const { currentTokens, windowLimit, summaryTokens } = thresholds
    if (windowLimit === undefined || currentTokens <= 0) {
        return undefined
    }

    const overhead = summaryTokens > 0 ? ` Summaries occupy ${format(summaryTokens)} of it.` : ""
    const remaining = windowLimit - currentTokens
    if (remaining <= 0) {
        return `Context: ${format(currentTokens)} used, past the ${format(windowLimit)} window.${overhead}`
    }

    return `Context: ${format(currentTokens)} used, ${format(remaining)} left of ${format(windowLimit)}.${overhead}`
}
