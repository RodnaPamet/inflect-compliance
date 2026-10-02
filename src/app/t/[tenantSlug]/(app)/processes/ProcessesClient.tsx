"use client";

/**
 * Processes page client shell.
 *
 * R25 mounted the canvas with zero persistence. R26-PR-A adds:
 *   - the existing process list, selectable from a slim header
 *     control
 *   - a "New process" affordance that POSTs to the create endpoint
 *   - a "Save" button that PUTs the canvas state back to the
 *     selected map's endpoint
 *   - rehydration: selecting a map loads its graph from the server
 *     and seeds the canvas as `initialNodes` + `initialEdges`
 *
 * The richer editor UX (visible name, save-as, inspector, alignment
 * helpers, undo-redo) lands in R26-PR-E; PR-A is the minimum
 * needed to prove the persistence loop end-to-end.
 *
 * Component split:
 *   - `<ProcessesClient>` (this file) owns the page chrome +
 *     selection state. It does NOT own canvas state; the canvas
 *     does (xyflow's internal nodes/edges, plus a wrapper that
 *     exposes a save callback).
 *   - `<TldrawProcessWorkspace>` (sibling component) wraps the
 *     R25 `<ProcessCanvas>` and adds the save/rehydrate plumbing.
 *     Splitting keeps the page chrome simple and lets the canvas
 *     own its xyflow state without prop-drilling.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { cn } from "@/lib/cn";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { useIsBelowMd } from "@/components/ui/hooks";
import { cardVariants } from "@/components/ui/card";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { RulesTab } from "./RulesTab";
import { AnalyticsTab } from "./AnalyticsTab";
import { MonitorTab } from "./MonitorTab";
import { CanvasModeProvider } from "@/lib/processes/canvas-mode-context";
// Re-exported, not declared: a route directory is not a module other surfaces
// import from (`tests/guards/route-import-boundaries.test.ts`). The type now
// lives in `@/lib/processes/process-map-summary`; this keeps the old path
// working for the route's own consumers.
import type { ProcessMapSummary } from "@/lib/processes/process-map-summary";
export type { ProcessMapSummary };
// R31 Bundle 3 — page-level Heading + PageBreadcrumbs retired. The
// document bar inside the canvas now carries the breadcrumbs +
// document title inline (Figma-style).

// xyflow uses browser-only APIs on mount (ResizeObserver,
// getBoundingClientRect). The `ssr:false` boundary lives at this
// import — the wrapper itself is a "use client" component, but
// "use client" still runs through SSR for the initial paint.
// Dynamic-import with ssr:false keeps the canvas off the server
// pipeline entirely. Same pattern R25 established via the
// `<ProcessCanvas>` import that this replaces.
// #3079 — ONE canvas. The second dynamic import that stood here existed so
// that choosing a renderer at call time could not pull both engines into the
// chunk graph; with one renderer there is nothing to keep apart.
const TldrawProcessWorkspace = dynamic(
    () =>
        import("@/components/processes/TldrawProcessWorkspace").then(
            (m) => m.TldrawProcessWorkspace,
        ),
    { ssr: false },
);


interface ProcessesClientProps {
    tenantSlug: string;
    initialProcesses: ProcessMapSummary[];
    /**
     * #2961 — mount the tldraw workspace instead of the xyflow canvas.
     *
     * Resolved on the server by `isProcessCanvasTldrawEnabled`, so this is a
     * boolean rather than something to ask for. Defaults FALSE: a tenant whose
     * flag could not be read gets the engine that has been shipping, which is
     * the only safe direction for a default to fail in.
     */
}

export function ProcessesClient({
    tenantSlug,
    initialProcesses,
}: ProcessesClientProps) {
    // The full list is owned here so a save can refresh the
    // selected map's metadata (version, updatedAt) without a full
    // page reload. Selection itself drives the canvas's load
    // sequence via its `processMapId` prop.
    const [processes, setProcesses] = useState<ProcessMapSummary[]>(
        initialProcesses,
    );
    // P2 reverse-lookup deep link — `/processes?activeId=<mapId>` opens
    // straight to a specific map (the "Where used" modals on control / risk /
    // asset detail link here). Honour the param when it names a map the tenant
    // can see; otherwise fall back to the first map.
    const searchParams = useSearchParams();
    const requestedId = searchParams.get("activeId");
    const [activeId, setActiveId] = useState<string | null>(
        requestedId && initialProcesses.some((p) => p.id === requestedId)
            ? requestedId
            : (initialProcesses[0]?.id ?? null),
    );
    // Re-target on a CLIENT-SIDE `?activeId` change too — a second "Where used"
    // link navigated to while already on /processes only pushes a new param,
    // not a fresh mount, so the initializer above wouldn't fire. Read the live
    // param (not just the once-run initializer) and follow it when it names a
    // visible map.
    useEffect(() => {
        if (requestedId && processes.some((p) => p.id === requestedId)) {
            setActiveId(requestedId);
        }
    }, [requestedId, processes]);

    // Automation Epic 1 — the Process page gains a tab bar. "Canvas" is
    // the existing process-map editor; "Rules" is the automation-rule
    // inventory. The tab bar uses the canonical EntityDetailLayout pattern
    // (border-b accent + emphasis text) — the single-tab-pattern ratchet
    // reserves the pill primitive out of app pages. Epic 9 extends this
    // with Analytics; Epic 10 adds Monitor.
    const t = useTranslations("processes");
    const [tab, setTab] = useState<"canvas" | "rules" | "analytics" | "monitor">("canvas");
    const TABS: ReadonlyArray<{
        key: "canvas" | "rules" | "analytics" | "monitor";
        label: string;
    }> = [
        { key: "canvas", label: t("tabCanvas") },
        { key: "rules", label: t("tabRules") },
        { key: "analytics", label: t("tabAnalytics") },
        { key: "monitor", label: t("tabMonitor") },
    ];

    return (
        <div className="flex h-full min-h-0 flex-col">
            <nav
                className="flex gap-1 border-b border-border-default overflow-x-auto"
                role="tablist"
                aria-label={t("tabsAria")}
            >
                {TABS.map((t) => {
                    const isActive = tab === t.key;
                    return (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={cn(
                                "px-4 py-2 text-sm font-medium transition border-b-2 whitespace-nowrap",
                                isActive
                                    ? "border-[var(--brand-default)] text-content-emphasis"
                                    : "border-transparent text-content-muted hover:text-content-emphasis",
                            )}
                            onClick={() => setTab(t.key)}
                            id={`processes-tab-${t.key}`}
                            data-testid={`processes-tab-${t.key}`}
                        >
                            {t.label}
                        </button>
                    );
                })}
                {/* PR-B follow-up — cross-map governance meta-graph. */}
                <a
                    href={`/t/${tenantSlug}/processes/governance`}
                    className="ml-auto self-center px-4 py-2 text-sm font-medium text-content-muted hover:text-content-emphasis whitespace-nowrap"
                    data-testid="governance-graph-link"
                >
                    {t("governanceLink")}
                </a>
            </nav>
            <div className="flex min-h-0 flex-1 flex-col pt-3">
                {tab === "rules" ? (
                    <RulesTab tenantSlug={tenantSlug} />
                ) : tab === "analytics" ? (
                    <AnalyticsTab />
                ) : tab === "monitor" ? (
                    <MonitorTab />
                ) : (
                    <CanvasWorkspace
                        tenantSlug={tenantSlug}
                        processes={processes}
                        activeId={activeId}
                        setActiveId={setActiveId}
                        setProcesses={setProcesses}
                    />
                )}
            </div>
        </div>
    );
}

function CanvasWorkspace({
    tenantSlug,
    processes,
    activeId,
    setActiveId,
    setProcesses,
}: {
    tenantSlug: string;
    processes: ProcessMapSummary[];
    activeId: string | null;
    setActiveId: (id: string | null) => void;
    setProcesses: (p: ProcessMapSummary[]) => void;
}) {
    // Mobile PR-5 — the xyflow canvas (pan/zoom/drag of a node graph) is
    // unusable on a phone. Below `md` we render a read-only LIST of the
    // process maps so mobile users can still browse them; editing the canvas
    // stays a desktop affordance. `useIsBelowMd` is false on SSR/jsdom, so
    // desktop + tests keep the canvas.
    const belowMd = useIsBelowMd();
    if (belowMd) {
        return <ProcessListMobile processes={processes} />;
    }

    return (
        // R31 Bundle 3 (PR 1) — Page header retired. Pre-R31 the
        // page above the canvas carried a CRUD-page header
        // (breadcrumbs + a level-1 page title + a description
        // sentence) — three bands of chrome before the working
        // surface. A canvas tool announces itself THROUGH the
        // canvas itself; the document bar inside
        // TldrawProcessWorkspace now carries the breadcrumbs +
        // document title inline, Figma-style. The header slot
        // stays available for future canvas-mode chrome (Design /
        // Run mode toggle, etc.) but is intentionally empty today.
        <WorkspaceShell className="animate-fadeIn">
            {/* The workspace frame — an elevated panel that contains
                the chrome (toolbar + palette) and the recessed canvas
                plane. It reads as raised purely through tone — the
                frame surface sits a step lighter than the page behind
                it (depth via background tone, not box-shadow, per the
                Card-primitive discipline). `overflow-hidden` clips
                every inner strip to the frame's rounded corners so the
                composition reads as one deliberate container. */}
            <WorkspaceShell.Body className="overflow-hidden rounded-lg border border-canvas-border bg-canvas-frame">
                <CanvasModeProvider
                    mode={
                        processes.find((p) => p.id === activeId)?.canvasMode ?? "DOCUMENT"
                    }
                >
                    <TldrawProcessWorkspace
                        tenantSlug={tenantSlug}
                        processes={processes}
                        activeId={activeId}
                        onActiveIdChange={setActiveId}
                        onProcessesChange={setProcesses}
                    />
                </CanvasModeProvider>
            </WorkspaceShell.Body>
        </WorkspaceShell>
    );
}

const PROCESS_STATUS_BADGE: Record<
    ProcessMapSummary["status"],
    StatusBadgeVariant
> = {
    ACTIVE: "success",
    DRAFT: "warning",
    ARCHIVED: "neutral",
};

/**
 * Mobile PR-5 — read-only process-map list shown in place of the canvas on
 * phones. Browse names / status / size; editing the canvas is desktop-only.
 */
function ProcessListMobile({
    processes,
}: {
    processes: ProcessMapSummary[];
}) {
    const t = useTranslations("processes");
    return (
        <div className="space-y-default" data-testid="processes-mobile-list">
            <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3 text-sm text-content-muted">
                <p>{t("mobileHint")}</p>
            </div>
            {processes.length === 0 ? (
                <p className="px-1 py-8 text-center text-sm text-content-subtle">
                    {t("mobileEmpty")}
                </p>
            ) : (
                <ul className="space-y-default">
                    {processes.map((p) => (
                        <li
                            key={p.id}
                            className={cn(cardVariants({ density: "compact" }), "space-y-tight")}
                            data-process-id={p.id}
                        >
                            <div className="flex items-start justify-between gap-default">
                                <span className="min-w-0 break-words font-medium text-content-emphasis">
                                    {p.name}
                                </span>
                                <StatusBadge
                                    variant={PROCESS_STATUS_BADGE[p.status]}
                                    size="sm"
                                >
                                    {p.status}
                                </StatusBadge>
                            </div>
                            {p.description && (
                                <p className="break-words text-sm text-content-muted">
                                    {p.description}
                                </p>
                            )}
                            <p className="text-xs text-content-subtle">
                                {t("steps", { count: p.nodeCount })} ·{" "}
                                {t("links", { count: p.edgeCount })} · v
                                {p.version}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
