'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { DataTable, createColumns } from '@/components/ui/table';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Checkbox } from '@/components/ui/checkbox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { PageHeader } from '@/components/layout/PageHeader';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import {
    TimeSeriesChart, Bars, XAxis, YAxis,
    RadarChart, chartReady, chartEmpty, type RadarAxisDatum,
} from '@/components/ui/charts';
import { formatDate } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';

// CC BY 4.0 attribution — carries everywhere derived NIS2 content renders.
const NIS2_ATTRIBUTION =
    'NIS2 gap-assessment questions © NISD2 contributors (Kardashev Catalyst UG / nisd2.eu), CC BY 4.0';
const NIS2_SOURCE_URL = 'https://github.com/NISD2/nis2-gap-assessment-schema';

type Bilingual = { en: string; de: string };
type Gap = {
    questionId: string; domainId: number; criticality: string; consequence: string;
    fineExposure: boolean; timeToFix: string; legalBasis: string; answer: string;
    priority: number; priorityTier: string; plainText: Bilingual;
};
type DomainScore = { domainId: number; code: string; name: Bilingual; score: number; answered: number; total: number };
type RunSummary = { id: string; source: string; status: string; completedAt: string | null; createdAt: string; overall: number; gapCount: number; answered: number; total: number };
type Snapshot = { score: number; gapCount: number; computedAt: string };
type Payload = {
    history: RunSummary[];
    snapshots: Snapshot[];
    latest: { score: { overall: number; byDomain: DomainScore[] }; gaps: Gap[]; fineExposureGaps: number; answeredTotal: number; questionTotal: number };
};
type Suggestion = {
    questionId: string; title: string; legalBasis: string; priorityTier: string;
    criticality: string; consequence: string; fineExposure: boolean;
    kind: 'RISK' | 'CONTROL_LINK' | 'CONTROL_CREATE' | 'TASK'; reason: string;
    existingControls?: Array<{ id: string; name: string }>;
};

function critVariant(c: string): 'error' | 'warning' | 'info' | 'neutral' {
    if (c === 'CRITICAL') return 'error';
    if (c === 'HIGH') return 'warning';
    if (c === 'MEDIUM') return 'info';
    return 'neutral';
}
function kindLabel(k: Suggestion['kind']): string {
    return k === 'RISK' ? 'Risk' : k === 'TASK' ? 'Task' : k === 'CONTROL_LINK' ? 'Link control' : 'New control';
}

/**
 * One request shape for every write in this file — the lifecycle page's two
 * and the delegation panel's one (fired by two buttons). Four hand-rolled
 * `fetch` + `res.ok` + error blocks is how error handling drifts apart.
 *
 * The two surfaces disagree about WHICH message the user sees, and that
 * disagreement is deliberate rather than drift, so it is an argument instead
 * of a second copy of the request: the assignments endpoints return an
 * actionable server message ("run already finalized", "not every respondent
 * has submitted") that the panel has always surfaced, while the nis2-gap
 * writes have always shown their own localized fallback.
 */
async function send(
    url: string,
    init: RequestInit,
    fallbackMessage: string,
    opts: { preferServerMessage?: boolean } = {},
) {
    const res = await fetch(url, init);
    if (!res.ok) {
        if (!opts.preferServerMessage) throw new Error(fallbackMessage);
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? fallbackMessage);
    }
    return res.json().catch(() => null);
}

export function Nis2GapLifecycleClient({ tenantSlug, canWrite }: { tenantSlug: string; canWrite: boolean }) {
    const tx = useTranslations('audits');
    const locale = useLocale();
    const lang = locale === 'de' ? 'de' : 'en';
    // Derived from the SAME registry key the reads use, so a write's URL and
    // the cache entry it refreshes cannot drift apart.
    const base = `/api/t/${tenantSlug}${CACHE_KEYS.audits.nis2Gap()}`;

    const [notice, setNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const [approved, setApproved] = useState<Record<string, boolean>>({});
    const [confirmOpen, setConfirmOpen] = useState(false);

    // ─── Reads ───
    //
    // One `Promise.all` + `useEffect` + three `useState`s became two SWR keys,
    // named in CACHE_KEYS rather than spelled inline: the mutations below
    // target the same strings, which is the property that makes their
    // invalidations land. A near-miss string refreshes nothing and reads as a
    // slow network.
    const stateQuery = useTenantSWR<Payload>(CACHE_KEYS.audits.nis2Gap());
    const data = stateQuery.data ?? null;
    const loading = stateQuery.isLoading;

    // The suggestion list is advisory — it only populates the "Create these?"
    // panel, so a failure leaves the page fully usable with no suggestions,
    // which is what the old `if (remRes.ok)` guard did. It no longer takes the
    // whole page down when the request REJECTS rather than 500s (the old
    // Promise.all made that one case fatal).
    const remediationsQuery = useTenantSWR<{ suggestions?: Suggestion[] }>(
        CACHE_KEYS.audits.nis2GapRemediations(),
    );
    const suggestions = useMemo(
        () => remediationsQuery.data?.suggestions ?? [],
        [remediationsQuery.data],
    );

    // A network blip on the state read stays distinguishable from an empty
    // state: SWR's `error` is the blip, `data === null` is "no payload yet"
    // (renders nothing, exactly as before). Both keep the localized message
    // the user already saw for the non-network case, and — unlike the old
    // `error` state — a successful retry clears it.
    const error = actionError ?? (stateQuery.error ? tx('nis2Gap.loadFailed') : null);

    const load = useCallback(() => {
        void stateQuery.mutate();
        void remediationsQuery.mutate();
    }, [stateQuery, remediationsQuery]);

    const rerunMutation = useTenantMutation<Payload, void>({
        key: CACHE_KEYS.audits.nis2Gap(),
        // No optimistic prediction: a re-run mints a whole new assessment row
        // (server id, createdAt, status) and every number on this page —
        // history, trend, per-domain score, gaps — is recomputed from it.
        // None of that is derivable here, so a guess would only make the page
        // shift when the real run lands.
        mutationFn: () =>
            send(`${base}/rerun`, { method: 'POST' }, tx('nis2Gap.rerunFailed')),
        // The suggestions are derived from the latest run's gaps.
        invalidate: [CACHE_KEYS.audits.nis2GapRemediations()],
    });
    const rerunning = rerunMutation.isMutating;

    const handleRerun = useCallback(async () => {
        setNotice(null);
        try {
            await rerunMutation.trigger();
            setNotice(tx('nis2Gap.rerunStarted'));
        } catch (e) {
            setActionError(e instanceof Error ? e.message : tx('nis2Gap.rerunFailed'));
        }
    }, [rerunMutation, tx]);

    const applyMutation = useTenantMutation<
        { suggestions?: Suggestion[] },
        Array<{ questionId: string; kind: Suggestion['kind']; linkControlId?: string }>,
        { risksCreated: number; controlsCreated: number; tasksCreated: number; skipped: number }
    >({
        key: CACHE_KEYS.audits.nis2GapRemediations(),
        // No optimistic prediction: the server decides what each approval
        // becomes and which ones it SKIPS as already-existing — the counts in
        // the success notice are the outcome, not the input. Optimistically
        // dropping the approved rows would be wrong in exactly the case the
        // `skipped` count exists to report.
        mutationFn: (approvals) =>
            send(
                `${base}/remediations`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approvals }),
                },
                tx('nis2Gap.applyFailed'),
            ),
        // The run's gap payload moves with the created entities, and each
        // minted entity shows up on its own list page.
        invalidate: [
            CACHE_KEYS.audits.nis2Gap(),
            CACHE_KEYS.risks.list(),
            CACHE_KEYS.controls.list(),
            CACHE_KEYS.tasks.list(),
        ],
    });
    const applying = applyMutation.isMutating;

    const handleApply = useCallback(async () => {
        try {
            const approvals = suggestions
                .filter((s) => approved[s.questionId])
                .map((s) => ({
                    questionId: s.questionId,
                    kind: s.kind,
                    linkControlId: s.kind === 'CONTROL_LINK' ? s.existingControls?.[0]?.id : undefined,
                }));
            const r = await applyMutation.trigger(approvals);
            setNotice(tx('nis2Gap.created', { risks: r.risksCreated, controls: r.controlsCreated, tasks: r.tasksCreated, skipped: r.skipped }));
            setApproved({});
        } catch (e) {
            setActionError(e instanceof Error ? e.message : tx('nis2Gap.applyFailed'));
        }
    }, [applyMutation, suggestions, approved, tx]);

    const radarState = useMemo(() => {
        const byDomain = data?.latest.score.byDomain ?? [];
        if (byDomain.length === 0) return chartEmpty<RadarAxisDatum[]>();
        return chartReady<RadarAxisDatum[]>(byDomain.map((d) => ({ key: d.code, label: d.name?.[lang] ?? d.code, value: d.score })));
    }, [data, lang]);

    const trend = useMemo(
        () => (data?.snapshots ?? []).map((s) => ({ date: new Date(s.computedAt), values: { value: s.score } })),
        [data],
    );

    const historyColumns = useMemo(
        () => createColumns<RunSummary>([
            {
                id: 'run', header: tx('nis2Gap.colRun'), cell: ({ row }) => (
                    <StatusBadge variant={row.original.source === 'WIZARD_BASELINE' ? 'info' : 'neutral'} size="sm">
                        {row.original.source === 'WIZARD_BASELINE' ? tx('nis2Gap.runBaseline') : tx('nis2Gap.runReassessment')}
                    </StatusBadge>
                ),
            },
            { accessorKey: 'overall', header: tx('nis2Gap.colScore'), cell: ({ row }) => <span className="tabular-nums">{row.original.overall}</span> },
            { accessorKey: 'gapCount', header: tx('nis2Gap.colGaps'), cell: ({ row }) => <span className="tabular-nums text-content-muted">{row.original.gapCount}</span> },
            { id: 'answered', header: tx('nis2Gap.colAnswered'), cell: ({ row }) => <span className="tabular-nums text-content-muted">{row.original.answered}/{row.original.total}</span> },
            { accessorKey: 'status', header: tx('nis2Gap.colStatus'), cell: ({ row }) => <span className="text-content-muted">{row.original.status}</span> },
            { id: 'date', header: tx('nis2Gap.colDate'), cell: ({ row }) => <span className="text-content-muted">{formatDate(new Date(row.original.createdAt))}</span> },
        ]),
        [tx],
    );

    const gapColumns = useMemo(
        () => createColumns<Gap>([
            { accessorKey: 'plainText', header: tx('nis2Gap.gapCol'), cell: ({ row }) => <span>{row.original.plainText?.[lang]}</span> },
            { accessorKey: 'criticality', header: tx('nis2Gap.gapCrit'), cell: ({ row }) => <StatusBadge variant={critVariant(row.original.criticality)} size="sm">{row.original.criticality}</StatusBadge> },
            {
                id: 'liability', header: tx('nis2Gap.gapLiability'), cell: ({ row }) => (
                    row.original.consequence === 'PERSONAL_LIABILITY'
                        ? <StatusBadge variant="error" size="sm">{tx('nis2Gap.personalLiability')}</StatusBadge>
                        : row.original.fineExposure
                            ? <StatusBadge variant="warning" size="sm">{tx('nis2Gap.fineExposure')}</StatusBadge>
                            : <span className="text-content-muted text-xs">{row.original.consequence}</span>
                ),
            },
            { accessorKey: 'answer', header: tx('nis2Gap.gapAnswer'), cell: ({ row }) => <span className="text-content-muted">{row.original.answer}</span> },
            { accessorKey: 'timeToFix', header: tx('nis2Gap.gapEffort'), cell: ({ row }) => <span className="text-content-muted">{row.original.timeToFix}</span> },
            { accessorKey: 'legalBasis', header: tx('nis2Gap.gapLegalBasis'), cell: ({ row }) => <span className="text-xs text-content-muted">{row.original.legalBasis}</span> },
        ]),
        [lang, tx],
    );

    const approvedCount = suggestions.filter((s) => approved[s.questionId]).length;

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <PageHeader
                breadcrumbs={[
                    { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
                    { label: tx('nav.nis2Gap') },
                ]}
                title={tx('nav.nis2Gap')}
                description={tx('nis2Gap.description')}
                actions={
                    <div className="flex items-center gap-tight">
                        <Link
                            href={`/t/${tenantSlug}/frameworks/NIS2/readiness`}
                            className={cn(buttonVariants({ variant: 'secondary' }))}
                            id="nis2-gap-coverage-link"
                        >
                            {tx('nis2Gap.viewCoverage')}
                        </Link>
                        {canWrite ? (
                            <Button variant="secondary" onClick={handleRerun} disabled={rerunning} id="nis2-gap-rerun-btn">
                                {rerunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                {tx('nis2Gap.rerun')}
                            </Button>
                        ) : null}
                    </div>
                }
            />

            <InlineNotice variant="info">
                {tx.rich('nis2Gap.disclaimer', { strong: (c) => <strong>{c}</strong> })}
            </InlineNotice>

            {notice && <InlineNotice variant="success">{notice}</InlineNotice>}
            {error && <p className="text-sm text-content-error">{error}</p>}

            {loading ? (
                <div className="flex items-center gap-tight p-6 text-content-muted text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> {tx('nis2Gap.loading')}
                </div>
            ) : !data ? null : (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-default">
                        <div className={cardVariants({ density: 'comfortable' })}>
                            <KPIStat value={`${data.latest.score.overall}`} label={tx('nis2Gap.kpiReadiness')} description={tx('nis2Gap.kpiReadinessDesc')} />
                        </div>
                        <div className={cardVariants({ density: 'comfortable' })}>
                            <KPIStat value={`${data.latest.fineExposureGaps}`} label={tx('nis2Gap.kpiFineExposure')} tone={data.latest.fineExposureGaps > 0 ? 'critical' : 'default'} description={tx('nis2Gap.kpiFineExposureDesc')} />
                        </div>
                        <div className={cardVariants({ density: 'comfortable' })}>
                            <KPIStat value={`${data.latest.gaps.length}`} label={tx('nis2Gap.kpiOpenGaps')} description={tx('nis2Gap.kpiAnswered', { answered: data.latest.answeredTotal, total: data.latest.questionTotal })} />
                        </div>
                    </div>

                    {trend.length >= 2 && (
                        <div className={cn(cardVariants({ density: 'comfortable' }), 'space-y-tight')}>
                            <Heading level={3}>{tx('nis2Gap.readinessOverTime')}</Heading>
                            <div className="h-56">
                                <TimeSeriesChart
                                    data={trend}
                                    series={[{ id: 'score', isActive: true, valueAccessor: (d: { values: { value: number } }) => d.values.value, colorClassName: 'text-brand-default' }]}
                                    type="bar"
                                >
                                    <YAxis showGridLines />
                                    <Bars />
                                    <XAxis tickFormat={(d: Date) => formatDate(d)} />
                                </TimeSeriesChart>
                            </div>
                        </div>
                    )}

                    {/* Radar spans the full width with a tall, roughly-square plot so
                        all 15 domain axis labels have room to breathe (a half-width,
                        default-height radar crushed them into overlap). */}
                    <div className={cn(cardVariants({ density: 'comfortable' }), 'space-y-tight')}>
                        <Heading level={3}>{tx('nis2Gap.maturityByDomain')}</Heading>
                        {data.latest.answeredTotal === 0 ? (
                            // A just-started run has no answers yet, so every domain
                            // scores 0 and the radar would render as a bare dot. Show
                            // why instead — it fills in as answers arrive.
                            <p className="py-10 text-center text-sm text-content-muted">
                                {tx('nis2Gap.radarEmpty')}
                            </p>
                        ) : (
                            <div className="mx-auto h-[520px] w-full max-w-3xl">
                                <RadarChart state={radarState} seriesIndex={2} maxValue={100} testId="nis2-gap-radar" ariaLabel={tx('nis2Gap.radarAria')} />
                            </div>
                        )}
                    </div>

                    <div className="space-y-tight">
                        <Heading level={3}>{tx('nis2Gap.histTitle')}</Heading>
                        <DataTable data={data.history} columns={historyColumns} getRowId={(r) => r.id} data-testid="nis2-gap-history-table" />
                    </div>

                    {/* Delegation. The assign→respond→review backend
                        (dispatchAssignments) hard-rejects a WIZARD_BASELINE run —
                        the onboarding baseline is never delegated. Rather than
                        silently hide the panel on a baseline (which reads as the
                        feature vanishing), explain WHY and offer the standalone
                        re-assessment that CAN be delegated. STANDALONE runs get the
                        real panel. */}
                    {canWrite && data.history[0]?.status !== 'COMPLETED' && (
                        data.history[0]?.source === 'STANDALONE' ? (
                            <Nis2AssignmentsPanel
                                tenantSlug={tenantSlug}
                                assessmentId={data.history[0].id}
                                onChanged={() => { void load(); }}
                            />
                        ) : data.history[0]?.source === 'WIZARD_BASELINE' ? (
                            <div className={cn(cardVariants({ density: 'comfortable' }))}>
                                <EmptyState
                                    variant="missing-prereqs"
                                    size="sm"
                                    title={tx('nis2Gap.baselineDelegateTitle')}
                                    description={tx('nis2Gap.baselineDelegateBody')}
                                    primaryAction={{
                                        label: tx('nis2Gap.baselineDelegateAction'),
                                        onClick: () => { void handleRerun(); },
                                        disabled: rerunning,
                                        'data-testid': 'nis2-gap-baseline-delegate-cta',
                                    }}
                                />
                            </div>
                        ) : null
                    )}

                    <div className="space-y-tight">
                        <Heading level={3}>{tx('nis2Gap.prioritisedGaps')}</Heading>
                        <DataTable data={data.latest.gaps} columns={gapColumns} getRowId={(r) => r.questionId} data-testid="nis2-gap-priority-table" />
                    </div>

                    {canWrite && suggestions.length > 0 && (
                        <div className="space-y-default">
                            <div className="flex items-center justify-between gap-compact flex-wrap">
                                <div>
                                    <Heading level={3}>{tx('nis2Gap.createThese')}</Heading>
                                    <p className="text-sm text-content-muted">{tx('nis2Gap.approveHint')}</p>
                                </div>
                                <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={applying || approvedCount === 0} id="nis2-gap-apply-btn">
                                    {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                    {approvedCount > 0 ? tx('nis2Gap.createSelectedN', { count: approvedCount }) : tx('nis2Gap.createSelectedZero')}
                                </Button>
                            </div>
                            <ul className="space-y-tight">
                                {suggestions.map((s) => (
                                    <li key={s.questionId} className={cn(cardVariants({ density: 'compact' }), 'flex items-start gap-default')}>
                                        <Checkbox
                                            checked={!!approved[s.questionId]}
                                            onCheckedChange={(v) => setApproved((prev) => ({ ...prev, [s.questionId]: !!v }))}
                                            aria-label={tx('nis2Gap.approveAria', { title: s.title })}
                                        />
                                        <div className="min-w-0 flex-1 space-y-tight">
                                            <div className="flex items-center gap-tight flex-wrap">
                                                <StatusBadge variant="info" size="sm">{kindLabel(s.kind)}</StatusBadge>
                                                <StatusBadge variant={critVariant(s.criticality)} size="sm">{s.criticality}</StatusBadge>
                                                {s.consequence === 'PERSONAL_LIABILITY' && <StatusBadge variant="error" size="sm">Personal liability</StatusBadge>}
                                                {s.fineExposure && <StatusBadge variant="warning" size="sm">Fine exposure</StatusBadge>}
                                                <span className="text-sm font-medium text-content-emphasis">{s.title}</span>
                                            </div>
                                            <p className="text-xs text-content-muted">{tx('nis2Gap.reasonLegal', { reason: s.reason, legalBasis: s.legalBasis })}</p>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <p className="text-xs text-content-subtle">
                        {NIS2_ATTRIBUTION}{' '}
                        <a href={NIS2_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-content-muted">{tx('nis2Gap.sourceLink')}</a>
                    </p>
                </>
            )}

            <ConfirmDialog
                showModal={confirmOpen}
                setShowModal={(open) => {
                    if (typeof open === 'function') { if (!open(confirmOpen)) setConfirmOpen(false); }
                    else setConfirmOpen(open);
                }}
                title={tx('nis2Gap.confirmTitle')}
                description={tx('nis2Gap.confirmDesc', { count: approvedCount })}
                confirmLabel={tx('nis2Gap.confirmLabel')}
                onConfirm={async () => { setConfirmOpen(false); await handleApply(); }}
            />
        </div>
    );
}

// ─── Owner delegation panel (multi-respondent async collection, Prompt 2) ───

const RESPONDENT_ROLES: Array<{ role: string; label: string }> = [
    { role: 'CEO', label: 'CEO — scoping & governance' },
    { role: 'IT', label: 'IT — technical & cryptography' },
    { role: 'HR', label: 'HR — training & awareness' },
    { role: 'PROCUREMENT', label: 'Procurement — supply chain' },
    { role: 'ANYONE', label: 'General' },
];

interface AssignmentRow {
    id: string;
    respondentRole: string;
    assigneeUserId: string | null;
    status: string;
    questionIds: string[];
}

function Nis2AssignmentsPanel({
    tenantSlug,
    assessmentId,
    onChanged,
}: {
    tenantSlug: string;
    assessmentId: string;
    onChanged: () => void;
}) {
    const tx = useTranslations('audits');
    const assignmentsKey = CACHE_KEYS.gapAssessments.assignments(assessmentId);
    const base = `/api/t/${tenantSlug}${assignmentsKey}`;
    const [picks, setPicks] = useState<Record<string, string>>({});
    const [err, setErr] = useState<string | null>(null);

    // A failed read is non-fatal, as it was before: the panel still renders its
    // five roles with no status badges, so the owner can still dispatch.
    //
    // `shouldRetryOnError: false` because the expected failure here is a 403,
    // and an authorization denial is not a transient condition to retry into.
    // This panel is rendered on `canWrite`, but `GET /gap-assessments/{id}/
    // assignments` is gated on `admin.manage` — so an EDITOR opening this page
    // is denied. The old one-shot loader swallowed a single 403 per visit; the
    // platform hook's default `errorRetryCount: 2` would turn that into three,
    // and every one of them writes an immutable AUTHZ_DENIED row (Epic C.1).
    // Focus revalidation stays ON: for the admins this panel is actually FOR,
    // respondent status changes out-of-band, which is precisely what it is for.
    //
    // The mis-gating itself (a panel whose every control 403s for an EDITOR)
    // predates this migration and is not fixed here — see the implementation
    // note's Remaining section.
    const assignmentsQuery = useTenantSWR<AssignmentRow[]>(assignmentsKey, {
        shouldRetryOnError: false,
    });
    const assignments = useMemo(() => assignmentsQuery.data ?? [], [assignmentsQuery.data]);

    // The saved role→assignee mapping as the server reports it. The old loader
    // replaced `picks` wholesale on every load, but it only ever loaded on
    // mount and after a write; SWR also revalidates on focus, so the sync is
    // keyed on the serialized mapping — an unchanged server answer must not
    // clobber a pick the owner is in the middle of making.
    const savedPicks = useMemo<Record<string, string>>(
        () => Object.fromEntries(
            assignments
                .filter((r) => r.assigneeUserId)
                .map((r) => [r.respondentRole, r.assigneeUserId as string]),
        ),
        [assignments],
    );
    const savedPicksKey = JSON.stringify(savedPicks);
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    useEffect(() => { setPicks(savedPicks); }, [savedPicksKey]);

    const byRole = useMemo(() => new Map(assignments.map((a) => [a.respondentRole, a])), [assignments]);
    const allSubmitted = assignments.length > 0 && assignments.every((a) => a.status === 'SUBMITTED');

    // One PUT-shaped write, two callers (dispatch and finalize) — same
    // endpoint family, same cache entry, different body. The mutation owns the
    // request lifecycle and the assignments-feed revalidation; the caller's
    // fallback message rides along as input so the two buttons keep their own
    // wording.
    const actionMutation = useTenantMutation<
        AssignmentRow[],
        { url: string; body: unknown; fallbackMessage: string }
    >({
        key: assignmentsKey,
        // Neither caller is predictable: dispatch MINTS one row per role
        // (server ids plus the per-role question split) and finalize
        // recomputes the run server-side. Both buttons are disabled while the
        // request is in flight, so there is no window a guess would fill.
        mutationFn: ({ url, body, fallbackMessage }) =>
            send(
                url,
                { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
                fallbackMessage,
                // These endpoints answer with an actionable message ("run
                // already finalized", "not every respondent has submitted")
                // that the panel has always shown over its own fallback.
                { preferServerMessage: true },
            ),
    });
    const busy = actionMutation.isMutating;

    async function act(url: string, body: unknown, ok: string) {
        setErr(null);
        try {
            await actionMutation.trigger({ url, body, fallbackMessage: ok });
            onChanged();
        } catch (e) {
            setErr(e instanceof Error ? e.message : tx('nis2Gap.actionFailed'));
        }
    }

    return (
        <div className="space-y-default">
            <div className="flex items-center justify-between gap-compact flex-wrap">
                <div>
                    <Heading level={3}>{tx('nis2Gap.assignTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {tx('nis2Gap.assignHint')}
                    </p>
                </div>
                <div className="flex items-center gap-tight">
                    <Button variant="secondary" disabled={busy} id="nis2-gap-dispatch-btn"
                        onClick={() => act(base, { roleToUserId: picks }, tx('nis2Gap.dispatchFailed'))}>
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} {tx('nis2Gap.dispatch')}
                    </Button>
                    <Button variant="secondary" disabled={busy || assignments.length === 0} id="nis2-gap-finalize-btn"
                        onClick={() => act(`${base}/finalize`, { force: !allSubmitted }, tx('nis2Gap.finalizeFailed'))}>
                        {allSubmitted ? tx('nis2Gap.finalize') : tx('nis2Gap.forceFinalize')}
                    </Button>
                </div>
            </div>
            {err && <p className="text-sm text-content-error">{err}</p>}
            <ul className="space-y-tight">
                {RESPONDENT_ROLES.map(({ role, label }) => {
                    const a = byRole.get(role);
                    return (
                        <li key={role} className={cn(cardVariants({ density: 'compact' }), 'flex items-center gap-default flex-wrap')}>
                            <span className="text-sm font-medium text-content-emphasis w-full sm:w-56 sm:shrink-0">{label}</span>
                            <div className="min-w-0 flex-1">
                                <UserCombobox
                                    tenantSlug={tenantSlug}
                                    selectedId={picks[role] || null}
                                    onChange={(id) => setPicks((prev) => ({ ...prev, [role]: id ?? '' }))}
                                    forceDropdown
                                    matchTriggerWidth
                                    placeholder={tx('nis2Gap.assignPlaceholder')}
                                    className="w-full sm:w-64"
                                />
                            </div>
                            {a && (
                                <StatusBadge variant={a.status === 'SUBMITTED' ? 'success' : a.status === 'IN_PROGRESS' ? 'info' : 'neutral'} size="sm">
                                    {tx('nis2Gap.assignStatus', { status: a.status, count: a.questionIds.length })}
                                </StatusBadge>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
