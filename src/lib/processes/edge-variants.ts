/**
 * The three connection variants, and what they mean.
 *
 * ═══ WHY THIS MODULE EXISTS ═══
 *
 * These four values lived in `components/processes/ProcessEdge.tsx` — the
 * xyflow edge renderer — and `ProcessInspector` imported them from there. The
 * inspector is engine-agnostic by design: `use-tldraw-selection.ts` records
 * that it "imports nothing from xyflow, and its selection contract is already
 * abstract", which is why it is reused unchanged on the tldraw host.
 *
 * That was true of `@xyflow/react` and not of the xyflow MODULES. Deleting the
 * renderer took the taxonomy with it and broke the panel that is supposed to
 * outlive both renderers. So the values move here, following what #3061 did
 * for the node side (`node-taxonomy.ts`) and the export side
 * (`canvas-export-shared.ts`): the shared vocabulary belongs to neither
 * renderer.
 *
 * ═══ WHAT A VARIANT IS FOR ═══
 *
 * Not decoration. `flow` is the process; `conditional` is an optional or
 * branch path; `reference` is a non-flow informational dependency — a step
 * citing an asset rather than passing control to it. On a compliance process
 * map the distinction is what tells a reader which steps are mandatory, which
 * is why the tldraw canvas renders all three differently (#3090) rather than
 * treating the value as metadata.
 */
import type { useTranslations } from 'next-intl';

/** Surface-namespace resolver (`useTranslations('automation.edges')`). */
type EdgesTranslate = ReturnType<typeof useTranslations>;

/** The three connection variants. Minimal, meaningful, curated. */
export type ProcessEdgeVariant = 'flow' | 'conditional' | 'reference';

/** Cycle order for the selection affordance. */
export const EDGE_VARIANT_ORDER: ProcessEdgeVariant[] = [
    'flow',
    'conditional',
    'reference',
];

/**
 * i18n factory — the three labels + descriptions, resolved through next-intl
 * at render. Consumers call this with a `t` scoped to `automation.edges`.
 *
 * A factory rather than a constant because the strings are locale-dependent
 * and a module-level constant would freeze whichever locale loaded first.
 */
export function buildEdgeVariantMeta(
    t: EdgesTranslate,
): Record<ProcessEdgeVariant, { label: string; description: string }> {
    return {
        flow: { label: t('flowLabel'), description: t('flowDescription') },
        conditional: {
            label: t('conditionalLabel'),
            description: t('conditionalDescription'),
        },
        reference: {
            label: t('referenceLabel'),
            description: t('referenceDescription'),
        },
    };
}

/**
 * Runtime guard — `edgeKind` is a free `String` column, so a rehydrated edge
 * may carry a value nothing recognises. Unknown kinds fall back to `flow` at
 * the render boundary, which is also what `edgeStrokeFor` does on the drawing
 * side; the two agree deliberately.
 */
export function isProcessEdgeVariant(v: unknown): v is ProcessEdgeVariant {
    return v === 'flow' || v === 'conditional' || v === 'reference';
}
