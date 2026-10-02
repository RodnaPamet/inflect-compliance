/**
 * The DRAWN half of a process edge.
 *
 * ═══ WHY THERE ARE TWO RECORDS FOR ONE EDGE ═══
 *
 * `process-edge-binding.ts` argues that an edge must be a binding and not an
 * arrow, because `ProcessEdgeControl` hangs off the edge and coverage queries
 * read it — "an edge that were merely drawn would have nowhere to put a control
 * and nothing for a compliance query to find". That is right, and nothing here
 * changes it.
 *
 * But it settles the DATA model and not the drawing, and a `BindingUtil` cannot
 * draw: its declaration has `getDefaultProps` plus thirteen lifecycle hooks and
 * no `component()` or `indicator()`. So with bindings alone the canvas showed
 * nodes and no connectors — data-complete and visually absent. Every edge test
 * asserted the round trip; none asserted a line was drawn, which is how a green
 * suite sat over a canvas missing half its content.
 *
 * tldraw's own connectors are both things at once: `TLArrowShape` draws and
 * arrow bindings attach it. This is that split, applied here:
 *
 *   • the BINDING owns identity — `edgeKey`, `controls`, `sourceKey`/`targetKey`
 *     — and is what the serializer reads. Unchanged, so the save path is too.
 *   • this SHAPE owns pixels and hit-testing, which is also what makes an edge
 *     selectable: tldraw's selection API is shapes-only, so without a shape the
 *     edge inspector had nothing to select.
 *
 * ═══ DERIVED, NEVER PERSISTED ═══
 *
 * This shape is rebuilt from the bindings on every load, so `ProcessEdge` stays
 * the single source of truth and there is no second record to keep in step.
 *
 * That makes one thing load-bearing in the serializer: `partitionCanvas` ends
 * `else freeform.push(r)`, and `freeform` IS persisted to
 * `ProcessMap.freeformJson`. A derived shape falling into that bucket would be
 * written on save, then both re-derived AND restored on the next load —
 * duplicating, and compounding every time. So `partitionCanvas` sorts this type
 * into a `derived` bucket that nothing writes.
 *
 * ═══ THE GEOMETRY IS DERIVED TOO, WHICH IS WHY RESIZE IS LOCKED ═══
 *
 * `dx` / `dy` are the offset to the far endpoint, recomputed whenever either
 * bound node moves. They are not persisted, exactly like the node shape's
 * `w` / `h` — and that is the same argument for refusing resize: a capability
 * whose result cannot be saved is a capability that reports success and
 * discards.
 */
import { T, type RecordProps, type TLBaseShape, type TLShapeId } from 'tldraw';

/** The discriminator. Distinct from the binding's `process-edge`. */
export const PROCESS_EDGE_SHAPE_TYPE = 'process-edge-line' as const;

export type ProcessEdgeShapeProps = {
    /**
     * The edge this line draws, by the binding's `edgeKey`.
     *
     * The KEY and not the binding id, for the reason the binding file gives
     * about `sourceKey` vs `fromId`: a key is the contract that survives a
     * reload, and an id is tldraw's own wiring. Empty for a line drawn in the
     * editor before a key is minted for it.
     */
    edgeKey: string;
    /**
     * The edge's variant, copied from the binding so the line can draw it.
     *
     * Duplicated rather than looked up, and the alternative is worth naming:
     * the binding is not findable from this shape cheaply. The binding joins
     * the two NODE shapes — this line is a third record that neither end
     * references — so resolving it means scanning the store for a matching
     * `edgeKey`, per line, per render.
     *
     * Derived exactly like `dx`/`dy`, and safe to duplicate for the same
     * reason: the line is rebuilt from the bindings on every load and lands in
     * `partitionCanvas`'s `derived` bucket, which nothing persists. So there is
     * no stored copy to migrate and no second source of truth at rest —
     * `ProcessEdge.edgeKind` stays the only one.
     *
     * The one write that is NOT a reload is the inspector's variant cycle,
     * which edits the binding directly; `useTldrawSelection.onEdgeUpdate`
     * therefore updates this alongside it.
     */
    edgeKind: string;
    /**
     * The edge's label, copied from the binding's `labelOverride`.
     *
     * Here for the same reason as `edgeKind` and with the same lifecycle: the
     * binding is not cheaply findable from this line, the value is re-derived
     * on every load, and nothing persists this copy.
     *
     * `''` rather than `null` for the empty case. The props are validated by
     * `T.string`, and a nullable prop would make every reader ask the same
     * question twice — "is it absent, or is it empty" — for two states that
     * render identically. `labelOverride` stays nullable at rest, where the
     * distinction between "never set" and "cleared" is the inspector's.
     */
    label: string;
    /**
     * The automation edge-kind chip's text, already resolved and already
     * precedence-checked. Empty for no chip (the common case).
     *
     * RESOLVED BY THE HOST, not here, for two reasons a renderer cannot work
     * around. The text is localised and no shape util in this codebase takes a
     * translator — the node util reads its per-kind text from `NODE_TAXONOMY`
     * constants and its label from props, which is the pattern this follows.
     * And the chip is a FALLBACK: xyflow showed it only when an edge had
     * neither controls nor an explicit label, and `controls` lives on the
     * BINDING, which the line cannot cheaply reach.
     *
     * So the host decides whether a chip is warranted and what it says; this
     * prop is the answer, and an empty string is "no".
     */
    chipLabel: string;
    /** Offset from this shape's origin to the far endpoint. Derived. */
    dx: number;
    dy: number;
};

export type ProcessEdgeShape = TLBaseShape<
    typeof PROCESS_EDGE_SHAPE_TYPE,
    ProcessEdgeShapeProps
>;

export const processEdgeShapeProps: RecordProps<ProcessEdgeShape> = {
    edgeKey: T.string,
    edgeKind: T.string,
    label: T.string,
    chipLabel: T.string,
    dx: T.number,
    dy: T.number,
};

/**
 * A stable shape id for an edge key.
 *
 * Deterministic for the same reason `shapeIdForNodeKey` is: seeding twice must
 * not produce two lines for one edge, and a derived record that minted a random
 * id each load would accumulate.
 */
export function shapeIdForEdgeKey(edgeKey: string): TLShapeId {
    return `shape:edge-${edgeKey}` as TLShapeId;
}

/** The inverse, for resolving a selected line back to its edge. */
export function edgeKeyFromShapeId(id: string): string | null {
    const prefix = 'shape:edge-';
    return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/**
 * How a variant is drawn.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * The xyflow canvas draws flow SOLID, conditional DASHED and reference DOTTED,
 * and `ProcessEdge.tsx`'s docblock explains the semantics: conditional is "an
 * optional / branch path", reference is "a non-flow informational dependency".
 * This renderer drew one stroke for all three, so the inspector's variant cycle
 * was settable, applied and persisted — and invisible. On a compliance process
 * map an optional branch indistinguishable from a required step misrepresents
 * the process to whoever reads it (#3090).
 *
 * ═══ WHAT IS PORTED, AND WHAT IS DELIBERATELY NOT ═══
 *
 * The DASH SIGNATURE is, with xyflow's exact patterns so the two canvases agree
 * during the cutover: `7 5` for conditional, `1 6` round-capped for reference.
 *
 * The SELECTED stroke is not. xyflow had to widen and re-tint the path itself
 * because it has no separate selection layer; tldraw draws `indicator()` over
 * the shape, so doing it here would stack two affordances. What matters from
 * xyflow's "a selected edge keeps its dash signature" is that selection must
 * not erase the distinction — and here it cannot, because selection does not
 * touch this line at all.
 *
 * Returns SVG presentation attributes rather than a className: a dash pattern
 * is geometry, and the colour stays token-driven on the element.
 */
export function edgeStrokeFor(edgeKind: string): {
    strokeDasharray?: string;
    strokeLinecap?: 'round' | 'butt';
    stroke?: string;
} {
    switch (edgeKind) {
        // ── DOCUMENT variants: dash only, colour from the element's token class
        case 'conditional':
            return { strokeDasharray: '7 5' };
        case 'reference':
            // Round caps are what make `1 6` read as dots rather than ticks.
            return { strokeDasharray: '1 6', strokeLinecap: 'round' };

        /*
            ── AUTOMATION kinds (VR-5) ─────────────────────────────────────
            `edgeKind` is ONE overloaded field: an edge carries either a
            document variant or an automation kind, never both. That is why
            these are more arms on this switch rather than a second mechanism —
            on the xyflow renderer the automation style OVERRODE the variant
            style on exactly the same read, which is the same dispatch written
            twice.

            These DO carry a colour, because the kind is the whole signal: a
            `condition-fail` branch that looked like a `condition-pass` branch
            would misdescribe the rule. The document variants deliberately do
            not — they are distinguished by dash, and inherit the theme's edge
            token so a map does not become a colour chart.
        */
        case 'trigger-flow':
            return { stroke: 'var(--brand-default)' };
        case 'condition-pass':
            return { stroke: 'var(--content-success)' };
        case 'condition-fail':
            return { stroke: 'var(--content-error)', strokeDasharray: '6 4' };
        case 'chain-delay':
            return { stroke: 'var(--canvas-edge)', strokeDasharray: '2 5' };
        case 'sla-breach':
            return { stroke: 'var(--content-warning)' };
        case 'sla-pass':
            return { stroke: 'var(--content-success)' };

        default:
            // `flow`, and anything unrecognised. `edgeKind` is a free string on
            // the wire (`z.string().min(1).max(64)`), so an unknown value must
            // render as the ordinary case rather than vanish — the same
            // fallback the xyflow renderer makes, asserted there as "an unknown
            // / missing variant falls back to flow (solid)".
            return {};
    }
}

/**
 * The `automation.edges` key naming an automation kind, or null.
 *
 * Pure and total, so the HOST can resolve the text without knowing the
 * taxonomy. `trigger-flow` maps to null deliberately: it is the DEFAULT
 * automation flow, and the xyflow renderer gave it an empty label for the same
 * reason — a chip on every ordinary edge is noise, and the colour already says
 * it is an automation edge.
 *
 * Returns null for every document variant too, which is what makes "no chip"
 * the common case rather than something the caller has to remember.
 */
export function automationChipKey(edgeKind: string): string | null {
    switch (edgeKind) {
        case 'condition-pass':
            return 'autoPass';
        case 'condition-fail':
            return 'autoFail';
        case 'chain-delay':
            return 'autoChain';
        case 'sla-breach':
            return 'autoSlaBreach';
        case 'sla-pass':
            return 'autoOnTime';
        default:
            return null;
    }
}

/** The minimum of tldraw's `Box` this module needs. */
export interface CentredBounds {
    center: { x: number; y: number };
}

/**
 * Where an edge line sits, given its two endpoints' bounds.
 *
 * Pure, and shared by the two places that must agree: the seed on load and the
 * reposition when a node moves. Those were going to be separate expressions,
 * and a connector whose seeded position differs from its repositioned one jumps
 * the first time anything is dragged — a difference nothing would fail on,
 * because both halves are individually plausible.
 */
export function edgeLineGeometry(
    from: CentredBounds,
    to: CentredBounds,
): { x: number; y: number; dx: number; dy: number } {
    return {
        x: from.center.x,
        y: from.center.y,
        dx: to.center.x - from.center.x,
        dy: to.center.y - from.center.y,
    };
}
