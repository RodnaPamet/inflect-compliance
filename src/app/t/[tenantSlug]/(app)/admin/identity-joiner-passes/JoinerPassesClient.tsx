'use client';

/**
 * The joiner pass report: what the pass would have created, and for whom.
 *
 * ═══ THE DECISIONS ARE THE ARTEFACT ═══
 *
 * A pass row on its own says a run happened. The seven-day window exists to
 * answer a narrower question — WHICH identity would this person have been given
 * — and only the per-starter decisions answer it. So the pass list is a way to
 * reach a pass, and the decision table under it is the thing an operator came
 * to read.
 *
 * ═══ `intendedAddress` IS RENDERED, AND THAT IS DELIBERATE ═══
 *
 * The usecase sets out why it may be: it is derived by this product from
 * `Employee.workEmail`, a plain RLS-scoped column the personnel page already
 * renders, not a directory-sourced identifier. Dropping it would leave "a report
 * that names decisions and no identities", which is the report not doing its
 * job. `reason` is scrubbed at the source and rendered as it arrives.
 *
 * ═══ EVERY FIELD IS NARROWED DEFENSIVELY ═══
 *
 * `resultJson` is a Json column read back verbatim, so a row written by an older
 * build carries fewer fields and one from a future build may carry more. Each
 * read degrades to a thinner render rather than a thrown page — the same
 * discipline `LeaverPassesClient` applies to its own result.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { formatDateTime } from '@/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';

/** One per-starter decision, as `recordPlan` persists it. */
interface JoinerDecision {
    employeeId: string;
    outcome: string;
    reason?: string | null;
    intendedAddress?: string | null;
    rosterAddress?: string | null;
}

/** The `resultJson` payload. Every field optional — it crosses a version boundary. */
interface JoinerResult {
    mode?: string;
    starters?: number;
    wouldCreate?: number;
    created?: number;
    decisions?: JoinerDecision[];
    refusal?: string | null;
    detail?: string | null;
}

interface JoinerPassRow {
    id: string;
    provider: string;
    status: string;
    executedAt: string;
    completedAt: string | null;
    resultJson: JoinerResult | null;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PASSED: 'success',
    NOT_APPLICABLE: 'warning',
    ERROR: 'error',
};

/**
 * An outcome's tone.
 *
 * PLANNED is `info`, not `success`: at DRY_RUN nothing was created, and a green
 * badge over a plan would say the opposite of what the seven-day window is for.
 */
const OUTCOME_VARIANT: Record<string, StatusBadgeVariant> = {
    PLANNED: 'info',
    CREATED: 'success',
};

export function JoinerPassesClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const { data, error, isLoading } = useTenantSWR<{ passes: JoinerPassRow[] }>(
        '/admin/identity-joiner-passes',
    );

    const rows = useMemo(() => data?.passes ?? [], [data]);
    const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
    const decisions = useMemo(() => selected?.resultJson?.decisions ?? [], [selected]);

    const passCols = useMemo(
        () =>
            createColumns<JoinerPassRow>([
                {
                    accessorKey: 'provider',
                    header: t('integrations.colProvider'),
                    cell: ({ getValue }) => <StatusBadge variant="info">{String(getValue())}</StatusBadge>,
                },
                {
                    id: 'status',
                    accessorKey: 'status',
                    header: t('integrations.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'mode',
                    header: t('joinerPasses.colMode'),
                    // The rung the pass ran at. Absent on a row from before the
                    // field existed, which renders as a dash rather than a
                    // guess.
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{row.original.resultJson?.mode ?? '—'}</span>
                    ),
                },
                {
                    id: 'starters',
                    header: t('joinerPasses.colStarters'),
                    cell: ({ row }) => (
                        <span className="tabular-nums">{row.original.resultJson?.starters ?? 0}</span>
                    ),
                },
                {
                    id: 'wouldCreate',
                    header: t('joinerPasses.colWouldCreate'),
                    // BOTH numbers, because they answer different questions and
                    // at DRY_RUN the second is always zero. Showing only one
                    // would make a plan indistinguishable from a run.
                    cell: ({ row }) => (
                        <span className="tabular-nums">
                            {row.original.resultJson?.wouldCreate ?? 0}
                            {' / '}
                            {row.original.resultJson?.created ?? 0}
                        </span>
                    ),
                },
                {
                    accessorKey: 'executedAt',
                    header: t('joinerPasses.colRan'),
                    cell: ({ row }) => (
                        <span className="text-content-muted tabular-nums">
                            {formatDateTime(row.original.executedAt)}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    const decisionCols = useMemo(
        () =>
            createColumns<JoinerDecision>([
                {
                    id: 'outcome',
                    accessorKey: 'outcome',
                    header: t('joinerPasses.colOutcome'),
                    cell: ({ row }) => (
                        <StatusBadge variant={OUTCOME_VARIANT[row.original.outcome] ?? 'neutral'}>
                            {row.original.outcome}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'address',
                    header: t('joinerPasses.colIntendedAddress'),
                    // THE FIELD THE WINDOW EXISTS FOR: which identity this
                    // person would have been given. Derived by this product
                    // from a column the personnel page already renders.
                    cell: ({ row }) => (
                        <span className="font-mono text-sm">{row.original.intendedAddress ?? '—'}</span>
                    ),
                },
                {
                    id: 'roster',
                    header: t('joinerPasses.colRosterAddress'),
                    // Carried only where the two addresses DISAGREEING is the
                    // decision, so it is empty on every other row by design.
                    cell: ({ row }) => (
                        <span className="font-mono text-sm text-content-muted">
                            {row.original.rosterAddress ?? '—'}
                        </span>
                    ),
                },
                {
                    id: 'reason',
                    header: t('joinerPasses.colReason'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{row.original.reason ?? '—'}</span>
                    ),
                },
            ]),
        [t],
    );

    return (
        <div className="space-y-comfortable">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('integrations.title'), href: tenantHref('/admin/integrations') },
                    { label: t('joinerPasses.breadcrumb') },
                ]}
            />
            <Heading level={1}>{t('joinerPasses.title')}</Heading>
            <p className="text-sm text-content-muted">{t('joinerPasses.intro')}</p>

            <Card>
                {error ? (
                    <InlineNotice variant="error">{t('joinerPasses.loadFailed')}</InlineNotice>
                ) : (
                    <DataTable
                        data-testid="joiner-passes-table"
                        data={rows}
                        columns={passCols}
                        getRowId={(r) => r.id}
                        selectionEnabled={false}
                        onRowClick={(row) => setSelectedId(row.original.id)}
                        emptyState={isLoading ? t('joinerPasses.loading') : t('joinerPasses.empty')}
                    />
                )}
            </Card>

            {selected && (
                <Card>
                    <Heading level={2}>{t('joinerPasses.decisionsTitle')}</Heading>
                    {selected.resultJson?.refusal && (
                        // A refusal is the pass's ANSWER, not an error. Rendered
                        // as a notice so it reads as the outcome it is.
                        <InlineNotice variant="warning">
                            {selected.resultJson.refusal}
                            {selected.resultJson.detail ? ` — ${selected.resultJson.detail}` : ''}
                        </InlineNotice>
                    )}
                    <DataTable
                        data-testid="joiner-pass-decisions-table"
                        data={decisions}
                        columns={decisionCols}
                        getRowId={(d) => d.employeeId}
                        selectionEnabled={false}
                        emptyState={t('joinerPasses.noDecisions')}
                    />
                </Card>
            )}
        </div>
    );
}
