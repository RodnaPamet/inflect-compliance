'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers/derived arrays recreated each render). The proper structural fix is wrapping parent-level callbacks in useCallback. Tracked as follow-up; existing per-line eslint-disable-next-line markers preserved. */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Row, RowSelectionState } from '@tanstack/react-table';
import { useRouter, useSearchParams } from 'next/navigation';
// NewControlModal was previously lazy-loaded via next/dynamic, but the JIT
// race in `next dev` made the modal occasionally fail to mount in serial-mode
// E2E runs (Playwright clicked the trigger before the chunk finished
// compiling). Static import — the bundle cost is negligible and the E2E suite
// becomes deterministic. (The list quick-view is <ControlEditPanel>, mounted
// in an <AsidePanel>.)
import { NewControlModal } from './NewControlModal';
import { ControlTaskRows, type ControlTask } from '@/components/controls-shared/ControlTaskRows';
// One-click on a control name / task opens an EDITABLE side panel (docked
// AsidePanel, no overlay → table stays visible). These replace the read-only
// quick-views AND the separate quick-edit Sheet (so no table blur, no edit btn).
import { ControlEditPanel } from './ControlEditPanel';
import { TaskEditPanel } from '@/components/controls-shared/TaskEditPanel';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ownerDisplayName } from '@/lib/owner-display';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { UserCombobox, useTenantMembers } from '@/components/ui/user-combobox';
import { Combobox } from '@/components/ui/combobox';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { formatDateTime } from '@/lib/format-date';
import { AppIcon } from '@/components/icons/AppIcon';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import { ViewsMenu } from '@/components/ui/views-menu';
import { Paperclip, ChevronDown, ChevronLeft } from 'lucide-react';
import {
    createColumns,
    useColumnsDropdown,
    sortRowsByDisplay,
    type SortAccessors,
} from '@/components/ui/table';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tooltip, InfoTooltip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import {
    FilterProvider,
    filterStateToUrlParams,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    type CardDefinition,
    type FilterType,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { useThresholdLoadMore, useKeyboardShortcut, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { AsidePanel } from '@/components/ui/aside-panel';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import {
    categorizeControl,
    ISO27001_DOMAIN_ORDER,
} from '@/lib/controls/control-taxonomy';
import { applicabilityState } from '@/lib/controls/control-applicability';
import { AiAssistRail } from '@/components/ui/ai-assist-rail';
import { Sparkle3 } from '@/components/ui/icons/nucleo/sparkle3';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiTrends, buildKpiSparklines, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import {
    buildControlFilters,
    buildControlStatusLabels,
    CONTROL_FILTER_KEYS,
} from './filter-defs';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import {
    CONTROL_HEALTH_VERDICT_VARIANT,
    type ControlHealthVerdict,
} from '@/lib/controls/control-health';
import { useCreateQueryParam } from '@/components/ui/hooks/use-create-query-param';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';
import { controlBulkActionsFor, type ControlBulkAction } from './_lib/bulk-action-policy';

// ─── Constants ───

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    NOT_STARTED: 'neutral',
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    IMPLEMENTING: 'info',
    IMPLEMENTED: 'success',
    NEEDS_REVIEW: 'warning',
    NOT_APPLICABLE: 'neutral',
};
/** The seven ControlStatus enum members, in canonical display order. Labels
 *  are resolved per-render from `buildControlStatusLabels(t)` inside the
 *  component (badge copy + filter picker copy share one localized source). */
const CONTROL_STATUS_VALUES = [
    'NOT_STARTED',
    'PLANNED',
    'IN_PROGRESS',
    'IMPLEMENTING',
    'IMPLEMENTED',
    'NEEDS_REVIEW',
    'NOT_APPLICABLE',
] as const;



// ─── Types ───

interface ControlListItem {
    id: string;
    code: string | null;
    annexId: string | null;
    name: string;
    status: string;
    applicability: string;
    /** R2-P4 — null when applicable-but-never-assessed (distinct from decided). */
    applicabilityDecidedAt?: string | null;
    category: string | null;
    frequency: string | null;
    /** Widened to include id/email so the owner filter can resolve + display. */
    owner: { id: string; name: string | null; email: string | null } | null;
    _count?: { evidenceLinks?: number; evidenceControlLinks?: number };
    /**
     * Unified linked-task counts (TaskLink CONTROL link OR the
     * `controlId` FK), supplied by `listControls`. The Tasks column
     * reads these — the legacy ControlTask stack was removed (TP-2).
     */
    taskTotal?: number;
    taskDone?: number;
    /** Soft-delete who/when — non-null only in the "Deleted controls" view
     *  (rows fetched with `?includeDeleted=true`). */
    deletedAt?: string | null;
    deletedByUserId?: string | null;
}

interface ControlsClientProps {
    initialControls: ControlListItem[];
    initialFilters?: Record<string, string>;
    tenantSlug: string;
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };
    appPermissions: {
        controls: { create: boolean; edit: boolean };
        // The inline task edit panel needs the task write permission.
        tasks: { edit: boolean };
    };
}

/**
 * Client island for controls — handles filters, status cycling, applicability mutations.
 * Data arrives pre-fetched from the server component, hydrated into React Query.
 *
 * Filter architecture (Epic 53):
 *   - `useFilterContext` manages state + URL sync for everything except search.
 *   - `search` is the `q` param, owned by the same context.
 *   - Owner / Category options are derived client-side from loaded controls so
 *     the picker reflects reality without an extra API call.
 */
export function ControlsClient(props: ControlsClientProps) {
    // Build the filter context at the outer boundary so the provider can wrap
    // the inner tree — the inner component consumes via `useFilters()`.
    const filterCtx = useFilterContext(
        // Static filter defs — options are patched in inside the inner component
        // where `controls` are available. Outer uses the static shape for keys.
        [],
        CONTROL_FILTER_KEYS,
        { serverFilters: props.initialFilters },
    );

    return (
        <FilterProvider value={filterCtx}>
            <ControlsPageInner {...props} />
        </FilterProvider>
    );
}

function ControlsPageInner({
    initialControls,
    initialFilters,
    tenantSlug,
    permissions,
    appPermissions,
}: ControlsClientProps) {
    // Stable across renders — selection-toggle re-renders (Phase 2)
    // must NOT hand the DataTable fresh `columns` / `onRowClick` /
    // `getRowId` references, or it rebuilds the whole table model
    // mid-double-click and breaks double-click-to-navigate.
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const tenantHref = useCallback(
        (path: string) => `/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const router = useRouter();
    const prefetchData = usePrefetchTenant();
    const t = useTranslations('controls');
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    // Bulk soft-delete + the Deleted-controls lifecycle view (Restore / Purge)
    // require ADMIN server-side (bulkDeleteControl / listControlsWithDeleted
    // both assertCanAdmin). Editors keep the status/assign bulk verbs.
    const canAdmin = permissions.canAdmin;
    // Single source for "which bulk verbs may this viewer use" — see
    // _lib/bulk-action-policy.
    const allowedBulkActions = useMemo(
        () => controlBulkActionsFor(permissions),
        [permissions],
    );
    const FREQ_LABELS = useMemo<Record<string, string>>(
        () => ({
            AD_HOC: t('freq.adHoc'),
            DAILY: t('freq.daily'),
            WEEKLY: t('freq.weekly'),
            MONTHLY: t('freq.monthly'),
            QUARTERLY: t('freq.quarterly'),
            ANNUALLY: t('freq.annually'),
        }),
        [t],
    );
    const tGroup = useTranslations('common.filterGroups');
    // Scoped-translator adapter: next-intl types the key as a narrow union; the
    // filter-defs factory takes a plain (key, values?) resolver.
    const tAdapter = useCallback(
        (k: string, v?: Record<string, unknown>) =>
            t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
        [t],
    );
    const tGroupAdapter = useCallback(
        (k: string) => tGroup(k as Parameters<typeof tGroup>[0]),
        [tGroup],
    );
    // Status labels: single localized source of truth for badges + the bulk
    // status picker (mirrors the filter-picker copy).
    const STATUS_LABELS = useMemo(() => buildControlStatusLabels(tAdapter), [tAdapter]);
    // #9 — the bulk STATUS picker must NOT offer NOT_APPLICABLE. Writing
    // status=NOT_APPLICABLE bypasses the applicability-justification flow and
    // leaves Status=N/A alongside Applicability=Yes on the same row. N/A is set
    // via the per-control applicability action; the detail-page status dropdown
    // already omits it ([controlId]/page.tsx). The full seven-value map stays
    // available for badge display (STATUS_LABELS) — only the picker is trimmed.
    const CONTROL_STATUS_OPTIONS = useMemo(() => {
        // guardrail-ignore: filtering a static enum CONSTANT (drop N/A from the bulk picker), not server-fetched rows.
        const values = CONTROL_STATUS_VALUES.filter((value) => value !== 'NOT_APPLICABLE');
        return values.map((value) => ({ value, label: STATUS_LABELS[value] ?? value }));
    }, [STATUS_LABELS]);

    const filterCtx = useFilters();
    const { state, search, clearAll, hasActive } = filterCtx;

    // Justification modal state

    // Create-control modal state. Auto-opens when the page is reached via
    // `/controls?create=1` — the `/controls/new` page redirects here so
    // deep links and E2E tests that `page.goto('/controls/new')` keep
    // working against the modal-based flow.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const searchParams = useSearchParams();
    useCreateQueryParam(() => setIsCreateOpen(true), `/t/${tenantSlug}/controls`);

    // ─── Consistency deep-link restriction (?ids=…) ───
    // The controls dashboard's consistency check deep-links each issue
    // count to `/controls?ids=<comma-separated control ids>`. When that
    // param is present we restrict the already-loaded list to exactly
    // those controls (a client-side row restriction — NOT a server
    // filter) and surface a dismissable banner. Clearing returns to
    // `/controls`. Coexists with the FilterToolbar filters/search.
    const flaggedIds = useMemo(() => {
        const raw = searchParams?.get('ids');
        if (!raw) return null;
        const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
        return ids.length > 0 ? new Set(ids) : null;
    }, [searchParams]);

    // ─── API query string from filter state + search + ?ids= deep-link ───
    // `ids` is not a FilterToolbar facet (it's a consistency deep-link param),
    // so it's threaded in here explicitly. Being part of `filtersForQuery` means
    // it flows into the SWR key AND `queryKeyFilters` — so the SSR-provided
    // `initialFilters` (which also carries `ids`) still matches on the first
    // paint and `fallbackData` is preserved (no cold refetch flash).
    const filtersForQuery = useMemo(() => {
        const params = filterStateToUrlParams(state);
        if (search) params.set('q', search);
        const idsParam = searchParams?.get('ids');
        if (idsParam) params.set('ids', idsParam);
        // #8a — `category` is the ONE facet still applied client-side (see
        // `clientFilteredControls`), so it must not reach the server query:
        // the Category column shows a DERIVED value while the server can only
        // match the raw stored column, and the two disagree. Dropping it here
        // keeps one authoritative value for the facet (the client's) and the
        // SWR key stable across picks. The SSR read drops it for the same
        // reason, so a hard nav and a client nav now agree.
        //
        // `applicability` USED to be stripped here too. It no longer is: the
        // three display states are expressible in SQL over
        // (applicability, applicabilityDecidedAt), so the server filters them
        // — which means the facet now sees every control, not just the loaded
        // page. See @/lib/controls/control-applicability.
        params.delete('category');
        return params;
    }, [state, search, searchParams]);

    // Flat shape for react-query cache key stability (objects with the same
    // serialised content should hit the same cache entry).
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of filtersForQuery) obj[k] = v;
        return obj;
    }, [filtersForQuery]);

    // ─── Query: controls list (hydrated with server data) ───

    // When server provides initialFilters, the data is already filtered server-side.
    // Only use initialData when the live filter state still matches what the server saw.
    const serverHadFilters = initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useSsrFallback({
        queryKeyFilters,
        initialFilters,
        serverHadFilters,
        hasActive,
    });

    // PR-5 — API returns `{ rows, truncated }`; SSR initial wraps
    // with `truncated: false` because the SSR cap (100) is well below
    // the backfill cap (5000), so the SSR slice never trips truncation
    // by itself.
    // ─── Deleted-controls lifecycle view (admin) ───
    // Admin-only toggle that swaps the list to soft-deleted rows (fetched with
    // `?includeDeleted=true`) so an admin can Restore or permanently Purge them.
    // Mirrors the Assets register's deleted view.
    const [showDeleted, setShowDeleted] = useState(false);
    // Resolve `deletedByUserId` → a display name for the Deleted view's
    // who/when column. Fetched only while the deleted view is open.
    const { data: deletedMembers } = useTenantMembers(tenantSlug, { enabled: showDeleted });
    const memberById = useMemo(
        () => new Map((deletedMembers ?? []).map((m) => [m.id, m])),
        [deletedMembers],
    );
    const deletedByLabel = useCallback(
        (id: string | null | undefined): string => {
            if (!id) return t('deleted.byUnknown');
            const m = memberById.get(id);
            return (m?.name || m?.email) ?? t('deleted.byUnknown');
        },
        [memberById, t],
    );
    // Typed-confirm purge modal — Purge is irreversible, so it uses the
    // sanctioned type-to-confirm pattern (mirrors AssetsClient), NOT the
    // undo-toast.
    const [purgeTarget, setPurgeTarget] = useState<ControlListItem | null>(null);
    const [confirmText, setConfirmText] = useState('');
    const [purging, setPurging] = useState(false);
    const [purgeError, setPurgeError] = useState<string | null>(null);

    const controlsKey = useMemo(() => {
        const params = new URLSearchParams(filtersForQuery);
        // Deleted view is a distinct fetch — append the flag so the SWR key
        // (and the backing GET) selects soft-deleted rows too.
        if (showDeleted) params.set('includeDeleted', 'true');
        const qs = params.toString();
        return qs ? `${CACHE_KEYS.controls.list()}?${qs}` : CACHE_KEYS.controls.list();
    }, [filtersForQuery, showDeleted]);
    // The live list GET returns `{ rows, truncated }`; the `includeDeleted`
    // branch returns a bare array (listControlsWithDeleted). Type + read both.
    const controlsQuery = useTenantSWR<CappedList<ControlListItem> | ControlListItem[]>(controlsKey, {
        // The SSR initial payload never contains soft-deleted rows, so the
        // deleted view must always fetch fresh (no fallback).
        fallbackData: filtersMatchInitial && !showDeleted
            ? { rows: initialControls, truncated: false }
            : undefined,
    });

    // SWR recreates its return OBJECT every render (only the bound `mutate`
    // is stable). Depend on `controlsMutate` — never the whole `controlsQuery`
    // — inside any callback that feeds the column memo (e.g. handleRestore),
    // or the DataTable model rebuilds every render and double-click-to-open
    // dies (the row DOM is replaced between the two clicks).
    const controlsMutate = controlsQuery.mutate;
    const controlsData = controlsQuery.data;
    const rawControls = Array.isArray(controlsData)
        ? controlsData
        : controlsData?.rows ?? [];
    const truncated = Array.isArray(controlsData) ? false : controlsData?.truncated ?? false;
    const loading = controlsQuery.isLoading && !controlsQuery.data;

    // ─── Health verdicts (lazy, batched) ────────────────────────────
    // One tenant-wide read backs the Health column badge. Loaded
    // independently of the list so the table paints immediately; the
    // badge fills in when the verdict map resolves (muted '—' until
    // then). The map keys the per-control verdict by id.
    const verdictsQuery = useTenantSWR<{
        verdicts: { controlId: string; verdict: ControlHealthVerdict; passRate: number | null }[];
    }>('/controls/health-verdicts');
    const verdictMap = useMemo(() => {
        const m = new Map<string, ControlHealthVerdict>();
        for (const v of verdictsQuery.data?.verdicts ?? []) m.set(v.controlId, v.verdict);
        return m;
    }, [verdictsQuery.data]);

    // ─── PR-1: org-parity sortable headers ───
    // Client-side sort over the loaded controls. The server returns
    // by its canonical order (annexId/code asc); when the user
    // clicks a sortable header the page re-orders the in-memory
    // slice without a refetch. `sortBy` + `sortOrder` flow into
    // the shared table primitive as the sortableColumns surface.
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    // Sort accessors return the value each column DISPLAYS, so sorting groups
    // same-displayed-value rows contiguously. The drift-prone columns (category,
    // frequency) point their `accessorFn` at the SAME function below — the sort
    // key and the rendered value can never diverge.
    const sortAccessors = useMemo<SortAccessors<ControlListItem>>(
        () => ({
            code: (c) => c.code || c.annexId || '',
            name: (c) => c.name || '',
            status: (c) => c.status || '',
            category: (c) => categorizeControl(c)?.category || '',
            frequency: (c) =>
                c.frequency ? FREQ_LABELS[c.frequency] || c.frequency : '',
            owner: (c) => c.owner?.name || c.owner?.email || '',
        }),
        [],
    );
    // #8a — `category` is applied HERE, over the already-loaded rows, on the
    // DERIVED value the column renders (see the note on `filtersForQuery`,
    // which strips it from the server query). Deriving keeps one authoritative
    // value for the facet and guarantees the picker only offers values a cell
    // can actually show. Runs before sort + windowing so the visible slice
    // already reflects the selection.
    //
    // KNOWN BOUND: this only sees the loaded page, so past the backfill cap a
    // matching control is missing. It stays client-side because
    // `categorizeControl` parses the ISO Annex clause out of `annexId`/`code`
    // with a permissive regex and looks it up in a 93-entry map — pushing that
    // into SQL means either duplicating the parser in the query builder (a
    // second source of truth for the thing this function IS) or persisting the
    // derived value in a column with a backfill. The second is the right move
    // if the cap ever binds; neither is worth it while it doesn't.
    // `applicability` moved to the server — see @/lib/controls/control-applicability.
    //
    // Read the raw `state.*` ref (stable across renders when unchanged) so the
    // memo — and the sort/window that depend on it — don't churn every render.
    const categoryFilter = state.category;
    const clientFilteredControls = useMemo(() => {
        if (!categoryFilter || categoryFilter.length === 0) return rawControls;
        const wanted = new Set(categoryFilter);
        // guardrail-ignore: client-side filter on the DERIVED framework category (matches the Category column) — not server-data refiltering; the server owns q/status/applicability/owner/health/ids.
        return rawControls.filter((c) => wanted.has(categorizeControl(c)?.category ?? ''));
    }, [rawControls, categoryFilter]);
    const controls = useMemo(() => {
        // The consistency `?ids=` deep-link is now applied SERVER-SIDE (threaded
        // into the SWR query + SSR read as an `id: { in }` restriction), so
        // `rawControls` already IS the flagged set — no client-side row filter,
        // which means a flagged control beyond the loaded page is no longer
        // silently dropped. `flaggedIds` is retained only to drive the banner.
        return sortRowsByDisplay(clientFilteredControls, sortAccessors, sortBy, sortOrder);
    }, [clientFilteredControls, sortAccessors, sortBy, sortOrder]);
    const sortableColumns = useMemo(
        () => ['code', 'name', 'status', 'category', 'frequency', 'owner'],
        [],
    );

    // ─── PR-1: org-parity progressive disclosure ───
    // Above the threshold (50 rows), render the first slice and
    // expose a "Load more …" button. Below the threshold, the table
    // renders all rows immediately. The hook owns the window size;
    // resetting happens on a fresh mount only (re-filtering keeps
    // the window so a narrowed result stays fully visible).
    const {
        visibleRows: visibleControls,
        hasMore: hasMoreControls,
        loadMore: loadMoreControls,
    } = useThresholdLoadMore(controls);

    // ─── Filter defs with runtime-derived owner/category options ───
    // Options are derived from `rawControls` (the full server-returned set),
    // NOT the client-filtered `controls` — otherwise selecting one derived
    // category would collapse the Category picker to just that value.
    const liveFilterDefs: FilterType[] = useMemo(
        () => buildControlFilters(rawControls, tAdapter, tGroupAdapter),
        [rawControls, tAdapter, tGroupAdapter],
    );

    // R-filter-gear (#3, 2026-06-07): the "Edit filter cards" gear now
    // controls the QUANTIFIABLE KPI cards above the table (Total /
    // Implemented / In Progress / Not Started) — their visibility + order —
    // not the filter categories (those live in the Filter dropdown). The
    // toolbar still gets the full `liveFilterDefs`.
    const kpiCards: CardDefinition[] = useMemo(
        () => [
            { id: 'total', label: t('kpi.total'), kind: 'kpi' },
            { id: 'implemented', label: t('kpi.implemented'), kind: 'kpi' },
            { id: 'inProgress', label: t('kpi.inProgress'), kind: 'kpi' },
            { id: 'notStarted', label: t('kpi.notStarted'), kind: 'kpi' },
        ],
        [],
    );
    const { visibleCards: visibleKpiCards, dropdown: filtersDropdown } =
        useFilterCardVisibility({
            storageKey: 'inflect:filter-vis:controls',
            cards: kpiCards,
        });

    // ─── R23-PR-D — KPI definitions for the Controls page ───
    // Status-based buckets aligned to the existing `status` filter.
    // The "In Progress" KPI buckets IN_PROGRESS + IMPLEMENTING under
    // one label visually, but the filter API sets only IN_PROGRESS;
    // pages that want a multi-status KPI extend the predicate.
    type ControlKpiId = 'total' | 'implemented' | 'inProgress' | 'notStarted';
    // guardrail-ignore: KPI counts across the loaded page, not a refilter.
    const totalControls = controls.length;
    // guardrail-ignore: KPI count, not a refilter.
    const implementedControls = controls.filter(
        (c) => c.status === 'IMPLEMENTED',
    ).length;
    // guardrail-ignore: KPI count, not a refilter.
    const inProgressControls = controls.filter(
        (c) => c.status === 'IN_PROGRESS' || c.status === 'IMPLEMENTING',
    ).length;
    // guardrail-ignore: KPI count, not a refilter.
    const notStartedControls = controls.filter(
        (c) => c.status === 'NOT_STARTED',
    ).length;

    // Canonical KPI-card sparklines — real per-day series from the daily
    // compliance-snapshot trends (shared hook). Each card maps to its column;
    // all four series exist + are populated for controls.
    const trendsQuery = useKpiTrends(tenantSlug);
    const controlTrends = useMemo(
        () =>
            buildKpiSparklines(trendsQuery.data?.dataPoints, (d) => d.controlsTotal, {
                total: (d) => d.controlsTotal,
                implemented: (d) => d.controlsImplemented,
                inProgress: (d) => d.controlsInProgress,
                notStarted: (d) => d.controlsNotStarted,
            }),
        [trendsQuery.data],
    );
    // Distinct sparkline colour per card (canonical allocator).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'implemented', 'inProgress', 'notStarted']),
        [],
    );
    const controlKpiDefs: ReadonlyArray<KpiFilterDef<ControlKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'implemented',
                apply: (ctx) => ctx.set('status', 'IMPLEMENTED'),
                isActive: (s) => (s.status ?? []).includes('IMPLEMENTED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                // #8c — the "In progress" KPI counts IN_PROGRESS + IMPLEMENTING
                // (see `inProgressControls`), so the drill-down must set BOTH
                // statuses — otherwise the filtered list showed fewer rows than
                // the number on the card. Active when both are present (mirrors
                // the Assets "High/Critical" two-value KPI).
                id: 'inProgress',
                apply: (ctx) => {
                    ctx.set('status', 'IN_PROGRESS');
                    ctx.add('status', 'IMPLEMENTING');
                },
                isActive: (s) => {
                    const v = s.status ?? [];
                    return v.includes('IN_PROGRESS') && v.includes('IMPLEMENTING');
                },
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'notStarted',
                apply: (ctx) => ctx.set('status', 'NOT_STARTED'),
                isActive: (s) => (s.status ?? []).includes('NOT_STARTED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
        ],
        [],
    );
    const { activeKpiId: activeControlKpi, toggle: toggleControlKpi } =
        useKpiFilter(controlKpiDefs);

    // ─── Column visibility (Epic 52 / R10-PR6) ───
    // Pagination removed — internal scroll inside the table card
    // (ListPageShell.Body + DataTable fillBody) shows all rows.
    const controlColumnList = useMemo(
        () => [
            { id: 'code', label: t('colVis.code'), defaultVisible: false },
            { id: 'name', label: t('colVis.title') },
            // Framework + Category, split into two columns (2026-06-07).
            // Both derived per-control via `categorizeControl` (ISO 27001
            // granular Annex domain, or the framework-native category) —
            // mirrors the Browse rail's grouping.
            { id: 'framework', label: t('colVis.framework') },
            { id: 'category', label: t('colVis.category') },
            { id: 'status', label: t('colVis.status') },
            { id: 'applicability', label: t('colVis.applicability') },
            { id: 'health', label: t('colVis.health') },
            { id: 'owner', label: t('colVis.owner') },
            { id: 'frequency', label: t('colVis.frequency'), defaultVisible: false },
            { id: 'tasks', label: t('colVis.tasks') },
            { id: 'evidence', label: t('colVis.evidence') },
        ],
        [],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:controls',
        columns: controlColumnList,
    });
    // ─── Row selection → canonical BulkActionBar ───
    // The page owns the selection state; DataTable is controlled via
    // `selectedRows` + `onRowSelectionChange`. When ≥1 row is selected
    // (and the viewer can edit), the `aside` slot mounts the
    // selection-summary rail with the bulk-status verbs — a calmer,
    // persistent home than the floating batch-action toolbar.
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

    // The rail is gated on the *settled* selection, not the live one.
    // DataTable's R13-PR14 click model has a single click toggle row
    // selection and a double-click navigate — so a double-click toggles
    // selection on, then off, within the double-click window. Gating
    // the rail (a layout-reflowing surface) on the live selection would
    // flash it in and then out mid-double-click, and the reflow between
    // the two physical clicks breaks double-click-to-navigate. Settling
    // the selection for 250ms before the rail reacts means a
    // double-click never trips it; a genuine single-click selection
    // (which stays put) mounts the rail a quarter-second later —
    // imperceptible.
    const [settledSelection, setSettledSelection] =
        useState<RowSelectionState>({});
    useEffect(() => {
        const t = setTimeout(() => setSettledSelection(rowSelection), 250);
        return () => clearTimeout(t);
    }, [rowSelection]);
    const selectedIds = useMemo(
        // guardrail-ignore: reads the truthy keys out of the local RowSelectionState record (selected row ids) — not server-data filtering.
        () => Object.keys(settledSelection).filter((id) => settledSelection[id]),
        [settledSelection],
    );
    const canEditControls = appPermissions.controls.edit;

    // Canonical bulk path — one `updateMany`-backed endpoint instead of the
    // former per-id status loop (kills the N+1). status + assign mirror the
    // Tasks/Assets bars.
    const [bulkApplying, setBulkApplying] = useState(false);
    const handleBulkApply = async (action: string, value: string, _label: string) => {
        if (!action || selectedIds.length === 0) return;
        const ids = selectedIds;

        // #3 — bulk delete is a SOFT/restorable delete → Epic 67 undo-toast
        // (not a blocking confirm). Optimistically drop the rows from the SWR
        // cache, fire the real bulk-delete only after the undo window elapses,
        // restore on Undo / failure. See docs/destructive-actions.md +
        // AssetsClient. (Admin-gated: the action isn't offered to non-admins.)
        if (action === 'delete') {
            const idSet = new Set(ids);
            setRowSelection({});
            controlsQuery.mutate(
                (cur) => {
                    if (!cur) return cur;
                    // guardrail-ignore: optimistic-delete cache update (drop the just-deleted rows during the Epic 67 undo window) — NOT display refiltering; mutate() restores on Undo/failure.
                    if (Array.isArray(cur)) return cur.filter((c) => !idSet.has(c.id));
                    // guardrail-ignore: optimistic-delete cache update over the CappedList rows — same undo-window drop, not server-data refiltering.
                    return { ...cur, rows: cur.rows.filter((c) => !idSet.has(c.id)) };
                },
                { revalidate: false },
            );
            triggerUndoToast({
                message: t('bulk.deletedToast', { count: ids.length }),
                undoMessage: t('deleted.undo'),
                action: async () => {
                    const res = await fetch(apiUrl('/controls/bulk/delete'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ controlIds: ids }),
                    });
                    if (!res.ok) throw new Error('Bulk delete failed');
                    await controlsQuery.mutate();
                },
                undoAction: () => { controlsQuery.mutate(); },
                onError: () => {
                    toast.error(t('bulk.actionFailed'));
                    controlsQuery.mutate();
                },
            });
            return;
        }

        // #2 — status / assign. The apply was previously a try/finally with NO
        // catch, so a `!res.ok` threw an unhandled rejection while the bar
        // cleared — the failure looked like success. Now: toast on both
        // outcomes, and clear the selection ONLY on success.
        setBulkApplying(true);
        try {
            const url =
                action === 'status'
                    ? apiUrl('/controls/bulk/status')
                    : apiUrl('/controls/bulk/assign');
            const body =
                action === 'status'
                    ? { controlIds: ids, status: value }
                    : { controlIds: ids, ownerUserId: value || null };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error('Bulk action failed');
            // Revalidate the same key the table reads (the active filtered list).
            await controlsQuery.mutate();
            toast.success(t('bulk.applied'));
            setRowSelection({});
        } catch {
            toast.error(t('bulk.actionFailed'));
        } finally {
            setBulkApplying(false);
        }
    };
    // The array literal is annotated INSIDE the callback, not just on the
    // const: `.filter(...)` makes the whole expression a method call, so the
    // literal no longer picks up its contextual type and every `renderInput`
    // parameter would fall back to `any`.
    const controlBulkActions: BulkActionDef[] = useMemo(() => {
        const defs: BulkActionDef[] = [
            {
                value: 'status',
                label: t('bulk.setStatus'),
                canApply: (v) => v !== '',
                renderInput: ({ value, setValue }) => (
                    <Combobox
                        hideSearch
                        id="bulk-value-input"
                        selected={CONTROL_STATUS_OPTIONS.find((o) => o.value === value) ?? null}
                        setSelected={(opt) => setValue(opt?.value ?? '')}
                        options={CONTROL_STATUS_OPTIONS}
                        placeholder={t('bulk.selectStatus')}
                        matchTriggerWidth
                        buttonProps={{ className: 'text-sm' }}
                    />
                ),
            },
            {
                value: 'assign',
                label: t('bulk.assignOwner'),
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
                        placeholder={t('bulk.ownerBlank')}
                        className="w-full sm:w-44"
                        id="bulk-value-input"
                    />
                ),
            },
            // DELETE is ADMIN-only: bulkDeleteControl asserts admin
            // server-side, so offering it to an EDITOR is a guaranteed 403.
            // No `confirm` here — it routes through the Epic 67 undo-toast in
            // handleBulkApply (soft, restorable delete).
            //
            // The role decision lives in _lib/bulk-action-policy, not in this
            // ternary: inline, the only thing guarding it was a regex that
            // matched the 'delete' literal INSIDE the conditional, so
            // removing the guard kept CI green.
            { value: 'delete', label: t('bulk.delete') },
        ];
        return defs.filter((def) =>
            allowedBulkActions.includes(def.value as ControlBulkAction),
        );
    }, [tenantSlug, allowedBulkActions, t, CONTROL_STATUS_OPTIONS]);

    // ─── Deleted-control lifecycle actions (#3) ───
    // Restore un-deletes a soft-deleted control; Purge permanently removes it.
    // Both hit the existing per-control routes (restoreControl / purgeControl).
    const handleRestore = useCallback(
        async (id: string) => {
            try {
                const res = await fetch(apiUrl(`/controls/${id}/restore`), {
                    method: 'POST',
                    credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('Restore failed');
                await controlsMutate();
                toast.success(t('deleted.restoredToast'));
            } catch {
                toast.error(t('deleted.restoreFailed'));
            }
        },
        [apiUrl, controlsMutate, toast, t],
    );
    const closePurge = useCallback(() => {
        setPurgeTarget(null);
        setConfirmText('');
        setPurging(false);
        setPurgeError(null);
    }, []);
    const confirmPurge = useCallback(async () => {
        if (!purgeTarget) return;
        setPurging(true);
        setPurgeError(null);
        try {
            const res = await fetch(apiUrl(`/controls/${purgeTarget.id}/purge`), {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                let message = t('deleted.purgeFailed');
                try {
                    const errBody = (await res.json()) as { error?: { message?: string } };
                    if (errBody?.error?.message) message = errBody.error.message;
                } catch {
                    /* not JSON */
                }
                setPurgeError(message);
                setPurging(false);
                return;
            }
            closePurge();
            await controlsQuery.mutate();
        } catch (err) {
            setPurgeError(err instanceof Error ? err.message : t('deleted.purgeFailed'));
            setPurging(false);
        }
    }, [purgeTarget, apiUrl, controlsQuery, t, closePurge]);
    // The confirm token is the control code/annexId when present, else its name.
    const purgeConfirmToken =
        purgeTarget?.code ?? purgeTarget?.annexId ?? purgeTarget?.name ?? '';

    // Stable DataTable callbacks — see the apiUrl/tenantHref note above.
    // `handleRowClick` is the double-click→navigate handler; keeping it
    // referentially stable means a selection-toggle re-render does not
    // rebuild the table's column model.
    const handleRowClick = useCallback(
        (row: Row<ControlListItem>) =>
            router.push(tenantHref(`/controls/${row.original.id}`)),
        [router, tenantHref],
    );
    const getControlRowId = useCallback((c: ControlListItem) => c.id, []);
    const handleRowPrefetch = useCallback(
        (row: Row<ControlListItem>) => {
            router.prefetch(tenantHref(`/controls/${row.original.id}`));
            prefetchData(CACHE_KEYS.controls.pageData(row.original.id));
        },
        [router, tenantHref, prefetchData],
    );
    // Controls PR-1 — expandable rows: a control with tasks shows a chevron;
    // expanding renders its tasks inline (lazy-fetched). Stable refs so a
    // selection/expand re-render doesn't rebuild the table model.
    const getControlCanExpand = useCallback(
        (row: Row<ControlListItem>) => (row.original.taskTotal ?? 0) > 0,
        [],
    );
    // Controls PR-2 — quick-view side panel. Clicking a control NAME opens the
    // control quick-view; clicking a task (inline row OR panel) opens the task
    // quick-view. Both surface in the docked AsidePanel (Sheet < xl).
    const [selectedControl, setSelectedControl] = useState<ControlListItem | null>(null);
    const [selectedTask, setSelectedTask] = useState<ControlTask | null>(null);
    // Bumped on every panel save so the inline ControlTaskRows re-fetch and
    // drop stale task title/status/owner/evidence (its fetch keys on this).
    const [taskRefreshToken, setTaskRefreshToken] = useState(0);
    const openControlQuickView = useCallback((c: ControlListItem) => {
        setSelectedTask(null);
        setSelectedControl(c);
    }, []);
    const closeQuickView = useCallback(() => {
        setSelectedTask(null);
        setSelectedControl(null);
    }, []);
    // After an inline panel edit, refresh the controls list so the new
    // name / owner / category show without a manual reload…
    const handlePanelSaved = useCallback(async () => {
        const updated = await controlsQuery.mutate();
        // …and re-seed the OPEN quick-view's backing row (#7a). Previously
        // `selectedControl` was a snapshot captured on row-click, so an
        // auto-saved edit left the panel header + the selected row showing the
        // pre-save values. `mutate()` resolves to the revalidated payload; find
        // the fresh row by id. The panel key is `qv-control-${id}` (unchanged),
        // so this re-renders the panel with fresh props without remounting.
        const rows = Array.isArray(updated) ? updated : updated?.rows;
        if (rows) {
            setSelectedControl((cur) =>
                cur ? rows.find((r) => r.id === cur.id) ?? cur : cur,
            );
        }
        // Revalidate any expanded inline task sub-rows too.
        setTaskRefreshToken((n) => n + 1);
    }, [controlsQuery]);
    // PR-3 — Escape closes the quick-view on the docked rail (≥xl). On < xl the
    // Sheet owns Escape natively (the global-scope hook is skipped while an
    // overlay is mounted) and its dismiss fires onClose → closeQuickView too.
    useKeyboardShortcut(['Escape'], closeQuickView, {
        enabled: !!(selectedControl || selectedTask),
        scope: 'global',
        description: t('list.closeQuickView'),
    });
    // Evidence cell renderer shared with the inline task sub-rows so their
    // Evidence column matches the control row's exactly (same Paperclip glyph,
    // size, and count colouring). Kept here because the lucide import lives on
    // this page, not in ControlTaskRows.
    const renderTaskEvidence = useCallback(
        (n: number) => (
            <span
                className={`inline-flex items-center gap-1 text-xs ${n > 0 ? 'text-content-emphasis' : 'text-content-subtle'}`}
            >
                <Paperclip
                    size={12}
                    className={n > 0 ? 'text-content-success' : 'text-content-subtle'}
                    aria-hidden
                />
                {n}
            </span>
        ),
        [],
    );
    // Aligned task sub-rows: real <tr>/<td> rows whose cells line up under the
    // parent CONTROL columns (category / status / owner / evidence). The
    // inherited category uses the SAME `categorizeControl` value the Category
    // column shows.
    const renderControlTaskSubRows = useCallback(
        (row: Row<ControlListItem>, columnIds: string[]) => (
            <ControlTaskRows
                tenantSlug={tenantSlug}
                controlId={row.original.id}
                controlCategory={categorizeControl(row.original)?.category ?? null}
                columnIds={columnIds}
                renderEvidence={renderTaskEvidence}
                onTaskClick={setSelectedTask}
                refreshToken={taskRefreshToken}
            />
        ),
        [tenantSlug, renderTaskEvidence, taskRefreshToken],
    );
    const handleRowSelectionChange = useCallback(
        (rows: Row<ControlListItem>[]) =>
            setRowSelection(
                Object.fromEntries(rows.map((r) => [r.id, true])),
            ),
        [],
    );

    // ─── Helpers ───

    const taskStats = useCallback((c: ControlListItem) => {
        // Unified linked-task counts from `listControls` (TaskLink
        // CONTROL link OR the controlId FK). The legacy ControlTask
        // stack was removed (TP-2).
        const total = c.taskTotal ?? 0;
        const done = c.taskDone ?? 0;
        return { total, done };
    }, []);

    // ── Column definitions ──
    const controlColumns = useMemo(() => createColumns<ControlListItem>([
        {
            accessorFn: (c) => c.code || c.annexId || '',
            id: 'code',
            header: t('colHeaders.code'),
            cell: ({ getValue }) => (
                <span className="text-xs text-content-muted font-mono">{getValue<string>() || '—'}</span>
            ),
        },
        {
            accessorKey: 'name',
            header: t('colHeaders.title'),
            // PR-2/PR-4 — single-click the NAME opens the control quick-view
            // side panel (mirrors the Assets title-button pattern) AND expands
            // the control's inline task rows in the table, so the related
            // tasks list appears right below the control (tasks live in the
            // table, not the panel). It's a <button>, so the table's
            // isClickOnInteractiveChild() skips the row's select/navigate
            // handlers: name-click = quick-view + expand tasks; row
            // single-click = select; row double-click = full detail page.
            cell: ({ row }) => (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        openControlQuickView(row.original);
                        if (row.getCanExpand()) row.toggleExpanded(true);
                    }}
                    className="inline-block max-w-full cursor-pointer truncate text-left align-middle rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    id={`control-link-${row.original.id}`}
                    data-testid={`control-title-${row.original.id}`}
                >
                    <TableTitleCell tintOn="self">{row.original.name}</TableTitleCell>
                </button>
            ),
        },
        {
            // Framework column — split out of `category` (2026-06-07).
            // The framework a control belongs to, derived via
            // `categorizeControl`, as a small uppercase tag.
            id: 'framework',
            header: t('colHeaders.framework'),
            accessorFn: (c) => categorizeControl(c)?.frameworkLabel || '',
            cell: ({ row }) => {
                const label = categorizeControl(row.original)?.frameworkLabel;
                if (!label) {
                    return <span className="text-xs text-content-subtle">—</span>;
                }
                return (
                    <span className="inline-flex items-center rounded border border-border-subtle bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content-muted">
                        {label}
                    </span>
                );
            },
        },
        {
            // Category badge only — the framework now lives in its own
            // `framework` column (split 2026-06-07). `categorizeControl`:
            // ISO 27001 → granular Annex domain; other frameworks → their
            // persisted TSC / section category. No category → `—`.
            id: 'category',
            header: t('colHeaders.category'),
            accessorFn: sortAccessors.category,
            cell: ({ row }) => {
                const cat = categorizeControl(row.original);
                if (!cat) {
                    return <span className="text-xs text-content-subtle">—</span>;
                }
                return <StatusBadge size="sm">{cat.category}</StatusBadge>;
            },
        },
        {
            accessorKey: 'status',
            header: t('colHeaders.status'),
            cell: ({ row }) => {
                const c = row.original;
                // 2026-05-19 — inline-edit dropdown retired. The
                // cell is now a read-only badge; status changes
                // route through the per-control detail page (Edit
                // Control sheet) or the bulk-set toolbar actions
                // (Mark Implemented / Needs Review / Not Applicable).
                // Keeping the well-known `#status-pill-{id}` id on
                // the badge so existing E2E selectors stay valid.
                return (
                    <StatusBadge
                        id={`status-pill-${c.id}`}
                        variant={STATUS_BADGE[c.status] || 'neutral'}
                        size="sm"
                    >
                        {STATUS_LABELS[c.status] || c.status}
                    </StatusBadge>
                );
            },
        },
        {
            accessorKey: 'applicability',
            header: t('colHeaders.applicability'),
            cell: ({ row }) => {
                const c = row.original;
                // 2026-05-19 — inline-edit dropdown retired alongside
                // Status (see comment above). Applicability changes
                // route through the per-control detail page; the
                // justification modal is preserved there. Selector
                // id `#applicability-pill-{id}` kept for E2E parity.
                // R2-P4 — three states, not two. The enum only holds
                // APPLICABLE / NOT_APPLICABLE, but a control that was never
                // assessed (applicabilityDecidedAt == null) is stored as
                // APPLICABLE and must read distinctly from a deliberately
                // decided one — else "assessed" and "unassessed" look alike.
                // Shared 3-state derivation — the SAME `applicabilityState`
                // whose SQL twin (`applicabilityStateWhere`) backs the server
                // filter, so the column and the picker can never disagree.
                const applState = applicabilityState(c);
                const applicabilityCell: { variant: StatusBadgeVariant; label: string } =
                    applState === 'NOT_APPLICABLE'
                        ? { variant: 'warning', label: t('list.na') }
                        : applState === 'APPLICABLE'
                          ? { variant: 'success', label: t('list.yes') }
                          : { variant: 'neutral', label: t('list.notAssessed') };
                return (
                    <StatusBadge
                        id={`applicability-pill-${c.id}`}
                        variant={applicabilityCell.variant}
                        size="sm"
                    >
                        {applicabilityCell.label}
                    </StatusBadge>
                );
            },
        },
        {
            // Composite control-health verdict badge — the batched
            // `/controls/health-verdicts` map keyed by control id. Muted
            // '—' until the map resolves (or if a control isn't in it).
            id: 'health',
            // Header carries the measured-only caveat: the verdict reflects
            // MEASURED test operating-effectiveness only. Declared effectiveness
            // informs valuation/ROI, not health — so a control with declared 95
            // and no tests reads UNKNOWN here while ROI shows 95%.
            header: () => (
                <span className="inline-flex items-center gap-1">
                    {t('list.healthColumn')}
                    <InfoTooltip content={t('dashboard.controlHealthMeasuredOnly')} />
                </span>
            ),
            accessorFn: (c) => verdictMap.get(c.id) ?? '',
            cell: ({ row }) => {
                const v = verdictMap.get(row.original.id);
                if (!v) {
                    return <span className="text-xs text-content-subtle">—</span>;
                }
                return (
                    <StatusBadge size="sm" variant={CONTROL_HEALTH_VERDICT_VARIANT[v]}>
                        {t(`health.verdict.${v}` as Parameters<typeof t>[0])}
                    </StatusBadge>
                );
            },
        },
        {
            id: 'owner',
            header: t('colHeaders.owner'),
            accessorFn: (c) => ownerDisplayName(c.owner?.name, c.owner?.email) || '—',
            cell: ({ row }) => {
                const c = row.original;
                // Name-only (or email local-part as username) — the full email
                // address is no longer shown in the Owner column.
                const display = ownerDisplayName(c.owner?.name, c.owner?.email);
                if (!display) {
                    return <span className="text-xs text-content-subtle">—</span>;
                }
                const initial = display.charAt(0).toUpperCase();
                return (
                    <span
                        className="inline-flex items-center gap-1.5"
                        data-testid={`control-owner-${c.id}`}
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
            id: 'frequency',
            header: t('colHeaders.frequency'),
            accessorFn: (c) => c.frequency ? FREQ_LABELS[c.frequency] || c.frequency : '—',
            cell: ({ getValue }) => (
                <span className="text-xs text-content-muted">{getValue<string>()}</span>
            ),
        },
        {
            id: 'tasks',
            header: t('colHeaders.tasks'),
            accessorFn: (c) => {
                const ts = taskStats(c);
                return `${ts.done}/${ts.total}`;
            },
            cell: ({ row }) => {
                const ts = taskStats(row.original);
                return (
                    <span className={ts.total > 0 && ts.done === ts.total ? 'text-content-success text-xs' : 'text-content-muted text-xs'}>
                        {ts.done}/{ts.total}
                    </span>
                );
            },
        },
        {
            id: 'evidence',
            header: t('colHeaders.evidence'),
            // R2-P4 — links + direct Evidence, matching the detail Evidence
            // tab badge (was evidenceLinks alone → the two diverged).
            accessorFn: (c) => (c._count?.evidenceLinks ?? 0) + (c._count?.evidenceControlLinks ?? 0),
            cell: ({ getValue, row }) => {
                const n = getValue<number>();
                return (
                    <span
                        className={`inline-flex items-center gap-1 text-xs ${n > 0 ? 'text-content-emphasis' : 'text-content-subtle'}`}
                        data-testid={`control-evidence-${row.original.id}`}
                    >
                        <Paperclip
                            size={12}
                            className={n > 0 ? 'text-content-success' : 'text-content-subtle'}
                            aria-hidden
                        />
                        {n}
                    </span>
                );
            },
        },
        // Lifecycle actions — only present in the "Deleted controls" view.
        // For a soft-deleted row: a neutral "Deleted" badge + Restore / Purge
        // + the who/when audit line. (Live rows never reach this column — the
        // whole column is absent unless showDeleted.)
        ...(showDeleted
            ? [
                  {
                      id: 'lifecycle',
                      header: t('deleted.actions'),
                      cell: ({ row }: { row: { original: ControlListItem } }) => {
                          const c = row.original;
                          if (!c.deletedAt) {
                              return <span className="text-content-muted">—</span>;
                          }
                          return (
                              <div className="flex flex-col gap-tight">
                                  <div className="flex items-center gap-tight">
                                      {/* Plain muted pill (deliberately not the
                                          status-badge primitive) — the row
                                          already lives in the Deleted view, so
                                          this stays quiet chrome and keeps the
                                          per-file badge budget. */}
                                      <span className="inline-flex items-center rounded border border-border-subtle bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content-muted">
                                          {t('deleted.badge')}
                                      </span>
                                      <Button
                                          type="button"
                                          variant="secondary"
                                          size="xs"
                                          onClick={(e) => {
                                              e.stopPropagation();
                                              void handleRestore(c.id);
                                          }}
                                          text={t('deleted.restore')}
                                      />
                                      <Button
                                          type="button"
                                          variant="destructive"
                                          size="xs"
                                          onClick={(e) => {
                                              e.stopPropagation();
                                              setPurgeTarget(c);
                                          }}
                                          text={t('deleted.purge')}
                                      />
                                  </div>
                                  <span className="text-xs text-content-subtle">
                                      {t('deleted.byWhen', {
                                          who: deletedByLabel(c.deletedByUserId),
                                          when: formatDateTime(c.deletedAt),
                                      })}
                                  </span>
                              </div>
                          );
                      },
                  },
              ]
            : []),
    ]), [appPermissions, tenantHref, taskStats, openControlQuickView, verdictMap, showDeleted, handleRestore, deletedByLabel, t]);

    // `orderColumns` spreads its input, so it returns a NEW array every
    // call — calling it inline in the `table` object would undo the memo
    // above and rebuild the table model on every render.
    const orderedControlColumns = useMemo(
        () => orderColumns(controlColumns),
        [orderColumns, controlColumns],
    );

    // The bulk-action UI lives in the DataTable's header-row selection
    // toolbar via the canonical <BulkActionBar> (`selectionControls`) — the
    // row-select action bar that pops over the column-names row. It carries
    // the full status picker + assign-owner, replacing the former
    // three-verb `batchActions` (and the per-id N+1 they drove).

    // Browse rail — category accordion. The loaded controls are
    // grouped by their framework-native category, derived via
    // `categorizeControl`: ISO 27001 → granular Annex domain (Access
    // control, Physical & environmental, Cryptography, …); other
    // frameworks → their persisted TSC / section category. Each
    // category is a collapsible <Accordion> section TAGGED with the
    // framework it belongs to; expanding it reveals the controls in
    // that category, each carrying a status tag and linking to its
    // detail page. The rail NAVIGATES — it no longer filters the table.
    // When the tenant's controls span multiple frameworks, each
    // framework's categories appear as their own tagged groups.
    const categoryGroups = useMemo(() => {
        type Group = {
            key: string;
            frameworkKey: string;
            frameworkLabel: string;
            category: string;
            controls: ControlListItem[];
        };
        const map = new Map<string, Group>();
        for (const c of controls) {
            const cat = categorizeControl(c);
            if (!cat) continue;
            const key = `${cat.frameworkKey}::${cat.category}`;
            let g = map.get(key);
            if (!g) {
                g = { key, ...cat, controls: [] };
                map.set(key, g);
            }
            g.controls.push(c);
        }
        // Stable order: framework label A→Z, then the canonical ISO
        // domain order for ISO groups, then descending control count,
        // then category name as the final tie-break.
        const isoIndex = (name: string) => {
            const i = ISO27001_DOMAIN_ORDER.indexOf(name);
            return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };
        return Array.from(map.values()).sort((a, b) => {
            if (a.frameworkLabel !== b.frameworkLabel)
                return a.frameworkLabel.localeCompare(b.frameworkLabel);
            const ai = isoIndex(a.category);
            const bi = isoIndex(b.category);
            if (ai !== bi) return ai - bi;
            if (b.controls.length !== a.controls.length)
                return b.controls.length - a.controls.length;
            return a.category.localeCompare(b.category);
        });
    }, [controls]);

    const railRowClass =
        'flex w-full items-center justify-between gap-tight rounded-md px-2 py-1 text-left text-xs text-content-default hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:bg-bg-muted';

    // Controlled accordion — lets the "Expand all / Collapse all"
    // toggle drive every section at once.
    const [openSections, setOpenSections] = useState<string[]>([]);
    const allSectionKeys = useMemo(
        () => categoryGroups.map((g) => g.key),
        [categoryGroups],
    );
    const allExpanded =
        allSectionKeys.length > 0 &&
        openSections.length === allSectionKeys.length;

    // UI-13: the "Expand all / Collapse all" toggle — a single chevron that
    // points DOWN when every section is expanded, LEFT when collapsed. It now
    // rides the AsidePanel header (to the LEFT of the panel collapse toggle)
    // via the `headerActions` slot, rather than sitting below the header in the
    // content. Canonical Tooltip carries the hint (not a popover trigger, so a
    // plain wrap is safe). Only meaningful when there are sections to toggle.
    const browseExpandAll =
        categoryGroups.length > 0 ? (
            <Tooltip content={allExpanded ? t('list.collapseAll') : t('list.expandAll')}>
                <button
                    type="button"
                    onClick={() =>
                        setOpenSections(allExpanded ? [] : allSectionKeys)
                    }
                    className="flex items-center justify-center rounded-md p-1 text-content-muted hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-4 [&_svg]:w-4"
                    data-testid="controls-browse-expand-all"
                    aria-label={allExpanded ? t('list.collapseAll') : t('list.expandAll')}
                    aria-expanded={allExpanded}
                >
                    {allExpanded ? <ChevronDown /> : <ChevronLeft />}
                </button>
            </Tooltip>
        ) : undefined;

    const browseAside = (
        <AsidePanel
            title={t('list.browse')}
            surfaceKey="controls-list-browse"
            defaultWidth={480}
            // The Browse rail starts collapsed-to-spine — the table is the
            // primary surface; the user opens Browse when they want to navigate
            // by category. (Persists per-user once toggled.)
            defaultCollapsed
            headerActions={browseExpandAll}
            icon={<AppIcon name="controls" size={16} />}
        >
            <div data-testid="controls-browse-aside" className="space-y-default">
                {categoryGroups.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-content-subtle">
                        {t('list.categorisedEmpty')}
                    </p>
                ) : (
                    <>
                        {/* Scroll stays INSIDE the browse box (viewport-
                            clamped) so an all-expanded rail doesn't push
                            the whole page — mirrors the table's
                            fillBody scroll. */}
                        <div className="max-h-[calc(100vh-15rem)] overflow-y-auto pr-1">
                            <Accordion
                                type="multiple"
                                value={openSections}
                                onValueChange={setOpenSections}
                                className="space-y-0"
                            >
                                {categoryGroups.map((g) => (
                            <AccordionItem
                                key={g.key}
                                value={g.key}
                                density="compact"
                                data-category-group={g.key}
                            >
                                <AccordionTrigger size="sm" className="px-2">
                                    <span className="flex min-w-0 flex-1 items-center justify-between gap-tight pr-2">
                                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                                            <span className="truncate font-medium text-content-default">
                                                {g.category}
                                            </span>
                                            {g.frameworkLabel && (
                                                <span
                                                    className="text-[10px] font-medium uppercase tracking-wide text-content-subtle"
                                                    data-framework-tag={g.frameworkLabel}
                                                >
                                                    {g.frameworkLabel}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 tabular-nums text-content-subtle">
                                            {g.controls.length}
                                        </span>
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent size="sm">
                                    <ul
                                        className="flex flex-col gap-0.5 pb-1"
                                        role="list"
                                    >
                                        {g.controls.map((c) => (
                                            <li key={c.id}>
                                                <button
                                                    type="button"
                                                    className={railRowClass}
                                                    data-control-id={c.id}
                                                    onClick={() =>
                                                        router.push(
                                                            tenantHref(
                                                                `/controls/${c.id}`,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    <span className="truncate">
                                                        {c.code || c.annexId
                                                            ? `${c.code || c.annexId} · ${c.name}`
                                                            : c.name}
                                                    </span>
                                                    <StatusBadge
                                                        size="sm"
                                                        variant={
                                                            STATUS_BADGE[c.status] ||
                                                            'neutral'
                                                        }
                                                    >
                                                        {STATUS_LABELS[c.status] ||
                                                            c.status}
                                                    </StatusBadge>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </AccordionContent>
                            </AccordionItem>
                                ))}
                            </Accordion>
                        </div>
                    </>
                )}
            </div>
        </AsidePanel>
    );

    // AI Assist — mirror of Risks' co-pilot rail. Quiet (44px spine)
    // by default; the same `<AiAssistRail>` content + `/risks/ai`
    // destination as the Risks page so the panel reads as one
    // shared co-pilot across registers, not a stub.
    const aiAssistAside = appPermissions.controls.edit ? (
        <AsidePanel
            title={t('list.aiAssist')}
            surfaceKey="controls-list-ai"
            defaultCollapsed
            icon={<Sparkle3 className="h-4 w-4" />}
        >
            <AiAssistRail aiHref={tenantHref('/risks/ai')} />
        </AsidePanel>
    ) : null;

    // PR-2 — quick-view takeover. When a control name or a task is selected,
    // the docked rail (Sheet < xl) shows the quick-view INSTEAD of the default
    // browse/best-value/AI stack (Tidal-style); closing returns to the default
    // rail. `openOnMount` expands the rail / opens the Sheet immediately so the
    // panel "appears" on the click.
    //
    // The `key` includes the ENTITY ID because `openOnMount` runs in a
    // mount-only effect, and these panels share their tree position (and
    // surfaceKey) with the browse stack: without a distinct key React reuses
    // the in-place AsidePanel and openOnMount never re-fires on a collapsed
    // rail. That is an AsidePanel contract, and the only reason left.
    //
    // It used to ALSO be compensating for the inner Control/TaskEditPanel
    // seeding its form on mount only — switching control→control would have
    // left the previous row's values in the fields. Those panels are
    // controlled now (useAutosaveFields re-seeds when `seed` changes), so they
    // no longer need the remount.
    const quickViewAside = selectedTask ? (
        <AsidePanel
            key={`qv-task-${selectedTask.id}`}
            title={t('list.task')}
            surfaceKey="controls-quickview"
            // A wide dedicated PANEL for the tabbed editor — not the narrow
            // browse/assist rail width.
            defaultWidth={520}
            openOnMount
            onClose={closeQuickView}
        >
            <TaskEditPanel
                tenantSlug={tenantSlug}
                task={selectedTask}
                canWrite={appPermissions.tasks.edit}
                onClose={closeQuickView}
                onSaved={handlePanelSaved}
            />
        </AsidePanel>
    ) : selectedControl ? (
        <AsidePanel
            key={`qv-control-${selectedControl.id}`}
            title={t('list.control')}
            surfaceKey="controls-quickview"
            // A wide dedicated PANEL for the tabbed editor — not the narrow
            // browse/assist rail width.
            defaultWidth={520}
            openOnMount
            onClose={closeQuickView}
        >
            <ControlEditPanel
                tenantSlug={tenantSlug}
                control={selectedControl}
                canWrite={appPermissions.controls.edit}
                onClose={closeQuickView}
                onSaved={handlePanelSaved}
            />
        </AsidePanel>
    ) : null;

    // Compose the aside slot — the quick-view takes over when active; otherwise
    // the always-on browse rail + best-value + AI assist co-pilot stack
    // vertically inside the docked third column.
    const composedAside = quickViewAside ? (
        // `xl:h-full xl:min-h-0` passes the bounded aside height down to the
        // panel card so its content scrolls (the card caps via max-h-full).
        <div className="flex flex-col gap-default xl:h-full xl:min-h-0">{quickViewAside}</div>
    ) : (
        <div className="flex flex-col gap-default xl:h-full xl:min-h-0">
            {browseAside}
            {aiAssistAside}
        </div>
    );

    return (
        <EntityListPage<ControlListItem>
            className="animate-fadeIn gap-section"
            aside={composedAside}
            banner={
                <>
                    <TruncationBanner truncated={truncated} />
                    {/* #6a — the Health column falls back to '—' when the
                        batched verdict read fails; surface the error so the
                        dash reads as "couldn't load", not "no data". */}
                    {verdictsQuery.error && !showDeleted && (
                        <InlineNotice variant="warning" id="controls-health-error">
                            {t('health.loadError')}
                        </InlineNotice>
                    )}
                    {flaggedIds && (
                        <InlineNotice variant="info" id="flagged-controls-banner">
                            {t('list.flaggedShowing', { count: controls.length })}
                            {' · '}
                            <Link
                                href={tenantHref('/controls')}
                                id="flagged-controls-clear"
                                className="font-medium underline hover:no-underline"
                            >
                                {t('list.flaggedClear')}
                            </Link>
                        </InlineNotice>
                    )}
                </>
            }
            header={{
                breadcrumbs: [
                    // Was `tenantHref('/')` — that resolves to `/t/<slug>/`
                    // which has no page.tsx and 404s. Next.js auto-prefetches
                    // every visible <Link>, so the failing prefetch kept the
                    // page in a perpetual "fetch in flight" state and made
                    // `waitForLoadState('networkidle')` hang for the full
                    // 180s test timeout in every Playwright spec on this
                    // page (create-control-modal, controls-filter-epic53,
                    // control-edit-modal, controls-enhanced).
                    { label: t('list.breadcrumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('list.breadcrumbControls') },
                ],
                title: (
                    <>
                        <AppIcon name="controls" className="inline-block mr-2 align-text-bottom" />
                        {' '}
                        {t('list.pageTitle')}
                    </>
                ),
                // Roadmap-2 PR-4 + PR-11 — editorial framing
                // replaces the count chip. Pages still surface
                // the count in the table body (DataTable shows
                // row count); the header line carries the
                // editorial intent.
                description: t('listDescription'),
                // Item 4/5 — the create button moved to the toolbar's
                // leading slot and the nav icons moved into the toolbar's
                // actions slot, so the page header action cluster is empty.
            }}
            kpis={
                /* R23-PR-D — KPI strip above the filter toolbar.
                   EntityListPage owns the placement; the page owns
                   the KPI definitions + the card content. Hidden in the
                   Deleted view — the Total/Implemented/In-progress/Not-started
                   counts + their click-to-filter describe the LIVE set, so
                   surfacing them over soft-deleted rows would mislead. */
                showDeleted ? undefined : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    {visibleKpiCards.map((card) => {
                        // Render config per KPI id — the gear owns which
                        // cards show + their order (visibleKpiCards).
                        const cfg: Record<
                            string,
                            {
                                value: number;
                                tone?:
                                    | 'success'
                                    | 'attention'
                                    | 'critical'
                                    | 'default';
                                sparkline?: typeof controlTrends.total;
                            }
                        > = {
                            total: {
                                value: totalControls,
                                sparkline: controlTrends.total,
                            },
                            implemented: {
                                value: implementedControls,
                                tone: 'success',
                                sparkline: controlTrends.implemented,
                            },
                            inProgress: {
                                value: inProgressControls,
                                tone: 'attention',
                                sparkline: controlTrends.inProgress,
                            },
                            notStarted: {
                                value: notStartedControls,
                                tone:
                                    notStartedControls > 0
                                        ? 'critical'
                                        : 'default',
                                sparkline: controlTrends.notStarted,
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
                                sparklineVariant={sparkColors[card.id as keyof typeof sparkColors]}
                                sparklineDomain={centeredSparklineDomain(c.sparkline)}
                                onClick={() =>
                                    toggleControlKpi(card.id as ControlKpiId)
                                }
                                selected={activeControlKpi === card.id}
                            />
                        );
                    })}
                </div>
                )
            }
            filters={{
                defs: liveFilterDefs,
                searchId: 'controls-search',
                searchPlaceholder: t('searchPlaceholder'),
                // Item 4 — primary create button lives in the toolbar's
                // leading slot (left of the Filter trigger).
                toolbarLeading: appPermissions.controls.create ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        id="new-control-btn"
                        onClick={() => setIsCreateOpen(true)}
                    >
                        {t('addControl')}
                    </Button>
                ) : undefined,
                // The secondary navigation folds into ONE labelled "Views ▾"
                // menu; only the page dashboard keeps a standalone icon, to
                // the right of the trigger. The gears stay outside and one
                // rung smaller — they are table chrome, not views.
                toolbarActions: (
                    <>
                        <ViewsMenu
                            id="controls-views-menu"
                            groups={[
                                {
                                    id: 'views',
                                    items: [
                                        // Sankey is read-only and informational —
                                        // it stays outside the create-permission
                                        // gate so READERs can still glance at the
                                        // asset → risk → control flow.
                                        {
                                            id: 'controls-sankey-btn',
                                            label: t('list.sankeyFlow'),
                                            icon: <AppIcon name="share" size={16} />,
                                            href: tenantHref('/controls/sankey'),
                                        },
                                        appPermissions.controls.create && {
                                            id: 'install-templates-btn',
                                            label: t('list.installTemplates'),
                                            icon: <AppIcon name="templates" size={16} />,
                                            href: tenantHref('/controls/templates'),
                                        },
                                        // #3 — Deleted-controls view. Admin only:
                                        // only admins can Restore / Purge (and see
                                        // soft-deleted rows) server-side.
                                        canAdmin && {
                                            id: 'controls-show-deleted-toggle',
                                            label: t('deleted.toggle'),
                                            icon: <Trash className="size-4" />,
                                            onSelect: () => setShowDeleted((v) => !v),
                                            selected: showDeleted,
                                        },
                                    ],
                                },
                            ]}
                        />
                        {/* R2-P3 — the controls dashboard is a read-only KPI
                            view; ungated from controls.create so READERs
                            (who can't create) can still see posture. Only the
                            template-install action stays create-gated. */}
                        <Tooltip content={t('list.controlsDashboard')}>
                            <Link href={tenantHref('/controls/dashboard')} aria-label={t('list.controlsDashboard')} className={buttonVariants({ variant: 'secondary', size: 'icon' })} id="controls-dashboard-btn">
                                <AppIcon name="dashboard" size={16} />
                            </Link>
                        </Tooltip>
                        {columnsDropdown}
                        {filtersDropdown}
                    </>
                ),
            }}
            table={{
                // Sliced data via useThresholdLoadMore so the table never
                // paints more than the windowed rows at once; the
                // `onReachEnd` sentinel (below) appends the next batch on
                // scroll — load-on-scroll, no "Load more" button.
                data: visibleControls,
                columns: orderedControlColumns,
                loading,
                // #6a — surface a failed list read. Previously
                // `controlsQuery.error` was never read, so a 500 fell through
                // to the "No controls yet · install a framework" empty state
                // (an error is not "no data"). DataTable renders its error
                // chrome instead of the empty state when `error` is set.
                error: controlsQuery.error ? t('list.loadError') : undefined,
                getRowId: getControlRowId,
                // PR-1 — sortable headers, matching the org-level
                // tables (with up/down arrow indicators baked into
                // the shared table primitive).
                sortableColumns,
                sortBy,
                sortOrder,
                onSortChange: ({ sortBy: nextBy, sortOrder: nextOrder }) => {
                    setSortBy(nextBy);
                    setSortOrder(nextOrder);
                },
                // Epic 68 — Controls page is the canonical opt-out
                // for auto-virtualization. Per product directive the
                // existing card scrolling on Controls stays as it is;
                // bespoke per-row affordances + the JS whole-row clip
                // depend on the standard <table> layout.
                virtualize: false,
                getRowCanExpand: getControlCanExpand,
                renderAlignedSubRows: renderControlTaskSubRows,
                // Load-on-scroll: auto-append the next windowed batch as
                // the user nears the bottom. Undefined when every row is
                // already visible so the sentinel unmounts. Replaces the
                // old "Load more controls" button.
                onReachEnd: hasMoreControls ? loadMoreControls : undefined,
                onRowClick: handleRowClick,
                onRowPrefetch: handleRowPrefetch,
                emptyState: showDeleted && !hasActive ? (
                    // Deleted view with nothing soft-deleted — no "install a
                    // framework" CTA (you don't create a deleted control).
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('deleted.emptyTitle')}
                        description={t('deleted.emptyDesc')}
                    />
                ) : hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('empty.filterTitle')}
                        description={t('empty.filterDesc')}
                        secondaryAction={{
                            label: t('empty.clearFilters'),
                            onClick: () => clearAll(),
                        }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('empty.noRecordsTitle')}
                        description={t('empty.recordsDesc')}
                        primaryAction={{
                            // Steer to the posture-feeding path: installing a
                            // framework writes controlRequirementLink and
                            // counts toward every framework's coverage/
                            // readiness. The raw template library (which the
                            // secondary points at) is the escape hatch.
                            label: t('empty.installFramework'),
                            href: tenantHref('/frameworks'),
                        }}
                        secondaryAction={{
                            label: t('empty.installTemplates'),
                            href: tenantHref('/controls/templates'),
                        }}
                    />
                ),
                resourceName: (p) => (p ? 'controls' : 'control'),
                columnVisibility,
                onColumnVisibilityChange: setColumnVisibility,
                'data-testid': 'controls-table',
                className: 'hover:bg-bg-muted',
                // Selection is page-controlled; the canonical BulkActionBar
                // renders in the header-row selection toolbar via
                // `selectionControls`. For viewers without edit permission,
                // selection is left off entirely (no checkboxes, no bar).
                selectionControls: canEditControls
                    ? () => (
                          <BulkActionBar
                              actions={controlBulkActions}
                              onApply={handleBulkApply}
                              applying={bulkApplying}
                              selectedCount={selectedIds.length}
                              entityLabel={t('bulk.entityLabel')}
                          />
                      )
                    : undefined,
                selectedRows: canEditControls ? rowSelection : undefined,
                onRowSelectionChange: canEditControls
                    ? handleRowSelectionChange
                    : undefined,
            }}
        >
            {/* Create Control Modal (Epic 54) */}
            <NewControlModal
                open={isCreateOpen}
                setOpen={setIsCreateOpen}
                tenantSlug={tenantSlug}
            />

            {/* #3 — Typed-confirmation purge modal. Purge is irreversible, so it
                requires typing the control code/name (the sanctioned pattern for
                permanent deletion, NOT the undo-toast). Mirrors AssetsClient. */}
            <Modal
                showModal={purgeTarget !== null}
                setShowModal={(o) => (o ? null : closePurge())}
            >
                <Modal.Header title={t('deleted.purgeTitle')} />
                <Modal.Body>
                    {purgeTarget && (
                        <div className="space-y-default">
                            <p className="text-sm text-content-default">
                                {t('deleted.purgeBody', { name: purgeConfirmToken })}
                            </p>
                            <FormField
                                label={t('deleted.purgeTypeToConfirm', {
                                    name: purgeConfirmToken,
                                })}
                                required
                            >
                                <Input
                                    value={confirmText}
                                    onChange={(e) => setConfirmText(e.target.value)}
                                    autoComplete="off"
                                    autoFocus
                                    placeholder={purgeConfirmToken}
                                />
                            </FormField>
                            {purgeError && (
                                <p className="text-sm text-content-error">{purgeError}</p>
                            )}
                        </div>
                    )}
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={closePurge}
                        text={t('new.cancel')}
                    />
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        loading={purging}
                        disabled={purging || confirmText.trim() !== purgeConfirmToken}
                        onClick={confirmPurge}
                        text={t('deleted.purge')}
                    />
                </Modal.Actions>
            </Modal>

        </EntityListPage>
    );
}

