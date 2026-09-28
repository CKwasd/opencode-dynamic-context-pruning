/** @jsxImportSource @opentui/solid */

import { formatTokenCount } from "../ui/utils"
import { ActionRow, Card, Metric, Progress, StatusPill } from "./ui"
import type { SnapshotView, ViewApi } from "./types"

// The panel is narrow and always visible, so it carries the three answers that
// are otherwise only in the log: how full the context is, what compression has
// saved, and whether the session is currently allowed to compress. The drill
// down views stay in dialogs.
export function DcpPanelView(props: {
    api: ViewApi
    snapshot: SnapshotView
    /** Host-reported content width, so the label column fits. */
    width: number
    onContext: () => void
    onStats: () => void
    onManual: (enabled: boolean) => void
}) {
    const theme = props.api.theme.current
    const labelWidth = Math.max(8, Math.min(24, Math.floor((props.width - 6) * 0.45)))
    const { context: breakdown, stats, manualMode, canCompress } = props.snapshot
    const conflicts = props.snapshot.conflicts ?? []
    const total = Math.max(0, breakdown.total)
    const pruned = breakdown.prunedTokens

    return (
        <box flexDirection="column" gap={1}>
            <Card theme={theme} title="Context">
                <Metric
                    theme={theme}
                    label="In context"
                    value={`~${formatTokenCount(total, true)}`}
                    hint="tokens"
                    labelWidth={labelWidth}
                />
                {total > 0 ? (
                    <Progress
                        theme={theme}
                        label="Pruned"
                        value={pruned}
                        total={total + pruned}
                        color="success"
                        detail={`${formatTokenCount(pruned, true)} removed`}
                        labelWidth={labelWidth}
                    />
                ) : null}
            </Card>

            <Card theme={theme} title="Savings">
                <StatusPill
                    theme={theme}
                    label="Removed"
                    value={formatTokenCount(stats.sessionTokens)}
                    accent="success"
                />
                {stats.sessionRetrievedTokens > 0 ? (
                    <StatusPill
                        theme={theme}
                        label="Retrieved"
                        value={formatTokenCount(stats.sessionRetrievedTokens)}
                        accent="warning"
                    />
                ) : null}
                <ActionRow theme={theme} title="Stats" detail="All time" onClick={props.onStats} />
            </Card>

            <Card theme={theme} title="State">
                <StatusPill
                    theme={theme}
                    label="Manual"
                    value={manualMode ? "on" : "off"}
                    accent={manualMode ? "warning" : "textMuted"}
                />
                <StatusPill
                    theme={theme}
                    label="Compress"
                    value={canCompress ? "allowed" : "blocked"}
                    accent={canCompress ? "success" : "error"}
                />
                {props.snapshot.blockedReason ? (
                    <box>
                        <text fg={theme.textMuted}>{props.snapshot.blockedReason}</text>
                    </box>
                ) : null}
                <ActionRow
                    theme={theme}
                    title={manualMode ? "Leave manual mode" : "Enter manual mode"}
                    detail="Toggle"
                    onClick={() => props.onManual(!manualMode)}
                />
                <ActionRow
                    theme={theme}
                    title="Context"
                    detail="Breakdown"
                    onClick={props.onContext}
                />
            </Card>

            {conflicts.length > 0 ? (
                <Card theme={theme} title="Conflicts">
                    <StatusPill
                        theme={theme}
                        label="Detected"
                        value={conflicts.length === 1 ? "1 event" : `${conflicts.length} events`}
                        accent="error"
                    />
                    {conflicts.slice(-3).map((event) => (
                        <box>
                            <text fg={theme.textMuted}>{event.detail}</text>
                        </box>
                    ))}
                    {conflicts.length > 3 ? (
                        <box>
                            <text fg={theme.textMuted}>
                                {conflicts.length - 3} more. Run /dcp stats for the full list.
                            </text>
                        </box>
                    ) : null}
                </Card>
            ) : null}
        </box>
    )
}
