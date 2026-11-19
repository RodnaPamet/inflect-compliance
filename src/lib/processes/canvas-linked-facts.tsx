'use client';
/**
 * What a `control`, `risk` or `asset` node's card says about the record it
 * links to.
 *
 * A linked node stores only its link (`controlId` / `riskId` / `assetId`,
 * persisted to `ProcessNodeControl` / `…Risk` / `…Asset`). Everything the card
 * shows is read live from `GET /processes/:id/<kind>-facts`, keyed by the ids
 * on the canvas, so a record renamed or re-scored elsewhere shows its current
 * state the next time the canvas loads, saves or regains focus, and a link
 * picked a moment ago fills in before autosave writes it. The saved map
 * `version` is part of each key, because a risk card's mitigation line is about
 * the controls placed on the map AS SAVED.
 *
 * The text is translated HERE, because a tldraw shape body has no translator:
 * it renders inside the canvas, and its own tests render it with no NextIntl
 * provider. Same split as `canvas-rule-status.tsx` and the execution overlay.
 *
 * SAFE WITHOUT A PROVIDER. `useLinkedCard` returns undefined when nothing is
 * mounted, so a node rendered bare (a test, the read-only proposal preview)
 * draws its label and nothing else rather than throwing.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useValue, type Editor } from 'tldraw';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { formatDate } from '@inflect/ui/lib/format-date';
import {
    LINKED_NODE_TYPES,
    NODE_LINK_FIELD,
    type LinkedNodeType,
} from '@/app-layer/schemas/process-map';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { ControlFact, ProcessMapControlFacts } from './control-facts-types';
import type {
    AssetFact,
    ProcessMapAssetFacts,
    ProcessMapRiskFacts,
    RiskFact,
} from './risk-asset-facts-types';

/** Which card state a linked node is in. */
export type LinkedCardState =
    | 'loading'
    | 'linked'
    | 'unlinked'
    | 'missing'
    | 'restricted'
    | 'unavailable';

export type CardTone = 'success' | 'warning' | 'neutral';

export interface LinkedCard {
    state: LinkedCardState;
    /** First line: `key · name` when linked, else the state's sentence. */
    title: string;
    /** Second line when linked. */
    detail: string | null;
    /** A coloured chip before the detail: a risk's matrix band. */
    chip: { name: string; color: string } | null;
    /** Third line when linked: a risk's mitigation on this map. */
    note: string | null;
    noteTone: CardTone;
    /** The stored status, as a fact a test can read. Linked only. */
    status: string | null;
    tone: CardTone;
}

interface LinkedCardContextValue {
    cardFor: (kind: LinkedNodeType, id: string | null) => LinkedCard;
}

const LinkedCardContext = createContext<LinkedCardContextValue | null>(null);

/** The ids each linked kind's nodes link to, sorted and deduped. */
export function linkedIdsByKind(editor: Editor): Record<LinkedNodeType, string[]> {
    const sets = Object.fromEntries(LINKED_NODE_TYPES.map((k) => [k, new Set<string>()])) as Record<
        LinkedNodeType,
        Set<string>
    >;
    for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== PROCESS_NODE_SHAPE_TYPE) continue;
        const props = s.props as Record<string, unknown>;
        const kind = props.nodeType as LinkedNodeType;
        if (!LINKED_NODE_TYPES.includes(kind)) continue;
        const id = props[NODE_LINK_FIELD[kind]];
        if (typeof id === 'string') sets[kind].add(id);
    }
    return Object.fromEntries(
        LINKED_NODE_TYPES.map((k) => [k, [...sets[k]].sort()]),
    ) as Record<LinkedNodeType, string[]>;
}

const CONTROL_IMPLEMENTED = new Set(['IMPLEMENTED']);
const CONTROL_NEEDS_ATTENTION = new Set(['NEEDS_REVIEW', 'NOT_STARTED']);

/** The facts one kind's read answered, in the shape every kind shares. */
interface KindRead<F> {
    data: { restricted: boolean; missing: string[] } | undefined;
    facts: Record<string, F> | undefined;
    error: unknown;
}

function factsPath(mapId: string | null, kind: string, ids: string, version: number | null): string | null {
    if (!mapId || ids === '') return null;
    const v = version === null ? '' : `&v=${version}`;
    return `/processes/${encodeURIComponent(mapId)}/${kind}-facts?ids=${encodeURIComponent(ids)}${v}`;
}

export function CanvasLinkedFactsProvider({
    editor,
    mapId,
    version = null,
    children,
}: {
    editor: Editor | null;
    mapId: string | null;
    /** The saved map version; a new one re-reads the facts. */
    version?: number | null;
    children: ReactNode;
}) {
    const tc = useTranslations('processes.controlCard');
    const tr = useTranslations('processes.riskCard');
    const ta = useTranslations('processes.assetCard');
    // Recomputed by tldraw whenever a shape changes; the string keys keep each
    // fetch from re-running when the canvas changes without its ids changing.
    const keys = useValue(
        'linked record ids',
        () => {
            const ids = editor ? linkedIdsByKind(editor) : { control: [], risk: [], asset: [] };
            return `${ids.control.join(',')}|${ids.risk.join(',')}|${ids.asset.join(',')}`;
        },
        [editor],
    );
    const [controlIds = '', riskIds = '', assetIds = ''] = keys.split('|');
    const controls = useTenantSWR<ProcessMapControlFacts>(factsPath(mapId, 'control', controlIds, version));
    const risks = useTenantSWR<ProcessMapRiskFacts>(factsPath(mapId, 'risk', riskIds, version));
    const assets = useTenantSWR<ProcessMapAssetFacts>(factsPath(mapId, 'asset', assetIds, version));

    const value = useMemo<LinkedCardContextValue>(() => {
        const has = (t: typeof tc, key: string) => typeof t.has === 'function' && t.has(key);
        const label = (t: typeof tc, group: string, value: string) =>
            has(t, `${group}.${value}`) ? t(`${group}.${value}`) : value;

        const plain = (t: typeof tc, state: LinkedCardState, tone: CardTone): LinkedCard => ({
            state,
            title: t(state),
            detail: null,
            chip: null,
            note: null,
            noteTone: 'neutral',
            status: null,
            tone,
        });

        const controlCard = (f: ControlFact): LinkedCard => {
            const parts = [label(tc, 'status', f.status)];
            if (f.effectiveness !== null) parts.push(tc('effectiveness', { percent: f.effectiveness }));
            parts.push(f.lastTested ? tc('tested', { date: formatDate(f.lastTested) }) : tc('neverTested'));
            return {
                state: 'linked',
                title: f.code ? `${f.code} · ${f.name}` : f.name,
                detail: parts.join(' · '),
                chip: null,
                note: null,
                noteTone: 'neutral',
                status: f.status,
                tone: CONTROL_IMPLEMENTED.has(f.status)
                    ? 'success'
                    : CONTROL_NEEDS_ATTENTION.has(f.status)
                      ? 'warning'
                      : 'neutral',
            };
        };

        const riskCard = (f: RiskFact): LinkedCard => {
            const score =
                f.scoreKind === 'RESIDUAL'
                    ? tr('residualScore', { score: f.score, inherent: f.inherentScore })
                    : tr('inherentScore', { score: f.score });
            const detail = [score, label(tr, 'status', f.status)];
            if (f.treatment) detail.push(label(tr, 'treatment', f.treatment));
            const notes: string[] = [];
            let noteTone: CardTone = 'neutral';
            if (f.mitigation.total === 0) {
                notes.push(tr('noMitigatingControl'));
                noteTone = 'warning';
            } else if (f.mitigation.onMap === 0) {
                notes.push(tr('noMitigationOnMap'));
                noteTone = 'warning';
            } else {
                notes.push(tr('mitigatedHere', { onMap: f.mitigation.onMap, total: f.mitigation.total }));
            }
            if (f.reviewOverdue) {
                notes.push(tr('reviewOverdue'));
                noteTone = 'warning';
            }
            return {
                state: 'linked',
                title: f.key ? `${f.key} · ${f.title}` : f.title,
                detail: detail.join(' · '),
                chip: f.band,
                note: notes.join(' · '),
                noteTone,
                status: f.status,
                tone: 'neutral',
            };
        };

        const assetCard = (f: AssetFact): LinkedCard => {
            const detail = [label(ta, 'type', f.type)];
            if (f.criticality) detail.push(ta('criticality', { level: label(ta, 'level', f.criticality) }));
            const retired = f.status === 'RETIRED';
            if (retired) detail.push(label(ta, 'status', f.status));
            return {
                state: 'linked',
                title: f.key ? `${f.key} · ${f.name}` : f.name,
                detail: detail.join(' · '),
                chip: null,
                note: null,
                noteTone: 'neutral',
                status: f.status,
                // A retired asset still in a live process is worth a second look.
                tone: retired ? 'warning' : 'neutral',
            };
        };

        function cardOf<F>(
            t: typeof tc,
            read: KindRead<F>,
            id: string | null,
            linked: (f: F) => LinkedCard,
        ): LinkedCard {
            if (id === null) return plain(t, 'unlinked', 'warning');
            if (read.data?.restricted) return plain(t, 'restricted', 'neutral');
            const fact = read.facts?.[id];
            if (fact) return linked(fact);
            // Asked and not found: deleted, trashed, or never this tenant's.
            if (read.data?.missing.includes(id)) return plain(t, 'missing', 'warning');
            // A failed read is not evidence the record is gone: never "removed".
            if (read.error) return plain(t, 'unavailable', 'neutral');
            // Not asked yet: a link picked a moment ago, until its read returns.
            return plain(t, 'loading', 'neutral');
        }

        return {
            cardFor: (kind, id) => {
                if (kind === 'control') {
                    return cardOf(tc, { data: controls.data, facts: controls.data?.controls, error: controls.error }, id, controlCard);
                }
                if (kind === 'risk') {
                    return cardOf(tr, { data: risks.data, facts: risks.data?.risks, error: risks.error }, id, riskCard);
                }
                return cardOf(ta, { data: assets.data, facts: assets.data?.assets, error: assets.error }, id, assetCard);
            },
        };
    }, [controls.data, controls.error, risks.data, risks.error, assets.data, assets.error, tc, tr, ta]);

    return <LinkedCardContext.Provider value={value}>{children}</LinkedCardContext.Provider>;
}

/**
 * The card for a linked node, or undefined with no provider mounted (or for a
 * node that links to nothing: pass `null` as the kind).
 */
export function useLinkedCard(kind: LinkedNodeType | null, id: string | null): LinkedCard | undefined {
    const ctx = useContext(LinkedCardContext);
    if (!ctx || kind === null) return undefined;
    return ctx.cardFor(kind, id);
}
