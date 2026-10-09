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
 * @module app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/reconciliation
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
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
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState<WireRow | null>(null);
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

    // ── Resolve the run, then the queue ─────────────────────────────────────
    const load = useCallback(async () => {
        if (!connectionId) return;
        setLoading(true);
        try {
            const execRes = await fetch(apiUrl(`/admin/integrations/${connectionId}/executions`));
            const execs: WireExecution[] = execRes.ok
                ? ((await execRes.json()).executions ?? [])
                : [];
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
            setRows(res.ok ? ((await res.json()).rows ?? []) : []);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, connectionId]);

    useEffect(() => {
        void load();
    }, [load]);

    // ── Deciding ────────────────────────────────────────────────────────────
    const decide = useCallback(
        async (accountKey: string, action: Record<string, unknown>) => {
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
                const body = await res.json().catch(() => null);
                setNotice({
                    ok: false,
                    text: t('decideFailed', { reason: body?.error ?? String(res.status) }),
                });
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
                setNotice({
                    ok: false,
                    text: t('decideFailed', { reason: body?.error ?? String(res.status) }),
                });
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
                                <span className="font-mono">{row.original.candidates[0].employeeId}</span>
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
                                        date: row.original.expiredAt?.slice(0, 10) ?? '',
                                    })}
                                </StatusBadge>
                            ) : (
                                <span className="text-content-muted">{t('reasonUNDECIDED')}</span>
                            ),
                    },
                    {
                        id: 'actions',
                        header: '',
                        // The decisions live on the ROW, and the Sheet is
                        // evidence only. Two reasons, and the second is the
                        // stronger one:
                        //
                        //   - a reviewer clearing a queue of forty service
                        //     accounts should not have to open a drawer forty
                        //     times to say "not a person";
                        //   - the repo-wide `primary` button count is a DOWNWARD
                        //     ratchet at 175, and `modal-action-order` requires a
                        //     Sheet action block to END with a primary or
                        //     destructive button. Satisfying both would mean
                        //     demoting some other feature's primary to make room,
                        //     which is not this PR's call to make.
                        cell: ({ row }) => (
                            <div className="flex items-center gap-tight">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setOpen(row.original)}
                                >
                                    {t('review')}
                                </Button>
                                {row.original.candidates.length > 0 ? (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() =>
                                            decide(row.original.accountKey, {
                                                kind: 'CONFIRM',
                                                employeeId: row.original.candidates[0].employeeId,
                                            })
                                        }
                                    >
                                        {t('actConfirm')}
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        decide(row.original.accountKey, { kind: 'DEFER' })
                                    }
                                >
                                    {t('actDefer')}
                                </Button>
                            </div>
                        ),
                    },
                ])
            ),
        [decide, orderColumns, t]
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumbIntegrations'), href: tenantHref('/admin/integrations') },
                        {
                            label: t('crumbConnection'),
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
                    {t('subtitle', { count: rows.length })}
                </p>
            </ListPageShell.Header>

            <ListPageShell.Filters>
                <div className="flex items-center gap-tight">{columnsDropdown}</div>
            </ListPageShell.Filters>

            <ListPageShell.Body>
                {notice ? (
                    <InlineNotice variant={notice.ok ? 'success' : 'error'}>{notice.text}</InlineNotice>
                ) : null}
                <DataTable
                    fillBody
                    data-testid="legacy-reconciliation-queue"
                    data={rows}
                    columns={columns}
                    getRowId={(r) => r.accountKey}
                    loading={loading}
                    emptyState={t('empty')}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    batchActions={[
                        {
                            label: t('actConfirm'),
                            onClick: (picked) => void bulkConfirm(picked.map((r) => r.original)),
                        },
                    ]}
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
                                        <span className="font-mono text-xs">{c.employeeId}</span>
                                        <span className="text-xs">{c.score}</span>
                                    </div>
                                    <ul className="text-xs">
                                        {c.signals.map((s, i) => (
                                            <li key={`${s.kind}-${i}`}>
                                                {s.kind} · {s.score} · {s.evidence ?? ''}
                                            </li>
                                        ))}
                                    </ul>
                                    {/* The vetoes, always. A vetoed candidate is the
                                        case most likely to look right and be wrong. */}
                                    <p className="mt-1 text-xs text-content-muted">
                                        {c.vetoes.length === 0
                                            ? t('sheetNoVetoes')
                                            : `${t('sheetVetoes')}: ${c.vetoes
                                                .map((v) => `${v.kind}${v.detail ? ` (${v.detail})` : ''}`)
                                                .join(', ')}`}
                                    </p>
                                </div>
                            ))}
                        </Sheet.Body>
                    </>
                ) : null}
            </Sheet>
        </ListPageShell>
    );
}
