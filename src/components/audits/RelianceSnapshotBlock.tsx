'use client';
/**
 * #3681 — how an agent-audit reliance pack item reads, to the external auditor
 * on the shared page and to the tenant on the pack page.
 *
 * The snapshot is written by `lib/agentic/audit-reliance.ts`; this file holds
 * its own structural view of the two shapes rather than importing that module,
 * which reaches server-only code. A snapshot of any other shape renders
 * nothing here, so every existing pack reads exactly as before.
 *
 * Two rules the planner holds and this view must not undo:
 *   - no concluded review is NO RATE, said in words — never "0%" or "100%";
 *   - every limit is shown; none is summarised away.
 */
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/ui/status-badge';

interface SamplingView {
    workpapers: number;
    notDrawn: number;
    drawn: number;
    unassigned: number;
    awaiting: number;
    concurred: number;
    dissented: number;
    indeterminate: number;
    concluded: number;
    agreementRate: number | null;
    disagreementRate: number | null;
}

interface ControlRelianceView {
    type: 'AGENT_AUDIT_RELIANCE_CONTROL';
    reliance: {
        procedures: { id: string; title: string; controlIdentifiers: string[] }[];
        periodLabels: string[];
        workpapers: {
            id: string;
            procedureId: string;
            periodLabel: string;
            conclusion: string;
            exceptionCount: number;
            sampleSize: number | null;
            populationCount: number;
            sampling: { state: string; dissentCodes: string[]; unassignedReason: string | null };
        }[];
        sampling: SamplingView;
        limits: string[];
    };
}

interface SummaryRelianceView {
    type: 'AGENT_AUDIT_RELIANCE_SUMMARY';
    framework: { key: string; version: string };
    period: { start: string; end: string; labels: string[] };
    scope: { procedureId: string; title: string; controlIds: string[] }[];
    proceduresWithoutControl: string[];
    catalogue: { versions: number[]; statement: string };
    agreement: SamplingView;
    definitions: { id: string; label: string; population: string; excludes: string[] }[];
    limits: string[];
}

type RelianceView = ControlRelianceView | SummaryRelianceView;

/** The snapshot as a reliance view, or null when it is any other pack item. */
export function asRelianceView(snapshot: unknown): RelianceView | null {
    if (typeof snapshot !== 'object' || snapshot === null) return null;
    const type = (snapshot as { type?: unknown }).type;
    if (type === 'AGENT_AUDIT_RELIANCE_CONTROL' || type === 'AGENT_AUDIT_RELIANCE_SUMMARY') {
        return snapshot as RelianceView;
    }
    return null;
}

/**
 * The closed vocabularies the catalog carries a label for, as local sets rather
 * than next-intl probes: most hand-rolled `next-intl` mocks implement only `t`,
 * and a set is pinned against both catalogs by a test instead of degrading per
 * locale (see `entity-prev-next-nav.tsx`). A code outside them shows as itself.
 */
export const RELIANCE_LIMIT_LABELS: ReadonlySet<string> = new Set([
    'NO_WORKPAPERS_IN_PERIOD',
    'NO_CONCLUDED_REVIEW',
    'WORKPAPERS_NOT_DRAWN',
    'REVIEWS_AWAITING',
    'REVIEWS_UNASSIGNED',
    'REVIEWS_INDETERMINATE',
    'DISSENT_RECORDED',
    'CONCLUSION_FAIL',
    'CONCLUSION_INCONCLUSIVE',
    'ATTRIBUTED_BY_CURRENT_PLAN',
    'CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT',
    'CATALOGUE_NOT_AGREED_BY_PWC',
    'PROCEDURE_WITHOUT_CONTROL',
]);
export const RELIANCE_STATE_LABELS: ReadonlySet<string> = new Set([
    'NOT_DRAWN',
    'UNASSIGNED',
    'AWAITING',
    'CONCURRED',
    'DISSENTED',
    'INDETERMINATE',
]);

const percent = (v: number) => `${Math.round(v * 1000) / 10}%`;

function Rate({ sampling, id }: { sampling: SamplingView; id: string }) {
    const t = useTranslations('external.auditShare.reliance');
    return (
        <div className="text-xs text-content-muted space-y-tight" data-testid={`reliance-rate-${id}`}>
            {sampling.agreementRate === null ? (
                <p data-testid={`reliance-no-rate-${id}`}>{t('rateAbsent')}</p>
            ) : (
                <p>
                    {t('rate', {
                        agreement: percent(sampling.agreementRate),
                        concurred: sampling.concurred,
                        concluded: sampling.concluded,
                    })}
                </p>
            )}
            <p>
                {t('counts', {
                    workpapers: sampling.workpapers,
                    notDrawn: sampling.notDrawn,
                    awaiting: sampling.awaiting,
                    unassigned: sampling.unassigned,
                    indeterminate: sampling.indeterminate,
                    dissented: sampling.dissented,
                })}
            </p>
        </div>
    );
}

function Limits({ limits, id }: { limits: string[]; id: string }) {
    const t = useTranslations('external.auditShare.reliance');
    if (limits.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-tight" data-testid={`reliance-limits-${id}`}>
            {limits.map((code) => (
                <StatusBadge key={code} variant="warning" data-testid={`reliance-limit-${code}`}>
                    {RELIANCE_LIMIT_LABELS.has(code) ? t(`limit.${code}`) : code}
                </StatusBadge>
            ))}
        </div>
    );
}

/** The reliance part of one pack item; nothing for an item of another kind. */
export function RelianceSnapshotBlock({ snapshot, itemId }: { snapshot: unknown; itemId: string }) {
    const t = useTranslations('external.auditShare.reliance');
    const view = asRelianceView(snapshot);
    if (!view) return null;

    if (view.type === 'AGENT_AUDIT_RELIANCE_CONTROL') {
        const r = view.reliance;
        return (
            <div className="mt-2 space-y-compact" data-testid={`reliance-control-${itemId}`}>
                <p className="text-xs text-content-muted">
                    {t('procedures', { list: r.procedures.map((p) => p.title).join(', ') || '—' })}
                </p>
                <Rate sampling={r.sampling} id={itemId} />
                <Limits limits={r.limits} id={itemId} />
                {r.workpapers.length > 0 && (
                    <ul className="text-xs space-y-tight" data-testid={`reliance-workpapers-${itemId}`}>
                        {r.workpapers.map((w) => (
                            <li key={w.id} data-testid={`reliance-workpaper-${w.id}`}>
                                {t('workpaper', {
                                    period: w.periodLabel,
                                    procedure: w.procedureId,
                                    conclusion: w.conclusion,
                                    exceptions: w.exceptionCount,
                                    state: RELIANCE_STATE_LABELS.has(w.sampling.state)
                                        ? t(`state.${w.sampling.state}`)
                                        : w.sampling.state,
                                })}
                                {w.sampling.dissentCodes.length > 0 && ` (${w.sampling.dissentCodes.join(', ')})`}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    return (
        <div className="mt-2 space-y-compact" data-testid={`reliance-summary-${itemId}`}>
            <p className="text-xs text-content-muted">
                {t('period', {
                    framework: `${view.framework.key} ${view.framework.version}`,
                    count: view.period.labels.length,
                })}
            </p>
            <ul className="text-xs space-y-tight">
                {view.scope.map((s) => (
                    <li key={s.procedureId}>
                        {t('scopeLine', { procedure: s.title, controls: s.controlIds.length })}
                    </li>
                ))}
            </ul>
            <Rate sampling={view.agreement} id={itemId} />
            <p className="text-xs text-content-muted" data-testid={`reliance-catalogue-${itemId}`}>
                {view.catalogue.statement}
            </p>
            <Limits limits={view.limits} id={itemId} />
            <div className="space-y-tight" data-testid={`reliance-definitions-${itemId}`}>
                {view.definitions.map((d) => (
                    <div key={d.id} className="text-xs" data-testid={`reliance-definition-${d.id}`}>
                        <p className="font-medium">{d.label}</p>
                        <p className="text-content-muted">{d.population}</p>
                        <p className="text-content-muted">{t('excludes', { list: d.excludes.join('; ') })}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
