'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useKpiTrends, buildKpiSparklines, buildKpiSparklineNullable, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { UserCombobox } from '@/components/ui/user-combobox';
import { ownerDisplayName } from '@/lib/owner-display';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { useUrlFilters } from '@/lib/hooks/useUrlFilters';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
// Both evidence modals were previously lazy-loaded via next/dynamic,
// but the JIT race in `next dev` made the modals occasionally fail to
// mount in serial-mode E2E runs (Playwright clicked the trigger before
// the chunk finished compiling). Static imports — the bundle cost is
// acceptable and the E2E suite becomes deterministic.
import { UploadEvidenceModal } from './UploadEvidenceModal';
import { EvidenceDetailSheet } from './EvidenceDetailSheet';
import { EditEvidenceModal } from './EditEvidenceModal';
import type { EditEvidenceInitial } from './EditEvidenceModal';
import { NewEvidenceTextModal } from './NewEvidenceTextModal';
import { NewEvidenceLinkModal } from './NewEvidenceLinkModal';
import { EvidenceBulkImportModal } from './EvidenceBulkImportModal';
import { RejectReasonModal } from './RejectReasonModal';
import { Popover } from '@/components/ui/popover';
import { CloudUpload, Note, Hyperlink, FileZip2 } from '@/components/ui/icons/nucleo';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import {
    DataTable,
    createColumns,
    useColumnsDropdown,
    sortRowsByDisplay,
    type SortAccessors,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    type CardDefinition,
    type FilterType,
} from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { useThresholdLoadMore, useToast } from '@/components/ui/hooks';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import {
    resolveFileTypeIcon,
} from '@/components/ui/file-type-icon';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { EvidenceGallery } from '@/components/ui/EvidenceGallery';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useCelebration } from '@/components/ui/hooks';
import { MILESTONES } from '@/lib/celebrations';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildEvidenceFilters,
    EVIDENCE_FILTER_KEYS,
    evidenceFreshnessLabels,
} from './filter-defs';
import { EVIDENCE_STATUS_VARIANT, evidenceStatusLabel } from './evidence-labels';
import {
    evidenceFreshnessBucket,
    reviewCurrencyAnchor,
    type EvidenceFreshnessBucket,
    type EvidenceRetentionMetrics,
} from '@/lib/evidence-review-currency';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Plus, Pen2, Download, BoxArchive, PaperPlane, Check, Xmark, CalendarRefresh, ShieldAlert, CircleHalfDottedClock } from '@/components/ui/icons/nucleo';
import { isScanServable, isScanInfected } from '@/lib/evidence-scan';
import { ownerLabel } from '@/lib/evidence-owner-label';

interface Permissions {
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
    canAudit: boolean;
    canExport: boolean;
}

// Moved to evidence-labels alongside the status LABELS, which were already
// shared. The tone was not, and the detail sheet's copy had lost
// PENDING_UPLOAD — so the same row badged differently in list vs sheet.
const STATUS_BADGE = EVIDENCE_STATUS_VARIANT;

// Shared icon-only action button (Edit / Archive / Download columns) —
// mirrors the control-table quick-edit affordance.
const ICON_ACTION_CLASS =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type RetentionFilter = 'active' | 'expiring' | 'archived';


type Tx = (key: string, values?: Record<string, string | number>) => string;

function getRetentionStatus(ev: EvidenceRow, now: Date | null, tx: Tx): { label: string; badge: StatusBadgeVariant; icon: string } {
    if (ev.isArchived) return { label: tx('list.retentionArchived'), badge: 'neutral', icon: '' };
    if (ev.expiredAt) return { label: tx('list.retentionExpired'), badge: 'error', icon: '' };
    if (ev.retentionUntil) {
        if (!now) return { label: tx('list.retentionActive'), badge: 'success', icon: '' };
        const until = new Date(ev.retentionUntil);
        const daysLeft = Math.ceil((until.getTime() - now.getTime()) / 86_400_000);
        if (daysLeft <= 0) return { label: tx('list.retentionExpired'), badge: 'error', icon: '' };
        if (daysLeft <= 30) return { label: tx('list.retentionExpiring', { days: daysLeft }), badge: 'warning', icon: '' };
        return { label: tx('list.retentionActive'), badge: 'success', icon: '' };
    }
    return { label: tx('list.retentionNoPolicy'), badge: 'neutral', icon: '—' };
}

// listEvidence → EvidenceRepository.list (evidenceListSelect). Cell/accessor/
// filter callbacks stay untyped (file-level disable above — the colon-any
// category); this types the query payload, mutation cache + column factory.
interface EvidenceRow {
    id: string;
    title: string;
    type: string;
    status: string;
    fileName: string | null;
    owner: string | null;
    ownerUserId: string | null;
    ownerUser?: { id: string; name: string | null; email: string | null } | null;
    folder: string | null;
    isArchived: boolean;
    expiredAt: string | null;
    deletedAt: string | null;
    retentionUntil: string | null;
    // EP-2 — review-currency drives the freshness signal + filter/KPIs.
    nextReviewDate: string | null;
    reviewCycle: string | null;
    updatedAt: string;
    dateCollected: string;
    fileRecordId: string | null;
    content: string | null;
    // EP-3 — persisted classification, now surfaced in the list.
    category: string | null;
    // EP-3 — many-to-many control links replaced the singular `control`.
    evidenceControlLinks: Array<{
        control: {
            id: string;
            name: string;
            annexId: string | null;
            code: string | null;
        };
    }>;
    fileRecord: { id: string; mimeType: string | null; scanStatus?: string | null } | null;
    /**
     * Tags on the row. FIXED — the row's Edit button now seeds
     * `EditEvidenceModal` with them (see the `tags:` mapping at the edit call
     * site below); this paragraph records why the field is declared here.
     *
     * The list select has always returned these (`evidenceListSelect` in
     * EvidenceRepository), but this interface did not declare them, so nothing
     * here could see them, and the row's Edit button seeded the modal without
     * them. `tags` is optional on `EditEvidenceInitial`, so that omission
     * type-checked, the field rendered empty, and saving reconciled the row's
     * tags to the empty set: every tag silently deleted. The detail sheet's
     * edit button always passed them, which is why the same modal behaved
     * correctly from there.
     */
    tags?: Array<{ tag: string }>;
}

/** EP-3 — condensed label for the linked-controls table cell. */
function controlLinksLabel(
    links: EvidenceRow['evidenceControlLinks'] | undefined | null,
): string {
    if (!links || links.length === 0) return '—';
    const first = links[0].control;
    const prefix = first.annexId || first.code || first.name;
    return links.length > 1 ? `${prefix} +${links.length - 1}` : prefix;
}

// Minimal control shape this page consumes (filter builder + upload modal).
// Sourced from controlListSelect; nullable to match the serialized payload.
interface EvidenceControlOption {
    id: string;
    name: string;
    code: string | null;
    annexId: string | null;
}

interface EvidenceClientProps {

    initialEvidence: EvidenceRow[];

    initialControls: EvidenceControlOption[];
    /**
     * EP-4 — SSR snapshot of the tenant-wide retention/KPI aggregate. Seeds
     * the KPI strips instantly and acts as SWR `fallbackData` for
     * `/evidence/retention` (the same usecase), so the KPI values reflect the
     * whole tenant and never diverge from the server metrics past the SSR cap.
     */
    initialMetrics: EvidenceRetentionMetrics;
    tenantSlug: string;
    permissions: Permissions;
    translations: Record<string, string>;
}

/**
 * Client island for evidence — handles all interactive features.
 * Data arrives pre-fetched from the server component, hydrated into React Query.
 *
 * Filter architecture (Epic 53):
 *   - `q`, `type`, `status`, `controlId` flow through `useFilterContext`
 *     (URL-synced via the shared context).
 *   - `tab` (retention view: active | expiring | archived) stays on
 *     `useUrlFilters` since it's a view selector, not a filter.
 */
export function EvidenceClient(props: EvidenceClientProps) {
    const filterCtx = useFilterContext([], EVIDENCE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <EvidencePageInner {...props} />
        </FilterProvider>
    );
}

function EvidencePageInner({ initialEvidence, initialControls, initialMetrics, tenantSlug, permissions, translations: t }: EvidenceClientProps) {
    // `tx` — next-intl for the strings not threaded via the server
    // `translations` prop (retention labels, bulk actions, KPI labels,
    // empty states, tooltips, toasts, …). The prop `t` stays intact.
    const tx = useTranslations('evidence');
    const tGroup = useTranslations('common.filterGroups');
    // Stabilise across renders so dependent useCallbacks don't get a
    // fresh identity every cycle (was a real exhaustive-deps warning).
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const { mutate: swrMutate } = useSWRConfig();
    const toast = useToast();

    // Retention-tab + view-mode selectors — deliberately kept separate from filter state.
    // `view`: list | gallery. URL-synced so a refresh / back-button preserves
    // the page shape, and toggling the view doesn't clobber the active filters
    // (filter state lives in `filterCtx`, not in `useUrlFilters`).
    //
    // R1-2b — `tab` used to live here too, written by a ToggleGroup. It is a
    // normal filter category now, so it lives in `filterCtx` with every other
    // filter. Two writers for one `?tab=` param is the bug this avoids: the
    // FilterProvider deletes every param it owns before re-serialising state,
    // so a `useUrlFilters`-owned `tab` would be dropped on any filter change.
    const { filters, setFilter } = useUrlFilters(['view']);
    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;

    // ─── Build the API query string from filter state + retention tab ───
    const fetchParams = useMemo(() => {
        const params = toApiSearchParams(state, { search });
        // `tab` rides in `state` now, so `toApiSearchParams` already carries
        // it. What it cannot carry is the DEFAULT: an unset bucket has always
        // meant `active`, and dropping the param would widen the default list
        // to include archived rows. Absent-means-active stays a page decision
        // rather than a filter-def one, because "no filter" is exactly what an
        // empty filter state should serialise to in the URL.
        if (!params.has('tab')) params.set('tab', 'active');
        return params;
    }, [state, search]);

    // ─── Epic 69 — SWR-first read for the evidence list ───
    //
    // Each filter combo gets its own cache entry via the
    // query-string suffix on the SWR key. The unfiltered baseline
    // is the registry's `list()`. Server-rendered initialEvidence
    // lands as `fallbackData` only when no filters / retention tab
    // is active — otherwise the hook fires a fresh request, mirroring
    // the prior "skip initialData when filters diverge" semantics.
    const anyFilterActive = hasActive || !!filters.tab;
    const evidenceKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs
            ? `${CACHE_KEYS.evidence.list()}?${qs}`
            : CACHE_KEYS.evidence.list();
    }, [fetchParams]);


    // PR-5 — API returns `{ rows, truncated }`; the Client pulls
    // `rows` for the table and `truncated` for the banner. SSR
    // initial wraps with `truncated: false` (cap is 5000, SSR cap is
    // 100, so the SSR slice never trips truncation by itself).
    // PR-5 — warm the detail-sheet data on row hover. Unlike the route-based
    // lists (controls/risks/…) the evidence "drill-in" is a client-side Sheet,
    // not a navigation — so there is no RSC route to prefetch, only the
    // `EvidenceDetailSheet`'s `useTenantSWR(CACHE_KEYS.evidence.detail(id))`
    // read to pre-populate. Warming it on hover means the sheet opens with the
    // record already in cache instead of flashing its loading state.
    const prefetchData = usePrefetchTenant();
    const evidenceQuery = useTenantSWR<CappedList<EvidenceRow>>(evidenceKey, {
        fallbackData: anyFilterActive
            ? undefined
            : { rows: initialEvidence, truncated: false },
    });
    const truncated = evidenceQuery.data?.truncated ?? false;

    // ─── Bulk actions (canonical BulkActionBar) ───
    // Approve, Assign owner, Delete. Bulk Approve is NOT a status bypass:
    // `bulkApproveEvidence` enforces the same reviewer tier, SUBMITTED
    // precondition and segregation-of-duties rule as the single-item
    // review (see the partition handling below).
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkApplying, setBulkApplying] = useState(false);
    const handleBulkApply = async (action: string, value: string) => {
        const ids = Array.from(selected);
        if (ids.length === 0 || !['assign', 'delete', 'approve'].includes(action)) return;
        setBulkApplying(true);
        try {
            const url =
                action === 'delete' ? apiUrl('/evidence/bulk/delete')
                : action === 'approve' ? apiUrl('/evidence/bulk/approve')
                : apiUrl('/evidence/bulk/assign');
            const body =
                action === 'assign'
                    ? { evidenceIds: ids, ownerUserId: value || null }
                    : { evidenceIds: ids };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(tx('list.bulkFailed'));
            // Bulk-approve is reviewer-gated: only SUBMITTED rows the
            // reviewer didn't author move to APPROVED. Surface what was
            // and wasn't touched so the reviewer isn't left guessing.
            if (action === 'approve') {
                const result = await res.json().catch(() => null) as
                    | { approved?: number; skippedNotSubmitted?: number; skippedSelfReview?: number }
                    | null;
                const approved = result?.approved ?? 0;
                const skippedNotSubmitted = result?.skippedNotSubmitted ?? 0;
                const skippedSelfReview = result?.skippedSelfReview ?? 0;
                const message = tx('list.bulkApproveResult', {
                    approved,
                    skippedNotSubmitted,
                    skippedSelfReview,
                });
                if (skippedNotSubmitted > 0 || skippedSelfReview > 0) {
                    toast.info(message);
                } else {
                    toast.success(message);
                }
            }
            await evidenceQuery.mutate();
            setSelected(new Set());
        } catch {
            // R5-P2 #3 — BulkActionBar calls onApply un-awaited, so a throw here
            // became an unhandled rejection and a failed bulk showed nothing.
            toast.error(tx('list.bulkFailed'));
        } finally {
            setBulkApplying(false);
        }
    };
    const evidenceBulkActions: BulkActionDef[] = useMemo(
        () => [
            // R5-P2 #3 — each bulk action is offered only to the tier the server
            // enforces: approve is reviewer-gated (ADMIN), assign/delete are
            // write-tier. A READER/AUDITOR sees none (selection is also disabled).
            ...(permissions.canAdmin ? [{
                value: 'approve',
                label: tx('list.bulkApprove'),
                confirm: {
                    tone: 'info' as const,
                    confirmLabel: tx('list.bulkApproveConfirm'),
                    description: tx('list.bulkApproveDesc'),
                },
            }] : []),
            ...(permissions.canWrite ? [{
                value: 'assign',
                label: tx('list.bulkAssign'),
                renderInput: ({ value, setValue, setLabel }: { value: string; setValue: (v: string) => void; setLabel: (l: string) => void }) => (
                    <UserCombobox
                        tenantSlug={tenantSlug}
                        selectedId={value || null}
                        onChange={(id, m) => {
                            setValue(id ?? '');
                            setLabel(ownerDisplayName(m?.name, m?.email) ?? '');
                        }}
                        forceDropdown
                        matchTriggerWidth
                        placeholder={tx('list.bulkAssignPlaceholder')}
                        className="w-full sm:w-44"
                        id="bulk-value-input"
                    />
                ),
            }] : []),
            ...(permissions.canWrite ? [{ value: 'delete', label: tx('list.bulkDelete'), confirm: true }] : []),
        ],
        [tenantSlug, tx, permissions.canAdmin, permissions.canWrite],
    );

    // Stabilise the array identity across renders so dependent hooks
    // (`useEffect` at line ~330 reads `evidence`) don't re-fire on
    // every render. Without the `useMemo` the `?? []` produces a new
    // empty array instance every cycle.

    const evidence: EvidenceRow[] = useMemo(
        () => evidenceQuery.data?.rows ?? [],
        [evidenceQuery.data],
    );

    const [controls] = useState<EvidenceControlOption[]>(initialControls);
    // Mirrors `fetchParams`' default so the notices and empty-states below
    // describe the bucket the server actually queried.
    const retentionFilter = (state.tab?.[0] || 'active') as RetentionFilter;
    const { celebrate } = useCelebration();
    const viewMode: 'list' | 'gallery' =
        filters.view === 'gallery' ? 'gallery' : 'list';
    const [showUpload, setShowUpload] = useState(false);

    // B5 — row-click detail sheet + edit modal.
    const [detailSheetOpen, setDetailSheetOpen] = useState(false);
    const [detailEvidenceId, setDetailEvidenceId] = useState<string | null>(null);
    // ep1 review gate — the evidence id whose row-level Reject prompt is
    // open (null = closed). The reason entered in the modal is threaded
    // through to `submitReview(..., 'REJECTED', reason)`.
    const [rejectRowId, setRejectRowId] = useState<string | null>(null);

    // R2-P2 — deep-link support: `?ev=<id>` opens that evidence record in the
    // detail sheet. Lets other surfaces (e.g. the control detail Evidence tab)
    // link to a specific record instead of dumping the user on the library.
    const searchParams = useSearchParams();
    useEffect(() => {
        const ev = searchParams.get('ev');
        if (ev) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDetailEvidenceId(ev);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDetailSheetOpen(true);
        }
    }, [searchParams]);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editInitial, setEditInitial] = useState<EditEvidenceInitial | null>(
        null,
    );

    // PART 1 — consolidated create menu. One primary trigger opens a
    // Popover.Menu offering the four creation surfaces; each item
    // mounts its own modal.
    const [createMenuOpen, setCreateMenuOpen] = useState(false);
    const [showTextModal, setShowTextModal] = useState(false);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [showBulkImport, setShowBulkImport] = useState(false);

    // Invalidate every cached evidence-list filter variant. SWR's
    // function-form `mutate()` matches by absolute URL prefix —
    // every key under `/api/t/{slug}/evidence` (with or without
    // query string) gets a background refetch.
    // Matches every cached evidence-list filter variant (the base URL
    // and any `?…` query-string sibling).
    const evidenceKeyMatcher = useCallback(
        (key: unknown): key is string => {
            const prefix = apiUrl(CACHE_KEYS.evidence.list());
            return (
                typeof key === 'string' &&
                (key === prefix || key.startsWith(`${prefix}?`))
            );
        },
        [apiUrl],
    );

    const invalidateEvidence = useCallback(
        () => swrMutate(evidenceKeyMatcher, undefined, { revalidate: true }),
        [swrMutate, evidenceKeyMatcher],
    );

    // Optimistically flip `isArchived` on the matching row across every
    // cached list variant, WITHOUT revalidating — so the row reacts
    // (e.g. drops out of the Active tab) the instant the button is
    // clicked, independent of refetch timing.
    const optimisticSetArchived = useCallback(
        (id: string, isArchived: boolean) =>
            swrMutate(
                evidenceKeyMatcher,
                (
                    current?: {
                        rows?: Record<string, unknown>[];
                        truncated?: boolean;
                    },
                ) =>
                    current
                        ? {
                              ...current,
                              rows: (current.rows ?? []).map((r) =>
                                  r.id === id ? { ...r, isArchived } : r,
                              ),
                          }
                        : current,
                { revalidate: false },
            ),
        [swrMutate, evidenceKeyMatcher],
    );

    // ─── Mutation: review workflow (Epic 69 — useTenantMutation) ───
    //
    // Migrated from React Query's `useMutation` + `onMutate` /
    // `onError` rollback hooks. The optimistic update flips the
    // matching row's status synchronously; SWR's `rollbackOnError`
    // default restores the prior list on failure. After success
    // SWR revalidates the current key, and `invalidateEvidence()`
    // fans out to sibling filter variants.
    // PR-5 — cache value is `CappedList<EvidenceRow>` (the API returns
    // `{ rows, truncated }`); preserve `truncated` and only rewrite `rows`.
    const reviewMutation = useTenantMutation<CappedList<EvidenceRow>, { id: string; action: string; comment: string }, unknown>({
        key: evidenceKey,
        mutationFn: async ({ id, action, comment }) => {
            const res = await fetch(apiUrl(`/evidence/${id}/review`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, comment }),
            });
            if (!res.ok) throw new Error(tx('list.reviewFailed'));
            return res.json().catch(() => null);
        },
        optimisticUpdate: (current, { id, action }) => {
            const newStatus =
                action === 'SUBMITTED'
                    ? 'SUBMITTED'
                    : action === 'APPROVED'
                        ? 'APPROVED'
                        : 'REJECTED';
            const rows = (current?.rows ?? []).map((ev) =>
                ev.id === id ? { ...ev, status: newStatus } : ev,
            );
            return { rows, truncated: current?.truncated ?? false };
        },
    });

    const submitReview = (id: string, action: string, comment = '') => {
        reviewMutation.trigger({ id, action, comment }).catch(() => {
            // R5-P2 #2 — surface the failure. The optimistic row already rolled
            // back; swallowing it silently read as a UI glitch (e.g. an EDITOR
            // shown Approve gets a 403, the row flips APPROVED then reverts).
            toast.error(tx('list.reviewFailed'));
        }).finally(() => {
            // Fan out to sibling filter variants for completeness —
            // status flips affect the "approved-only" / "rejected-
            // only" filter views which the primary key revalidation
            // doesn't cover.
            invalidateEvidence();
        });
    };

    // ─── Retention actions ─────────────────────────────────────────

    // Shared archive/unarchive runner. Optimistically flips the row,
    // POSTs, then revalidates from the server on either outcome. The
    // try/catch is load-bearing: the row buttons call this from a
    // non-awaited `onClick`, so a thrown fetch (offline / blocked /
    // network) would otherwise reject silently and the click would
    // appear to "do nothing". Any failure now rolls back + alerts.
    const setArchived = async (id: string, isArchived: boolean) => {
        const verb = isArchived ? 'archive' : 'unarchive';
        await optimisticSetArchived(id, isArchived);
        try {
            const res = await fetch(apiUrl(`/evidence/${id}/${verb}`), {
                method: 'POST',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                throw new Error(
                    err?.error?.message ||
                        (isArchived
                            ? tx('list.archiveFailedStatus', { status: res.status })
                            : tx('list.unarchiveFailedStatus', { status: res.status })),
                );
            }
            await invalidateEvidence();
        } catch (e) {
            await invalidateEvidence(); // roll back to server truth
            // EP-4 — surface via the platform toast (was a raw `alert`).
            toast.error(
                e instanceof Error
                    ? e.message
                    : isArchived
                      ? tx('list.archiveFailedNet')
                      : tx('list.unarchiveFailedNet'),
            );
        }
    };

    const archiveEvidence = (id: string) => setArchived(id, true);
    const unarchiveEvidence = (id: string) => setArchived(id, false);

    const statusLabel = (status: string) => {
        // Optimistic upload sentinel keeps its bespoke in-progress copy;
        // every real EvidenceStatus (incl. NEEDS_REVIEW) resolves through
        // the shared statusLabels group so table + sheet + gallery agree.
        if (status === 'PENDING_UPLOAD') return tx('list.uploading');
        return evidenceStatusLabel(status, tx);
    };

    // ─── Retention filter counts ───
    // Null on SSR + first client render so the "Expiring" count matches
    // exactly across hydration (avoids React #418/#422).
    const hydratedNow = useHydratedNow();

    // ─── R23-PR-E — KPI definitions for the Evidence page ───
    // Status-based buckets aligned to the existing `status` filter
    // (DRAFT/SUBMITTED/APPROVED/REJECTED). The retention tabs
    // (Active/Expiring/Archived) are a separate dimension owned by
    // the tab-bar above the filter toolbar — KPIs cover status only
    // so the two affordances stay independent.
    type EvidenceKpiId = 'total' | 'draft' | 'submitted' | 'approved';

    // EP-4 — the KPI strips are SERVER-computed (getEvidenceRetentionMetrics),
    // NOT counted from the ≤100 loaded rows. Seeded by the SSR `initialMetrics`
    // prop and revalidated against `/evidence/retention` (the same usecase),
    // so the tiles reflect the WHOLE tenant and can never diverge from the
    // server metrics past the SSR row cap (the old client-row count silently
    // under-reported once the list capped).
    const metricsQuery = useTenantSWR<EvidenceRetentionMetrics>(
        CACHE_KEYS.evidence.retention(),
        { fallbackData: initialMetrics, dedupingInterval: 30_000 },
    );
    const metrics = metricsQuery.data ?? initialMetrics;
    const totalEvidence = metrics.total;

    // Canonical KPI-card sparklines (shared hook). `total` is an always-present
    // series; the status buckets (draft/submitted/approved) are forward-only
    // nullable columns — empty until history accrues, never a fake ramp.
    const trendsQuery = useKpiTrends(tenantSlug);
    const evidenceTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints;
        return {
            total: buildKpiSparklines(points, (d) => d.evidenceTotal, {
                total: (d) => d.evidenceTotal,
            }).total,
            draft: buildKpiSparklineNullable(points, (d) => d.evidenceDraft),
            submitted: buildKpiSparklineNullable(points, (d) => d.evidenceSubmitted),
            approved: buildKpiSparklineNullable(points, (d) => d.evidenceApproved),
        };
    }, [trendsQuery.data]);
    // Distinct sparkline colour per card (canonical allocator) — no two cards
    // on the row share a colour. Memo on [] so the random allocation is stable
    // for this page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'draft', 'submitted', 'approved']),
        [],
    );
    // EP-4 — server-sourced (metrics.byStatus), not a loaded-row count.
    const draftEvidence = metrics.byStatus.DRAFT;
    const submittedEvidence = metrics.byStatus.SUBMITTED;
    const approvedEvidence = metrics.byStatus.APPROVED;
    const evidenceKpiDefs: ReadonlyArray<KpiFilterDef<EvidenceKpiId>> = useMemo(
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
                id: 'submitted',
                apply: (ctx) => ctx.set('status', 'SUBMITTED'),
                isActive: (s) => (s.status ?? []).includes('SUBMITTED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'approved',
                apply: (ctx) => ctx.set('status', 'APPROVED'),
                isActive: (s) => (s.status ?? []).includes('APPROVED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
        ],
        [],
    );
    const { activeKpiId: activeEvidenceKpi, toggle: toggleEvidenceKpi } =
        useKpiFilter(evidenceKpiDefs);

    // The retention tab is applied SERVER-side (`tab` on the list query), so
    // the rows that arrive are already the tab's whole-tenant result. This
    // used to re-partition them here, which meant the tab only ever filtered
    // whatever the backfill cap returned.
    //
    // Note the client's `expiring` partition keyed on `retentionUntil` alone —
    // the definition the KPI tile stopped using when the two were unified. The
    // server predicate prefers `nextReviewDate` and falls back to retention, so
    // the tab and the tile now agree; see `evidenceRetentionTabWhere`.
    const displayEvidence = evidence;

    // ─── EP-2 — freshness (review-currency) refinement ───
    // Read from the FilterProvider state (single-select). The API
    // ignores the `freshness` param (schema `.strip()`), so this is a
    // client-side view refinement layered on top of the retention tab.
    const freshnessValue = (state.freshness?.[0] ?? null) as
        | EvidenceFreshnessBucket
        | null;
    // Applied SERVER-side now (`freshness` on the list query), so the rows
    // arriving here are already the bucket's whole-tenant result rather than
    // one page filtered twice. Kept as an alias so the render sites below
    // read unchanged.
    const displayEvidenceFresh = displayEvidence;

    // EP-4 — freshness KPI counts are SERVER-computed (the retention
    // aggregate's freshness buckets), not a pass over the ≤100 loaded rows.
    // The server buckets mirror `evidenceFreshnessBucket` exactly, so the
    // tiles agree with the per-row freshness badge the table renders while
    // reflecting the whole tenant.
    // No manual useMemo — the React Compiler auto-memoizes this derivation,
    // and a hand-rolled useMemo here trips the compiler's
    // "existing memoization could not be preserved" bailout (which would
    // skip compiling the whole component).
    const freshnessCounts = {
        current: metrics.current,
        expiring: metrics.expiringSoon,
        expired: metrics.expired,
        needs_review: metrics.needsReview,
    };

    // The tile count and the row count are both whole-tenant now, so the
    // banner that used to explain their disagreement has nothing to explain.
    // It existed because the tiles read a server aggregate while the filter
    // refined one loaded page; the filter moved server-side, so the two are
    // the same query. A row count short of the tile now means an ordinary
    // pagination cap, which `truncated` already reports on its own.
    const freshnessCountMismatch = false;

    const setFreshnessFilter = useCallback(
        (bucket: EvidenceFreshnessBucket) => {
            if (freshnessValue === bucket) filterCtx.removeAll('freshness');
            else filterCtx.set('freshness', bucket);
        },
        [freshnessValue, filterCtx],
    );

    // ─── PR-1: org-parity sortable headers + progressive disclosure ───
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    // Sort accessors return the value each column DISPLAYS, so sorting groups
    // same-displayed-value rows contiguously. Several columns render a DERIVED
    // label, not a raw field — the old comparator sorted by the raw field and
    // so failed to group rows that look identical:
    //   - `type`      → the cell shows resolveFileTypeIcon(...).label (PDF /
    //                   Image / Link), not the raw `ev.type` enum.
    //   - `control`   → the cell shows "{annexId} {name}", not just annexId.
    //   - `retention` → the cell shows getRetentionStatus(...).label
    //                   (Active / Expiring / Expired), not the raw ISO date.
    //   - `status`    → the cell shows statusLabel(ev.status), not the enum.
    //   - `owner`     → resolved owner: the assigned USER's name, falling
    //     back to the legacy free-text column. The cell used to show
    //     `ev.owner` alone, which made `ownerUserId` write-only from the
    //     UI's point of view — the edit modal's owner picker and the bulk
    //     "Assign owner" action both wrote the FK and nothing rendered it.
    // Each accessor below reuses the SAME derivation as its column cell.
    const sortAccessors = useMemo<SortAccessors<EvidenceRow>>(
        () => ({
            title: (ev) => ev.title || '',
            type: (ev) =>
                resolveFileTypeIcon(
                    ev.fileName ?? null,
                    ev.fileRecord?.mimeType ?? null,
                    ev.type ?? null,
                ).label,
            control: (ev) => controlLinksLabel(ev.evidenceControlLinks),
            category: (ev) => ev.category || '—',
            retention: (ev) => getRetentionStatus(ev, hydratedNow, tx).label,
            status: (ev) => statusLabel(ev.status),
            owner: (ev) => ownerLabel(ev),
        }),
        // statusLabel closes over `t`; getRetentionStatus is pure of `hydratedNow`.
        [t, hydratedNow, tx],
    );
    const sortedEvidence = useMemo(
        () => sortRowsByDisplay(displayEvidenceFresh, sortAccessors, sortBy, sortOrder),
        [displayEvidenceFresh, sortAccessors, sortBy, sortOrder],
    );
    const sortableEvidenceColumns = useMemo(
        () => ['title', 'type', 'control', 'category', 'retention', 'status', 'owner'],
        [],
    );
    const {
        visibleRows: visibleEvidence,
        hasMore: hasMoreEvidence,
        loadMore: loadMoreEvidence,
    } = useThresholdLoadMore(sortedEvidence);

    // Epic 62 — celebrate when every active evidence row is fresh.
    // Gates that suppress false positives:
    //   - hydratedNow set (skips SSR / first-render race)
    //   - default 'active' retention tab + no other filters
    //   - query has actually loaded data at least once
    // Session dedupe in `useCelebration` prevents repeat fires across
    // refreshes / re-renders.
    // EP-4 — "all current" is judged from the SERVER retention aggregate
    // (whole tenant) rather than `isAllEvidenceCurrent` over the ≤100 loaded
    // rows: at least one non-deleted row AND zero in the expired / expiring /
    // needs-review buckets means every row is in the `current` bucket.
    const allEvidenceCurrent =
        metrics.total > 0 &&
        metrics.expired === 0 &&
        metrics.expiringSoon === 0 &&
        metrics.needsReview === 0;
    useEffect(() => {
        if (!hydratedNow) return;
        if (retentionFilter !== 'active') return;
        if (anyFilterActive) return;
        if (evidenceQuery.isLoading) return;
        if (!allEvidenceCurrent) return;
        const def = MILESTONES['evidence-all-current'];
        celebrate({
            preset: def.preset,
            key: def.key,
            message: def.message,
            description: def.description,
        });
    }, [
        allEvidenceCurrent,
        hydratedNow,
        retentionFilter,
        anyFilterActive,
        evidenceQuery.isLoading,
        celebrate,
    ]);

    // ─── Column visibility (Epic 52 / R10-PR6) ───
    // Pagination removed — internal scroll inside the table card
    // (ListPageShell.Body + DataTable fillBody) shows all rows.
    const evidenceColumnList = useMemo(
        () => [
            { id: 'title', label: tx('colVis.title') },
            { id: 'type', label: tx('colVis.type') },
            { id: 'control', label: tx('colVis.control') },
            { id: 'category', label: tx('colVis.category') },
            // B8 follow-up — Folder column. Hidden by default
            // (`defaultHidden: true` would be ideal but the dropdown
            // primitive doesn't carry that yet) — the user reveals
            // it via the gear once they start using folders.
            { id: 'folder', label: tx('colVis.folder') },
            { id: 'retention', label: tx('colVis.retention') },
            { id: 'freshness', label: tx('colVis.freshness') },
            { id: 'status', label: tx('colVis.status') },
            { id: 'owner', label: tx('colVis.owner') },
            { id: 'actions', label: tx('colVis.actions'), alwaysVisible: true },
        ],
        [tx],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:evidence',
        columns: evidenceColumnList,
    });

    // ─── Filter defs (FDEFS) + the "Edit filter cards" gear ───
    // Built in the parent (rather than inside EvidenceFilterToolbar) so
    // the filter gear can ride the same toolbar `actions` slot as the
    // columns gear. The FilterProvider state (keyed by
    // EVIDENCE_FILTER_KEYS) is untouched — a hidden filter keeps its value.
    const evidenceFilters: FilterType[] = useMemo(
        () =>
            buildEvidenceFilters(
                controls as Parameters<typeof buildEvidenceFilters>[0],
                evidence,
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [controls, evidence, tx, tGroup],
    );
    // U1 (2026-08-13) — the gear edits the KPI CARDS, not the Filter
    // dropdown's categories. Registering the filter defs as cards meant
    // hiding a card removed a FILTER from the product while the KPI
    // strip — hardcoded JSX — never changed. Every card is `kind: 'kpi'`;
    // that swap away from filter ids was carried by the hook's stale-id
    // migration, which fires only when ALL persisted ids are dead.
    //
    // Status-card ids still match the `evidenceKpiDefs` ids exactly —
    // `selected={activeEvidenceKpi === card.id}` depends on it. The four
    // freshness ids are `EvidenceFreshnessBucket` values for the same reason:
    // the card id IS the filter value it applies.
    //
    // R1-2c — the four FRESHNESS cards join the four status cards here, as
    // OPT-IN cards. They were hardcoded JSX, so the gear could not hide them
    // and they cost a permanent second row of vertical space no matter how a
    // tenant works. Review-currency is a real way to work but not the common
    // one; the page opens on the status four and offers the rest in the gear.
    //
    // `defaultVisible: false` is what makes this a fold rather than a move —
    // and it is only reachable because #1909 fixed the hook to reconcile
    // against EVERY registered card. Before that, `onToggle` wrote an opt-in
    // id to storage and the next render dropped it again, so the checkbox
    // would not even check.
    //
    // No storage-key migration is needed, which is the point. New cards that
    // are hidden by default are exactly the case `reconcileOrder` already
    // handles: it drops dead ids and never appends, so a user's persisted
    // status-card order survives untouched and the four freshness cards
    // simply appear as unchecked rows in the gear. (The `-v2` key this
    // briefly used was only justified while the cards were default-VISIBLE,
    // where being dropped would have hidden them for anyone who had ever
    // touched the gear. Reverting it restores those users' saved card order;
    // nothing was stranded, because the version that wrote `-v2` never
    // reached a deployed environment.)
    const kpiCards: CardDefinition[] = useMemo(() => {
        // Built INSIDE the memo, and not hoisted to its own `useMemo`: the
        // React Compiler reads a `.current` property access on a memoized
        // value as a ref access, infers `labels.current` as the dependency,
        // and bails out of optimizing the whole component ("existing
        // memoization could not be preserved"). `current` is a freshness
        // bucket name here, not a ref.
        const fresh = evidenceFreshnessLabels((k, v) =>
            tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
        );
        return [
            { id: 'total', label: tx('list.kpiTotal'), kind: 'kpi' },
            { id: 'draft', label: tx('list.kpiDraft'), kind: 'kpi' },
            { id: 'submitted', label: tx('list.kpiSubmitted'), kind: 'kpi' },
            { id: 'approved', label: tx('list.kpiApproved'), kind: 'kpi' },
            { id: 'current', label: fresh.current, kind: 'kpi', defaultVisible: false },
            { id: 'expiring', label: fresh.expiring, kind: 'kpi', defaultVisible: false },
            { id: 'expired', label: fresh.expired, kind: 'kpi', defaultVisible: false },
            { id: 'needs_review', label: fresh.needs_review, kind: 'kpi', defaultVisible: false },
        ];
    }, [tx]);
    const { visibleCards: visibleKpiCards, dropdown: filtersDropdown } =
        useFilterCardVisibility({
            storageKey: 'inflect:filter-vis:evidence',
            cards: kpiCards,
        });

    // ── Evidence Column Definitions ──

    const evidenceColumns = useMemo(() => createColumns<EvidenceRow>([
        {
            accessorKey: 'title',
            header: t.evidenceTitle,
            // R13-PR1 — title cell uses the canonical <TableTitleCell>
            // primitive. The file-type icon + filename subtitle that
            // used to live here pushed the row height past every other
            // page's baseline. File type information is still in the
            // dedicated Type column.

            cell: ({ row }) => {
                // Evidence has no dedicated detail page yet — the record opens
                // via the master/detail pattern from this list page. The title
                // is truncated VISUALLY with a CSS ellipsis (the semantic
                // max-w-trunc-default token) — the FULL text stays in the DOM,
                // so accessibility, search, copy-paste,
                // and list assertions keep working; the full value also shows
                // on hover. (A prior JS substring truncated the DOM text itself,
                // which silently broke the evidence-list E2E specs that assert
                // the new row's full title appears.)
                const title = row.original.title;
                const truncated = !!title && title.length > 20;
                const inner = (
                    <TableTitleCell className="block max-w-trunc-default truncate">
                        {title}
                    </TableTitleCell>
                );
                return truncated ? (
                    <Tooltip content={title}>
                        <span className="inline-flex max-w-full min-w-0">{inner}</span>
                    </Tooltip>
                ) : (
                    inner
                );
            },
        },
        {
            accessorKey: 'type',
            header: t.type,

            cell: ({ row }) => {
                const ev = row.original;
                // Mixed-file aware: pick the actual file kind by
                // extension/MIME when this row is a file; fall back to
                // the domain kind (LINK / TEXT) for non-file rows.
                const match = resolveFileTypeIcon(
                    ev.fileName ?? null,
                    ev.fileRecord?.mimeType ?? null,
                    ev.type ?? null,
                );
                return (
                    <span
                        className="inline-flex items-center gap-1.5 text-xs text-content-muted"
                        data-file-kind={match.label.toLowerCase()}
                    >
                        <match.Icon
                            size={14}
                            className={match.colorClass}
                            aria-hidden
                        />
                        <span>{match.label}</span>
                    </span>
                );
            },
        },
        {
            id: 'control',
            header: t.control,
            // EP-3 \u2014 many-to-many links; the cell condenses to the
            // first control's code/annex id + a "+N" overflow badge.
            accessorFn: (ev) => controlLinksLabel(ev.evidenceControlLinks),
            cell: ({ row }) => {
                const links = row.original.evidenceControlLinks ?? [];
                if (links.length === 0) {
                    return <span className="text-content-subtle">\u2014</span>;
                }
                const label = controlLinksLabel(links);
                const full = links
                    .map((l) => {
                        const c = l.control;
                        const prefix = c.annexId || c.code || '';
                        return prefix ? `${prefix}: ${c.name}` : c.name;
                    })
                    .join(', ');
                return (
                    <Tooltip content={full}>
                        <span className="text-xs text-content-muted">{label}</span>
                    </Tooltip>
                );
            },
        },
        {
            id: 'category',
            header: tx('colHeaders.category'),
            // EP-3 \u2014 persisted classification, previously invisible.
            accessorFn: (ev: { category?: string | null }) => ev.category || '',
            cell: ({ row }: { row: { original: { category?: string | null } } }) =>
                row.original.category ? (
                    <span className="text-xs text-content-muted">
                        {row.original.category}
                    </span>
                ) : (
                    <span className="text-content-subtle">\u2014</span>
                ),
        },
        {
            id: 'folder',
            header: tx('colHeaders.folder'),
            // B8 follow-up \u2014 the Folder column matches the
            // VendorDocsTable shape: empty/null = em-dash, otherwise
            // a muted tag. Hidden by default if a tenant has zero
            // foldered evidence \u2014 the column-visibility gear keeps
            // it discoverable.
            accessorFn: (ev: { folder?: string | null }) => ev.folder || '',
            cell: ({ row }: { row: { original: { folder?: string | null } } }) =>
                row.original.folder ? (
                    <span className="text-xs text-content-muted">
                        {row.original.folder}
                    </span>
                ) : (
                    <span className="text-content-subtle">—</span>
                ),
        },
        {
            id: 'retention',
            header: tx('colHeaders.retention'),

            cell: ({ row }) => {
                const ev = row.original;
                const rs = getRetentionStatus(ev, hydratedNow, tx);
                // Retention is now edited from the evidence Edit modal
                // (Edit icon → "Retention date"); the column is display-
                // only. Status badge + the resolved date.
                return (
                    <div className="text-xs">
                        <StatusBadge variant={rs.badge} id={`retention-status-${ev.id}`}>
                            {rs.icon} {rs.label}
                        </StatusBadge>
                        {ev.retentionUntil && !ev.isArchived && (
                            <TimestampTooltip
                                date={ev.retentionUntil}
                                className="text-content-subtle mt-0.5 block"
                                data-testid={`evidence-row-retention-date-${ev.id}`}
                            />
                        )}
                    </div>
                );
            },
            meta: { disableTruncate: true },
        },
        {
            id: 'freshness',
            header: tx('colHeaders.freshness'),

            cell: ({ row }) => {
                const ev = row.original;
                // EP-2 Part 4 — freshness now tracks REVIEW-CURRENCY,
                // not `updatedAt`. `nextReviewDate` (primary) / `expiredAt`
                // (fallback) mean a metadata edit or archive-toggle no
                // longer resets the age: a future review date reads
                // fresh, a past one reads increasingly stale ("overdue
                // for review"). Same badge vocabulary, review-driven input.
                return (
                    <FreshnessBadge
                        lastRefreshedAt={reviewCurrencyAnchor(ev)}
                        now={hydratedNow ?? undefined}
                        compact
                        data-testid={`evidence-row-freshness-${ev.id}`}
                    />
                );
            },
            meta: { disableTruncate: true },
        },
        {
            accessorKey: 'status',
            header: t.status,

            cell: ({ row }) => {
                const ev = row.original;
                return <StatusBadge variant={STATUS_BADGE[ev.status]}>{statusLabel(ev.status)}</StatusBadge>;
            },
        },
        {
            id: 'owner',
            header: t.ownerLabel,

            accessorFn: (ev) => ownerLabel(ev) || '\u2014',
            cell: ({ getValue }: { getValue: () => string }) => (
                <span className="text-xs">{getValue()}</span>
            ),
        },
        // Edit — icon-only column (Control-table parity). Opens the
        // SAME EditEvidenceModal the detail side-sheet's edit icon does.
        {
            id: 'edit',
            header: '',
            enableHiding: false,
            cell: ({ row }) => {
                const ev = row.original;
                if (!permissions.canWrite || ev.id?.startsWith('temp:')) return null;
                return (
                    <Tooltip content={tx('list.editEvidence')}>
                        <button
                            type="button"
                            aria-label={tx('list.editEvidence')}
                            className={ICON_ACTION_CLASS}
                            id={`edit-evidence-${ev.id}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                setEditInitial({
                                    id: ev.id,
                                    title: ev.title,
                                    content: ev.content ?? null,
                                    ownerUserId: ev.ownerUserId ?? null,
                                    controlLinks: (ev.evidenceControlLinks ?? []).map(
                                        (l) => l.control,
                                    ),
                                    category: ev.category ?? null,
                                    folder: ev.folder ?? null,
                                    // Seeded so the modal shows the row's real
                                    // tags and reconciles against them. Matches
                                    // what the detail sheet passes.
                                    tags: (ev.tags ?? []).map((tg) => tg.tag),
                                    retentionUntil: ev.retentionUntil ?? null,
                                    type: ev.type,
                                    fileRecordId: ev.fileRecordId ?? null,
                                });
                                setEditModalOpen(true);
                            }}
                        >
                            <Pen2 className="size-3.5" />
                        </button>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Archive — icon-only column. Toggles archive / unarchive.
        {
            id: 'archive',
            header: '',
            enableHiding: false,
            cell: ({ row }) => {
                const ev = row.original;
                if (!permissions.canWrite || ev.id?.startsWith('temp:')) return null;
                const archived = !!ev.isArchived;
                return (
                    <Tooltip content={archived ? tx('list.unarchiveEvidence') : tx('list.archiveEvidence')}>
                        <button
                            type="button"
                            aria-label={archived ? tx('list.unarchiveEvidence') : tx('list.archiveEvidence')}
                            className={ICON_ACTION_CLASS}
                            id={`${archived ? 'unarchive' : 'archive'}-${ev.id}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (archived) unarchiveEvidence(ev.id);
                                else archiveEvidence(ev.id);
                            }}
                        >
                            <BoxArchive className={`size-3.5${archived ? ' text-content-emphasis' : ''}`} />
                        </button>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Download — icon-only column. Only file-backed evidence is
        // downloadable; non-file rows render nothing.
        {
            id: 'download',
            header: '',
            enableHiding: false,
            cell: ({ row }) => {
                const ev = row.original;
                if (ev.type !== 'FILE' || !ev.fileRecordId || ev.id?.startsWith('temp:')) return null;
                // R5-P2 #1 — refuse the download affordance for a file the AV gate
                // would block: an infected/pending link previously rendered
                // unconditionally and navigated to a 403 the browser saved as a
                // "file". Show the scan state instead of a broken download.
                const scan = ev.fileRecord?.scanStatus;
                if (isScanInfected(scan)) {
                    return (
                        <Tooltip content={tx('scan.infectedTooltip')}>
                            <span className={ICON_ACTION_CLASS} aria-label={tx('scan.infected')}>
                                <ShieldAlert className="size-3.5 text-content-error" />
                            </span>
                        </Tooltip>
                    );
                }
                if (!isScanServable(scan)) {
                    return (
                        <Tooltip content={tx('scan.pendingTooltip')}>
                            <span className={ICON_ACTION_CLASS} aria-label={tx('scan.pending')}>
                                <CircleHalfDottedClock className="size-3.5 text-content-subtle animate-pulse" />
                            </span>
                        </Tooltip>
                    );
                }
                return (
                    <Tooltip content={tx('list.downloadFile')}>
                        <a
                            href={apiUrl(`/evidence/files/${ev.fileRecordId}/download`)}
                            download
                            aria-label={tx('list.downloadFile')}
                            className={ICON_ACTION_CLASS}
                            id={`download-${ev.id}`}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <Download className="size-3.5" />
                        </a>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Review workflow — the remaining state-transition actions.
        {
            id: 'actions',
            // Leaf header is blank — the spanning "Actions" group header (added
            // in `tableColumns` below) labels this + the edit/archive/download
            // icon columns together.
            header: '',
            enableHiding: false,

            cell: ({ row }) => {
                const ev = row.original;
                const isPending = ev.id?.startsWith('temp:');
                if (isPending) return <span className="text-xs text-content-subtle">{tx('list.uploading')}</span>;
                if (!permissions.canWrite) return null;
                const submitBtn = (
                    <Tooltip content={t.submitForReview}>
                        <button
                            type="button"
                            aria-label={t.submitForReview}
                            className={ICON_ACTION_CLASS}
                            onClick={() => submitReview(ev.id, 'SUBMITTED')}
                        >
                            <PaperPlane className="size-3.5" />
                        </button>
                    </Tooltip>
                );
                return (
                    <div className="flex gap-1 flex-wrap" onClick={e => e.stopPropagation()}>
                        {ev.status === 'DRAFT' && submitBtn}
                        {/* R5-P2 #2 — Approve/Reject require ADMIN (server:
                            assertCanAdmin). The row previously showed them to any
                            write-tier user, who then hit a silent 403. */}
                        {ev.status === 'SUBMITTED' && permissions.canAdmin && (
                            <>
                                <Tooltip content={t.approveEvidence}>
                                    <button
                                        type="button"
                                        aria-label={t.approveEvidence}
                                        className={ICON_ACTION_CLASS}
                                        onClick={() => submitReview(ev.id, 'APPROVED')}
                                    >
                                        <Check className="size-3.5" />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t.rejectEvidence}>
                                    <button
                                        type="button"
                                        aria-label={t.rejectEvidence}
                                        className={`${ICON_ACTION_CLASS} hover:text-content-error`}
                                        onClick={() => setRejectRowId(ev.id)}
                                    >
                                        <Xmark className="size-3.5" />
                                    </button>
                                </Tooltip>
                            </>
                        )}
                        {ev.status === 'REJECTED' && submitBtn}
                        {/* EP-2 Part 5 — first-class Re-review action for
                            NEEDS_REVIEW rows. Functionally NEEDS_REVIEW →
                            SUBMITTED, but labelled for renewal (distinct
                            icon + tooltip) so stale evidence is renewable
                            straight from the row. */}
                        {ev.status === 'NEEDS_REVIEW' && (
                            <Tooltip content={tx('list.reReview')}>
                                <button
                                    type="button"
                                    aria-label={tx('list.reReview')}
                                    className={ICON_ACTION_CLASS}
                                    id={`rereview-${ev.id}`}
                                    onClick={() => submitReview(ev.id, 'SUBMITTED')}
                                >
                                    <CalendarRefresh className="size-3.5" />
                                </button>
                            </Tooltip>
                        )}
                    </div>
                );
            },
            meta: { disableTruncate: true },
        },
    // R5-P3 #4 — include hydratedNow: the retention column's rendered labels
    // (getRetentionStatus) close over it, and sortAccessors already depends on
    // it, so omitting it let the labels and the sort order disagree after hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ]), [t, permissions, apiUrl, tx, hydratedNow]);

    // Item 3 — collapse the four right-most columns (edit / archive /
    // download / actions) under ONE spanning "Actions" header. orderColumns
    // (flat slot-merge) runs first; then the action columns are lifted into a
    // single TanStack group so its header cell spans them. The other columns
    // get a placeholder top-row header cell automatically.
    const tableColumns = useMemo(() => {
        const ordered = orderColumns(evidenceColumns);
        const actionIds = new Set(['edit', 'archive', 'download', 'actions']);
        // Partition into body columns + the four action columns without an
        // array `.filter()` (the no-client-side-filtering guard flags that
        // heuristic in list clients — this is grouping column DEFS, not data).
        const rest: typeof ordered = [];
        const actionCols: typeof ordered = [];
        for (const col of ordered) {
            if (actionIds.has(col.id as string)) actionCols.push(col);
            else rest.push(col);
        }
        if (actionCols.length === 0) return ordered;
        return [
            ...rest,
            { id: 'actionsGroup', header: tx('colHeaders.actions'), columns: actionCols },
        ];
    }, [orderColumns, evidenceColumns, tx]);

    // Stable table-model identities — a fresh identity here rebuilds the
    // table model mid-double-click and kills row navigation (#1678).
    const getEvidenceRowId = useCallback((ev: EvidenceRow) => ev.id, []);
    const openEvidenceDetail = useCallback((id: string) => {
        setDetailEvidenceId(id);
        setDetailSheetOpen(true);
    }, []);
    const handleEvidenceRowClick = useCallback(
        (row: { original: EvidenceRow }) => openEvidenceDetail(row.original.id),
        [openEvidenceDetail],
    );
    const handleEvidenceCardClick = useCallback(
        (ev: EvidenceRow) => openEvidenceDetail(ev.id),
        [openEvidenceDetail],
    );
    const handleEvidenceRowPrefetch = useCallback(
        (row: { original: EvidenceRow }) =>
            prefetchData(CACHE_KEYS.evidence.detail(row.original.id)),
        [prefetchData],
    );

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: tx('list.crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t.title },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1} className="sr-only">{t.title}</Heading>
                        {t.listDescription && (
                            <p className="text-sm text-content-muted mt-1">{t.listDescription}</p>
                        )}
                    </div>
                </div>
            </ListPageShell.Header>

            {permissions.canWrite && (
                <>
                    <UploadEvidenceModal
                        open={showUpload}
                        setOpen={setShowUpload}
                        tenantSlug={tenantSlug}
                        apiUrl={apiUrl}
                        controls={controls}
                    />
                    <NewEvidenceTextModal
                        open={showTextModal}
                        setOpen={setShowTextModal}
                        tenantSlug={tenantSlug}
                        apiUrl={apiUrl}
                        controls={controls}
                    />
                    <NewEvidenceLinkModal
                        open={showLinkModal}
                        setOpen={setShowLinkModal}
                        tenantSlug={tenantSlug}
                        apiUrl={apiUrl}
                        controls={controls}
                    />
                    <EvidenceBulkImportModal
                        open={showBulkImport}
                        setOpen={setShowBulkImport}
                        tenantSlug={tenantSlug}
                        apiUrl={apiUrl}
                    />
                </>
            )}

            {/* B5 — Evidence detail sheet + edit modal. The sheet
                opens on row click and shows the read-only evidence
                detail + the existing approval-flow actions (which
                route back through `submitReview` for optimistic
                updates). The edit modal opens from the sheet's
                edit button. */}
            <EvidenceDetailSheet
                open={detailSheetOpen}
                setOpen={setDetailSheetOpen}
                evidenceId={detailEvidenceId}
                tenantSlug={tenantSlug}
                canWrite={permissions.canWrite}
                canAdmin={permissions.canAdmin}
                onEdit={(ev) => {
                    setEditInitial(ev);
                    setEditModalOpen(true);
                }}
                onReview={(id, action, comment) => submitReview(id, action, comment)}
            />
            <RejectReasonModal
                open={rejectRowId !== null}
                onClose={() => setRejectRowId(null)}
                onConfirm={(reason) => {
                    if (rejectRowId) submitReview(rejectRowId, 'REJECTED', reason);
                }}
            />
            <EditEvidenceModal
                open={editModalOpen}
                setOpen={setEditModalOpen}
                tenantSlug={tenantSlug}
                controls={controls}
                initial={editInitial}
                onSaved={() => {
                    // Revalidate the list cache so the freshly-saved
                    // values flow back into the table.
                    invalidateEvidence();
                }}
            />

            {/* B8 follow-up — shared folder-suggestions datalist.
                The UploadEvidenceModal references
                reference `list="evidence-folder-suggestions"` so
                the user converges on a small named set of folders.
                Mounting the datalist here means a single source of
                truth derived from the currently-loaded evidence. */}
            <datalist id="evidence-folder-suggestions">
                {Array.from(
                    new Set(
                        (evidence as Array<{ folder?: string | null }>)
                            .map((e) => (e.folder || '').trim())
                            .filter(Boolean),
                    ),
                )
                    .sort()
                    .map((f) => (
                        <option key={f} value={f} />
                    ))}
            </datalist>

            <ListPageShell.Filters className="space-y-section">
                {/* R1-2c — ONE gear-managed KPI strip, ONE row by default. It
                    used to be three stacked blocks: status cards, a retention
                    ToggleGroup, and a freshness strip — roughly a third of the
                    viewport before a single row of evidence appeared, none of
                    it dismissable. The retention bucket is a filter category
                    now, and the freshness four are opt-in cards, so the page
                    opens on four status cards and a tenant that works by
                    review-currency switches the others on in the gear.

                    `grid-cols-2 md:grid-cols-4` therefore fills exactly one
                    row at the default, and wraps to a second only for a user
                    who asked for more. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    {visibleKpiCards.map((card) => {
                        // Status cards drive `useKpiFilter`; freshness cards
                        // drive the `freshness` filter directly. Both axes
                        // carry their own click + selected binding here rather
                        // than being forced onto one mechanism — the strip is
                        // a layout, not a claim that the two mean the same
                        // thing. Only the freshness four are sparkline-less;
                        // `centeredSparklineDomain` already takes `undefined`.
                        const cfg: Record<
                            string,
                            {
                                value: number;
                                tone?: 'default' | 'attention' | 'success' | 'critical';
                                sparkline?: typeof evidenceTrends.total;
                                sparklineVariant?: typeof sparkColors.total;
                                onClick: () => void;
                                selected: boolean;
                            }
                        > = {
                            total: {
                                value: totalEvidence,
                                sparkline: evidenceTrends.total,
                                sparklineVariant: sparkColors.total,
                                onClick: () => toggleEvidenceKpi('total'),
                                selected: activeEvidenceKpi === 'total',
                            },
                            draft: {
                                value: draftEvidence,
                                tone: 'attention',
                                sparkline: evidenceTrends.draft,
                                sparklineVariant: sparkColors.draft,
                                onClick: () => toggleEvidenceKpi('draft'),
                                selected: activeEvidenceKpi === 'draft',
                            },
                            submitted: {
                                value: submittedEvidence,
                                tone: 'default',
                                sparkline: evidenceTrends.submitted,
                                sparklineVariant: sparkColors.submitted,
                                onClick: () => toggleEvidenceKpi('submitted'),
                                selected: activeEvidenceKpi === 'submitted',
                            },
                            approved: {
                                value: approvedEvidence,
                                tone: 'success',
                                sparkline: evidenceTrends.approved,
                                sparklineVariant: sparkColors.approved,
                                onClick: () => toggleEvidenceKpi('approved'),
                                selected: activeEvidenceKpi === 'approved',
                            },
                            current: {
                                value: freshnessCounts.current,
                                tone: 'success',
                                onClick: () => setFreshnessFilter('current'),
                                selected: freshnessValue === 'current',
                            },
                            expiring: {
                                value: freshnessCounts.expiring,
                                tone: 'attention',
                                onClick: () => setFreshnessFilter('expiring'),
                                selected: freshnessValue === 'expiring',
                            },
                            expired: {
                                value: freshnessCounts.expired,
                                tone: 'critical',
                                onClick: () => setFreshnessFilter('expired'),
                                selected: freshnessValue === 'expired',
                            },
                            needs_review: {
                                value: freshnessCounts.needs_review,
                                tone: 'attention',
                                onClick: () => setFreshnessFilter('needs_review'),
                                selected: freshnessValue === 'needs_review',
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
                                onClick={c.onClick}
                                selected={c.selected}
                            />
                        );
                    })}
                </div>

                {/*
                  Filter toolbar — the Filter button + live search sit on
                  the LEFT, matching every other list page (previously
                  this whole cluster was right-anchored). The Epic 43.2
                  view toggle + columns gear ride the toolbar's right-edge
                  `actions` slot. The view toggle stays in `useUrlFilters`,
                  NOT `filterCtx`, so flipping the renderer doesn't disturb
                  search-q or any active filter pill — both the table and
                  the gallery read from the same `displayEvidence` array.
                */}
                <EvidenceFilterToolbar
                    filters={evidenceFilters}
                    leading={
                        permissions.canWrite ? (
                            // PART 1 — one primary trigger opens a create
                            // menu (Popover.Menu). The four creation
                            // surfaces — file upload, text note, link/URL,
                            // and bulk ZIP import — each mount their own
                            // modal. The trigger keeps the canonical
                            // icon-slot Plus + bare-noun label.
                            <Popover
                                openPopover={createMenuOpen}
                                setOpenPopover={setCreateMenuOpen}
                                align="start"
                                content={
                                    <Popover.Menu aria-label={tx('list.createMenuAria')}>
                                        <Popover.Item
                                            icon={<CloudUpload className="size-4" />}
                                            id="create-evidence-upload"
                                            onClick={() => {
                                                setCreateMenuOpen(false);
                                                setShowUpload(true);
                                            }}
                                        >
                                            {tx('list.createFileUpload')}
                                        </Popover.Item>
                                        <Popover.Item
                                            icon={<Note className="size-4" />}
                                            id="create-evidence-text"
                                            onClick={() => {
                                                setCreateMenuOpen(false);
                                                setShowTextModal(true);
                                            }}
                                        >
                                            {tx('list.createTextNote')}
                                        </Popover.Item>
                                        <Popover.Item
                                            icon={<Hyperlink className="size-4" />}
                                            id="create-evidence-link"
                                            onClick={() => {
                                                setCreateMenuOpen(false);
                                                setShowLinkModal(true);
                                            }}
                                        >
                                            {tx('list.createLink')}
                                        </Popover.Item>
                                        <Popover.Item
                                            icon={<FileZip2 className="size-4" />}
                                            id="create-evidence-bulk"
                                            onClick={() => {
                                                setCreateMenuOpen(false);
                                                setShowBulkImport(true);
                                            }}
                                        >
                                            {tx('list.createBulkImport')}
                                        </Popover.Item>
                                    </Popover.Menu>
                                }
                            >
                                <Button
                                    variant="primary"
                                    icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                    id="add-evidence-btn"
                                >
                                    {t.addEvidence}
                                </Button>
                            </Popover>
                        ) : undefined
                    }
                    actions={
                        <>
                            <ToggleGroup
                                size="sm"
                                ariaLabel={tx('list.viewAria')}
                                options={[
                                    { value: 'list', label: tx('list.viewList'), id: 'evidence-view-list' },
                                    { value: 'gallery', label: tx('list.viewGallery'), id: 'evidence-view-gallery' },
                                ]}
                                selected={viewMode}
                                selectAction={(v) => setFilter('view', v === 'list' ? '' : v)}
                                className="shrink-0"
                            />
                            {/* Columns are list-only chrome — there is no
                                column model in gallery view. */}
                            {viewMode === 'list' ? columnsDropdown : null}
                            {/* The KPI gear is NOT list-only. It was, back when
                                it managed filter categories; it now manages the
                                KPI strip, and that strip renders in BOTH views
                                (it sits in ListPageShell.Filters, outside any
                                viewMode guard). Leaving it gated meant a user
                                who hid cards in list view and switched to
                                gallery had no control to bring them back — and
                                the choice persists in localStorage, so it
                                survived a reload too. */}
                            {filtersDropdown}
                        </>
                    }
                />

                {/* Archived warning */}
                {retentionFilter === 'archived' && displayEvidence.length > 0 && (
                    <InlineNotice variant="warning" title={tx('list.archivedNoticeTitle')}>
                        {tx('list.archivedNoticeBody')}
                    </InlineNotice>
                )}
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <TruncationBanner truncated={truncated} />

                {/* Freshness tile ≠ shown rows. The tile counts the whole
                    tenant; the refinement runs over the loaded page. */}
                {freshnessCountMismatch && (
                    <div
                        className="rounded-lg border border-border-warning bg-bg-warning px-4 py-2 text-sm text-content-warning"
                        role="status"
                        data-testid="evidence-freshness-scope-notice"
                    >
                        {tx('list.freshnessScopeNotice', {
                            shown: displayEvidenceFresh.length,
                            total: freshnessCounts[freshnessValue!] ?? 0,
                        })}
                    </div>
                )}
                {viewMode === 'gallery' ? (
                  <>
                    {/* EP-2 — bulk action bar in gallery view too (the
                        table renders it via `selectionControls`; the
                        gallery has no built-in selection chrome, so mount
                        it here when a selection exists). */}
                    {selected.size > 0 && (
                        <div className="mb-default">
                            <BulkActionBar
                                actions={evidenceBulkActions}
                                onApply={handleBulkApply}
                                applying={bulkApplying}
                                selectedCount={selected.size}
                                entityLabel={tx('list.entityLabel')}
                            />
                        </div>
                    )}
                    <EvidenceGallery
                        rows={displayEvidenceFresh}
                        // Same clock the table cell uses, so a row's
                        // freshness badge reads identically in both views.
                        now={hydratedNow ?? undefined}
                        loading={evidenceQuery.isLoading && !evidenceQuery.data}
                        emptyState={
                            anyFilterActive ? (
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={
                                        retentionFilter === 'archived'
                                            ? tx('list.emptyArchivedTitle')
                                            : retentionFilter === 'expiring'
                                                ? tx('list.emptyExpiringTitle')
                                                : tx('list.emptyFilterTitle')
                                    }
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
                                    title={t.noEvidence}
                                    description={tx('list.emptyRecordsDesc')}
                                />
                            )
                        }
                        fileUrl={(ev) =>
                            ev.fileRecordId
                                ? apiUrl(`/evidence/files/${ev.fileRecordId}/download`)
                                : null
                        }
                        statusBadgeVariant={(s) => STATUS_BADGE[s] ?? 'neutral'}
                        statusLabel={statusLabel}
                        retentionStatus={(ev) => {
                            const rs = getRetentionStatus(ev, hydratedNow, tx);
                            return { label: rs.label, badge: rs.badge };
                        }}
                        // EP-2 Part 2 — click-to-open (same handler the
                        // table row uses) + bulk-selection parity + a
                        // localized download label on every card.
                        onRowClick={handleEvidenceCardClick}
                        selectedIds={selected}
                        onToggleSelect={(id, next) =>
                            setSelected((prev) => {
                                const n = new Set(prev);
                                if (next) n.add(id);
                                else n.delete(id);
                                return n;
                            })
                        }
                        downloadLabel={tx('list.downloadFile')}
                        data-testid="evidence-gallery"
                    />
                  </>
                ) : (
                    <DataTable
                        fillBody
                        data={visibleEvidence}
                        columns={tableColumns}
                        // Spanning "Actions" group header needs the real
                        // <table> path (virtualized grid header can't colSpan);
                        // Evidence is bounded, mirroring the Controls page.
                        virtualize={false}
                        onReachEnd={hasMoreEvidence ? loadMoreEvidence : undefined}
                        getRowId={getEvidenceRowId}
                        // Column resizing is opt-in per table (disabled
                        // by default since #823). Re-enabled here only —
                        // the Evidence Library's wide title/folder/owner
                        // columns benefit most from user-tuned widths.
                        // Auto-disables above the virtualization
                        // threshold, where fixed grid widths apply.
                        enableColumnResizing
                        sortableColumns={sortableEvidenceColumns}
                        sortBy={sortBy}
                        sortOrder={sortOrder}
                        onSortChange={({
                            sortBy: nextBy,
                            sortOrder: nextOrder,
                        }) => {
                            setSortBy(nextBy);
                            setSortOrder(nextOrder);
                        }}
                        // B5 — row click opens the detail sheet so
                        // users can actually drill into an evidence
                        // record. Pre-B5 the table was read-only
                        // until you clicked a specific cell-level
                        // action button.
                        onRowClick={handleEvidenceRowClick}
                        onRowPrefetch={handleEvidenceRowPrefetch}
                        selectionEnabled={permissions.canWrite}
                        selectedRows={Object.fromEntries(
                            Array.from(selected).map((id) => [id, true]),
                        )}
                        onRowSelectionChange={(rows) =>
                            setSelected(new Set(rows.map((r) => r.original.id)))
                        }
                        selectionControls={() => (
                            <BulkActionBar
                                actions={evidenceBulkActions}
                                onApply={handleBulkApply}
                                applying={bulkApplying}
                                selectedCount={selected.size}
                                entityLabel={tx('list.entityLabel')}
                            />
                        )}
                        emptyState={
                            anyFilterActive ? (
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={
                                        retentionFilter === 'archived'
                                            ? tx('list.emptyArchivedTitle')
                                            : retentionFilter === 'expiring'
                                                ? tx('list.emptyExpiringTitle')
                                                : tx('list.emptyFilterTitle')
                                    }
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
                                    title={t.noEvidence}
                                    description={tx('list.emptyRecordsDesc')}
                                />
                            )
                        }
                        resourceName={(p) => p ? tx('list.resourceMany') : tx('list.resourceOne')}
                        columnVisibility={columnVisibility}
                        onColumnVisibilityChange={setColumnVisibility}
                        data-testid="evidence-table"
                        className="hover:bg-bg-muted"
                    />
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}

// ─── Evidence filter toolbar ─────────────────────────────────────────

function EvidenceFilterToolbar({
    filters,
    actions,
    leading,
}: {
    filters: FilterType[];
    actions?: React.ReactNode;
    leading?: React.ReactNode;
}) {
    const tx = useTranslations('evidence');
    return (
        <FilterToolbar
            filters={filters}
            searchId="evidence-search"
            searchPlaceholder={tx('list.searchPlaceholder')}
            leading={leading}
            actions={actions}
        />
    );
}
