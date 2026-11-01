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
 * ═══ IN WORDS, AND BY REFERENCE (#4877) ═══
 *
 * Each entry names whose account it is (the routes' `accounts`, by `linkId`)
 * and who made it (`actors`), and every stored code is worded. A reference from
 * a disable notification opens its entry: pasted into the field, or as
 * `?ref=<id>` from the leaver passes. The captured state is shown as the
 * directory's own fields, because whoever reads it is about to re-apply them by
 * hand. A failed read of the backlog says so rather than looking like none.
 *
 * ═══ THE CAPTURED STATE IS FETCHED ONE ROW AT A TIME ═══
 *
 * Deliberately, and the usecase says why: the index is a page of up to a
 * hundred rows about named people's access changes, and nobody scanning it
 * needs the prior state of all hundred. Fetching it anyway would put a hundred
 * directory captures on the wire to answer "which row was it?".
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { formatDateTime } from '@inflect/ui/lib/format-date';
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
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

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

/** Declared here rather than imported: a client page may not import a usecase. */
interface Person {
    name: string | null;
    email: string | null;
}
interface People {
    accounts?: Record<string, Person>;
    actors?: Record<string, Person>;
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

const OUTCOMES = ['APPLIED', 'FAILED', 'PENDING', 'INDETERMINATE', 'REVERTED'] as const;
const ACTIONS = [
    'DISABLE_ACCOUNT',
    'ENABLE_ACCOUNT',
    'CREATE_ACCOUNT',
    'ASSIGN_GROUP',
    'REMOVE_GROUP',
    'ISSUE_CREDENTIAL',
] as const;
const PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'] as const;

function known<T extends string>(list: readonly T[], value: string): value is T {
    return (list as readonly string[]).includes(value);
}

const personText = (p: Person) => (p.name && p.email ? `${p.name} · ${p.email}` : (p.name ?? p.email ?? ''));

export function JournalClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    // A reference handed over in the address (the leaver passes link with
    // `?ref=`) opens its entry at once.
    const [selectedId, setSelectedId] = useState<string | null>(() => searchParams?.get('ref')?.trim() || null);
    const [reference, setReference] = useState(() => searchParams?.get('ref')?.trim() ?? '');

    const { data, error, isLoading } = useTenantSWR<{ writes: JournalRow[] } & People>(
        '/admin/identity-write-journal',
    );
    // The index must NEVER gate on this call. A backlog endpoint returning 500
    // must not blank a page whose own history loaded fine — but it must say
    // so (#4877): an empty backlog and an unread one are different answers.
    const { data: unsettled, error: unsettledError } = useTenantSWR<
        { writes: JournalRow[]; minutes: number } & People
    >('/admin/identity-write-journal/unsettled');
    const { data: detail, error: detailError } = useTenantSWR<{ write: JournalDetail } & People>(
        selectedId ? `/admin/identity-write-journal/${encodeURIComponent(selectedId)}` : null,
    );

    const rows = data?.writes ?? [];
    const backlog = unsettled?.writes ?? [];

    // Every read carries the names of the entries it returned; one map serves
    // all three, so a row reads the same in the backlog, the history and the
    // opened entry.
    const accounts = useMemo(
        () => ({ ...unsettled?.accounts, ...data?.accounts, ...detail?.accounts }),
        [data?.accounts, unsettled?.accounts, detail?.accounts],
    );
    const actors = useMemo(
        () => ({ ...unsettled?.actors, ...data?.actors, ...detail?.actors }),
        [data?.actors, unsettled?.actors, detail?.actors],
    );

    const accountLabel = useCallback(
        (linkId: string | null) => {
            if (!linkId) return t('identityWriteJournal.accountUnlinked');
            const p = accounts[linkId];
            return p && (p.name || p.email) ? personText(p) : t('identityWriteJournal.accountGone');
        },
        [accounts, t],
    );
    // Null means a SCHEDULED run with no human behind it, which the schema
    // states in as many words. Rendering it as "—" would make a pass
    // indistinguishable from a person we failed to record.
    const actorLabel = useCallback(
        (userId: string | null) => {
            if (!userId) return t('identityWriteJournal.actorScheduled');
            const p = actors[userId];
            return p && (p.name || p.email) ? personText(p) : t('identityWriteJournal.actorFormer');
        },
        [actors, t],
    );
    const actionLabel = useCallback(
        (a: string) => (known(ACTIONS, a) ? t(`identityWriteJournal.action.${a}`) : a),
        [t],
    );
    const outcomeLabel = useCallback(
        (o: string) => (known(OUTCOMES, o) ? t(`identityWriteJournal.outcome.${o}`) : o),
        [t],
    );
    const providerLabel = useCallback(
        (p: string) => (known(PROVIDERS, p) ? t(`identityAccounts.providerLabels.${p}`) : p),
        [t],
    );

    // MEMOISED, and both tables share the one definition. The columns close
    // over `t`, so rebuilding them on every render hands DataTable a new
    // array identity each time and defeats its own memoisation — the reason
    // `data-table` pins this pattern across every migrated page.
    const columns = useMemo(
        () =>
            createColumns<JournalRow>([
                {
                    id: 'account',
                    accessorKey: 'linkId',
                    header: t('identityWriteJournal.colAccount'),
                    cell: ({ row }) => <span className="text-sm">{accountLabel(row.original.linkId)}</span>,
                },
                {
                    accessorKey: 'provider',
                    header: t('integrations.colProvider'),
                    cell: ({ row }) => <StatusBadge variant="info">{providerLabel(row.original.provider)}</StatusBadge>,
                },
                {
                    accessorKey: 'action',
                    header: t('identityWriteJournal.colAction'),
                    cell: ({ row }) => actionLabel(row.original.action),
                },
                {
                    id: 'outcome',
                    accessorKey: 'outcome',
                    header: t('integrations.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={OUTCOME_VARIANT[row.original.outcome] ?? 'neutral'}>
                            {outcomeLabel(row.original.outcome)}
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
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{actorLabel(row.original.actorUserId)}</span>
                    ),
                },
            ]),
        [accountLabel, actionLabel, actorLabel, outcomeLabel, providerLabel, t],
    );

    const openReference = () => {
        const ref = reference.trim();
        if (ref) setSelectedId(ref);
    };

    const opened = detail?.write ?? null;
    const notFound = (detailError as { status?: number } | undefined)?.status === 404;

    return (
        <div className="space-y-comfortable">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.integrations'), href: tenantHref('/admin/integrations') },
                    { label: t('identityWriteJournal.breadcrumb') },
                ]}
            />
            <Heading level={1}>{t('identityWriteJournal.title')}</Heading>
            <p className="text-sm text-content-muted">{t('identityWriteJournal.intro')}</p>

            {/* The reference a disable notification quotes resolves here
                (#4877): paste it rather than find the row by eye. */}
            <Card className="space-y-default">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        openReference();
                    }}
                >
                    <FormField label={t('identityWriteJournal.findLabel')} hint={t('identityWriteJournal.findHint')}>
                        <div className="flex gap-compact">
                            <Input
                                id="identity-write-journal-reference"
                                className="font-mono"
                                value={reference}
                                onChange={(e) => setReference(e.target.value)}
                            />
                            <Button
                                type="submit"
                                variant="secondary"
                                id="identity-write-journal-open"
                                disabled={!reference.trim()}
                            >
                                {t('identityWriteJournal.findOpen')}
                            </Button>
                        </div>
                    </FormField>
                </form>
            </Card>

            {unsettledError ? (
                <InlineNotice variant="error" id="identity-write-journal-unsettled-error">
                    {t('identityWriteJournal.unsettledLoadFailed')}
                </InlineNotice>
            ) : (
                backlog.length > 0 && (
                    <Card>
                        <Heading level={2}>{t('identityWriteJournal.unsettledTitle')}</Heading>
                        <InlineNotice variant="warning">
                            {t('identityWriteJournal.unsettledNotice', { count: backlog.length })}
                        </InlineNotice>
                        <DataTable
                            data-testid="identity-write-journal-unsettled-table"
                            data={backlog}
                            columns={columns}
                            getRowId={(r) => r.journalId}
                            selectionEnabled={false}
                            onRowClick={(row) => setSelectedId(row.original.journalId)}
                            emptyState={t('identityWriteJournal.unsettledEmpty')}
                        />
                    </Card>
                )
            )}

            {selectedId && (
                <Card className="space-y-default" id="identity-write-journal-entry">
                    <Heading level={2}>{t('identityWriteJournal.capturedTitle')}</Heading>
                    {/*
                      * The REFERENCE, copyable, because this is the string the
                      * DISABLED mail told an operator to quote — matching it
                      * against what is on screen is the whole errand that
                      * brought them here.
                      */}
                    <CopyText value={selectedId} />
                    {detailError ? (
                        <InlineNotice variant="error" id="identity-write-journal-entry-error">
                            {notFound
                                ? t('identityWriteJournal.referenceNotFound', { ref: selectedId.slice(0, 64) })
                                : t('identityWriteJournal.entryLoadFailed')}
                        </InlineNotice>
                    ) : opened ? (
                        <>
                            <dl className="grid grid-cols-1 gap-x-default gap-y-tight text-sm sm:grid-cols-[max-content_1fr]">
                                <dt className="text-content-muted">{t('identityWriteJournal.colAccount')}</dt>
                                <dd>{accountLabel(opened.linkId)}</dd>
                                <dt className="text-content-muted">{t('identityWriteJournal.colAction')}</dt>
                                <dd>
                                    {actionLabel(opened.action)} · {providerLabel(opened.provider)}
                                </dd>
                                <dt className="text-content-muted">{t('integrations.colStatus')}</dt>
                                <dd>
                                    <StatusBadge variant={OUTCOME_VARIANT[opened.outcome] ?? 'neutral'}>
                                        {outcomeLabel(opened.outcome)}
                                    </StatusBadge>
                                </dd>
                                <dt className="text-content-muted">{t('identityWriteJournal.colAttempted')}</dt>
                                <dd className="tabular-nums">{formatDateTime(opened.attemptedAt)}</dd>
                                <dt className="text-content-muted">{t('identityWriteJournal.colActor')}</dt>
                                <dd>{actorLabel(opened.actorUserId)}</dd>
                            </dl>
                            {opened.detail && <p className="text-sm text-content-muted">{opened.detail}</p>}
                            {/*
                              * The capture is PROVIDER-SHAPED — for Active
                              * Directory a whole `userAccountControl` integer,
                              * for Entra an `accountEnabled` with the groups
                              * touched — and the usecase refuses to freeze a
                              * schema for it. So each field is shown under the
                              * directory's own name, which is the name somebody
                              * re-applying it by hand will look for, and the
                              * whole capture can still be copied as it was
                              * stored (#4877).
                              */}
                            <PriorState
                                state={opened.priorState ?? {}}
                                title={t('identityWriteJournal.priorStateTitle')}
                                hint={t('identityWriteJournal.priorStateHint')}
                                yes={t('identityWriteJournal.valueYes')}
                                no={t('identityWriteJournal.valueNo')}
                                empty={t('identityWriteJournal.valueEmpty')}
                                copyLabel={t('identityWriteJournal.priorStateCopy')}
                            />
                        </>
                    ) : (
                        <p className="text-sm text-content-muted">{t('identityWriteJournal.loading')}</p>
                    )}
                </Card>
            )}

            <Card>
                <Heading level={2}>{t('identityWriteJournal.historyTitle')}</Heading>
                {error ? (
                    <InlineNotice variant="error">{t('identityWriteJournal.loadFailed')}</InlineNotice>
                ) : (
                    <DataTable
                        data-testid="identity-write-journal-history-table"
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
        </div>
    );
}

/** A value from the capture, as text: booleans in words, structures as compact JSON. */
function formatValue(value: unknown, words: { yes: string; no: string; empty: string }): string {
    if (value === true) return words.yes;
    if (value === false) return words.no;
    if (value === null || value === undefined || value === '') return words.empty;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value) && value.length === 0) return words.empty;
    return JSON.stringify(value);
}

function PriorState({
    state,
    title,
    hint,
    yes,
    no,
    empty,
    copyLabel,
}: {
    state: Record<string, unknown>;
    title: string;
    hint: string;
    yes: string;
    no: string;
    empty: string;
    copyLabel: string;
}) {
    const entries = Object.entries(state);
    return (
        <section className="space-y-tight" id="identity-write-journal-prior-state">
            <Heading level={3}>{title}</Heading>
            <p className="text-xs text-content-muted">{hint}</p>
            <dl className="grid grid-cols-1 gap-x-default gap-y-tight text-sm sm:grid-cols-[max-content_1fr]">
                {entries.map(([key, value]) => (
                    <div key={key} className="contents">
                        <dt className="font-mono text-xs text-content-muted">{key}</dt>
                        <dd className="break-all">{formatValue(value, { yes, no, empty })}</dd>
                    </div>
                ))}
            </dl>
            <CopyText value={JSON.stringify(state, null, 2)} label={copyLabel} truncate className="font-mono text-xs" />
        </section>
    );
}
