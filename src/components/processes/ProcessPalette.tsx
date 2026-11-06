"use client";

/**
 * Roadmap-26 PR-B → R31 Bundle 4 (PR 2) — ProcessPalette.
 *
 * Pre-R31 this lived as a HORIZONTAL strip across the top of the
 * canvas (eight icon-and-label pills wrapping into a second row
 * once the eighth kind landed). Every world-class design tool —
 * Figma, Sketch, Adobe XD, Linear's canvas, Excalidraw —
 * positions its tool palette on the LEFT, not above. Pre-R31 we
 * had it stacked above; R31 Bundle 4 moves it where the
 * vocabulary expects it.
 *
 * The new shape:
 *   • Vertical 56px-wide column on the left of the canvas body.
 *   • Icon-only buttons. The kind label appears on hover via
 *     `title=` (Epic 56 tooltip primitive would be ideal; a
 *     `title` attribute is a deliberate small-surface choice to
 *     avoid adding a new dep + an extra render path in the canvas
 *     critical path).
 *   • Category dividers — a thin hairline between
 *     Flow (step, decision) →  Context (risk, asset, external) →
 *     Container (group) → Note (annotation). Exposes the taxonomy
 *     hierarchy that was hidden by the flat horizontal strip.
 *   • Drag-source contract unchanged: `application/x-inflect-process-step`
 *     MIME type with the same `{ kind, label }` JSON payload.
 *     Existing R26-PR-B + R30 ratchets keep asserting the payload
 *     shape — only the LAYOUT changed here.
 *
 * The seven taxonomy kinds plus group (R30) all carry an icon by
 * design. The hover label is the accessible name for screen
 * readers via `aria-label`; the visible icon is purely decorative.
 *
 * ═══ CLICK TO ADD, AS WELL AS DRAG ═══
 *
 * Each item is a real `<button>`. A click (or Enter / Space on a
 * focused item) calls `onAdd`, and the canvas places the step in
 * the middle of the view. Drag stayed the only way in for a long
 * time, and it was the wrong only way: HTML5 drag never fires on a
 * touch screen, a keyboard cannot drag at all, and when the drop
 * handler broke (tldraw swallowed the event) the items did nothing
 * whatever the user tried. An item that takes no `onAdd` still
 * drags, so a host without a canvas to place into loses nothing.
 */

import type { DragEvent } from "react";
import { useTranslations } from "next-intl";
import {
    NODE_TAXONOMY,
    NODE_TAXONOMY_ORDER,
    AUTOMATION_NODE_ORDER,
} from "./node-taxonomy";
import type {
    NodeCategory,
    ProcessNodeKind,
} from "./node-taxonomy";
import { useIsAutomationMode } from "@/lib/processes/canvas-mode-context";

/**
 * Canonical drag-data mime type for palette → canvas transfers.
 * The canvas reads this on `onDrop` to identify palette payloads
 * (vs unrelated drag sources like file uploads).
 */
export const PALETTE_DRAG_MIME = "application/x-inflect-process-step";

/**
 * Payload contract — the canvas's drop handler parses this shape.
 * Kept as an exported type so the canvas + tests stay in lockstep
 * with the palette's emission.
 */
export interface PaletteDropPayload {
    kind: ProcessNodeKind;
    label: string;
}

export interface ProcessPaletteProps {
    /**
     * Add a step of this kind to the canvas, placed by the host. Called
     * for a click or a key press on an item; a drag goes through the
     * canvas's own drop handler instead.
     */
    onAdd?: (kind: ProcessNodeKind, label: string) => void;
}

/**
 * Category display order in the rail. The vertical column reads
 * top-to-bottom: build the flow → layer the context → wrap a
 * group → leave a note.
 */
const CATEGORY_ORDER: readonly NodeCategory[] = [
    "flow",
    "context",
    "group",
    "note",
];

function onDragStart(
    event: DragEvent<HTMLButtonElement>,
    kind: ProcessNodeKind,
    label: string,
) {
    const payload: PaletteDropPayload = { kind, label };
    event.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
}

function PaletteItem({
    kind,
    onAdd,
}: {
    kind: ProcessNodeKind;
    onAdd: ProcessPaletteProps["onAdd"];
}) {
    const t = useTranslations("automation.palette");
    const meta = NODE_TAXONOMY[kind];
    const Icon = meta.icon;
    return (
        <button
            type="button"
            draggable
            onDragStart={(e) => onDragStart(e, kind, meta.label)}
            onClick={() => onAdd?.(kind, meta.label)}
            data-palette-item={kind}
            data-process-palette-item="true"
            title={meta.label}
            aria-label={t(onAdd ? "clickToAdd" : "dragToAdd", {
                label: meta.label.toLowerCase(),
            })}
            className="inline-flex h-8 w-8 cursor-grab items-center justify-center rounded-[8px] border border-canvas-border bg-canvas-node-muted text-content-default transition-colors hover:border-border-emphasis hover:bg-canvas-node hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-emphasis active:cursor-grabbing"
        >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
    );
}

export function ProcessPalette({ onAdd }: ProcessPaletteProps = {}) {
    const t = useTranslations("automation.palette");
    const isAutomation = useIsAutomationMode();

    // Group the taxonomy by semantic category. The ORDER inside a
    // category mirrors NODE_TAXONOMY_ORDER so the rail reads the
    // same as the legacy strip for any tester walking it by index.
    const grouped: Record<NodeCategory, ProcessNodeKind[]> = {
        flow: [],
        context: [],
        group: [],
        note: [],
    };
    for (const kind of NODE_TAXONOMY_ORDER) {
        const meta = NODE_TAXONOMY[kind];
        grouped[meta.category].push(kind);
    }

    return (
        <aside
            className="flex w-14 shrink-0 flex-col items-center gap-tight border-r border-canvas-border bg-canvas-frame py-3"
            data-process-palette="true"
            data-process-palette-layout="vertical"
            aria-label={t("paletteAria")}
        >
            <span className="text-[9px] font-semibold uppercase tracking-wider text-content-subtle">
                {t("tools")}
            </span>
            {CATEGORY_ORDER.map((category, categoryIdx) => {
                const kindsInCategory = grouped[category];
                if (kindsInCategory.length === 0) return null;
                return (
                    <div
                        key={category}
                        className="flex flex-col items-center gap-tight"
                        data-process-palette-category={category}
                    >
                        {categoryIdx > 0 && (
                            // The thin hairline between categories
                            // exposes the taxonomy hierarchy that
                            // was hidden by the legacy flat strip.
                            <span
                                className="my-1 block h-px w-6 bg-canvas-border"
                                aria-hidden="true"
                            />
                        )}
                        {kindsInCategory.map((kind) => (
                            <PaletteItem key={kind} kind={kind} onAdd={onAdd} />
                        ))}
                    </div>
                );
            })}
            {/* VR-1/VR-2 — Automation section, AUTOMATION mode only. */}
            {isAutomation && (
                <div
                    className="flex flex-col items-center gap-tight"
                    data-process-palette-category="automation"
                >
                    <span
                        className="my-1 block h-px w-6 bg-canvas-border"
                        aria-hidden="true"
                    />
                    {AUTOMATION_NODE_ORDER.map((kind) => (
                        <PaletteItem key={kind} kind={kind} onAdd={onAdd} />
                    ))}
                </div>
            )}
        </aside>
    );
}
