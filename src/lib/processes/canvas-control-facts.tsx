'use client';
/**
 * What a `control` node's card says about the Control it links to.
 *
 * A control node stores only the link (`props.controlId`, persisted to
 * `ProcessNodeControl`). Its code, name, status, effectiveness and last test
 * are read live from `GET /processes/:id/control-facts`, keyed by the ids on
 * the canvas, so a control renamed or re-tested elsewhere shows its current
 * state the next time the canvas loads or regains focus, and a link picked a
 * moment ago fills in before autosave writes it.
 *
 * The text is translated HERE, because a tldraw shape body has no translator:
 * it renders inside the canvas, and its own tests render it with no NextIntl
 * provider. Same split as `canvas-rule-status.tsx` and the execution overlay.
 *
 * SAFE WITHOUT A PROVIDER. `useControlCard` returns undefined when nothing is
 * mounted, so a node rendered bare (a test, the read-only proposal preview)
 * draws its label and nothing else rather than throwing.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useValue, type Editor } from 'tldraw';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { formatDate } from '@inflect/ui/lib/format-date';
import { CONTROL_NODE_TYPE } from '@/app-layer/schemas/process-map';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { ControlFact, ProcessMapControlFacts } from './control-facts-types';

/** Which card state a control node is in. */
export type ControlCardState =
    | 'loading'
    | 'linked'
    | 'unlinked'
    | 'missing'
    | 'restricted'
    | 'unavailable';

export interface ControlCard {
    state: ControlCardState;
    /** First line: `code · name` when linked, else the state's sentence. */
    title: string;
    /** Second line when linked: status, effectiveness, last test. */
    detail: string | null;
    /** The stored status, as a fact a test can read. Linked only. */
    status: string | null;
    tone: 'success' | 'warning' | 'neutral';
}

interface ControlCardContextValue {
    cardFor: (controlId: string | null) => ControlCard;
}

const ControlCardContext = createContext<ControlCardContextValue | null>(null);

/** The control ids the canvas's control nodes link to, sorted and deduped. */
export function linkedControlIds(editor: Editor): string[] {
    const ids = new Set<string>();
    for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== PROCESS_NODE_SHAPE_TYPE) continue;
        const props = s.props as { nodeType?: unknown; controlId?: unknown };
        if (props.nodeType === CONTROL_NODE_TYPE && typeof props.controlId === 'string') {
            ids.add(props.controlId);
        }
    }
    return [...ids].sort();
}

const IMPLEMENTED = new Set(['IMPLEMENTED']);
const NEEDS_ATTENTION = new Set(['NEEDS_REVIEW', 'NOT_STARTED']);

export function CanvasControlFactsProvider({
    editor,
    mapId,
    children,
}: {
    editor: Editor | null;
    mapId: string | null;
    children: ReactNode;
}) {
    const t = useTranslations('processes.controlCard');
    // Recomputed by tldraw whenever a shape changes; the string key keeps the
    // fetch from re-running when the canvas changes without the ids changing.
    const idsKey = useValue(
        'linked control ids',
        () => (editor ? linkedControlIds(editor).join(',') : ''),
        [editor],
    );
    const path =
        mapId && idsKey !== ''
            ? `/processes/${encodeURIComponent(mapId)}/control-facts?ids=${encodeURIComponent(idsKey)}`
            : null;
    const { data, error } = useTenantSWR<ProcessMapControlFacts>(path);

    const value = useMemo<ControlCardContextValue>(() => {
        const statusText = (status: string): string =>
            typeof t.has === 'function' && t.has(`status.${status}`) ? t(`status.${status}`) : status;
        const linkedCard = (fact: ControlFact): ControlCard => {
            const parts = [statusText(fact.status)];
            if (fact.effectiveness !== null) {
                parts.push(t('effectiveness', { percent: fact.effectiveness }));
            }
            parts.push(
                fact.lastTested
                    ? t('tested', { date: formatDate(fact.lastTested) })
                    : t('neverTested'),
            );
            return {
                state: 'linked',
                title: fact.code ? `${fact.code} · ${fact.name}` : fact.name,
                detail: parts.join(' · '),
                status: fact.status,
                tone: IMPLEMENTED.has(fact.status)
                    ? 'success'
                    : NEEDS_ATTENTION.has(fact.status)
                      ? 'warning'
                      : 'neutral',
            };
        };
        const plain = (state: ControlCardState, tone: ControlCard['tone']): ControlCard => ({
            state,
            title: t(state),
            detail: null,
            status: null,
            tone,
        });
        return {
            cardFor: (controlId) => {
                if (controlId === null) return plain('unlinked', 'warning');
                if (data?.restricted) return plain('restricted', 'neutral');
                const fact = data?.controls[controlId];
                if (fact) return linkedCard(fact);
                // Asked and not found: deleted, trashed, or never this tenant's.
                if (data?.missing.includes(controlId)) return plain('missing', 'warning');
                // The read failed: that is not evidence the control is gone, so
                // it never says "removed".
                if (error) return plain('unavailable', 'neutral');
                // Not asked yet: a link picked a moment ago, until the read for
                // the new set of ids returns.
                return plain('loading', 'neutral');
            },
        };
    }, [data, error, t]);

    return <ControlCardContext.Provider value={value}>{children}</ControlCardContext.Provider>;
}

/**
 * The card for a control node's link, or undefined with no provider mounted
 * (or for a node that is not a control node: pass `undefined`).
 */
export function useControlCard(controlId: string | null | undefined): ControlCard | undefined {
    const ctx = useContext(ControlCardContext);
    if (!ctx || controlId === undefined) return undefined;
    return ctx.cardFor(controlId);
}
