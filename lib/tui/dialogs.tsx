/** @jsxImportSource @opentui/solid */

import type { analyzeContextTokens } from "../commands/context"
import { formatTokenCount } from "../ui/utils"
import { formatDuration, formatRatio } from "./format"
import { ActionRow, Card, DcpFrame, Metric, Progress, PromptRow, StatusPill } from "./ui"
import type { StatsReport, ViewApi } from "./types"

/**
 * Label column for a dialog row.
 *
 * The panel gets its width from the host; a dialog has to derive one, and the
 * 24-character default collapses into the value on anything narrower, which
 * reads as "Tokens saved~3.2K tokens". The dialog chrome is a guess, so this is
 * an upper bound rather than an exact figure.
 */
function dialogLabelWidth(api: ViewApi): number {
    const terminal = api.renderer.terminalWidth ?? 100
    return Math.max(8, Math.min(24, Math.floor(terminal * 0.3) - 2))
}

export function StatusDialog(props: {
    api: ViewApi
    title: string
    eyebrow: string
    message: string
}) {
    return (
        <DcpFrame api={props.api} title={props.title} eyebrow={props.eyebrow}>
            <box paddingTop={1} paddingBottom={1}>
                <text fg={props.api.theme.current.textMuted}>{props.message}</text>
            </box>
        </DcpFrame>
    )
}

export function ContextDialog(props: {
    api: ViewApi
    breakdown: ReturnType<typeof analyzeContextTokens>
    onBack: () => void
}) {
    const theme = props.api.theme.current
    const labelWidth = dialogLabelWidth(props.api)
    const breakdown = props.breakdown
    const total = Math.max(0, breakdown.total)
    const activePruned = breakdown.prunedToolCount + breakdown.prunedMessageCount

    return (
        <DcpFrame api={props.api} title="Context" eyebrow="DCP" onBack={props.onBack}>
            <Card theme={theme} title="Current">
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Total in context"
                    value={`~${formatTokenCount(total)}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tools in context"
                    value={`${breakdown.toolsInContextCount}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Active pruned targets"
                    value={`${activePruned}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tokens pruned"
                    value={`~${formatTokenCount(breakdown.prunedTokens)}`}
                />
            </Card>
            <Card theme={theme} title="Breakdown">
                <Progress
                    theme={theme}
                    label="System"
                    value={breakdown.system}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.system)} tokens`}
                />
                <Progress
                    theme={theme}
                    label="User"
                    value={breakdown.user}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.user)} tokens`}
                />
                <Progress
                    theme={theme}
                    label="Assistant"
                    value={breakdown.assistant}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.assistant)} tokens`}
                />
                <Progress
                    theme={theme}
                    label={`Tools (${breakdown.toolsInContextCount})`}
                    value={breakdown.tools}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.tools)} tokens`}
                />
            </Card>
        </DcpFrame>
    )
}

export function StatsDialog(props: { api: ViewApi; report: StatsReport; onBack: () => void }) {
    const theme = props.api.theme.current
    const labelWidth = dialogLabelWidth(props.api)
    const ratio = formatRatio(props.report.sessionTokens, props.report.sessionSummaryTokens)
    return (
        <DcpFrame api={props.api} title="Stats" eyebrow="DCP" onBack={props.onBack}>
            <Card theme={theme} title="Session">
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.sessionTokens)}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tokens retrieved"
                    value={`~${formatTokenCount(props.report.sessionRetrievedTokens)}`}
                    hint="put back"
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Summary size"
                    value={`~${formatTokenCount(props.report.sessionSummaryTokens)}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Compression ratio"
                    value={ratio}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Compression time"
                    value={formatDuration(props.report.sessionDurationMs)}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tools pruned"
                    value={`${props.report.sessionTools}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Messages pruned"
                    value={`${props.report.sessionMessages}`}
                />
            </Card>
            <Card theme={theme} title="All time">
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.allTime.totalTokens)}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Tools pruned"
                    value={`${props.report.allTime.totalTools}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Messages pruned"
                    value={`${props.report.allTime.totalMessages}`}
                />
                <Metric
                    theme={theme}
                    labelWidth={labelWidth}
                    label="Sessions with DCP history"
                    value={`${props.report.allTime.sessionCount}`}
                />
            </Card>
        </DcpFrame>
    )
}

export function PanelDialog(props: {
    api: ViewApi
    manualMode: boolean
    canCompress: boolean
    blockedReason?: string
    onContext: () => void
    onStats: () => void
    onManual: (enabled: boolean) => void
}) {
    const theme = props.api.theme.current
    const canCompress = props.canCompress
    return (
        <DcpFrame api={props.api} eyebrow="DCP">
            <Card theme={theme} title="Views">
                <box flexDirection="column" gap={1}>
                    <ActionRow
                        theme={theme}
                        title="Context"
                        detail="Token usage"
                        onClick={props.onContext}
                    />
                    <ActionRow
                        theme={theme}
                        title="Stats"
                        detail="Savings"
                        onClick={props.onStats}
                    />
                </box>
            </Card>
            <Card theme={theme} title="Prompt">
                {canCompress ? (
                    <PromptRow
                        theme={theme}
                        command="/dcp-compress [focus]"
                        description="Ask the model to compress"
                        accent="primary"
                    />
                ) : (
                    <text fg={theme.textMuted}>
                        {props.blockedReason ?? "Compression is denied by permissions."}
                    </text>
                )}
            </Card>
            <Card theme={theme} title="Session State">
                <ManualModeToggle
                    api={props.api}
                    enabled={props.manualMode}
                    onToggle={props.onManual}
                />
                <StatusPill
                    theme={theme}
                    label="Compression command"
                    value={canCompress ? "enabled" : "disabled"}
                    accent={canCompress ? "success" : "warning"}
                />
            </Card>
        </DcpFrame>
    )
}

function ManualModeToggle(props: {
    api: ViewApi
    enabled: boolean
    onToggle: (enabled: boolean) => void
}) {
    const theme = props.api.theme.current
    const enabled = props.enabled
    const track = enabled ? theme.success : theme.error
    return (
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <box width={22}>
                <text fg={theme.primary}>
                    <b>Manual mode</b>
                </text>
            </box>
            <box
                backgroundColor={track}
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => props.onToggle(!enabled)}
            >
                <text fg={theme.background}>{enabled ? "   ■" : "■   "}</text>
            </box>
        </box>
    )
}
