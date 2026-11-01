'use client';

/**
 * Step 4b: the reconciliation review queue for one legacy connection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PAGE PICKS THE RUN, THE REVIEWER DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The queue is always "one run, on one connection" — the API requires both,
 * because an executionId alone cannot say which connection's aliases suppress a
 * row. This page resolves the run itself: the latest PASSED execution whose
 * `automationKey` is `legacy-mcp.reconcile`.
 *
 * LATEST, and PASSED, and that key. Each term does work:
 *
 *   - a FAILED or PARTIAL run refused before resolving anything, so its queue
 *     is empty and showing it would read as "nothing to do";
 *   - the key matters because a connection also has pull and profile
 *     executions, and the newest execution on the connection is frequently one
 *     of those;
 *   - latest, because a decision carries the run it was made against and the
 *     server returns 409 against a superseded one. Letting a reviewer work an
 *     older run would produce a queue every action on which is refused.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EVIDENCE IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A reviewer cannot sanely confirm that an account belongs to a person without
 * seeing WHY the engine thought so, signal by signal. So the Sheet lists each
 * candidate with its score and every signal's own evidence string, plus the
 * vetoes — a vetoed candidate is the case most likely to look right and be
 * wrong, and hiding the veto would hide exactly that.
 *
 * `reason` is shown as a column rather than folded into the outcome, because
 * "nobody has decided this" and "somebody decided it and the answer expired"
 * need different questions asked of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IN WORDS, AND ALL SIX DECISIONS (#4871)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Candidates are named by the person HR holds (the queue route's `people`),
 * never by their employee id; each signal and veto is named in words; a
 * failed read says so rather than "nothing to decide". The Sheet carries the
 * four decisions the row cannot (someone else, service account, external
 * person, nobody can say) beside Confirm, for a viewer who may decide. A row
 * Confirm is sent after an undo window, because the next match treats it as
 * certain.
 *
 * @module app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/reconciliation
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { formatDate } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useToastWithUndo } from '@/components/ui/hooks';
import { DecisionForm, type DecisionAction } from './DecisionForm';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { FilterProvider, createFilterDefs, useFilterContext } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { AppIcon } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Sheet } from '@/components/ui/sheet';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';

const RECONCILE_KEY = 'legacy-mcp.reconcile';

interface WireSignal {
    kind: string;
    score: number;
    evidence?: string | null;
}

interface WireVeto {
    kind: string;
    detail?: string | null;
}

interface WireCandidate {
    employeeId: string;
    score: number;
    signals: WireSignal[];
    vetoes: WireVeto[];
}

interface WireRow {
    accountKey: string;
    outcome: 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED';
    candidates: WireCandidate[];
    reason: 'UNDECIDED' | 'EXTERNAL_EXPIRED';
    expiredAt: string | null;
}

interface WirePerson {
    name: string;
    email: string | null;
}

/** Signal and veto kinds this page words. Others render as themselves. */
const SIGNAL_KINDS = [
    'CONFIRMED_ALIAS', 'EMPLOYEE_NUMBER', 'EMAIL_EXACT', 'DIRECTORY_BRIDGE', 'EMAIL_UNTAGGED',
    'STALE_DIRECTORY_LINK', 'NAME_EXACT', 'NAME_TRANSLIT', 'NAME_INITIAL', 'USERNAME_CONVENTION',
    'SIMILARITY', 'DEPARTMENT_MATCH',
] as const;
const VETO_KINDS = ['EMPLOYEE_NUMBER_CONFLICT', 'EMAIL_DOMAIN_CONFLICT', 'ACCOUNT_POSTDATES_END_DATE'] as const;

function known<T extends string>(list: readonly T[], value: string): value is T {
    return (list as readonly string[]).includes(value);
}

interface WireExecution {
    id: string;
    automationKey: string;
    status: string;
    executedAt: string;
}

/**
 * Loose record with a neutral fallback at the call site, following the
 * convention the connection page states: an outcome missing here renders
 * neutral rather than failing to compile.
 */
const OUTCOME_TONE: Record<string, 'warning' | 'error' | 'neutral'> = {
    SUGGESTED: 'warning',
    // `error`, not `danger`: StatusBadge's set is warning|neutral|info|
    // success|error. AMBIGUOUS is the engine refusing to choose between
    // equal candidates, which is the row a reviewer must not skim past.
    AMBIGUOUS: 'error',
    UNMATCHED: 'neutral',
};

export default function ReconciliationQueuePage() {
    const t = useTranslations('admin.integrations.legacyQueue');
    const tenantHref = useTenantHref();
    const apiUrl = useTenantApiUrl();
    const params = useParams<{ connectionId: string }>();
    const connectionId = params?.connectionId ?? '';

    const [executionId, setExecutionId] = useState<string | null>(null);
    const [rows, setRows] = useState<WireRow[]>([]);
    const [people, setPeople] = useState<Record<string, WirePerson>>({});
    const [loading, setLoading] = useState(true);
    // A failed read is NOT "nothing to decide" (#4871): that sentence is a
    // claim about the run, and a refused or failed read supports no claim.
    const [loadError, setLoadError] = useState(false);
    const [connectionName, setConnectionName] = useState<string | null>(null);
    const { appPermissions } = useTenantContext();
    const canDecide = appPermissions?.identity_reconciliation?.confirm === true;
    const triggerUndoToast = useToastWithUndo();

    /** A candidate as a person: name, then work email; never the id. */
    const personLabel = useCallback(
        (employeeId: string) => {
            const p = people[employeeId];
            if (!p) return t('unknownPerson');
            return p.email ? `${p.name} · ${p.email}` : p.name;
        },
        [people, t],
    );
    const [open, setOpen] = useState<WireRow | null>(null);
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

    // ── THE TWO FACETS THIS QUEUE ALWAYS WANTED (#3358) ─────────────────────
    //
    // `filter-toolbar-coverage` exempted this page on the grounds that it could
    // not have them: `FilterDefInput.icon` demanded a `LucideIcon` and
    // `no-lucide` forbids a new lucide import site, so the documented filter
    // API was unreachable from new code. #4109 widened that field to
    // `FilterIcon`, which already admitted a `ReactNode` — so the icons below
    // are `<AppIcon>` elements, and this page is the first production caller of
    // the builder the GUIDE documents. The exemption is deleted in this diff
    // rather than re-justified, which is what its own last line asked for.
    //
    // Both facets are closed unions on `WireRow`, so the option lists cannot
    // drift from the data: a new `outcome` or `reason` member is a type error
    // at `OUTCOME_OPTIONS` / `REASON_OPTIONS` before it is a missing chip.
    const { filters: queueFilters, filterKeys } = useMemo(
        () =>
            createFilterDefs({
                outcome: {
                    label: t('colOutcome'),
                    icon: <AppIcon name="circleDashed" />,
                    options: (['SUGGESTED', 'AMBIGUOUS', 'UNMATCHED'] satisfies Array<WireRow['outcome']>).map(
                        (value) => ({ value, label: t(`outcome${value}`) }),
                    ),
                    multiple: true,
                },
                reason: {
                    label: t('colReason'),
                    icon: <AppIcon name="alertCircle" />,
                    options: [
                        { value: 'UNDECIDED', label: t('reasonUNDECIDED') },
                        // The column label interpolates a date; a chip has no
                        // row to take one from, so it gets its own label.
                        { value: 'EXTERNAL_EXPIRED', label: t('filterReasonEXTERNAL_EXPIRED') },
                    ] satisfies Array<{ value: WireRow['reason']; label: string }>,
                    multiple: true,
                },
            }),
        [t],
    );
    const filterCtx = useFilterContext([], filterKeys);
    // guardrail-ignore: faceting the rows this page already loaded in full — the queue is one run's undecided accounts with no server-side filter params, and both facets are closed unions on the loaded row.
    const visibleRows = useMemo(() => {
        const wanted = (key: string) => filterCtx.state[key] ?? [];
        const outcomes = wanted('outcome');
        const reasons = wanted('reason');
        // The search, over the rows this page holds: the account and its
        // candidates' names (#4871 — the placeholder existed, the search did not).
        const q = filterCtx.search.trim().toLowerCase();
        return rows.filter(
            (r) =>
                (outcomes.length === 0 || outcomes.includes(r.outcome)) &&
                (reasons.length === 0 || reasons.includes(r.reason)) &&
                (q === '' ||
                    r.accountKey.toLowerCase().includes(q) ||
                    r.candidates.some((c) => (people[c.employeeId]?.name ?? '').toLowerCase().includes(q))),
        );
    }, [rows, filterCtx.state, filterCtx.search, people]);

    // ── Resolve the run, then the queue ─────────────────────────────────────
    const load = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        setLoadError(false);
        try {
            const execRes = await fetch(apiUrl(`/admin/integrations/${connectionId}/executions`));
            if (!execRes.ok) {
                setLoadError(true);
                setRows([]);
                return;
            }
            const execBody = (await execRes.json()) as {
                executions?: WireExecution[];
                connection?: { name?: string } | null;
            };
            setConnectionName(execBody.connection?.name || null);
            const execs: WireExecution[] = execBody.executions ?? [];
            const run = execs
                .filter((e) => e.automationKey === RECONCILE_KEY && e.status === 'PASSED')
                .sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0];

            if (!run) {
                setExecutionId(null);
                setRows([]);
                return;
            }
            setExecutionId(run.id);

            const url = apiUrl(
                `/admin/legacy-access/queue?executionId=${encodeURIComponent(run.id)}`
                + `&connectionId=${encodeURIComponent(connectionId)}`
            );
            const res = await fetch(url);
            if (!res.ok) {
                setLoadError(true);
                setRows([]);
                return;
            }
            const body = await res.json();
            setRows(body.rows ?? []);
            setPeople(body.people ?? {});
        } catch {
            setLoadError(true);
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, connectionId]);

    useEffect(() => {
        void load();
    }, [load]);

    // ── Deciding ────────────────────────────────────────────────────────────
    const decide = useCallback(
        async (accountKey: string, action: DecisionAction | { kind: 'DEFER' }) => {
            if (!executionId) return;
            const res = await fetch(apiUrl('/admin/legacy-access/queue/decide'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId, accountKey, executionId, action }),
            });
            if (res.status === 409) {
                // Named, not generic. A superseded result has one remedy and the
                // reviewer needs to know it is re-opening the queue rather than
                // retrying the same click.
                setNotice({ ok: false, text: t('superseded') });
                return;
            }
            if (!res.ok) {
                // The server's sentence, never a bare status (#4871).
                const body = await res.json().catch(() => null);
                setNotice({ ok: false, text: apiErrorMessage(body, t('decideFailedGeneric')) });
                return;
            }
            setNotice({ ok: true, text: t('decided') });
            setOpen(null);
            await load();
        },
        [apiUrl, connectionId, executionId, load, t]
    );

    /**
     * Bulk confirm, through the house batch-action bar.
     *
     * Only rows that HAVE a candidate are sent. A selected row with none would
     * be refused by the server anyway, and including it would make the refused
     * count report a client mistake as a server judgement — which is the
     * opposite of what the per-row outcome list is for.
     */
    const bulkConfirm = useCallback(
        async (picked: readonly WireRow[]) => {
            if (!executionId) return;
            const payload = picked
                .filter((r) => r.candidates.length > 0)
                .map((r) => ({ accountKey: r.accountKey, employeeId: r.candidates[0].employeeId }));
            if (payload.length === 0) return;

            const res = await fetch(apiUrl('/admin/legacy-access/queue/bulk-confirm'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId, executionId, rows: payload }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setNotice({ ok: false, text: apiErrorMessage(body, t('decideFailedGeneric')) });
                return;
            }
            // The per-row counts, not "done". The server reports per row
            // precisely so a half-succeeding call can say which half.
            setNotice({
                ok: (body?.refused ?? 0) === 0,
                text: t('bulkDone', {
                    confirmed: body?.confirmed ?? 0,
                    refused: body?.refused ?? 0,
                }),
            });
            await load();
        },
        [apiUrl, connectionId, executionId, load, t]
    );

    /**
     * A row Confirm, sent when the undo window closes (#4871). The next match
     * treats a confirmed link as certain, so a mis-click must be catchable;
     * Undo inside the window means the POST never fires.
     */
    const confirmWithUndo = useCallback((row: WireRow) => {
        const top = row.candidates[0];
        if (!top) return;
        triggerUndoToast({
            message: t('confirmQueued', { person: personLabel(top.employeeId) }),
            undoMessage: t('undo'),
            action: async () => {
                await decide(row.accountKey, { kind: 'CONFIRM', employeeId: top.employeeId });
            },
        });
    }, [decide, personLabel, t, triggerUndoToast]);

    // ── Columns ─────────────────────────────────────────────────────────────
    const { columnVisibility, setColumnVisibility, orderColumns, dropdown: columnsDropdown } =
        useColumnsDropdown({
            storageKey: 'inflect:col-vis:legacy-reconciliation',
            columns: [
                { id: 'account', label: t('colAccount') },
                { id: 'outcome', label: t('colOutcome') },
                { id: 'candidate', label: t('colTopCandidate') },
                { id: 'score', label: t('colScore') },
                { id: 'reason', label: t('colReason') },
            ],
        });

    const columns = useMemo(
        () =>
            orderColumns(
                createColumns<WireRow>([
                    {
                        id: 'account',
                        header: t('colAccount'),
                        cell: ({ row }) => <span className="font-mono">{row.original.accountKey}</span>,
                    },
                    {
                        id: 'outcome',
                        header: t('colOutcome'),
                        cell: ({ row }) => (
                            <StatusBadge variant={OUTCOME_TONE[row.original.outcome] ?? 'neutral'}>
                                {t(`outcome${row.original.outcome}` as Parameters<typeof t>[0])}
                            </StatusBadge>
                        ),
                    },
                    {
                        id: 'candidate',
                        header: t('colTopCandidate'),
                        cell: ({ row }) =>
                            row.original.candidates.length === 0 ? (
                                <span className="text-content-muted">{t('noCandidates')}</span>
                            ) : (
                                <span>{personLabel(row.original.candidates[0].employeeId)}</span>
                            ),
                    },
                    {
                        id: 'score',
                        header: t('colScore'),
                        cell: ({ row }) =>
                            row.original.candidates.length === 0 ? null : <span>{row.original.candidates[0].score}</span>,
                    },
                    {
                        id: 'reason',
                        header: t('colReason'),
                        cell: ({ row }) =>
                            row.original.reason === 'EXTERNAL_EXPIRED' ? (
                                <StatusBadge variant="warning">
                                    {t('reasonEXTERNAL_EXPIRED', {
                                        date: row.original.expiredAt ? formatDate(row.original.expiredAt) : '',
                                    })}
                                </StatusBadge>
                            ) : (
                                <span className="text-content-muted">{t('reasonUNDECIDED')}</span>
                            ),
                    },
                    {
                        id: 'actions',
                        header: '',
                        // The two one-click decisions live on the ROW: Confirm
                        // the top candidate, and Defer. The four that need an
                        // answer (someone else, a service account, an external
                        // person, nobody can say) live in the Sheet's decision
                        // form, beside the evidence they are judged on (#4871).
                        // That form records with a SECONDARY button in the
                        // Sheet body rather than a footer action block: the
                        // repo-wide `primary` count is a downward ratchet, and
                        // `modal-action-order` would require a footer block to
                        // end with a primary.
                        cell: ({ row }) => (
                            <div className="flex items-center gap-tight">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setOpen(row.original)}
                                >
                                    {t('review')}
                                </Button>
                                {canDecide && row.original.candidates.length > 0 ? (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => confirmWithUndo(row.original)}
                                    >
                                        {t('actConfirm')}
                                    </Button>
                                ) : null}
                                {canDecide && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            decide(row.original.accountKey, { kind: 'DEFER' })
                                        }
                                    >
                                        {t('actDefer')}
                                    </Button>
                                )}
                            </div>
                        ),
                    },
                ])
            ),
        [canDecide, confirmWithUndo, decide, orderColumns, personLabel, t]
    );

    return (
        <FilterProvider value={filterCtx}>
        <ListPageShell>
            <ListPageShell.Header>
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumbAdmin'), href: tenantHref('/admin') },
                        { label: t('crumbIntegrations'), href: tenantHref('/admin/integrations') },
                        {
                            label: connectionName ?? t('crumbConnection'),
                            href: tenantHref(`/admin/integrations/${connectionId}`),
                        },
                        { label: t('title') },
                    ]}
                    className="mb-1"
                />
                {/* sr-only, matching the canonical list pages. The visible page
                    title IS the breadcrumb trail; a second visible H1 directly
                    under it repeats the same words. The heading stays for the
                    accessibility tree and the skip-link target. */}
                <Heading level={1} id="legacy-queue-title" className="sr-only">
                    {t('title')}
                </Heading>
                <p className="text-sm text-content-muted">
                    {t('subtitle', { count: visibleRows.length })}
                </p>
            </ListPageShell.Header>

            <ListPageShell.Filters>
                <FilterToolbar
                    filters={queueFilters}
                    actions={columnsDropdown}
                    searchId="legacy-queue-search"
                    searchPlaceholder={t('searchPlaceholder')}
                />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                {notice ? (
                    <InlineNotice variant={notice.ok ? 'success' : 'error'}>{notice.text}</InlineNotice>
                ) : null}
                <DataTable
                    fillBody
                    data-testid="legacy-reconciliation-queue"
                    data={visibleRows}
                    columns={columns}
                    getRowId={(r) => r.accountKey}
                    loading={loading}
                    // A failed read empties the table, so its empty state is
                    // where the page says so — never "nothing to decide".
                    emptyState={loadError ? t('loadError') : executionId ? t('empty') : t('noRun')}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    // Bulk confirm is a decision too: offered only to a viewer
                    // the decide routes accept (#4871).
                    batchActions={
                        canDecide
                            ? [
                                  {
                                      label: t('actConfirm'),
                                      onClick: (picked) => void bulkConfirm(picked.map((r) => r.original)),
                                  },
                              ]
                            : undefined
                    }
                />
            </ListPageShell.Body>

            <Sheet open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
                {open ? (
                    <>
                        <Sheet.Header>
                            <Sheet.Title>{t('sheetTitle', { accountKey: open.accountKey })}</Sheet.Title>
                            <Sheet.Description>{t('sheetEvidence')}</Sheet.Description>
                        </Sheet.Header>
                        <Sheet.Body>
                            {open.candidates.map((c) => (
                                <div key={c.employeeId} className="mb-4 border-b pb-3">
                                    <div className="mb-1 flex items-center justify-between">
                                        <span className="text-sm font-medium text-content-emphasis">{personLabel(c.employeeId)}</span>
                                        <span className="text-xs">{c.score}</span>
                                    </div>
                                    <ul className="text-xs">
                                        {c.signals.map((s, i) => (
                                            <li key={`${s.kind}-${i}`}>
                                                {known(SIGNAL_KINDS, s.kind) ? t(`signalKind.${s.kind}`) : s.kind} · {s.score}
                                                {s.evidence ? ` · ${s.evidence}` : ''}
                                            </li>
                                        ))}
                                    </ul>
                                    {/* The vetoes, always. A vetoed candidate is the
                                        case most likely to look right and be wrong. */}
                                    <p className="mt-1 text-xs text-content-muted">
                                        {c.vetoes.length === 0
                                            ? t('sheetNoVetoes')
                                            : `${t('sheetVetoes')}: ${c.vetoes
                                                .map((v) => {
                                                    const label = known(VETO_KINDS, v.kind) ? t(`vetoKind.${v.kind}`) : v.kind;
                                                    return `${label}${v.detail ? ` (${v.detail})` : ''}`;
                                                })
                                                .join(', ')}`}
                                    </p>
                                </div>
                            ))}
                            {canDecide && (
                                <DecisionForm
                                    candidates={open.candidates.map((c) => ({
                                        employeeId: c.employeeId,
                                        label: personLabel(c.employeeId),
                                    }))}
                                    onDecide={async (action: DecisionAction) => {
                                        await decide(open.accountKey, action);
                                    }}
                                />
                            )}
                        </Sheet.Body>
                    </>
                ) : null}
            </Sheet>
        </ListPageShell>
        </FilterProvider>
    );
}
