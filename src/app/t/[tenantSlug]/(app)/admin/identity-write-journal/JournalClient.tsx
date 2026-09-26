'use client';

/**
 * Renders the journal index, the unsettled backlog, and one captured state.
 *
 * ═══ THE BACKLOG COMES FIRST, AND THAT IS THE POINT ═══
 *
 * The index is a history. The unsettled list is a QUESTION: each row is an
 * account this product may or may not have changed, and only a human looking at
 * the directory can answer it. Putting the history first would bury the one
 * section that asks somebody to do something.
 *
 * ═══ EVERY FIELD IS NARROWED DEFENSIVELY ═══
 *
 * These payloads cross a version boundary — a row written by an older build
 * carries fewer fields, one from a future build may carry more. Every read
 * degrades to a thinner render rather than a thrown page, the same discipline
 * `LeaverPassesClient` applies to `resultJson`.
 *
 * ═══ THE CAPTURED STATE IS FETCHED ONE ROW AT A TIME ═══
 *
 * Deliberately, and the usecase says why: the index is a page of up to a
 * hundred rows about named people's access changes, and nobody scanning it
 * needs the prior state of all hundred. Fetching it anyway would put a hundred
 * directory captures on the wire to answer "which row was it?".
 */
import { useState } from 'react';
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
import { CopyText } from '@/components/ui/copy-text';

/** One row of the index, as `toIndexEntry` writes it. */
interface JournalRow {
    journalId: string;
    linkId: string | null;
    provider: string;
    action: string;
    mode: string;
    outcome: string;
    attemptedAt: string;
    settledAt: string | null;
    actorUserId: string | null;
}

/** The by-id read: the index entry plus the answer. */
interface JournalDetail extends JournalRow {
    priorState?: Record<string, unknown>;
    detail?: string | null;
}

/**
 * How each outcome reads.
 *
 * `REVERTED` is `info` rather than `success`: a restore put the account back,
 * which is a fact to record rather than an outcome to celebrate — somebody had
 * to undo something. The two unsettled states are `warning`, because they are
 * the rows that need a human.
 */
const OUTCOME_VARIANT: Record<string, StatusBadgeVariant> = {
    APPLIED: 'success',
    FAILED: 'error',
    PENDING: 'warning',
    INDETERMINATE: 'warning',
    REVERTED: 'info',
};

export function JournalClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const { data, error, isLoading } = useTenantSWR<{ writes: JournalRow[] }>(
        '/admin/identity-write-journal',
    );
    // The index must NEVER gate on this call. A backlog endpoint returning 500
    // must not blank a page whose own history loaded fine — the section simply
    // does not render, which is what the sibling page does with its ladder
    // summary and for the same reason.
    const { data: unsettled } = useTenantSWR<{ writes: JournalRow[]; minutes: number }>(
        '/admin/identity-write-journal/unsettled',
    );
    const { data: detail } = useTenantSWR<{ write: JournalDetail }>(
        selectedId ? `/admin/identity-write-journal/${selectedId}` : null,
    );

    const rows = data?.writes ?? [];
    const backlog = unsettled?.writes ?? [];

    const columns = createColumns<JournalRow>([
        {
            accessorKey: 'provider',
            header: t('integrations.colProvider'),
            cell: ({ getValue }) => <StatusBadge variant="info">{String(getValue())}</StatusBadge>,
        },
        { accessorKey: 'action', header: t('identityWriteJournal.colAction') },
        {
            id: 'outcome',
            accessorKey: 'outcome',
            header: t('integrations.colStatus'),
            cell: ({ row }) => (
                <StatusBadge variant={OUTCOME_VARIANT[row.original.outcome] ?? 'neutral'}>
                    {row.original.outcome}
                </StatusBadge>
            ),
        },
        {
            accessorKey: 'attemptedAt',
            header: t('identityWriteJournal.colAttempted'),
            cell: ({ row }) => (
                <span className="text-content-muted tabular-nums">
                    {formatDateTime(row.original.attemptedAt)}
                </span>
            ),
        },
        {
            id: 'actor',
            accessorKey: 'actorUserId',
            header: t('identityWriteJournal.colActor'),
            // Null means a SCHEDULED run with no human behind it, which the
            // schema states in as many words. Rendering it as "—" would make a
            // pass indistinguishable from a person we failed to record.
            cell: ({ row }) => (
                <span className="text-sm text-content-muted">
                    {row.original.actorUserId ?? t('identityWriteJournal.actorScheduled')}
                </span>
            ),
        },
    ]);

    return (
        <div className="space-y-comfortable">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('integrations.title'), href: tenantHref('/admin/integrations') },
                    { label: t('identityWriteJournal.breadcrumb') },
                ]}
            />
            <Heading level={1}>{t('identityWriteJournal.title')}</Heading>
            <p className="text-sm text-content-muted">{t('identityWriteJournal.intro')}</p>

            {backlog.length > 0 && (
                <Card>
                    <Heading level={2}>{t('identityWriteJournal.unsettledTitle')}</Heading>
                    <InlineNotice variant="warning">
                        {t('identityWriteJournal.unsettledNotice', { count: backlog.length })}
                    </InlineNotice>
                    <DataTable
                        data={backlog}
                        columns={columns}
                        getRowId={(r) => r.journalId}
                        selectionEnabled={false}
                        onRowClick={(row) => setSelectedId(row.original.journalId)}
                        emptyState={t('identityWriteJournal.unsettledEmpty')}
                    />
                </Card>
            )}

            <Card>
                <Heading level={2}>{t('identityWriteJournal.historyTitle')}</Heading>
                {error ? (
                    <InlineNotice variant="error">{t('identityWriteJournal.loadFailed')}</InlineNotice>
                ) : (
                    <DataTable
                        data={rows}
                        columns={columns}
                        getRowId={(r) => r.journalId}
                        selectionEnabled={false}
                        onRowClick={(row) => setSelectedId(row.original.journalId)}
                        emptyState={
                            isLoading
                                ? t('identityWriteJournal.loading')
                                : t('identityWriteJournal.empty')
                        }
                    />
                )}
            </Card>

            {selectedId && (
                <Card>
                    <Heading level={2}>{t('identityWriteJournal.capturedTitle')}</Heading>
                    {/*
                      * The REFERENCE, copyable, because this is the string the
                      * DISABLED mail told an operator to quote — matching it
                      * against what is on screen is the whole errand that
                      * brought them here.
                      */}
                    <CopyText value={selectedId} />
                    {detail?.write ? (
                        <>
                            {detail.write.detail && (
                                <p className="text-sm text-content-muted">{detail.write.detail}</p>
                            )}
                            {/*
                              * Rendered as JSON on purpose. The capture is
                              * PROVIDER-SHAPED and opaque here — for Active
                              * Directory a whole `userAccountControl` integer,
                              * for Entra an `accountEnabled` with the groups
                              * touched. The usecase refuses to freeze a schema
                              * for it, and a page that pretended to know the
                              * fields would date exactly as badly.
                              */}
                            <pre className="overflow-x-auto rounded bg-surface-subtle p-tight text-xs">
                                {JSON.stringify(detail.write.priorState ?? {}, null, 2)}
                            </pre>
                        </>
                    ) : (
                        <p className="text-sm text-content-muted">
                            {t('identityWriteJournal.loading')}
                        </p>
                    )}
                </Card>
            )}
        </div>
    );
}
