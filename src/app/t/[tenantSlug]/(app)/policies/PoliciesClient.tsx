'use client';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { NewPolicyModal } from './NewPolicyModal';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { useKpiTrends, buildKpiSparklines, buildKpiSparklineNullable, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { ownerDisplayName } from '@/lib/owner-display';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { UserCombobox } from '@/components/ui/user-combobox';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import {
    createColumns,
    useColumnsDropdown,
    sortRowsByDisplay,
    type SortAccessors,
} from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    type CardDefinition,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { useThresholdLoadMore, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildPolicyFilters,
    POLICY_FILTER_KEYS,
    buildPolicyStatusLabels,
} from './filter-defs';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { useCreateQueryParam } from '@/components/ui/hooks/use-create-query-param';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';

// Status badge classes — keyed off the canonical PolicyStatus enum
// values. POLICY_STATUS_LABELS in `filter-defs.ts` is the single
// source of truth for the human label; this map covers the visual
// treatment per state.
const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'info',
    APPROVED: 'success',
    PUBLISHED: 'success',
    ARCHIVED: 'warning',
};

// listPolicies → PolicyRepository.list (policyListSelect). Cell/accessor
// callbacks stay explicitly-untyped (separate ratchet category); this types
// the query payload, the column factory + the list-page generic.
interface PolicyRow {
    id: string;
    title: string;
    status: string;
    category: string | null;
    owner: { id: string; name: string | null; email: string | null } | null;
    currentVersion: { id: string; versionNumber: number } | null;
    lifecycleVersion: number;
    nextReviewAt: string | null;
    updatedAt: string;
    /** Derived client-side from nextReviewAt for the review-cycle filter/KPI. */
    reviewBucket?: 'overdue' | 'upcoming';
    /**
     * Current-version acknowledgement rollup, computed SERVER-side
     * (annotatePolicyAcknowledgements). Optional because non-PUBLISHED rows
     * and older cached payloads may omit it.
     */
    acknowledgement?: {
        assignedCount: number;
        acknowledgedCount: number;
        outstanding: boolean;
    };
}

interface PoliciesClientProps {
    /** Server-computed KPI counts for the first paint (see page.tsx). */
    initialKpiCounts: PolicyKpiCounts;
    initialPolicies: PolicyRow[];
    initialFilters?: Record<string, string>;
    tenantSlug: string;
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };
    translations: {
        title: string;
        listDescription: string;
    };
}

/**
 * Client island for policies — handles filters, search, and the
 * interactive list. Data arrives pre-fetched from the server
 * component, hydrated into React Query.
 *
 * Epic 45.1 — page sits on the unified `<EntityListPage>` shell
 * (Epic 91) so the layout chrome (header, filters, body, modals
 * passthrough) stays consistent with controls + risks.
 */
/**
 * Shape of GET /api/t/:slug/policies. `kpiCounts` is computed in the database
 * (PolicyRepository.kpiCounts) rather than from `rows`, because `rows` is
 * capped and SSR-windowed while every KPI card's filter resolves tenant-wide.
 */
type PolicyKpiCounts = {
    total: number;
    draft: number;
    inReview: number;
    approved: number;
    overdueReview: number;
    outstandingAck: number;
};
type PolicyListResponse = CappedList<PolicyRow> & { kpiCounts?: PolicyKpiCounts };

export function PoliciesClient(props: PoliciesClientProps) {
    const filterCtx = useFilterContext([], POLICY_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <PoliciesPageInner {...props} />
        </FilterProvider>
    );
}

function PoliciesPageInner({
    initialPolicies,
    initialKpiCounts,
    initialFilters,
    tenantSlug,
    permissions,
    translations: t,
}: PoliciesClientProps) {
    const tx = useTranslations('policies');
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const tGroup = useTranslations('common.filterGroups');
    const policyStatusLabels = useMemo(
        () => buildPolicyStatusLabels((k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1])),
        [tx],
    );
    // Stable across renders. A double-click toggles selection ON then OFF
    // (DataTable's R13-PR14 click model), so the row re-renders BETWEEN the
    // two clicks. Handing DataTable fresh `columns` / `onRowClick` /
    // `getRowId` identities on that re-render rebuilds the table model
    // mid-double-click, the row's DOM node is replaced, and the browser
    // never fires `dblclick` — so double-click-to-open silently dies.
    // ControlsClient documents the same rule; Policies had drifted off it.
    const tenantHref = useCallback(
        (path: string) => `/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const router = useRouter();
    // Null on SSR + first client render so the "Overdue" badge doesn't
    // flip between server- and client-side `new Date()` values.
    const hydratedNow = useHydratedNow();

    // Modal-form P2 — create-policy modal auto-opens on `?create=1`
    // (the redirect target from `/policies/new`). `?template=1`
    // additionally puts the modal in template-picker mode (the
    // legacy `?template=1` deep-link on `/policies/new` is forwarded
    // by the redirect shim).
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [createTemplateMode, setCreateTemplateMode] = useState(false);
    const searchParams = useSearchParams();
    useCreateQueryParam(() => setIsCreateOpen(true), `/t/${tenantSlug}/policies`);

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;
    const fetchParams = useMemo(
        () => toApiSearchParams(state, { search }),
        [state, search],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);

    const serverHadFilters =
        initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useSsrFallback({
        queryKeyFilters,
        initialFilters,
        serverHadFilters,
        hasActive,
    });

    // Epic 69 — read source is `useTenantSWR` against a filter-aware
    // cache key. Each filter combination becomes its own cache entry
    // (the qs-suffix on the path keeps them isolated). Server-rendered
    // `initialPolicies` lands as `fallbackData` only when the active
    // filters match the server view — otherwise the hook fires a
    // fresh request immediately, mirroring the prior React Query
    // "skip initialData when filters diverge" semantics.
    const policiesKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs
            ? `${CACHE_KEYS.policies.list()}?${qs}`
            : CACHE_KEYS.policies.list();
    }, [fetchParams]);

    // PR-5 — API returns `{ rows, truncated }`. SSR initial wraps
    // with `truncated: false` (the SSR cap is below the backfill cap).
    // `kpiCounts` is OPTIONAL, not required, and that is deliberate: the SSR
    // fallback below has rows but no counts, so the cards fall back to
    // page-derived numbers for the first paint only. Typing it required would
    // force a fake zero into the fallback, and a card reading 0 before
    // hydration is a worse lie than one reading the page count.
    const policiesQuery = useTenantSWR<PolicyListResponse>(policiesKey, {
        fallbackData: filtersMatchInitial
            ? { rows: initialPolicies, truncated: false, kpiCounts: initialKpiCounts }
            : undefined,
    });

    // NOT `policiesQuery.data?.rows ?? []` at module-body level: the `?? []`
    // mints a NEW array identity on every render where data is undefined, and
    // that value is a dependency of the memo below — so the memo recomputed
    // every render and the file-wide eslint suppression hid it. Depend on the
    // stable `data` reference and apply the fallback inside.
    const policiesData = policiesQuery.data;
    const truncated = policiesData?.truncated ?? false;

    // Derive the review-cycle bucket per row (hydration-safe: null until mount,
    // matching the nextReviewAt column's overdue highlight). Drives the
    // reviewBucket filter + the "overdue review" KPI.
    const policies = useMemo<PolicyRow[]>(() => {
        const nowMs = hydratedNow ? hydratedNow.getTime() : null;
        const upcomingMs = nowMs !== null ? nowMs + 30 * 24 * 60 * 60 * 1000 : null;
        return (policiesData?.rows ?? []).map((p) => {
            let reviewBucket: 'overdue' | 'upcoming' | undefined;
            if (nowMs !== null && upcomingMs !== null && p.nextReviewAt) {
                const due = new Date(p.nextReviewAt).getTime();
                reviewBucket = due < nowMs ? 'overdue' : due <= upcomingMs ? 'upcoming' : undefined;
            }
            return { ...p, reviewBucket };
        });
    }, [policiesData, hydratedNow]);

    // ─── Sortable headers (per-column asc/desc, parity with Controls) ───
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    const sortableColumns = useMemo(
        () => [
            'title', 'status', 'category', 'owner',
            'version', 'nextReviewAt', 'updatedAt',
        ],
        [],
    );
    // One accessor per sortable column id, each returning the value the
    // matching COLUMN DISPLAYS (not the raw field) so sorting groups
    // same-displayed-value rows. status → POLICY_STATUS_LABELS label
    // (cell renders the label, not the raw enum); owner → ownerDisplayName
    // (cell renders the derived username, not the raw email); category /
    // version / nextReviewAt / updatedAt mirror their column accessorFn.
    const sortAccessors = useMemo<SortAccessors<PolicyRow>>(
        () => ({
            title: (p) => p.title || '',
            status: (p) =>
                policyStatusLabels[p.status] ??
                p.status,
            category: (p) => p.category || '—',
            owner: (p) => ownerDisplayName(p.owner?.name, p.owner?.email) ?? '—',
            version: (p) =>
                p.currentVersion?.versionNumber ?? p.lifecycleVersion ?? null,
            nextReviewAt: (p) => p.nextReviewAt || '',
            updatedAt: (p) => p.updatedAt,
        }),
        [policyStatusLabels],
    );
    const sortedPolicies = useMemo(
        () => sortRowsByDisplay(policies, sortAccessors, sortBy, sortOrder),
        [policies, sortAccessors, sortBy, sortOrder],
    );
    // #107 — publish the rendered order so the detail page's prev/next
    // stepper walks what the user saw. The sorted+filtered set, not the
    // load-on-scroll window.
    usePublishDisplayedOrder(CACHE_KEYS.policies.list(), sortedPolicies);

    // Load-on-scroll windowing — render the first batch, append more as
    // the user nears the bottom (DataTable onReachEnd sentinel).
    const {
        visibleRows: visiblePolicies,
        hasMore: hasMorePolicies,
        loadMore: loadMorePolicies,
    } = useThresholdLoadMore(sortedPolicies);
    const loading = policiesQuery.isLoading && !policiesQuery.data;

    // ─── Bulk actions (canonical BulkActionBar — assign + archive) ───
    // Policy status is approval-gated, so the bar carries Assign owner
    // (write) + Archive (the one safe terminal verb, admin-gated) — no bulk
    // status that could bypass the publish-approval workflow.
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkApplying, setBulkApplying] = useState(false);
    const handleBulkApply = async (action: string, value: string) => {
        const ids = Array.from(selected);
        if (!action || ids.length === 0) return;

        // Bulk delete is a SOFT delete, so it is reversible — the Epic 67
        // undo-toast is the convention for that, not a blocking confirm.
        // Drop the rows now, fire the real DELETE after the undo window,
        // restore on Undo or on failure.
        if (action === 'delete') {
            const idSet = new Set(ids);
            setSelected(new Set());
            void policiesQuery.mutate(
                // guardrail-ignore: optimistic-delete cache update for the undo window; the server still owns the list filter and mutate() restores on Undo/failure.
                (cur) => (cur ? { ...cur, rows: cur.rows.filter((r) => !idSet.has(r.id)) } : cur),
                { revalidate: false },
            );
            triggerUndoToast({
                message: tx('bulk.deletedToast', { count: ids.length }),
                undoMessage: tx('bulk.undo'),
                action: async () => {
                    const res = await fetch(`/api/t/${tenantSlug}/policies/bulk/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ policyIds: ids }),
                    });
                    if (!res.ok) throw new Error(tx('bulk.failed'));
                    // The optimistic toast above necessarily says `ids.length`
                    // — it is composed BEFORE this request fires (Epic 67
                    // schedules the commit 5s later), so it structurally
                    // cannot know how many rows the server actually found.
                    //
                    // `deleted` is the count that survived a tenant-scoped
                    // listByIds, so it drops ids already deleted by someone
                    // else, and foreign-tenant ids. The single-delete path
                    // throws notFound for exactly that case; the bulk path
                    // absorbed it silently and told the user all N went.
                    // Reconcile once the truth is known rather than leaving a
                    // confident wrong number on screen.
                    const body = (await res.json().catch(() => null)) as
                        | { deleted?: number }
                        | null;
                    const deleted = typeof body?.deleted === 'number' ? body.deleted : ids.length;
                    if (deleted !== ids.length) {
                        toast.info(
                            tx('bulk.deletedReconciled', {
                                deleted,
                                skipped: ids.length - deleted,
                            }),
                        );
                    }
                    await policiesQuery.mutate();
                },
                undoAction: () => { void policiesQuery.mutate(); },
                onError: () => {
                    toast.error(tx('bulk.failed'));
                    void policiesQuery.mutate();
                },
            });
            return;
        }

        setBulkApplying(true);
        try {
            const url =
                action === 'archive'
                    ? `/api/t/${tenantSlug}/policies/bulk/archive`
                    : `/api/t/${tenantSlug}/policies/bulk/assign`;
            const body =
                action === 'assign'
                    ? { policyIds: ids, ownerUserId: value || null }
                    : { policyIds: ids };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const detail = await res
                    .json()
                    .then((b) => (typeof b?.error === 'string' ? b.error : null))
                    .catch(() => null);
                throw new Error(detail || tx('bulk.failed'));
            }
            // Report the SERVER's figure. bulkArchivePolicy and
            // bulkAssignPolicy both return { updated } from a tenant-scoped
            // listByIds, so it excludes ids already deleted by a teammate.
            // ids.length claimed all N every time — while the single-item
            // path throws notFound in the same situation.
            const payload = (await res.json().catch(() => null)) as
                | { updated?: number }
                | null;
            const applied =
                typeof payload?.updated === 'number' ? payload.updated : ids.length;

            await policiesQuery.mutate();
            setSelected(new Set());
            if (applied !== ids.length) {
                toast.info(
                    tx('bulk.appliedReconciled', {
                        count: applied,
                        skipped: ids.length - applied,
                    }),
                );
            } else {
                toast.success(
                    action === 'archive'
                        ? tx('bulk.archivedToast', { count: applied })
                        : tx('bulk.assignedToast', { count: applied }),
                );
            }
        } catch (err: unknown) {
            // Previously this threw inside try/finally with NO catch, into an
            // un-awaited onApply — an unhandled rejection: no toast, no error
            // state, and the selection left intact as though nothing had been
            // attempted. `bulk.failed` was referenced but could never reach a
            // user, and the success path said nothing either.
            toast.error(err instanceof Error && err.message ? err.message : tx('bulk.failed'));
        } finally {
            setBulkApplying(false);
        }
    };
    const policyBulkActions: BulkActionDef[] = useMemo(() => {
        const defs: BulkActionDef[] = [
            {
                value: 'assign',
                label: tx('bulk.assignOwner'),
                renderInput: ({ value, setValue, setLabel }) => (
                    <UserCombobox
                        tenantSlug={tenantSlug}
                        selectedId={value || null}
                        onChange={(id, m) => {
                            setValue(id ?? '');
                            setLabel(ownerDisplayName(m?.name, m?.email) ?? '');
                        }}
                        forceDropdown
                        matchTriggerWidth
                        placeholder={tx('bulk.ownerBlank')}
                        className="w-full sm:w-44"
                        id="bulk-value-input"
                    />
                ),
            },
        ];
        // Archive + Delete are admin-gated (mirror the OWNER/ADMIN guards on
        // archivePolicy / bulkDeletePolicy).
        if (permissions.canAdmin) {
            // Archive blocks every edit path until restored, so it earns the
            // confirm it did not have. Delete is a reversible SOFT delete and
            // routes through the undo-toast instead — the confirm here was the
            // inverse of the consequences.
            defs.push({ value: 'archive', label: tx('bulk.archive'), confirm: true });
            defs.push({ value: 'delete', label: tx('bulk.delete') });
        }
        return defs;
    }, [tenantSlug, permissions.canAdmin, tx]);

    const liveFilters = useMemo(
        () => buildPolicyFilters(policies, (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [policies, tx, tGroup],
    );

    // R-filter-gear (#3) — the gear controls the quantifiable KPI CARDS
    // (Total / Draft / In review / Approved / Overdue review / Outstanding
    // ack), not the filter categories, which stay in the Filter dropdown and
    // are always passed to the toolbar in full. Registering ONLY kind:'kpi'
    // cards under this key is deliberate: the hook's stale-data migration
    // fires only when EVERY persisted id is dead, so a mixed
    // filter+kpi namespace would leave old gear users with hidden KPI cards.
    const kpiCards: CardDefinition[] = useMemo(
        () => [
            { id: 'total', label: tx('list.kpiTotal'), kind: 'kpi' },
            { id: 'draft', label: tx('list.kpiDraft'), kind: 'kpi' },
            { id: 'inReview', label: tx('list.kpiInReview'), kind: 'kpi' },
            { id: 'approved', label: tx('list.kpiApproved'), kind: 'kpi' },
            // Opt-in, not removed. Four cards fill the grid-cols-2 md:grid-cols-4
            // row exactly; six wrapped two onto a second row, which no other
            // list page does. These two are also the only pair without
            // sparklines, so the row reads as one kind of thing again.
            //
            // Safe to demote because both are real SERVER-side filters
            // (reviewBucket=overdue, outstanding=true) resolved in
            // PolicyRepository — the latter as a currentVersionId IN (…)
            // narrowing that composes with other filters and survives
            // pagination. Nothing becomes unreachable; it moves behind the gear.
            //
            // Ids are UNCHANGED on purpose. The stale-id migration at
            // use-filter-card-visibility only fires when EVERY persisted id is
            // dead, so renaming one would strand prior gear users with a single
            // visible card — and only those who had used the gear, which is
            // invisible in review. Anyone who has already configured this strip
            // keeps their choice; only the untouched default changes.
            { id: 'overdueReview', label: tx('list.kpiOverdueReview'), kind: 'kpi', defaultVisible: false },
            { id: 'outstandingAck', label: tx('list.kpiOutstandingAck'), kind: 'kpi', defaultVisible: false },
        ],
        [tx],
    );
    const { visibleCards: visibleKpiCards, dropdown: filtersDropdown } =
        useFilterCardVisibility({
            storageKey: 'inflect:filter-vis:policies',
            cards: kpiCards,
        });

    // ─── R23-PR-F — KPI definitions for the Policies page ───
    type PolicyKpiId = 'total' | 'draft' | 'inReview' | 'approved' | 'overdueReview' | 'outstandingAck';
    // KPI card counts come from the LIST ENDPOINT, not from `policies`.
    //
    // `policies` is the current-filter result capped at LIST_BACKFILL_CAP —
    // and, until the SWR backfill lands, only the first SSR_PAGE_LIMIT rows.
    // Every card's filter resolves against the whole tenant, so a count taken
    // from that array could not predict its own click: a card read 3 and
    // produced 47. `total` was worse than windowed — it displayed the CURRENT
    // FILTERED length while its click calls clearAll(), so it disagreed with
    // itself whenever any filter was set.
    //
    // The server computes, per card, the count its click would return. The
    // fallbacks below are the pre-hydration values only.
    const serverKpiCounts = policiesQuery.data?.kpiCounts ?? initialKpiCounts;
    const totalPolicies = serverKpiCounts.total;

    // Canonical KPI-card sparklines (shared hook). `total` is always present;
    // the status buckets (draft/inReview/approved) are forward-only nullable
    // columns — empty until history accrues, never a fake ramp.
    const trendsQuery = useKpiTrends(tenantSlug);
    const policyTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints;
        return {
            total: buildKpiSparklines(points, (d) => d.policiesTotal, {
                total: (d) => d.policiesTotal,
            }).total,
            draft: buildKpiSparklineNullable(points, (d) => d.policiesDraft),
            inReview: buildKpiSparklineNullable(points, (d) => d.policiesInReview),
            approved: buildKpiSparklineNullable(points, (d) => d.policiesApproved),
        };
    }, [trendsQuery.data]);
    // Distinct sparkline colour per card (canonical allocator).
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'draft', 'inReview', 'approved']),
        [],
    );
    const draftPolicies = serverKpiCounts.draft;
    const inReviewPolicies = serverKpiCounts.inReview;
    const approvedPolicies = serverKpiCounts.approved;
    const overdueReviewPolicies = serverKpiCounts.overdueReview;
    const outstandingAckPolicies = serverKpiCounts.outstandingAck;
    const policyKpiDefs: ReadonlyArray<KpiFilterDef<PolicyKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'draft',
                apply: (ctx) => ctx.set('status', 'DRAFT'),
                isActive: (s) => (s.status ?? []).includes('DRAFT'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'inReview',
                apply: (ctx) => ctx.set('status', 'IN_REVIEW'),
                isActive: (s) => (s.status ?? []).includes('IN_REVIEW'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                // The card has always DISPLAYED approved-or-published, while
                // applying status=APPROVED alone — so it over-counted by the
                // published set on every render, and clicking it produced
                // fewer rows than it advertised. Widen the filter to match the
                // count rather than shrinking the count to match the filter:
                // a policy that is PUBLISHED is past approval, not outside it.
                id: 'approved',
                apply: (ctx) => {
                    ctx.set('status', 'APPROVED');
                    ctx.add('status', 'PUBLISHED');
                },
                isActive: (s) =>
                    (s.status ?? []).includes('APPROVED') &&
                    (s.status ?? []).includes('PUBLISHED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'overdueReview',
                apply: (ctx) => ctx.set('reviewBucket', 'overdue'),
                isActive: (s) => (s.reviewBucket ?? []).includes('overdue'),
                clear: (ctx) => ctx.removeAll('reviewBucket'),
            },
            {
                // Forwarded to the API as `outstanding=true` and resolved
                // against the whole tenant, so the count the card filters TO
                // can legitimately exceed the count it displays (which is
                // scoped to the loaded page).
                id: 'outstandingAck',
                apply: (ctx) => ctx.set('outstanding', 'true'),
                isActive: (s) => (s.outstanding ?? []).includes('true'),
                clear: (ctx) => ctx.removeAll('outstanding'),
            },
        ],
        [],
    );
    const { activeKpiId: activePolicyKpi, toggle: togglePolicyKpi } =
        useKpiFilter(policyKpiDefs);

    // ─── Column visibility (Epic 52 / R10-PR6) ───
    const policyColumnList = useMemo(
        () => [
            { id: 'title', label: tx('colHeaders.title') },
            { id: 'status', label: tx('colHeaders.status') },
            { id: 'category', label: tx('colHeaders.category') },
            { id: 'owner', label: tx('colHeaders.owner') },
            { id: 'version', label: tx('colHeaders.version') },
            { id: 'acknowledgement', label: tx('colHeaders.acknowledgement') },
            { id: 'nextReviewAt', label: tx('colHeaders.nextReview') },
            { id: 'updatedAt', label: tx('colHeaders.updated') },
        ],
        [tx],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:policies',
        columns: policyColumnList,
    });

    // Stable table-model identities — see the note on `tenantHref`.
    const getPolicyRowId = useCallback((p: PolicyRow) => p.id, []);
    const handleRowClick = useCallback(
        (row: { original: PolicyRow }) =>
            router.push(tenantHref(`/policies/${row.original.id}`)),
        [router, tenantHref],
    );
    const handleRowPrefetch = useCallback(
        (row: { original: PolicyRow }) =>
            router.prefetch(tenantHref(`/policies/${row.original.id}`)),
        [router, tenantHref],
    );
    const resourceName = useCallback(
        (p?: unknown) =>
            p ? tx('list.resourcePlural') : tx('list.resourceSingular'),
        [tx],
    );

    const policyColumns = useMemo(() => createColumns<PolicyRow>([
        {
            accessorKey: 'title',
            header: tx('colHeaders.title'),
            // R12-PR2 — drop the block-level <p> description that
            // pushed rows to 60+px. Title cell stays single-line so
            // every row across the product reads at the same
            // ~44px height (the DataTable primitive's `py-2.5
            // leading-6` baseline). Description is still visible on
            // the policy detail page.
            cell: ({ row }) => (
                <TableTitleCell
                    href={tenantHref(`/policies/${row.original.id}`)}
                >
                    {row.original.title}
                </TableTitleCell>
            ),
        },
        {
            accessorKey: 'status',
            header: tx('colHeaders.status'),
            // Pulls labels from the canonical POLICY_STATUS_LABELS so
            // the badge copy and the filter copy cannot drift.
            cell: ({ row }) => {
                const status = row.original.status as string;
                const cls = STATUS_BADGE[status] ?? 'neutral';
                const label =
                    policyStatusLabels[status] ??
                    status;
                return (
                    <StatusBadge variant={cls} data-testid={`policy-status-${row.original.id}`}>
                        {label}
                    </StatusBadge>
                );
            },
        },
        {
            id: 'category',
            header: tx('colHeaders.category'),
            accessorFn: (p) => p.category || '—',
            cell: ({ getValue }) => (
                <span className="text-xs text-content-muted">{getValue()}</span>
            ),
        },
        {
            id: 'owner',
            header: tx('colHeaders.owner'),
            // UI-14 (capstone): name-only via ownerDisplayName — name, or the
            // email local-part as a username, never the full email address.
            accessorFn: (p) =>
                ownerDisplayName(p.owner?.name, p.owner?.email) ?? '—',
            cell: ({ row }) => {
                const p = row.original;
                const display = ownerDisplayName(p.owner?.name, p.owner?.email);
                if (!display) {
                    return (
                        <span className="text-xs text-content-subtle">—</span>
                    );
                }
                const initial = display.charAt(0).toUpperCase();
                return (
                    <span
                        className="inline-flex items-center gap-1.5"
                        data-testid={`policy-owner-${p.id}`}
                    >
                        <span
                            aria-hidden
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-[10px] font-medium text-content-emphasis"
                        >
                            {initial}
                        </span>
                        <span className="min-w-0 leading-tight">
                            <span className="block truncate text-xs text-content-emphasis">
                                {display}
                            </span>
                        </span>
                    </span>
                );
            },
        },
        {
            id: 'version',
            header: tx('colHeaders.version'),
            // Prefer the bound `currentVersion.versionNumber` (the
            // operator-visible counter). Falls back to `lifecycleVersion`,
            // which now reflects real published lineage — publishPolicy
            // increments it and records prior published snapshots in
            // lifecycleHistoryJson (Prompt-3.1), so it is no longer frozen
            // at 1. Finally a dash for policies without any version row yet.
            accessorFn: (p) =>
                p.currentVersion?.versionNumber ??
                p.lifecycleVersion ??
                null,
            cell: ({ getValue, row }) => {
                const v = getValue();
                if (v == null) {
                    return (
                        <span className="text-xs text-content-subtle">—</span>
                    );
                }
                return (
                    <span
                        className="inline-flex items-center rounded-md bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-content-emphasis"
                        data-testid={`policy-version-${row.original.id}`}
                    >
                        v{v}
                    </span>
                );
            },
        },
        {
            id: 'acknowledgement',
            header: tx('colHeaders.acknowledgement'),
            // `acked/assigned` for the CURRENT published version. A dash means
            // no live campaign (unpublished, or nobody assigned) — distinct
            // from `0/12`, which means a campaign nobody has completed yet.
            accessorFn: (p) => p.acknowledgement?.assignedCount ?? 0,
            cell: ({ row }) => {
                const ack = row.original.acknowledgement;
                if (!ack || ack.assignedCount === 0) {
                    return <span className="text-xs text-content-subtle">—</span>;
                }
                return (
                    <StatusBadge
                        variant={ack.outstanding ? 'warning' : 'success'}
                        data-testid={`policy-ack-${row.original.id}`}
                    >
                        {tx('list.ackProgress', {
                            acknowledged: ack.acknowledgedCount,
                            assigned: ack.assignedCount,
                        })}
                    </StatusBadge>
                );
            },
        },
        {
            id: 'nextReviewAt',
            header: tx('colHeaders.nextReview'),
            accessorFn: (p) => p.nextReviewAt || '',
            cell: ({ row }) => {
                const p = row.original;
                if (!p.nextReviewAt) {
                    return <span className="text-xs text-content-muted">—</span>;
                }
                const isOverdue =
                    !!hydratedNow &&
                    new Date(p.nextReviewAt) < hydratedNow &&
                    p.status !== 'ARCHIVED';
                return (
                    <span className="inline-flex items-center gap-1 text-xs text-content-muted">
                        <TimestampTooltip date={p.nextReviewAt} />
                        {isOverdue && (
                            <StatusBadge variant="error" data-testid={`policy-overdue-${p.id}`}>
                                {tx('list.overdue')}
                            </StatusBadge>
                        )}
                    </span>
                );
            },
            meta: { disableTruncate: true },
        },
        {
            id: 'updatedAt',
            header: tx('colHeaders.updated'),
            accessorFn: (p) => p.updatedAt,
            cell: ({ getValue }) => (
                <TimestampTooltip
                    date={getValue() as string | null | undefined}
                    className="text-xs text-content-subtle"
                />
            ),
        },
    ]), [tenantHref, hydratedNow, tx, policyStatusLabels]);

    // Memoised: `orderColumns()` returns a NEW array each call, and a fresh
    // `columns` identity rebuilds the table model (see `tenantHref` above).
    const orderedPolicyColumns = useMemo(
        () => orderColumns(policyColumns),
        [orderColumns, policyColumns],
    );

    return (
        <EntityListPage<PolicyRow>
            className="animate-fadeIn gap-section"
            banner={<TruncationBanner truncated={truncated} />}
            header={{
                breadcrumbs: [
                    { label: tx('list.dashboard'), href: tenantHref('/dashboard') },
                    { label: t.title },
                ],
                title: t.title,
                // Roadmap-2 PR-4 — editorial framing.
                description: t.listDescription,
                // Header action cluster is intentionally empty — the
                // create button moved into the toolbar leading slot and
                // the "From Template" affordance into the toolbar actions
                // slot (left of the gears).
                actions: undefined,
            }}
            kpis={
                /* R23-PR-F — KPI strip rendered via EntityListPage's
                   kpis slot (added in R23-PR-D). */
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    {visibleKpiCards.map((card) => {
                        const cfg: Record<
                            string,
                            {
                                value: number;
                                tone?: 'default' | 'attention' | 'success' | 'critical';
                                sparkline?: typeof policyTrends.total;
                                sparklineVariant?: typeof sparkColors.total;
                            }
                        > = {
                            total: {
                                value: totalPolicies,
                                sparkline: policyTrends.total,
                                sparklineVariant: sparkColors.total,
                            },
                            draft: {
                                value: draftPolicies,
                                tone: 'attention',
                                sparkline: policyTrends.draft,
                                sparklineVariant: sparkColors.draft,
                            },
                            inReview: {
                                value: inReviewPolicies,
                                tone: 'default',
                                sparkline: policyTrends.inReview,
                                sparklineVariant: sparkColors.inReview,
                            },
                            approved: {
                                value: approvedPolicies,
                                tone: 'success',
                                sparkline: policyTrends.approved,
                                sparklineVariant: sparkColors.approved,
                            },
                            overdueReview: {
                                value: overdueReviewPolicies,
                                tone: overdueReviewPolicies > 0 ? 'critical' : 'default',
                            },
                            outstandingAck: {
                                value: outstandingAckPolicies,
                                tone: outstandingAckPolicies > 0 ? 'attention' : 'default',
                            },
                        };
                        const c = cfg[card.id];
                        if (!c) return null;
                        return (
                            <KpiFilterCard
                                key={card.id}
                                label={card.label}
                                value={c.value}
                                tone={c.tone}
                                sparkline={c.sparkline}
                                sparklineVariant={c.sparklineVariant}
                                sparklineDomain={centeredSparklineDomain(c.sparkline)}
                                onClick={() => togglePolicyKpi(card.id as PolicyKpiId)}
                                selected={activePolicyKpi === card.id}
                            />
                        );
                    })}
                </div>
            }
            filters={{
                defs: liveFilters,
                searchId: 'policies-search',
                searchPlaceholder: tx('list.searchPlaceholder'),
                toolbarLeading: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => {
                            setCreateTemplateMode(false);
                            setIsCreateOpen(true);
                        }}
                        id="new-policy-btn"
                    >
                        {tx('list.addBtn')}
                    </Button>
                ) : undefined,
                // "From template" now lives in the new-policy modal's
                // "Start with" selector, so the separate toolbar button is
                // gone — the toolbar carries just the columns / kpi gears.
                toolbarActions: (
                    <>
                        {columnsDropdown}
                        {filtersDropdown}
                    </>
                ),
            }}
            table={{
                data: visiblePolicies,
                onReachEnd: hasMorePolicies ? loadMorePolicies : undefined,
                columns: orderedPolicyColumns,
                loading,
                sortableColumns,
                sortBy,
                sortOrder,
                onSortChange: ({ sortBy: nextBy, sortOrder: nextOrder }) => {
                    setSortBy(nextBy);
                    setSortOrder(nextOrder);
                },
                getRowId: getPolicyRowId,
                onRowClick: handleRowClick,
                onRowPrefetch: handleRowPrefetch,
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={tx('list.emptyFilterTitle')}
                        description={tx('list.emptyFilterDesc')}
                        secondaryAction={{
                            label: tx('list.clearFilters'),
                            onClick: () => filterCtx.clearAll(),
                        }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={tx('noPolicies')}
                        description={tx('list.emptyDesc')}
                    />
                ),
                resourceName,
                columnVisibility,
                onColumnVisibilityChange: setColumnVisibility,
                'data-testid': 'policies-table',
                className: 'hover:bg-bg-muted',
                // Selection + canonical BulkActionBar; gated on edit so a
                // READER sees neither checkboxes nor the bar.
                selectedRows: permissions.canWrite
                    ? Object.fromEntries(Array.from(selected).map((id) => [id, true]))
                    : undefined,
                onRowSelectionChange: permissions.canWrite
                    ? (rows) => setSelected(new Set(rows.map((r) => r.original.id)))
                    : undefined,
                selectionControls: permissions.canWrite
                    ? () => (
                          <BulkActionBar
                              actions={policyBulkActions}
                              onApply={handleBulkApply}
                              applying={bulkApplying}
                              selectedCount={selected.size}
                              entityLabel={tx('list.entityLabel')}
                          />
                      )
                    : undefined,
            }}
        >
            {permissions.canWrite && (
                <NewPolicyModal
                    open={isCreateOpen}
                    setOpen={setIsCreateOpen}
                    isTemplateMode={createTemplateMode}
                />
            )}
        </EntityListPage>
    );
}
