'use client';

/**
 * INTERNAL AUDIT'S SAMPLED WORKPAPERS (#3677, step 3d).
 *
 * The auditor agent re-performs audit procedures and writes workpapers; the
 * daily sweep draws them (every one in the pilot) and assigns each to a member
 * of internal audit. This page is internal audit's queue: a sheet in which a
 * reviewer re-performs a workpaper and records their answer — CONCURRED,
 * DISSENTED or INDETERMINATE — once.
 *
 * ## Who sees what (owner decisions, 2026-10-19)
 *
 * Internal audit — an ACTIVE third-line member who owns no auditor agent —
 * sees EVERY assignment in the workspace and its status, and answers only its
 * own: somebody else's row opens read-only. Anybody else sees only the rows
 * assigned to them; somebody who is not an ACTIVE third-line member is told so,
 * rather than shown an empty queue that reads as "nothing to do". Internal
 * audit also sets the sampling rate here, inline, with a secondary button.
 *
 * ## Nothing here chooses
 *
 * There is no control that opens a review, picks a workpaper or picks a
 * reviewer: the sweep does all three, and a page that could would be choosing
 * the sample. The rate is not a choice of workpaper — every one is decided by
 * its own keyed score against it.
 *
 * ## The answer is codes, never prose
 *
 * The sheet's form is a radio group and, for a dissent, a multi-select of the
 * stable dissent codes. There is no text field anywhere on it, on purpose: the
 * record has no free-text column, and a box that accepted a note would be a
 * place to quote the workpaper's units into a plaintext row.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { BadgeCheck } from '@inflect/ui/components/ui/icons/nucleo';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

import { WorkpaperReviewSampleRate } from './WorkpaperReviewSampleRate';
import { WorkpaperReviewSheet } from './WorkpaperReviewSheet';

/** The tenant-relative endpoint. One data path — the page has no SSR twin. */
export const WORKPAPER_REVIEWS_ENDPOINT = '/audits/workpaper-reviews';

export type ReviewOutcome = 'PENDING' | 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE';

/** One review, as `GET /api/t/:slug/audits/workpaper-reviews` projects it. */
export interface WorkpaperReviewRow {
    id: string;
    workpaperId: string;
    samplingEpoch: string;
    samplePercent: number;
    sampledAt: string;
    assignedToUserId: string | null;
    unassignedReason: string | null;
    assignedAt: string;
    outcome: ReviewOutcome;
    dissentCodes: string[];
    reviewedAt: string | null;
    findingProposalId: string | null;
    /** Assigned to the viewer. Only such a row is ever answerable here. */
    mine: boolean;
    assignee: { userId: string; name: string } | null;
    answerable: boolean;
    refusal: string | null;
    workpaper: {
        procedureId: string;
        catalogueVersion: number;
        periodLabel: string;
        conclusion: string;
        conclusionBasis: string;
        populationCount: number;
        sampleSize: number | null;
        exceptionCount: number;
        auditorAgentId: string;
        createdAt: string;
    };
}

export interface WorkpaperReviewListPayload {
    reviewer: { eligible: boolean; reason: string | null };
    /** `ALL`: internal audit's overview. `OWN`: the viewer's assignments only. */
    scope: 'ALL' | 'OWN';
    sampleRate: { percent: number; canChange: boolean; refusal: string | null };
    rows: WorkpaperReviewRow[];
    truncated: boolean;
}

export function WorkpaperReviewsClient(props: { tenantSlug: string }) {
    // No filter definitions: a reviewer's queue is short and already theirs.
    // The search narrows it by procedure or period.
    const filterCtx = useFilterContext([], []);
    return (
        <FilterProvider value={filterCtx}>
            <WorkpaperReviewsInner {...props} />
        </FilterProvider>
    );
}

/** One badge per row: the answer, or — while unanswered — whether the viewer can give it. */
const ANSWERED_VARIANT: Record<Exclude<ReviewOutcome, 'PENDING'>, StatusBadgeVariant> = {
    CONCURRED: 'success',
    DISSENTED: 'error',
    INDETERMINATE: 'warning',
};

function outcomeBadge(row: WorkpaperReviewRow, t: ReturnType<typeof useTranslations>) {
    if (row.outcome !== 'PENDING') {
        return <StatusBadge variant={ANSWERED_VARIANT[row.outcome]}>{t(`workpaperReviews.outcome.${row.outcome}`)}</StatusBadge>;
    }
    // Somebody else's unanswered row: waiting on its reviewer, or on the sweep.
    const waitingOnOther = !row.mine && row.assignedToUserId !== null;
    const blocked = !row.answerable && !waitingOnOther;
    const label = waitingOnOther
        ? t('workpaperReviews.awaitingReviewer')
        : blocked
          ? t(`workpaperReviews.refusal.${row.refusal ?? 'UNKNOWN'}`)
          : t('workpaperReviews.outcome.PENDING');
    return <StatusBadge variant={blocked ? 'neutral' : 'info'}>{label}</StatusBadge>;
}

function WorkpaperReviewsInner({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('audits');
    const { search } = useFilters();
    const [openId, setOpenId] = useState<string | null>(null);

    const query = useTenantSWR<WorkpaperReviewListPayload>(WORKPAPER_REVIEWS_ENDPOINT);
    const allRows = useMemo(() => query.data?.rows ?? [], [query.data]);
    const reviewer = query.data?.reviewer ?? null;
    const truncated = query.data?.truncated ?? false;
    const overview = query.data?.scope === 'ALL';
    const sampleRate = query.data?.sampleRate ?? null;

    const needle = search.trim().toLowerCase();
    const rows = useMemo(
        () =>
            needle
                ? allRows.filter((r) =>
                      `${r.workpaper.procedureId} ${r.workpaper.periodLabel}`.toLowerCase().includes(needle),
                  )
                : allRows,
        [allRows, needle],
    );
    const awaiting = allRows.filter((r) => r.mine && r.outcome === 'PENDING' && r.answerable).length;

    const columns = useMemo(
        () =>
            createColumns<WorkpaperReviewRow>([
                {
                    id: 'procedure',
                    header: t('workpaperReviews.colProcedure'),
                    accessorFn: (r) => r.workpaper.procedureId,
                    cell: ({ row }) => (
                        <span className="font-mono text-content-default" data-testid={`workpaper-review-row-${row.original.id}`}>
                            {row.original.workpaper.procedureId}
                        </span>
                    ),
                },
                {
                    id: 'period',
                    header: t('workpaperReviews.colPeriod'),
                    accessorFn: (r) => r.workpaper.periodLabel,
                    cell: ({ row }) => <span className="text-content-muted">{row.original.workpaper.periodLabel}</span>,
                },
                {
                    id: 'conclusion',
                    header: t('workpaperReviews.colConclusion'),
                    accessorFn: (r) => r.workpaper.conclusion,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t('workpaperReviews.conclusionValue', {
                                conclusion: row.original.workpaper.conclusion,
                                basis: row.original.workpaper.conclusionBasis,
                            })}
                        </span>
                    ),
                },
                // Who it is assigned to — only in internal audit's overview,
                // where the rows are not all the viewer's own.
                ...(overview
                    ? [
                          {
                              id: 'assignee',
                              header: t('workpaperReviews.colAssignee'),
                              accessorFn: (r: WorkpaperReviewRow) => r.assignee?.name ?? '',
                              cell: ({ row }: { row: { original: WorkpaperReviewRow } }) => (
                                  <span
                                      className="text-content-muted"
                                      data-testid={`workpaper-review-assignee-${row.original.id}`}
                                  >
                                      {row.original.mine
                                          ? t('workpaperReviews.assigneeYou')
                                          : (row.original.assignee?.name ?? t('workpaperReviews.assigneeNobody'))}
                                  </span>
                              ),
                          },
                      ]
                    : []),
                {
                    id: 'sampledAt',
                    header: t('workpaperReviews.colDrawn'),
                    accessorFn: (r) => r.sampledAt,
                    cell: ({ row }) => (
                        <span className="whitespace-nowrap text-content-muted">{formatDate(row.original.sampledAt)}</span>
                    ),
                },
                {
                    id: 'answer',
                    header: t('workpaperReviews.colAnswer'),
                    accessorFn: (r) => r.outcome,
                    cell: ({ row }) => outcomeBadge(row.original, t),
                },
            ]),
        [t, overview],
    );

    const getRowId = useCallback((r: WorkpaperReviewRow) => r.id, []);
    const onRowClick = useCallback((row: { original: WorkpaperReviewRow }) => setOpenId(row.original.id), []);

    const loadError = query.error
        ? query.error instanceof Error
            ? query.error.message
            : t('workpaperReviews.loadFailed')
        : undefined;

    return (
        <>
            <EntityListPage<WorkpaperReviewRow>
                header={{
                    back: { smart: true },
                    breadcrumbs: [
                        { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('crumb.audits'), href: `/t/${tenantSlug}/audits` },
                        { label: t('workpaperReviews.crumb') },
                    ],
                    title: t('workpaperReviews.title'),
                    count: overview
                        ? t('workpaperReviews.countOverview', { awaiting, total: allRows.length })
                        : t('workpaperReviews.count', { awaiting, total: allRows.length }),
                }}
                filters={{
                    defs: [],
                    searchId: 'workpaper-reviews-search',
                    searchPlaceholder: t('workpaperReviews.searchPlaceholder'),
                }}
                banner={
                    <div className="space-y-default">
                        <InlineNotice variant="info" data-testid="workpaper-reviews-about">
                            {t('workpaperReviews.about')}
                        </InlineNotice>
                        {reviewer && !reviewer.eligible && (
                            <InlineNotice variant="warning" data-testid="workpaper-reviews-not-eligible">
                                {t(`workpaperReviews.notEligible.${reviewer.reason ?? 'UNKNOWN'}`)}
                            </InlineNotice>
                        )}
                        {overview && (
                            <InlineNotice variant="info" icon={null} data-testid="workpaper-reviews-overview">
                                {t('workpaperReviews.overview')}
                            </InlineNotice>
                        )}
                        {sampleRate?.canChange && (
                            <WorkpaperReviewSampleRate
                                percent={sampleRate.percent}
                                onSaved={() => {
                                    void query.mutate();
                                }}
                            />
                        )}
                        {truncated && (
                            <InlineNotice variant="warning" data-testid="workpaper-reviews-truncated">
                                {t('workpaperReviews.truncated', { shown: allRows.length })}
                            </InlineNotice>
                        )}
                    </div>
                }
                table={{
                    'data-testid': 'workpaper-reviews-table',
                    data: rows,
                    columns,
                    getRowId,
                    onRowClick,
                    // Nothing acts on a selection, and with selection on a
                    // single click toggles it and the row opens on a double
                    // click — which would hide the only thing a row is for.
                    selectionEnabled: false,
                    loading: query.isLoading,
                    error: loadError,
                    resourceName: (plural) =>
                        plural ? t('workpaperReviews.resourcePlural') : t('workpaperReviews.resourceSingular'),
                    emptyState: (
                        <EmptyState
                            icon={BadgeCheck}
                            title={overview ? t('workpaperReviews.emptyTitleOverview') : t('workpaperReviews.emptyTitle')}
                            description={
                                reviewer && !reviewer.eligible
                                    ? t('workpaperReviews.emptyNotEligible')
                                    : overview
                                      ? t('workpaperReviews.emptyDescOverview')
                                      : t('workpaperReviews.emptyDesc')
                            }
                        />
                    ),
                }}
            />
            {openId && (
                <WorkpaperReviewSheet
                    reviewId={openId}
                    onClose={() => setOpenId(null)}
                    onAnswered={() => {
                        void query.mutate();
                    }}
                />
            )}
        </>
    );
}
