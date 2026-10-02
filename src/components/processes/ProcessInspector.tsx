"use client";

/**
 * R26-PR-E / R28 — ProcessInspector.
 *
 * Right-side property panel for the selected canvas element.
 * Originally NODE-only (R26-PR-E); R28 extends to EDGES — selecting
 * a connection now opens the same panel with edge-specific fields
 * (label override + the variant cycle: flow / conditional / reference).
 *
 * Why a panel and not an inline popover:
 *   • Inline popovers compete with the canvas surface for focus;
 *     the user's eye has to alternate between "where the node
 *     lives" and "where the popover is". A persistent right
 *     panel anchors the edit affordance in one stable place.
 *   • Multiple edits (e.g. label THEN subtitle) need a
 *     persistent affordance, not a popover that closes on every
 *     blur.
 *
 * Why it's COLLAPSIBLE:
 *   • Authors who already know what they're building shouldn't
 *     have to look at a panel of empty fields. The panel mounts
 *     only when something is selected; selecting nothing
 *     hides it.
 *
 * Empty-state messaging:
 *   • When something IS selected but the kind doesn't carry
 *     editable fields (decision: just a label; annotation: just
 *     text), the panel still mounts so the user sees a
 *     consistent affordance — never a partial-mount that reads
 *     as "is anything happening?"
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
// NO ENGINE IMPORT. The inspector edits MEANING — node type, size, linked
// entity, edge variant, controls — and none of that depends on what draws the
// canvas. #2961's selection adapter is what keeps it that way, and what makes
// the renderer swap reviewable without touching these 697 lines.
import type {
    SelectedCanvasEdge,
    SelectedCanvasNode,
} from "@/lib/processes/canvas-selection";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { AsidePanel } from "@/components/ui/aside-panel";
import { NodeBiaAffordance } from "@/components/bia/NodeBiaAffordance";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
    findTenantControl,
    formatControlLabel,
    useTenantControls,
} from "@/lib/processes/use-tenant-controls";
import {
    findTenantRisk,
    useTenantRisks,
} from "@/lib/processes/use-tenant-risks";
import {
    findTenantAsset,
    formatAssetLabel,
    useTenantAssets,
} from "@/lib/processes/use-tenant-assets";

/**
 * PR-D polish — refresh cadence for linked-entity status. 30s
 * balances "live enough that an admin changing a control's status
 * in another tab reflects on the canvas" against API hammering.
 */
const ENTITY_STATUS_POLL_MS = 30_000;

/**
 * PR-D polish — map a linked-entity `status` value to a tone class
 * for the chip. The chip is informational, not interactive — the
 * tones lean on the existing semantic-bg-* token suite.
 *
 * Unknown / missing statuses get the neutral `subtle` tone (no
 * special colour) — never blank, never wrong.
 */
function entityStatusTone(status: string | null | undefined): string {
    if (!status) return "bg-bg-subtle text-content-muted";
    const s = status.toUpperCase();
    if (s === "DONE" || s === "MITIGATED" || s === "ACTIVE") {
        return "bg-bg-success/40 text-content-success";
    }
    if (s === "IN_PROGRESS" || s === "OPEN") {
        return "bg-bg-info/40 text-content-info";
    }
    if (s === "BLOCKED" || s === "REJECTED" || s === "DECOMMISSIONED") {
        return "bg-bg-error/40 text-content-error";
    }
    return "bg-bg-subtle text-content-muted";
}
import {
    NODE_TAXONOMY,
    isProcessNodeKind,
    isAutomationNodeKind,
} from "./node-taxonomy";
import { useIsAutomationMode } from "@/lib/processes/canvas-mode-context";
// The server's bound on graph text, imported rather than restated. The
// four-bare-200s version of this let a 300-character label reach the API and
// fail there; `src/app-layer/schemas/` is backend-first but not client-free
// (CLAUDE.md names 13 `use client` files that import values from it).
import { MAX_GRAPH_TEXT_LENGTH } from "@/app-layer/schemas/process-map";
import { AutomationInspectorPanel } from "./AutomationInspectorPanel";
import {
    DEFAULT_NODE_SIZE,
    isProcessNodeSize,
    type ProcessNodeSize,
} from "./node-taxonomy";
import {
    buildEdgeVariantMeta,
    EDGE_VARIANT_ORDER,
    isProcessEdgeVariant,
    type ProcessEdgeVariant,
} from "@/lib/processes/edge-variants";

/**
 * Epic P2-PR-A — shape of an edge-attached control reference.
 * The inspector's control picker is MULTI (PR-D): an edge can carry several
 * controls, rendered as one pill per persisted control; `ProcessEdgeControl`
 * backs the many-to-one.
 */
export interface EdgeControlRef {
    /** Stable per-edge identifier — survives saves + reloads. */
    controlKey: string;
    /** Human label rendered on the in-canvas pill. */
    label: string;
    /** Optional FK to a tenant Control. Null = unbound label. */
    controlId: string | null;
}

export interface ProcessInspectorProps {
    /** Selected node, or null when nothing is selected. */
    node: SelectedCanvasNode | null;
    /**
     * R28 — selected edge, or null when nothing is selected. Mutually
     * exclusive with `node` in practice: an engine may let you select both,
     * and the canvas mirrors one slot at a time with the node winning. That
     * rule is `resolveSelection` in `@/lib/processes/canvas-selection` — stated
     * once, testable without mounting anything, and no longer a property of
     * whichever library happens to be underneath.
     */
    edge?: SelectedCanvasEdge | null;
    /**
     * Tenant slug — Epic P2-PR-A — used by the edge inspector to
     * fetch the tenant's Controls list for the picker. Optional:
     * the node-mode panel doesn't need it, and absence in edge mode
     * gracefully hides the picker (rendered tests + storybook
     * stages without the canvas surrounding context keep working).
     */
    tenantSlug?: string;
    /**
     * Whether the host's renderer actually honours `data.size`.
     *
     * Defaults to TRUE, so the xyflow canvas is unchanged. The tldraw canvas
     * passes false: its node shape renders at `PROCESS_NODE_DEFAULT_W` / `_H`
     * and never reads the column, which is the owner's option-B decision on
     * #2961 — #2960 made `dataJson` an opaque passthrough, so teaching the
     * renderer to read it was declined.
     *
     * The control was therefore VISIBLE and INERT on that host: it persisted a
     * value nothing displayed. A setting that silently does nothing reads as a
     * bug to whoever touches it, and "it is behind a flag" stops being a
     * defence when the flag is about to become the only renderer.
     *
     * Named for the RENDERER's capability rather than `showSize`, because that
     * is the fact a host knows about itself. A presentational name would invite
     * hiding the control for layout reasons and leaving the persistence
     * mismatch in place.
     */
    rendererHonoursSize?: boolean;
    /**
     * Called when the user commits a label / subtitle / size /
     * entity-link change. The canvas writes the change back into
     * its nodes state.
     *
     * Epic P2-PR-B — `linkedEntityId` carries the FK to whichever
     * entity matches the node's kind (control / risk / asset). The
     * picker is conditional on `data.kind`, so a single shared field
     * suffices — kind disambiguates on read.
     */
    onUpdate: (
        nodeId: string,
        patch: {
            label?: string;
            subtitle?: string | null;
            size?: ProcessNodeSize;
            linkedEntityId?: string | null;
        },
    ) => void;
    /**
     * R28 + Epic P2-PR-A — commit an edge edit. The canvas applies
     * the patch to the edge's `label` (top-level on xyflow) +
     * `data.variant` + `data.controls` (P2-PR-A — linked tenant
     * Control).
     */
    onEdgeUpdate?: (
        edgeId: string,
        patch: {
            label?: string | null;
            variant?: ProcessEdgeVariant;
            controls?: EdgeControlRef[];
        },
    ) => void;
    /** Active process map id — enables the node's Business Continuity (BIA) cross-link. */
    mapId?: string;
}

export function ProcessInspector({
    node,
    edge = null,
    tenantSlug,
    rendererHonoursSize = true,
    onUpdate,
    onEdgeUpdate,
    mapId,
}: ProcessInspectorProps) {
    // Local state mirrors the node's data so the user can type
    // without every keystroke flushing to the canvas state. The
    // mirror commits on blur (or Enter), which is when the canvas
    // actually receives the patch.
    const data = node?.data as
        | {
              label?: string;
              subtitle?: string;
              kind?: unknown;
              size?: unknown;
              linkedEntityId?: unknown;
          }
        | undefined;
    const [label, setLabel] = useState(data?.label ?? "");
    const [subtitle, setSubtitle] = useState(data?.subtitle ?? "");
    // VR-4 — automation-mode inspector branch (hook stays unconditional).
    const isAutomation = useIsAutomationMode();
    const t = useTranslations("automation.inspector");

    // Sync local mirror when the selected node changes.
    useEffect(() => {
        setLabel(data?.label ?? "");
        setSubtitle(data?.subtitle ?? "");
    }, [node?.id, data?.label, data?.subtitle]);

    // R28 — edge-selection mode. Node wins if both are set; the
    // canvas only mirrors one slot at a time but the guard here
    // keeps the rendering deterministic regardless of order.
    if (!node && edge) {
        return (
            <EdgeInspectorBody
                edge={edge}
                tenantSlug={tenantSlug}
                onEdgeUpdate={onEdgeUpdate}
            />
        );
    }

    if (!node) {
        return null;
    }

    // VR-4 — when an automation node is selected on an AUTOMATION canvas, the
    // inspector renders the inline rule editor instead of the document panels.
    if (isAutomation && isAutomationNodeKind(data?.kind)) {
        const ruleId =
            data && typeof (data as { ruleId?: unknown }).ruleId === "string"
                ? ((data as { ruleId?: string }).ruleId as string)
                : null;
        return (
            <AsidePanel title={t("ruleTitle")} surfaceKey="processes-inspector">
                <div className="flex flex-col gap-default p-default">
                    <AutomationInspectorPanel
                        kind={data!.kind as "trigger" | "condition" | "action" | "slaGate"}
                        ruleId={ruleId}
                    />
                </div>
            </AsidePanel>
        );
    }

    const kindMeta = isProcessNodeKind(data?.kind)
        ? NODE_TAXONOMY[data.kind]
        : null;

    const size: ProcessNodeSize = isProcessNodeSize(data?.size)
        ? data.size
        : DEFAULT_NODE_SIZE;

    const commit = () => {
        const trimmedLabel = label.trim();
        const trimmedSubtitle = subtitle.trim();
        onUpdate(node.id, {
            label: trimmedLabel,
            subtitle: trimmedSubtitle === "" ? null : trimmedSubtitle,
        });
    };

    // R31 Bundle 5 (PR 6) — Inspector chrome now flows through the
    // canonical `<AsidePanel>` primitive (Risks + Controls parity).
    // The pre-R31 bespoke 260px `<aside>` is gone; the new shell
    // gives the inspector collapse-to-spine, resize, deep-link
    // (`?aside=processes-inspector`), and a `<Sheet>` fallback
    // below xl for free. The inner body retains every existing
    // testid the R28 ratchet pins; only the chrome moved.
    return (
        <AsidePanel
            title={t("title")}
            surfaceKey="processes-inspector"
        >
            <div
                className="flex flex-col gap-default"
                data-process-inspector="true"
                aria-label={t("selectedNodeAria")}
            >
                {kindMeta && (
                    <span className="text-[10px] uppercase tracking-wide text-content-subtle">
                        {kindMeta.label}
                    </span>
                )}
                <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("label")}
                </span>
                <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    maxLength={MAX_GRAPH_TEXT_LENGTH}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-label-input"
                />
            </label>
            <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("subtitle")}
                </span>
                <input
                    type="text"
                    value={subtitle}
                    onChange={(e) => setSubtitle(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    placeholder={t("optional")}
                    maxLength={MAX_GRAPH_TEXT_LENGTH}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-subtitle-input"
                />
            </label>
            {/* Hidden where the renderer does not read `data.size` — see
                `rendererHonoursSize`. Not disabled: a greyed-out control still
                advertises a capability the host does not have. */}
            {rendererHonoursSize && (
                <div className="flex flex-col gap-tight" data-testid="inspector-size">
                    <span className="text-[10px] uppercase tracking-wide text-content-muted">
                        {t("size")}
                    </span>
                    <ToggleGroup
                        size="sm"
                        ariaLabel={t("nodeSizeAria")}
                        selected={size}
                        options={[
                            { value: "sm", label: "S" },
                            { value: "md", label: "M" },
                            { value: "lg", label: "L" },
                        ]}
                        selectAction={(v) =>
                            onUpdate(node.id, { size: v as ProcessNodeSize })
                        }
                    />
                </div>
            )}
            {/* Epic P2-PR-B — Linked-entity picker. Mounts only on
                nodes whose kind matches a compliance entity (control
                / risk / asset). The selection writes the FK into
                `data.linkedEntityId`; the canvas's `nodeDataJson`
                serialiser persists it via the existing `dataJson`
                column — no schema change needed. */}
            <NodeLinkedEntityPicker
                nodeKind={data?.kind}
                tenantSlug={tenantSlug}
                selectedId={
                    typeof data?.linkedEntityId === "string"
                        ? data.linkedEntityId
                        : null
                }
                onCommit={(linkedEntityId) =>
                    onUpdate(node.id, { linkedEntityId })
                }
            />
                {/* Business Continuity cross-link — View/Add a BIA for this
                    process node (resolves nodeKey → DB id server-side). */}
                {tenantSlug && mapId && (
                    <NodeBiaAffordance tenantSlug={tenantSlug} mapId={mapId} nodeKey={node.id} />
                )}
                <p className="text-[10px] text-content-subtle">
                    {t("saveHint")}
                </p>
            </div>
        </AsidePanel>
    );
}

// ─── Epic P2-PR-B — Linked-entity picker (control / risk / asset) ──

function NodeLinkedEntityPicker({
    nodeKind,
    tenantSlug,
    selectedId,
    onCommit,
}: {
    nodeKind: unknown;
    tenantSlug?: string;
    selectedId: string | null;
    onCommit: (id: string | null) => void;
}) {
    // Three hooks unconditionally — React rules of hooks. Each
    // short-circuits to a no-op when the slug is the empty string,
    // and we discard the unused responses below.
    //
    // PR-D polish — periodic revalidation so a status change made
    // elsewhere reflects on the canvas without a reload. The cache
    // is shared module-scoped, so the 30s poll runs once per
    // tenant even with three concurrent hook mounts.
    const t = useTranslations("automation.inspector");
    const slug = tenantSlug ?? "";
    const controls = useTenantControls(slug, { pollMs: ENTITY_STATUS_POLL_MS });
    const risks = useTenantRisks(slug, { pollMs: ENTITY_STATUS_POLL_MS });
    const assets = useTenantAssets(slug, { pollMs: ENTITY_STATUS_POLL_MS });

    if (nodeKind !== "control" && nodeKind !== "risk" && nodeKind !== "asset") {
        return null;
    }

    const active =
        nodeKind === "control"
            ? {
                  label: t("linkedControl"),
                  options: controls.options.map((c) => ({
                      value: c.id,
                      label: formatControlLabel(c),
                  })),
                  loading: controls.loading,
                  emptyHint: t("noControls"),
              }
            : nodeKind === "risk"
              ? {
                    label: t("linkedRisk"),
                    options: risks.options.map((r) => ({
                        value: r.id,
                        label: r.title,
                    })),
                    loading: risks.loading,
                    emptyHint: t("noRisks"),
                }
              : {
                    label: t("linkedAsset"),
                    options: assets.options.map((a) => ({
                        value: a.id,
                        label: formatAssetLabel(a),
                    })),
                    loading: assets.loading,
                    emptyHint: t("noAssets"),
                };

    const selectedOption = selectedId
        ? active.options.find((o) => o.value === selectedId) ?? null
        : null;

    // PR-D polish — live status chip for the currently-selected
    // entity. Reads from the same hook state the picker reads;
    // the 30s polling cadence above keeps the value live.
    const liveStatus =
        nodeKind === "control"
            ? findTenantControl(controls, selectedId)?.status ?? null
            : nodeKind === "risk"
              ? findTenantRisk(risks, selectedId)?.status ?? null
              : findTenantAsset(assets, selectedId)?.status ?? null;

    return (
        <div
            className="flex flex-col gap-tight"
            data-testid="inspector-node-entity-picker"
            data-entity-kind={nodeKind}
        >
            <div className="flex items-center justify-between gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {active.label}
                </span>
                {liveStatus && (
                    <span
                        className={`rounded-[4px] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${entityStatusTone(liveStatus)}`}
                        data-testid="inspector-node-entity-status"
                        data-status={liveStatus}
                        title={t("currentStatus", { status: liveStatus })}
                    >
                        {liveStatus}
                    </span>
                )}
            </div>
            <Combobox
                selected={selectedOption}
                setSelected={(option) =>
                    onCommit(option?.value ?? null)
                }
                options={active.options}
                disabled={active.loading || active.options.length === 0}
                aria-label={active.label}
                placeholder={
                    active.loading
                        ? t("loading")
                        : active.options.length === 0
                          ? active.emptyHint
                          : t("pickOne")
                }
            />
        </div>
    );
}

// ─── R28 + Epic P2-PR-A — Edge inspector body ──────────────────────

function EdgeInspectorBody({
    edge,
    tenantSlug,
    onEdgeUpdate,
}: {
    edge: SelectedCanvasEdge;
    tenantSlug?: string;
    onEdgeUpdate?: ProcessInspectorProps["onEdgeUpdate"];
}) {
    const t = useTranslations("automation.inspector");
    const tEdges = useTranslations("automation.edges");
    const edgeMeta = useMemo(() => buildEdgeVariantMeta(tEdges), [tEdges]);
    const variantRaw = (edge.data as { variant?: unknown } | undefined)
        ?.variant;
    const variant: ProcessEdgeVariant = isProcessEdgeVariant(variantRaw)
        ? variantRaw
        : "flow";
    const initialLabel =
        typeof edge.label === "string" ? edge.label : "";
    const [label, setLabel] = useState(initialLabel);

    useEffect(() => {
        setLabel(typeof edge.label === "string" ? edge.label : "");
    }, [edge.id, edge.label]);

    // Epic P2-PR-A / PR-D — controls attached to this edge. PR-D lifts the
    // one-control-per-edge limit: the picker is a multi-select so several
    // real controls can gate one connection ("two controls gate this edge").
    // The underlying ProcessEdgeControl table already supported many.
    const existingControls = readEdgeControls(edge);
    // Passing the empty string short-circuits the hook to a no-op
    // ({ options: [], loading: false }); the picker block below
    // also gates on `tenantSlug` so absence cleanly hides the
    // affordance.
    const { options: tenantControls, loading: controlsLoading } =
        useTenantControls(tenantSlug ?? "");

    const controlOptions = useMemo<ComboboxOption[]>(
        () =>
            tenantControls.map((c) => ({
                value: c.id,
                label: formatControlLabel(c),
            })),
        [tenantControls],
    );
    const selectedControlOptions = useMemo<ComboboxOption[]>(() => {
        const ids = new Set(
            existingControls
                .map((c) => c.controlId)
                .filter((id): id is string => typeof id === "string"),
        );
        return controlOptions.filter((o) => ids.has(o.value));
    }, [controlOptions, existingControls]);

    const commitLinkedControls = (options: ComboboxOption[]) => {
        if (!onEdgeUpdate) return;
        // Preserve the stable controlKey of controls already attached (match
        // by controlId) so re-selection doesn't churn keys; mint a fresh key
        // for newly-added controls.
        const byControlId = new Map(
            existingControls
                .filter((c) => typeof c.controlId === "string")
                .map((c) => [c.controlId as string, c]),
        );
        const next: EdgeControlRef[] = [];
        for (const option of options) {
            const ref = tenantControls.find((c) => c.id === option.value);
            if (!ref) continue;
            const existing = byControlId.get(ref.id);
            next.push({
                controlKey:
                    existing?.controlKey ??
                    `ctrl-${edge.id}-${ref.id}-${Date.now().toString(36)}`,
                controlId: ref.id,
                label: formatControlLabel(ref),
            });
        }
        onEdgeUpdate(edge.id, { controls: next });
    };

    const commit = () => {
        if (!onEdgeUpdate) return;
        const trimmed = label.trim();
        onEdgeUpdate(edge.id, { label: trimmed === "" ? null : trimmed });
    };

    // R31 Bundle 5 (PR 6) — edge inspector chrome moves to AsidePanel
    // parity, same as the node inspector above. Same surfaceKey so
    // a user toggling between node + edge selection sees a single
    // inspector panel persist its collapse state across both modes.
    return (
        <AsidePanel
            title={t("title")}
            surfaceKey="processes-inspector"
        >
            <div
                className="flex flex-col gap-default"
                data-process-inspector="true"
                data-inspector-mode="edge"
                aria-label={t("selectedEdgeAria")}
            >
                <span className="text-[10px] uppercase tracking-wide text-content-subtle">
                    {t("connection")}
                </span>
                <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("label")}
                </span>
                <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    placeholder={t("optional")}
                    maxLength={MAX_GRAPH_TEXT_LENGTH}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-edge-label-input"
                />
            </label>
            <div className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("variant")}
                </span>
                <ToggleGroup
                    size="sm"
                    ariaLabel={t("edgeVariantAria")}
                    selected={variant}
                    options={EDGE_VARIANT_ORDER.map((v) => ({
                        value: v,
                        label: edgeMeta[v].label,
                    }))}
                    selectAction={(v) =>
                        onEdgeUpdate?.(edge.id, {
                            variant: v as ProcessEdgeVariant,
                        })
                    }
                />
                <span className="text-[10px] text-content-subtle">
                    {edgeMeta[variant].description}
                </span>
            </div>
            {/* Epic P2-PR-A — Linked control picker. Mounts a tenant-
                wide Controls combobox so the user can attach a real
                compliance control to this edge. The selection writes
                ProcessEdgeControl rows on the next save; the canvas
                already round-trips the controls on load. */}
            <div
                className="flex flex-col gap-tight"
                data-testid="inspector-edge-control-picker"
            >
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("linkedControl")}
                </span>
                <Combobox
                    multiple
                    selected={selectedControlOptions}
                    setSelected={commitLinkedControls}
                    options={controlOptions}
                    disabled={controlsLoading || tenantControls.length === 0}
                    aria-label={t("linkedControl")}
                    placeholder={
                        controlsLoading
                            ? t("loadingControls")
                            : tenantControls.length === 0
                              ? t("noControls")
                              : t("pickControl")
                    }
                />
                <span className="text-[10px] text-content-subtle">
                    {t("auditorsHint")}
                </span>
            </div>
                <p className="text-[10px] text-content-subtle">
                    {t("saveHint")}
                </p>
            </div>
        </AsidePanel>
    );
}

/**
 * Epic P2-PR-A — read the typed control list off an edge's `data`.
 * Tolerant of pre-P2 edges whose data omits the controls array.
 */
function readEdgeControls(edge: SelectedCanvasEdge): EdgeControlRef[] {
    const raw = (edge.data as { controls?: unknown } | undefined)?.controls;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r) => {
            const row = r as {
                controlKey?: unknown;
                label?: unknown;
                controlId?: unknown;
            };
            if (typeof row.controlKey !== "string") return null;
            return {
                controlKey: row.controlKey,
                label:
                    typeof row.label === "string" ? row.label : row.controlKey,
                controlId:
                    typeof row.controlId === "string"
                        ? row.controlId
                        : null,
            } satisfies EdgeControlRef;
        })
        .filter((r): r is EdgeControlRef => r !== null);
}
