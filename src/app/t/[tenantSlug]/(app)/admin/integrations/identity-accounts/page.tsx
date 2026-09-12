'use client';

/**
 * P1 — synced-identity roster. Gives ConnectedIdentityAccount a browse surface
 * (like Personnel / Devices) so an Okta / Google Workspace directory sync
 * produces something visible, and a CONNECTED_APP access review can be
 * pre-checked instead of throwing "zero subjects" on empty.
 *
 * THE SEARCH ON THIS PAGE IS SERVER-SIDE, and that is the point (#2418). The
 * roster is capped at IDENTITY_ROSTER_PAGE_SIZE with no cursor, so a filter
 * applied to the rows already delivered could only ever hide some of them —
 * it could not reach the ones the cap cut off. The toolbar's search term and
 * provider facet are therefore query parameters on the roster GET, and every
 * change refetches. That is what makes any account reachable by naming it,
 * which is what this page has to be able to promise: it is where an operator
 * decides which accounts must never be offboarded automatically.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { useToastWithUndo } from '@/components/ui/hooks';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { buildIdentityAccountFilters, IDENTITY_ACCOUNT_FILTER_KEYS } from './filter-defs';
import { IDENTITY_ROSTER_PAGE_SIZE } from '@/lib/identity-roster';

interface AccountRow {
    id: string;
    provider: string;
    /**
     * WHICH directory connection observed this account.
     *
     * Not decoration. Two connections for one provider is a supported
     * configuration, and the account key is
     * (tenantId, connectionId, externalUserId) — so one human can hold two
     * rows here that agree on provider, email and display name and disagree
     * on `isProtected`, because protection is per row. Without this the two
     * render identically and "protect this account" is a click an operator
     * cannot verify.
     */
    connectionId: string;
    /** The operator-legible half of `connectionId`, which is a cuid. */
    connectionName: string | null;
    email: string | null;
    displayName: string | null;
    status: string;
    isAdmin: boolean;
    mfaEnrolled: boolean;
    lastActiveAt: string | null;
    syncedAt: string | null;
    isProtected: boolean;
    protectionReason: string | null;
    /** Live, from the link relation — authoritative. */
    linked: boolean;
    /** From the LAST reconcile, and only when still unlinked. May be absent. */
    unlinkedReason: string | null;
    /**
     * What WE last did to this account, and whether the mirror has caught up (#2480).
     *
     * `status` above is what the DIRECTORY said at `syncedAt`. The sync runs at
     * 03:00 and the leaver pass at 05:00, so a disable always lands two hours
     * AFTER the observation that could have seen it — leaving the row reading
     * ACTIVE until the next 03:00, roughly 22 hours. This page's own subtitle
     * invites an access review from this data, so for that window the review
     * concluded the opposite of the truth.
     *
     * `writeNewerThanSync` is computed server-side rather than by comparing
     * `lastWriteAt` to `syncedAt` here: both are wire strings, the comparison is
     * the whole point of the fix, and two places deciding it is how they drift.
     */
    lastWriteAction: string | null;
    lastWriteOutcome: string | null;
    lastWriteAt: string | null;
    writeNewerThanSync: boolean;
}

/**
 * The badge a row earns when we have acted since the directory was last read.
 *
 * Returns null — meaning "render the mirror's status, unchanged" — unless there
 * is a settled write the sync has not yet re-observed. Once the next sync lands,
 * `status` is authoritative again and this goes quiet on its own.
 *
 * ONLY `DISABLE_ACCOUNT` IS TREATED AS NEWS, and every outcome is spelled out
 * rather than defaulted. `APPLIED` is the common case; `INDETERMINATE` is the
 * most valuable of them, because nobody knows whether that write landed and the
 * mirror cannot tell you. `FAILED` deliberately yields null: it is a positive
 * claim that the directory is UNCHANGED, so the mirror's own status is correct
 * and flagging it would invent a discrepancy. `REVERTED` likewise — the account
 * was put back, which is what `status` already says.
 */
function writeSignal(row: AccountRow): { label: string; tip: string } | null {
    if (!row.writeNewerThanSync || row.lastWriteAction !== 'DISABLE_ACCOUNT') return null;
    switch (row.lastWriteOutcome) {
        case 'APPLIED':
            return { label: 'disableApplied', tip: 'disableAppliedTip' };
        case 'INDETERMINATE':
            return { label: 'disableUnconfirmed', tip: 'disableUnconfirmedTip' };
        default:
            return null;
    }
}

export default function IdentityAccountsPage() {
    // The toolbar's state IS this page's server query — see the docblock at the
    // top of the file — so it has to live above the component that fetches.
    const filterCtx = useFilterContext([], IDENTITY_ACCOUNT_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <IdentityAccountsContent />
        </FilterProvider>
    );
}

function IdentityAccountsContent() {
    const t = useTranslations('admin');
    const tGroup = useTranslations('common.filterGroups');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const triggerUndoToast = useToastWithUndo();
    const { state, search, hasActive } = useFilters();
    const [rows, setRows] = useState<AccountRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // The account awaiting a reason. Protecting REQUIRES one — the usecase
    // refuses without it — because the value of this list a year from now is
    // that every entry says why it is there.
    const [protecting, setProtecting] = useState<AccountRow | null>(null);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    // The RELEASE path's own error surface. `saveError` above is rendered
    // inside Modal.Body, which only mounts while `protecting` is non-null — so
    // a failed release (the 403 an ADMIN gets on this very page, or a dropped
    // connection) had nowhere at all to show, and the account stayed protected
    // while the operator was told nothing. An undo toast that reports nothing
    // when the PATCH fails would be a worse lie than no toast.
    const [releaseError, setReleaseError] = useState(false);

    // The adapter idiom every filter-defs consumer uses: `useTranslations`
    // returns a Translator whose key + values types are narrowed to the
    // namespace, and `buildIdentityAccountFilters` takes the widened resolver
    // shape that keeps filter-defs.ts free of next-intl types.
    const filters = useMemo(
        () =>
            buildIdentityAccountFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    // Single-valued: the route's `provider` parameter takes one provider, and
    // the filter def is declared `multiple: false` to match.
    const provider = state.provider?.[0];
    const query = useMemo(() => {
        const params = new URLSearchParams();
        const q = search.trim();
        if (q) params.set('q', q);
        if (provider) params.set('provider', provider);
        const qs = params.toString();
        return qs ? `?${qs}` : '';
    }, [search, provider]);

    // THE ROSTER IS CAPPED, AND UNTIL #2412 IT DID NOT SAY SO.
    //
    // `listConnectedAccounts` takes IDENTITY_ROSTER_PAGE_SIZE rows — a hard
    // cap, not a cursor page: there is no next link and the response carries
    // no `truncated` flag (deliberately; the access-review page consumes this
    // body through a reader that fails open on an unrecognised shape). So the
    // only evidence available here is the one the access-reviews directory
    // gate already uses against the same constant: a full page might have been
    // cut. `>=` rather than the gate's `<` because this side is asserting the
    // hazard rather than standing down from it — a response somehow longer
    // than the cap is still a list this page cannot promise is whole.
    //
    // It matters on THIS page above all others, because this is where an
    // operator decides which accounts must never be offboarded: an account
    // past the cap cannot be protected from here, and it is indistinguishable
    // from one that does not exist.
    //
    // The cap still fires under a search — it applies to the MATCHES — but it
    // now means "narrow further", not "this account is out of reach". The
    // notice says so.
    const truncated = rows.length >= IDENTITY_ROSTER_PAGE_SIZE;

    // Show the connection column ONLY when the provider badge cannot already
    // tell two rows apart — i.e. when some provider has more than one
    // connection in this roster. One connection per provider is the normal
    // configuration, and a column repeating one name down every row is the
    // kind of noise this page's density rules exist to refuse.
    const showConnection = useMemo(() => {
        const byProvider = new Map<string, Set<string>>();
        for (const r of rows) {
            const seen = byProvider.get(r.provider) ?? new Set<string>();
            seen.add(r.connectionId);
            byProvider.set(r.provider, seen);
        }
        return [...byProvider.values()].some((s) => s.size > 1);
    }, [rows]);

    // Monotonic request id. The toolbar commits a new search on a 250ms
    // debounce, so two roster fetches can be in flight at once and the DB is
    // free to answer them out of order. Rendering a stale answer under the
    // current search box would be the page telling the operator that THESE are
    // the accounts matching what they typed — on a page whose whole job is
    // "this account exists / does not", that is the one lie worth code.
    const requestSeq = useRef(0);

    const load = useCallback(async () => {
        const seq = ++requestSeq.current;
        setError(false);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/identity-accounts${query}`));
            if (seq !== requestSeq.current) return;
            if (!res.ok) { setError(true); return; }
            const body = await res.json();
            if (seq !== requestSeq.current) return;
            setRows(body.accounts ?? []);
        } catch {
            if (seq !== requestSeq.current) return;
            setError(true);
        } finally {
            if (seq === requestSeq.current) {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setLoading(false);
            }
        }
    }, [apiUrl, query]);
    useEffect(() => { void load(); }, [load]);

    const setProtection = useCallback(async (account: AccountRow, isProtected: boolean, why: string | null) => {
        setSaving(true);
        setSaveError(false);
        try {
            const res = await fetch(apiUrl(`/admin/identity-account-protection/${account.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isProtected, reason: why }),
            });
            if (!res.ok) { setSaveError(true); return; }
            setProtecting(null);
            setReason('');
            // Refetch rather than patch in place: the server owns protectedAt and
            // protectedByUserId, and a row assembled here would drift from it.
            await load();
        } catch {
            setSaveError(true);
        } finally {
            setSaving(false);
        }
    }, [apiUrl, load]);

    // RELEASING IS THE DESTRUCTIVE DIRECTION, and until now it was the only one
    // with no guard: protecting opened a modal and demanded a reason, releasing
    // fired the PATCH straight off the row button. The asymmetry ran backwards.
    // Releasing is not recoverable by re-protecting — the usecase NULLs
    // protectedAt, protectedByUserId and protectionReason and writes a
    // hash-chained audit row, so re-protecting records a NEW fact rather than
    // restoring the old one, and on an AUTOMATIC write policy this click is the
    // last thing between a live account and a 05:00 disable.
    //
    // Hence the house undo-toast convention (docs/destructive-actions.md) and
    // not a confirm dialog: the commit is DEFERRED, so Undo inside the window
    // means the PATCH never fires at all and no audit row is ever written.
    const releaseProtection = (account: AccountRow) => {
        // 1. Snapshot the operator's visible state.
        const previous = rows;
        setReleaseError(false);
        // 2. Optimistic release — the row reads unprotected immediately. The
        //    toast IS the pending indicator; no row-level spinner.
        setRows((rs) =>
            rs.map((r) =>
                r.id === account.id ? { ...r, isProtected: false, protectionReason: null } : r,
            ),
        );
        // 3. Trigger the toast — this is what schedules the real PATCH.
        triggerUndoToast({
            message: t('identityAccounts.released'),
            undoMessage: t('identityAccounts.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/admin/identity-account-protection/${account.id}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    // Releasing needs no reason — see the usecase, which
                    // deliberately refuses to require one and discards a
                    // non-null reason on this direction anyway.
                    body: JSON.stringify({ isProtected: false, reason: null }),
                });
                if (!res.ok) throw new Error('release failed');
                // Refetch for the same reason the protect path does: the server
                // owns protectedAt and protectedByUserId.
                await load();
            },
            // Undo and commit-failure restore the same snapshot — "the row came
            // back" must look identical either way.
            undoAction: () => setRows(previous),
            onError: () => {
                setRows(previous);
                setReleaseError(true);
            },
        });
    };

    const cols = createColumns<AccountRow>([
        { accessorKey: 'provider', header: t('integrations.colProvider'), cell: ({ getValue }) => <StatusBadge variant="info">{getValue()}</StatusBadge> },
        // Plain text, NOT a StatusBadge: this page is at its badge budget, and
        // a connection name is an identifier rather than a state signal.
        ...(showConnection
            ? [{
                id: 'connection',
                accessorKey: 'connectionName',
                header: t('identityAccounts.colConnection'),
                cell: ({ row }: { row: { original: AccountRow } }) => (
                    <span className="text-content-muted">{row.original.connectionName ?? row.original.connectionId}</span>
                ),
            }]
            : []),
        { accessorKey: 'email', header: t('identityAccounts.colEmail'), cell: ({ row }) => <span className="font-medium">{row.original.email ?? row.original.displayName ?? '—'}</span> },
        { id: 'name', accessorKey: 'displayName', header: t('identityAccounts.colName'), cell: ({ getValue }) => <span className="text-content-muted">{String(getValue() ?? '—')}</span> },
        {
            id: 'status',
            accessorKey: 'status',
            header: t('integrations.colStatus'),
            // THE CORRECTION GOES WHERE THE WRONG CLAIM IS RENDERED (#2480).
            //
            // One badge, replaced — not a second badge beside it and not a new
            // column. The defect was that this cell asserted ACTIVE for an
            // account we had disabled hours earlier; a discreet marker elsewhere
            // would leave the false claim standing and add a footnote.
            cell: ({ row }) => {
                const signal = writeSignal(row.original);
                if (!signal) {
                    return (
                        <StatusBadge variant={row.original.status === 'ACTIVE' ? 'success' : 'neutral'}>
                            {row.original.status}
                        </StatusBadge>
                    );
                }
                return (
                    <StatusBadge
                        variant="warning"
                        tone="solid"
                        tooltip={t(`identityAccounts.${signal.tip}`, {
                            status: row.original.status,
                            observedAt: row.original.syncedAt ? formatDateTime(row.original.syncedAt) : '—',
                            appliedAt: row.original.lastWriteAt ? formatDateTime(row.original.lastWriteAt) : '—',
                        })}
                    >
                        {t(`identityAccounts.${signal.label}`)}
                    </StatusBadge>
                );
            },
        },
        { id: 'admin', accessorKey: 'isAdmin', header: t('identityAccounts.colAdmin'), cell: ({ row }) => row.original.isAdmin ? <StatusBadge variant="warning">{t('identityAccounts.admin')}</StatusBadge> : <span className="text-content-subtle">—</span> },
        {
            id: 'linked',
            accessorKey: 'linked',
            header: t('identityAccounts.colLinked'),
            // THE OFFBOARDING GAP, RUNNING THE OTHER WAY.
            //
            // An account with no employee is one no leaver pass will ever act
            // on: the pass reads workers the HR feed marks TERMINATED, and a
            // person the feed does not carry can never be marked anything. So
            // this account is not "not yet linked" — without intervention it is
            // permanently outside offboarding, and nothing else on this page
            // says so.
            //
            // The reconciler already computes WHY and records it on the sync's
            // execution row; until now nothing read it.
            cell: ({ row }) => {
                // MATCHED IS THE NORMAL STATE, so it does not get a badge.
                // The density guard's rule is one loud badge per row with
                // secondaries quietened into the chrome, and it is right here:
                // a page where every row shouts "Matched" buries the handful
                // that say the opposite.
                if (row.original.linked) {
                    return <span className="text-content-subtle">{t('identityAccounts.linked')}</span>;
                }
                const reason = row.original.unlinkedReason;
                return (
                    <span className="inline-flex flex-wrap items-center gap-tight">
                        <StatusBadge variant="warning">{t('identityAccounts.unlinked')}</StatusBadge>
                        {/* An ABSENT reason is not "no problem" — it is "the last
                            reconcile did not name this one", which happens when
                            the sample hits its cap. Rendered as unknown, never
                            as fine. */}
                        <span className="font-mono text-xs text-content-muted">
                            {reason ?? t('identityAccounts.unlinkedReasonUnknown')}
                        </span>
                    </span>
                );
            },
        },
        {
            id: 'protected',
            accessorKey: 'isProtected',
            header: t('identityAccounts.colProtected'),
            // Plain text and a Button rather than a StatusBadge. This page is at
            // the badge-density cap of 5 and a sixth would trip the ratchet — but
            // the better reason is that this is an ACTION column, and a badge
            // that cannot be clicked next to a button that can reads as two
            // controls where there is one.
            cell: ({ row }) => (
                <div className="flex items-center gap-tight">
                    {row.original.isProtected && (
                        <span className="text-sm text-content-default" title={row.original.protectionReason ?? undefined}>
                            {t('identityAccounts.protected')}
                        </span>
                    )}
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                            if (row.original.isProtected) {
                                releaseProtection(row.original);
                            } else {
                                setSaveError(false);
                                setReason('');
                                setProtecting(row.original);
                            }
                        }}
                    >
                        {row.original.isProtected ? t('identityAccounts.release') : t('identityAccounts.protect')}
                    </Button>
                </div>
            ),
        },
        { id: 'mfa', accessorKey: 'mfaEnrolled', header: t('identityAccounts.colMfa'), cell: ({ row }) => row.original.mfaEnrolled ? <StatusBadge variant="success">{t('identityAccounts.mfaOn')}</StatusBadge> : <StatusBadge variant="error">{t('identityAccounts.mfaOff')}</StatusBadge> },
        { id: 'synced', accessorKey: 'syncedAt', header: t('identityAccounts.colSynced'), cell: ({ row }) => <span className="text-content-muted tabular-nums">{row.original.syncedAt ? formatDateTime(row.original.syncedAt) : '—'}</span> },
    ]);

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('integrations.title'), href: tenantHref('/admin/integrations') }, { label: t('identityAccounts.breadcrumb') }]} />
            <Heading level={1}>{t('identityAccounts.title')}</Heading>
            <p className="text-sm text-content-muted">{t('identityAccounts.intro')}</p>

            {/* ABOVE the card, and outside every loading / empty / error
                branch below it. A filter that produced no rows must still be
                clearable, and a roster that failed to load must still be
                searchable — hiding the control that caused the state along
                with the state is how an operator gets stuck on an empty page
                with no way back. */}
            <FilterToolbar
                filters={filters}
                searchId="identity-accounts-search"
                searchPlaceholder={t('identityAccounts.searchPlaceholder')}
            />

            <Card className="space-y-default p-6">
                {/* Outside the {protecting && …} modal on purpose: this is the
                    release path's only visible failure, and the modal never
                    mounts on it. */}
                {releaseError && (
                    <InlineNotice variant="error" onDismiss={() => setReleaseError(false)}>
                        {t('identityAccounts.releaseError')}
                    </InlineNotice>
                )}
                {error ? (
                    <InlineNotice variant="error">{t('identityAccounts.loadError')}</InlineNotice>
                ) : loading ? (
                    <p className="text-sm text-content-subtle">{t('integrations.fetching')}</p>
                ) : rows.length === 0 ? (
                    // TWO DIFFERENT SENTENCES, because they mean different
                    // things. "No synced accounts yet" tells an operator to go
                    // connect a directory; saying that to someone whose search
                    // simply matched nothing would be false, and on this page a
                    // false "there is nothing here" is the exact failure the
                    // search was added to prevent.
                    hasActive ? (
                        <div className="space-y-tight">
                            <p className="text-sm text-content-default">{t('identityAccounts.noMatches')}</p>
                            <p className="text-sm text-content-muted">{t('identityAccounts.noMatchesDescription')}</p>
                        </div>
                    ) : (
                        <p className="text-sm text-content-muted">{t('identityAccounts.empty')}</p>
                    )
                ) : (
                    <>
                        {/* The cap, said out loud. Not dismissible: it is a
                            standing property of what is on screen, not an
                            event that has been acknowledged. */}
                        {truncated && (
                            <InlineNotice
                                variant="warning"
                                title={t('identityAccounts.truncatedTitle', { cap: IDENTITY_ROSTER_PAGE_SIZE })}
                            >
                                {t('identityAccounts.truncated')}
                            </InlineNotice>
                        )}
                        <DataTable data={rows} columns={cols} getRowId={(r) => r.id} emptyState={t('identityAccounts.empty')} />
                    </>
                )}
            {protecting && (
                <Modal showModal setShowModal={(v) => { if (!v && !saving) setProtecting(null); }} size="md" preventDefaultClose={saving}>
                    <Modal.Header
                        title={t('identityAccounts.protect')}
                        description={t('identityAccounts.protectPrompt')}
                    />
                    <Modal.Body>
                        {saveError && <InlineNotice variant="error">{t('identityAccounts.protectError')}</InlineNotice>}
                        {/* The PROMPT is the modal description; the field label is
                            just "Reason". Rendering the same sentence twice made
                            the control ambiguous to a screen reader and to any
                            query that looks it up by name. */}
                        <FormField label={t('identityAccounts.reasonLabel')} required>
                            <Textarea
                                id="protection-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={3}
                                className="w-full"
                            />
                        </FormField>
                    </Modal.Body>
                    <Modal.Footer>
                        {/* Cancel, not "Release" — reusing the row action's key here
                            put the word for the OPPOSITE operation on the button
                            that abandons this one. */}
                        <Button type="button" variant="secondary" onClick={() => setProtecting(null)} disabled={saving}>
                            {t('identityAccounts.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            disabled={saving || reason.trim().length === 0}
                            onClick={() => void setProtection(protecting, true, reason.trim())}
                        >
                            {t('identityAccounts.protect')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
            </Card>
        </div>
    );
}
