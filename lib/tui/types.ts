import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { buildStatsReport } from "../commands/stats"
import type { analyzeContextTokens } from "../commands/context"

export type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]
export type Theme = Pick<
    TuiApi["theme"]["current"],
    | "primary"
    | "accent"
    | "text"
    | "textMuted"
    | "background"
    | "backgroundElement"
    | "borderSubtle"
    | "selectedListItemText"
    | "success"
    | "warning"
    | "error"
>
export type ThemeColor = keyof Theme
export type ViewApi = {
    theme: { readonly current: Theme }
    renderer: Pick<TuiApi["renderer"], "height" | "on" | "off" | "terminalWidth">
    ui: { dialog: { clear(): void } }
}
export type StatsReport = Awaited<ReturnType<typeof buildStatsReport>>

/** Output of the `dcp.snapshot` RPC method, as the TUI views consume it. */
export type SnapshotView = {
    manualMode: boolean
    canCompress: boolean
    blockedReason?: string
    context: ReturnType<typeof analyzeContextTokens>
    stats: StatsReport
}

export type DcpCommand = {
    title: string
    name: string
    description: string
    slashName: string
    slashAliases?: string[]
    run: () => void | Promise<void>
}
