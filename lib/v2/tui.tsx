/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { ContextDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import { DcpPanelView } from "../tui/panel"
import { createSnapshotCache } from "../tui/snapshot-cache"
import type { SnapshotView, ViewApi } from "../tui/types"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

const PANEL = "dcp"

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return
    const api: ViewApi = {
        renderer: ctx.renderer,
        theme: {
            get current() {
                return panelTheme(ctx.theme)
            },
        },
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        // W18: the bare command opens the session panel instead of a modal, so
        // the conversation stays visible and the numbers stay on screen.
        if (page === "panel") {
            ctx.ui.panel.open(PANEL)
            return
        }
        try {
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    // W19: the panel used to take one snapshot when it opened and then go
    // stale. Every notice means the server state moved, so drop the cache and
    // let the slot render refetch. Reading revision() inside render is what
    // makes the refresh actually repaint.
    const cache = createSnapshotCache<SnapshotView>()
    const [revision, setRevision] = createSignal(0)
    const invalidate = (sessionID?: string) => {
        cache.invalidate(sessionID)
        setRevision((n) => n + 1)
    }
    async function ensure(sessionID: string): Promise<SnapshotView | undefined> {
        if (!cache.shouldFetch(sessionID)) return cache.get(sessionID)
        cache.beginFetch(sessionID)
        try {
            const data: SnapshotView = await client.snapshot({ sessionID }, options())
            cache.put(sessionID, data)
            return data
        } catch {
            return undefined
        } finally {
            cache.endFetch(sessionID)
            setRevision((n) => n + 1)
        }
    }

    // W16: DCP formats its own notification text and emits it over RPC. Until
    // this subscription existed the server computed the report and dropped it.
    const unsubscribe = client.events.on("notice", (event) => {
        const { title, text, level } = event.data
        invalidate(event.data.sessionID)
        ctx.ui.toast.show({
            title,
            message: text,
            variant: level === "error" ? "error" : level === "warning" ? "warning" : "info",
        })
        if (level !== "info")
            ctx.attention.notify({
                title,
                message: text,
                notification: { when: "blurred" },
            })
    })

    // W18: contribute to the host's session panel so /dcp no longer takes over
    // the screen. The host owns layout, focus and input scope.
    const unclaimPanel = ctx.ui.slot({
        append: "session.panel",
        render(input) {
            if (input.name !== PANEL) return null
            revision()
            const data = cache.get(input.sessionID)
            if (!data) {
                void ensure(input.sessionID)
                return (
                    <box paddingLeft={2} paddingTop={1}>
                        <text fg={panelTheme(ctx.theme).textMuted}>Loading DCP...</text>
                    </box>
                )
            }
            return (
                <DcpPanelView
                    api={api}
                    snapshot={data}
                    width={input.width}
                    onContext={() => {
                        void open("context")
                    }}
                    onStats={() => {
                        void open("stats")
                    }}
                    onManual={(enabled) => {
                        void client
                            .manual({ sessionID: input.sessionID, enabled }, options())
                            .then(() => invalidate(input.sessionID))
                            .catch(error)
                    }}
                />
            )
        },
    })

    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })

    return () => {
        unsubscribe()
        unclaimPanel()
    }
}
