'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate, formatDateTime } from '@/lib/format-date';
import { SkeletonCard, SkeletonDetailPage } from '@/components/ui/skeleton';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { EditControlModal } from './_modals/EditControlModal';
import { ControlReverseLookupModal } from '@/components/controls/ControlReverseLookupModal';
import { LinkedVendorsPanel } from '@/components/LinkedVendorsPanel';
import { ControlMappingsTab } from './_tabs/ControlMappingsTab';
import { EvidenceSubTable, type EvidenceTabData } from '@/components/controls-shared/EvidenceSubTable';
import { ControlChecksTab } from './_tabs/ControlChecksTab';
import { EvidenceAddForm } from '@/components/EvidenceAddForm';
import { MetaStrip } from '@/components/ui/meta-strip';
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CONTROL_CATEGORY_THEMES } from '@/lib/controls/control-categories';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { extractMutationError } from '@/lib/mutations';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Tooltip, InfoTooltip } from '@/components/ui/tooltip';
import { CopyText } from '@/components/ui/copy-text';
import dynamic from 'next/dynamic';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { AsidePanel } from '@/components/ui/aside-panel';
import { AutomationSuggestionsRail } from '@/components/automation/AutomationSuggestionsRail';
import { Sparkle3 } from '@/components/ui/icons/nucleo/sparkle3';
import { cardVariants } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

import { ControlRoiCard } from './_components/ControlRoiCard';
import { ControlHealthCard } from './_tabs/ControlHealthCard';
import { ControlBiaSurface } from '@/components/bia/ControlBiaSurface';

const TraceabilityPanel = dynamic(() => import('@/components/TraceabilityPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});
// Epic G-5 — exceptions panel + header badge. The badge alone is
// loaded eagerly via a tiny named import so the control header can
// surface "Exception: APPROVED" without waiting for the modal
// machinery in the panel chunk.
const ControlExceptionsPanel = dynamic(
    () => import('@/components/ControlExceptionsPanel').then((m) => m.ControlExceptionsPanel),
    {
        loading: () => <SkeletonCard lines={3} />,
        ssr: false,
    },
);
const ControlExceptionHeaderBadge = dynamic(
    () => import('@/components/ControlExceptionsPanel').then((m) => m.ControlExceptionHeaderBadge),
    { ssr: false },
);
const TestPlansPanel = dynamic(() => import('@/components/TestPlansPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});
const LinkedTasksPanel = dynamic(() => import('@/components/LinkedTasksPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});
import type {
    ControlDetailDTO, EvidenceLinkDTO,
    ContributorDTO, AuditLogEntry,
} from '@/lib/dto';
import { buildControlStatusLabels } from '../filter-defs';
import { buildControlPatchBody } from '../_lib/control-write-values';
import { Pencil } from 'lucide-react';

// The detail status dropdown reuses the CANONICAL status vocabulary
// (buildControlStatusLabels — the same i18n source the list badges + filter
// use) so no status is un-selectable on detail. NOT_APPLICABLE is omitted
// because it is set via the separate applicability action, not the status
// dropdown; the other six (NOT_STARTED / PLANNED / IN_PROGRESS /
// IMPLEMENTING / IMPLEMENTED / NEEDS_REVIEW) are all selectable here.
const buildStatusLabels = (t: (k: string) => string): Record<string, string> => {
    const { NOT_APPLICABLE: _omitNa, ...selectable } = buildControlStatusLabels(t);
    return selectable;
};
const buildFreqLabels = (t: (k: string) => string): Record<string, string> => ({
    AD_HOC: t('freq.adHoc'), DAILY: t('freq.daily'), WEEKLY: t('freq.weekly'),
    MONTHLY: t('freq.monthly'), QUARTERLY: t('freq.quarterly'), ANNUALLY: t('freq.annually'),
});
const buildAutomationTypeLabels = (t: (k: string) => string): Record<string, string> => ({
    AUTOMATED: t('automationTypeLabels.AUTOMATED'), MANUAL: t('automationTypeLabels.MANUAL'), IT_DEPENDENT_MANUAL: t('automationTypeLabels.IT_DEPENDENT_MANUAL'),
});
const buildMitigationTypeLabels = (t: (k: string) => string): Record<string, string> => ({
    PREVENTIVE: t('mitigationTypeLabels.PREVENTIVE'), DETECTIVE: t('mitigationTypeLabels.DETECTIVE'), DETERRENT: t('mitigationTypeLabels.DETERRENT'),
    CORRECTIVE: t('mitigationTypeLabels.CORRECTIVE'), COMPENSATING: t('mitigationTypeLabels.COMPENSATING'),
});
const FREQ_OPTIONS = ['', 'AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'];
const buildFreqCbOptions = (freqLabels: Record<string, string>): ComboboxOption[] => FREQ_OPTIONS.filter(Boolean).map(fq => ({ value: fq, label: freqLabels[fq] || fq }));
const CATEGORY_OPTIONS = ['', ...CONTROL_CATEGORY_THEMES];
const buildCategoryLabels = (t: (k: string) => string): Record<string, string> => ({
    ORGANIZATIONAL: t('categoryLabels.ORGANIZATIONAL'), PEOPLE: t('categoryLabels.PEOPLE'), PHYSICAL: t('categoryLabels.PHYSICAL'), TECHNOLOGICAL: t('categoryLabels.TECHNOLOGICAL'),
});
const buildCategoryCbOptions = (categoryLabels: Record<string, string>): ComboboxOption[] => CATEGORY_OPTIONS.filter(Boolean).map(c => ({ value: c, label: categoryLabels[c] || c }));
const buildStatusCbOptions = (statusLabels: Record<string, string>): ComboboxOption[] => Object.entries(statusLabels).map(([val, lbl]) => ({ value: val, label: lbl }));

// R2-P2 — an Overview field label that teaches its own term. Reuses the
// NewControlModal applicability-tooltip pattern (InfoTooltip beside the label)
// so a control detail explains its vocabulary instead of assuming it.
function ConceptEyebrow({ label, help, helpLabel }: { label: string; help: string; helpLabel: string }) {
    return (
        <span className="text-xs text-content-subtle uppercase inline-flex items-center gap-1">
            {label}
            <InfoTooltip aria-label={helpLabel} content={help} iconClassName="h-3 w-3" />
        </span>
    );
}

type Tab = 'overview' | 'tasks' | 'evidence' | 'mappings' | 'traceability' | 'activity' | 'tests' | 'checks';

/**
 * Evidence-tab payload — `GET /controls/{id}/evidence` (#102 item 1).
 * Carries both the manual evidence links and the `Evidence` entities
 * attached directly to the control.
 */


const EVENT_KEYS = ['CONTROL_CREATED','CONTROL_UPDATED','CONTROL_STATUS_CHANGED','CONTROL_APPLICABILITY_CHANGED','CONTROL_OWNER_CHANGED','CONTROL_CONTRIBUTOR_ADDED','CONTROL_CONTRIBUTOR_REMOVED','CONTROL_TASK_CREATED','CONTROL_TASK_COMPLETED','CONTROL_TASK_UPDATED','CONTROL_EVIDENCE_LINKED','CONTROL_EVIDENCE_UNLINKED','CONTROL_TEST_COMPLETED','CONTROL_INSTALLED_FROM_TEMPLATE'] as const;
const buildEventLabels = (t: (k: string) => string): Record<string, string> => Object.fromEntries(EVENT_KEYS.map(k => [k, t(`eventLabels.${k}`)]));

// Read-only Policies section (Overview tab): local status → badge map so
// this control page stays free of policy-domain helper imports.
const POLICY_STATUS_BADGE_VARIANT: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'error'> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'warning',
    APPROVED: 'success',
    PUBLISHED: 'success',
    ARCHIVED: 'neutral',
};

export default function ControlDetailPage() {
    const tx = useTranslations('controls');
    const STATUS_LABELS = buildStatusLabels(tx);
    const FREQ_LABELS = buildFreqLabels(tx);
    const AUTOMATION_TYPE_LABELS = buildAutomationTypeLabels(tx);
    const MITIGATION_TYPE_LABELS = buildMitigationTypeLabels(tx);
    const CATEGORY_LABELS = buildCategoryLabels(tx);
    const EVENT_LABELS = buildEventLabels(tx);
    const FREQ_CB_OPTIONS = buildFreqCbOptions(FREQ_LABELS);
    const CATEGORY_CB_OPTIONS = buildCategoryCbOptions(CATEGORY_LABELS);
    const STATUS_CB_OPTIONS = buildStatusCbOptions(STATUS_LABELS);
    const params = useParams();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions, tenantSlug } = useTenantContext();
    const controlId = params?.controlId as string;
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();

    // ─── Page data — Epic 69 SWR-first read ──────────────────────────
    //
    // Hits `/controls/:id/page-data` which collapses the prior
    // serial waterfall (GET /controls/:id THEN GET /controls/:id/sync)
    // into one round-trip. The sync sub-payload is `null` for
    // controls without an `automationKey` or when the mapping lookup
    // fails — the page renders the conflict badge unconditionally
    // against it.
    //
    // Epic 69 migration: this read used to flow through TanStack
    // React Query (`useQuery` + `queryKeys.controls.detail`). It's
    // now a `useTenantSWR` against `CACHE_KEYS.controls.pageData(id)`
    // so the status mutation below can apply optimistic updates that
    // the rest of the UI sees immediately. Other pages on this
    // codebase still use React Query — that migration is incremental.
    interface ControlPageDataDTO {
        // `_count` carries the tab badge counts; `doneControlTasks`
        // backs the Overview "Tasks Progress" widget (#102 item 1) —
        // the heavy relation arrays no longer ride on this payload.
        control: ControlDetailDTO & { doneControlTasks?: number };
        syncStatus: {
            syncStatus: string | null;
            lastSyncedAt: string | null;
            errorMessage: string | null;
            provider: string | null;
        } | null;
    }
    const pageDataKey = controlId
        ? CACHE_KEYS.controls.pageData(controlId)
        : null;
    const pageDataQuery = useTenantSWR<ControlPageDataDTO>(pageDataKey);
    const control = pageDataQuery.data?.control ?? null;
    const loading = pageDataQuery.isLoading;
    const error =
        pageDataQuery.error
            ? pageDataQuery.error.message || tx('detailPage.errors.controlNotFound')
            : '';
    // Stable revalidation handle that mirrors the prior `refetch()`
    // contract — `mutate(undefined)` re-runs the fetcher for this
    // hook's key. Wrapped in `useCallback` so the call sites that
    // pass it down to event handlers don't re-bind on every render.
    const refetch = useCallback(
        () => pageDataQuery.mutate(),
        [pageDataQuery],
    );
    const initialSyncStatus = pageDataQuery.data?.syncStatus ?? null;
    const [tab, setTab] = useState<Tab>('overview');

    // ─── Controls roster for the exception panel's compensating-control
    // picker ─────────────────────────────────────────────────────────
    //
    // The detail page has no controls roster in scope, so the
    // <ControlExceptionsPanel> compensating-control combobox was always
    // empty. Fetch the tenant's controls via the shared list key. The
    // unbounded `GET /controls` returns `{ rows, truncated }` (the
    // applyBackfillCap envelope), so extract `rows` and narrow to the
    // {id,name,code} shape the panel's ControlOption type expects. The
    // panel/dialog already filters out the current control by id.
    interface ControlRosterRow { id: string; name: string; code?: string | null }
    const rosterQuery = useTenantSWR<{ rows?: ControlRosterRow[] }>(
        CACHE_KEYS.controls.list(),
    );
    const compensatingControlChoices = useMemo<ControlRosterRow[]>(
        () =>
            (rosterQuery.data?.rows ?? []).map((c) => ({
                id: c.id,
                name: c.name,
                code: c.code ?? null,
            })),
        [rosterQuery.data],
    );

    // ─── Per-tab lazy reads (#102 item 1) ───────────────────────────
    //
    // The Tasks / Evidence / Mappings tab bodies each fetch their own
    // slice on demand. The SWR key is `null` until that tab is the
    // active one, so nothing loads until the user opens the tab — and
    // `getControlHeader` no longer eager-loads these four arrays into
    // the page-data payload. Mirrors the existing Activity /
    // Traceability / Tests panels, which already self-fetch.
    // B4 — the legacy control-task fetch was removed; the Tasks tab's
    // <LinkedTasksPanel> self-fetches the unified tasks.
    const evidenceSWR = useTenantSWR<EvidenceTabData>(
        controlId && tab === 'evidence'
            ? CACHE_KEYS.controls.evidence(controlId)
            : null,
    );

    // Status change
    const [changingStatus, setChangingStatus] = useState(false);

    // Applicability
    const [showApplicability, setShowApplicability] = useState(false);
    const [appChoice, setAppChoice] = useState('APPLICABLE');
    const [appJustification, setAppJustification] = useState('');
    const [savingApp, setSavingApp] = useState(false);
    // Epic P2-PR-C — reverse-lookup modal. "Where is this control
    // used in process maps?" — opens from a header button.
    const [reverseLookupOpen, setReverseLookupOpen] = useState(false);

    // Contributor add/remove (Overview). Adds/removes route through the
    // dedicated contributor endpoints; the page-data SWR (which already
    // carries `control.contributors`) is revalidated on success so the
    // badge list stays authoritative.
    const [addContributorId, setAddContributorId] = useState<string | null>(null);
    const [savingContributor, setSavingContributor] = useState(false);

    // Task creation

    // Evidence linking
    const [showEvidenceForm, setShowEvidenceForm] = useState(false);
    const [evidenceUrl, setEvidenceUrl] = useState('');
    const [evidenceNote, setEvidenceNote] = useState('');
    const [savingEvidence, setSavingEvidence] = useState(false);

    // File upload for this control (folded into the "+ Evidence" form)
    const [fileToUpload, setFileToUpload] = useState<File | null>(null);
    const [fileUploadTitle, setFileUploadTitle] = useState('');
    const [fileUploading, setFileUploading] = useState(false);
    const [fileUploadError, setFileUploadError] = useState('');
    const fileUploadRef = useRef<HTMLInputElement>(null);

    // Activity trail — lazily loaded only while the Activity tab is open
    // (conditional SWR key = null when closed), cached so re-opening the
    // tab renders instantly instead of re-fetching every time.
    const activityQuery = useTenantSWR<AuditLogEntry[]>(
        tab === 'activity' ? `/controls/${controlId}/activity` : null,
    );
    const activity = activityQuery.data ?? [];
    const activityLoading = activityQuery.isLoading;
    // Distinguish a fetch FAILURE from a genuinely empty trail — without
    // this the Activity tab renders "No activity" on an error, which reads
    // as "nothing happened" when the real story is "we couldn't load it".
    const activityError = activityQuery.error;

    // Sync status — drives the header conflict/synced badges (the
    // overview Automation section + manual "Sync Now" were removed).
    const [syncStatus, setSyncStatus] = useState<string | null>(null);
    const [syncLastAt, setSyncLastAt] = useState<string | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);

    // Edit modal state
    const [showEditModal, setShowEditModal] = useState(false);
    const [editForm, setEditForm] = useState({ name: '', objective: '', successCriteria: '', testingMethodology: '', category: '', frequency: '', owner: '', automationType: '', mitigationType: '', annualCost: '', effectiveness: '' });
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState('');

    // (fetchControl replaced by useQuery above — use refetch() below)

    // ─── Edit modal handlers ───

    const openEditModal = () => {
        if (!control) return;
        setEditForm({
            name: control.name || '',
            objective: control.objective || '',
            successCriteria: control.successCriteria || '',
            testingMethodology: control.testingMethodology || '',
            category: control.category || '',
            frequency: control.frequency || '',
            owner: control.ownerUserId || '',
            automationType: control.automationType || '',
            mitigationType: control.mitigationType || '',
            annualCost:
                control.annualCost === null || control.annualCost === undefined
                    ? ''
                    : String(control.annualCost),
            effectiveness:
                control.effectiveness === null || control.effectiveness === undefined
                    ? ''
                    : String(control.effectiveness),
        });
        setEditError('');
        setShowEditModal(true);
    };


    // ─── Mutation: edit control ─────────────────────────────────────
    //
    // Epic 69 migration — the prior React Query `useMutation` with
    // `onMutate` / `onError` rollback hooks is now a single
    // `useTenantMutation`. The optimistic update walks the cached
    // page-data shape (control nested under `pageData.control`)
    // because the SWR cache holds the whole envelope, not the bare
    // detail. Rollback is automatic on throw via SWR's
    // `rollbackOnError: true` default.
    const editMutation = useTenantMutation<
        ControlPageDataDTO,
        typeof editForm,
        unknown
    >({
        key: pageDataKey ?? '',
        mutationFn: async (form) => {
            const res = await fetch(apiUrl(`/controls/${controlId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildControlPatchBody(form)),
            });
            if (!res.ok) {
                const err = await res
                    .json()
                    .catch(() => ({}));
                throw new Error(extractMutationError(err, tx('detailPage.errors.updateFailed')));
            }
            // If owner changed, call the separate owner endpoint
            const originalOwner = control?.ownerUserId || '';
            if (form.owner.trim() !== originalOwner) {
                const ownerRes = await fetch(
                    apiUrl(`/controls/${controlId}/owner`),
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ownerUserId: form.owner.trim() || null,
                        }),
                    },
                );
                if (!ownerRes.ok) {
                    const ownerErr = await ownerRes
                        .json()
                        .catch(() => ({}));
                    throw new Error(
                        extractMutationError(ownerErr, tx('detailPage.errors.ownerUpdateFailed')),
                    );
                }
            }
            return form;
        },
        optimisticUpdate: (current, form) =>
            current
                ? {
                      ...current,
                      control: {
                          ...current.control,
                          name: form.name.trim(),
                          objective: form.objective.trim() || null,
                          successCriteria: form.successCriteria.trim() || null,
                          testingMethodology: form.testingMethodology.trim() || null,
                          category: form.category.trim() || null,
                          frequency: form.frequency || null,
                          // Kept in step with the PATCH body above — an
                          // optimistic paint that omits a field the request
                          // sends would flash the old value and then correct
                          // itself, which reads as a bug even when the write
                          // succeeded.
                          automationType: form.automationType || null,
                          mitigationType: form.mitigationType || null,
                      },
                  }
                : (current as unknown as ControlPageDataDTO),
        // Refresh the list cache too — the controls list page shows
        // these same fields.
        invalidate: [CACHE_KEYS.controls.list()],
    });

    const handleEditSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editForm.name || editForm.name.trim().length < 3) {
            setEditError(tx('detailPage.errors.titleMinLength'));
            return;
        }
        setSavingEdit(true);
        setEditError('');
        try {
            await editMutation.trigger(editForm);
            setShowEditModal(false);
            toast.success(tx('detailPage.controlUpdated'));
        } catch (err) {
            setEditError(err instanceof Error ? err.message : tx('detailPage.errors.updateFailed'));
        } finally {
            setSavingEdit(false);
        }
    };

    const handleEditCancel = () => {
        setShowEditModal(false);
        setEditError('');
    };

    // (Activity is now loaded via the conditional `activityQuery`
    // useTenantSWR above — no imperative fetch-on-tab-open effect.)

    // Hydrate sync status from the page-data response (one round-trip
    // instead of the previous control-then-sync waterfall). The
    // dependency on the data identity — not just on automationKey —
    // ensures the badge updates after `refetch()` lands a fresh
    // page-data payload (e.g. after Sync Now or after an edit that
    // changes the automationKey).
    useEffect(() => {
        if (!initialSyncStatus) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSyncStatus(null);
            setSyncLastAt(null);
            setSyncError(null);
            return;
        }
        setSyncStatus(initialSyncStatus.syncStatus ?? null);
        setSyncLastAt(initialSyncStatus.lastSyncedAt ?? null);
        setSyncError(initialSyncStatus.errorMessage ?? null);
    }, [initialSyncStatus]);

    // ─── Mutation: change control status (Epic 69 pilot #2) ────────
    //
    // The headline migration of this file. The previous flow was
    // `fetch(POST /status) → await refetch() → invalidateQueries(list)`,
    // a coarse round-trip that left the badge showing the old value
    // for the duration of the network call.
    //
    // The new flow uses `useTenantMutation`:
    //
    //   1. `optimisticUpdate` flips `control.status` in the cached
    //      page-data envelope synchronously — the badge re-renders
    //      with the predicted value before the POST is sent.
    //   2. `mutationFn` performs the POST. A non-2xx response throws.
    //   3. On success, SWR background-revalidates the page-data key
    //      (re-fetches `/controls/{id}/page-data`) — confirming the
    //      server agrees with the prediction. The `invalidate`
    //      sibling (`/controls`) refreshes the list page in parallel.
    //   4. On failure, `rollbackOnError: true` (the default) restores
    //      the prior `control.status` automatically — the badge
    //      flips back to the original value with no spinner thrash.
    //
    // No `router.refresh()` involved. No coarse page reload. No
    // imperative `refetch()` chained behind state setters.
    const statusMutation = useTenantMutation<
        ControlPageDataDTO,
        { status: string },
        unknown
    >({
        key: pageDataKey ?? '',
        mutationFn: async ({ status }) => {
            const res = await fetch(apiUrl(`/controls/${controlId}/status`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) {
                const err = await res
                    .json()
                    .catch(() => ({}));
                throw new Error(
                    extractMutationError(err, tx('detailPage.errors.statusUpdateFailed')),
                );
            }
            return res.json().catch(() => null);
        },
        optimisticUpdate: (current, { status }) =>
            current
                ? {
                      ...current,
                      control: { ...current.control, status },
                  }
                : (current as unknown as ControlPageDataDTO),
        // List page shows status badges too — keep it in sync, and the
        // executive dashboard's control-coverage KPI shifts on a status
        // flip, so refresh its card stack too.
        invalidate: [CACHE_KEYS.controls.list(), CACHE_KEYS.dashboard.executive()],
    });

    const changeStatus = async (status: string) => {
        setChangingStatus(true);
        try {
            await statusMutation.trigger({ status });
        } catch {
            // Rollback already applied by the hook; the error is
            // available on `statusMutation.error` for any future
            // toast surface. Status badge has reverted on its own.
        } finally {
            setChangingStatus(false);
        }
    };

    const saveApplicability = async () => {
        if (appChoice === 'NOT_APPLICABLE' && !appJustification.trim()) return;
        setSavingApp(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/applicability`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applicability: appChoice, justification: appChoice === 'NOT_APPLICABLE' ? appJustification : null }),
            });
            // Applicability is an auditable Statement-of-Applicability
            // decision — never report success (nor close the panel) unless
            // the write actually landed.
            if (!res.ok) {
                toast.error(tx('detailPage.errors.applicabilityFailed'));
                return;
            }
            await refetch();
            toast.success(tx('detailPage.applicabilityUpdated'));
            setShowApplicability(false);
        } finally {
            setSavingApp(false);
        }
    };

    const addContributor = async () => {
        if (!addContributorId) return;
        setSavingContributor(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/contributors`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: addContributorId }),
            });
            if (!res.ok) {
                toast.error(tx('detailPage.errors.addContributorFailed'));
                return;
            }
            setAddContributorId(null);
            await refetch();
        } finally {
            setSavingContributor(false);
        }
    };

    // Epic 67 — deferred-commit contributor removal. Optimistically drop
    // the contributor from the page-data SWR cache so the badge disappears
    // immediately; the DELETE only fires after the 5 s undo window. Undo (or
    // a failed commit) restores the whole page-data snapshot.
    const removeContributor = (userId: string) => {
        const previous = pageDataQuery.data;
        if (previous) {
            pageDataQuery.mutate(
                {
                    ...previous,
                    control: {
                        ...previous.control,
                        contributors: (previous.control.contributors ?? []).filter(
                            (c) => c.user.id !== userId,
                        ),
                    },
                },
                { revalidate: false },
            );
        }
        triggerUndoToast({
            message: tx('detailPage.contributorRemoved'),
            undoMessage: tx('detailPage.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/controls/${controlId}/contributors/${userId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) {
                    throw new Error(tx('detailPage.errors.removeContributorFailed'));
                }
                await refetch();
            },
            undoAction: () => {
                if (previous) {
                    pageDataQuery.mutate(previous, { revalidate: false });
                }
            },
            onError: () => {
                if (previous) {
                    pageDataQuery.mutate(previous, { revalidate: false });
                }
                toast.error(tx('detailPage.errors.removeContributorFailed'));
            },
        });
    };

    // B4 (2026-06-07): the legacy control-scoped task flow
    // (updateTaskStatus + controlTaskColumns + the tasksSWR fetch) was
    // removed with the legacy "Control tasks" DataTable — the Control Tasks
    // tab is now a single <LinkedTasksPanel>, matching Asset + Risk.

    const resetEvidenceForm = () => {
        setEvidenceUrl('');
        setEvidenceNote('');
        setFileToUpload(null);
        setFileUploadTitle('');
        setFileUploadError('');
        if (fileUploadRef.current) fileUploadRef.current.value = '';
        setShowEvidenceForm(false);
    };

    // Unified "+ Evidence" submit. The single form supports BOTH a file
    // upload (browse + title) and a URL link. A chosen file takes
    // precedence: it uploads via /evidence/uploads (FileRecord +
    // Evidence(FILE) + ControlEvidenceLink); otherwise a non-empty URL
    // links a LINK evidence record. Both land in this control's Evidence
    // tab + the Evidence Library.
    const addEvidence = async (e: React.FormEvent) => {
        e.preventDefault();
        setFileUploadError('');

        if (fileToUpload) {
            setFileUploading(true);
            try {
                const formData = new FormData();
                formData.append('file', fileToUpload);
                if (fileUploadTitle) formData.append('title', fileUploadTitle);
                formData.append('controlId', controlId);
                const res = await fetch(apiUrl('/evidence/uploads'), { method: 'POST', body: formData });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
                    throw new Error(err.error || err.message || tx('detailPage.errors.uploadFailed'));
                }
                resetEvidenceForm();
                await Promise.all([evidenceSWR.mutate(), refetch()]);
            } catch (err: unknown) {
                setFileUploadError(err instanceof Error ? err.message : tx('detailPage.errors.uploadFailed'));
            } finally {
                setFileUploading(false);
            }
            return;
        }

        if (!evidenceUrl.trim()) {
            setFileUploadError(tx('detailPage.errors.chooseFile'));
            return;
        }
        setSavingEvidence(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/evidence`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'LINK', url: evidenceUrl, note: evidenceNote || undefined }),
            });
            if (!res.ok) throw new Error(tx('detailPage.errors.linkEvidenceFailed'));
            resetEvidenceForm();
            await Promise.all([evidenceSWR.mutate(), refetch()]);
        } catch (err: unknown) {
            setFileUploadError(err instanceof Error ? err.message : tx('detailPage.errors.linkEvidenceFailed'));
        } finally {
            setSavingEvidence(false);
        }
    };

    // Epic 67 — delayed-commit unlink. Optimistic remove via SWR
    // `mutate(key, value, { revalidate: false })` so the row
    // disappears immediately; the actual DELETE fires after the 5 s
    // undo window. Snapshot is the WHOLE pageData so undo can
    // restore even if the user concurrently triggered another
    // change.
    //
    // Migrated from `queryClient.setQueryData/getQueryData` to the
    // SWR equivalent in the Epic 69 pass — semantics identical.
    const unlinkEvidence = (linkId: string) => {
        // Epic 67 delayed-commit unlink — now scoped to the Evidence
        // tab's own SWR cache (#102 item 1). Optimistically drop the
        // link so the row disappears immediately; the DELETE fires
        // after the 5 s undo window. Snapshot is the whole tab
        // payload so undo restores even after a concurrent change.
        const previous = evidenceSWR.data;
        if (previous) {
            evidenceSWR.mutate(
                {
                    ...previous,
                    links: previous.links.filter(
                        (link) => link.id !== linkId,
                    ),
                },
                { revalidate: false },
            );
        }
        triggerUndoToast({
            message: tx('detailPage.evidenceUnlinked'),
            undoMessage: tx('detailPage.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/controls/${controlId}/evidence/${linkId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(tx('detailPage.errors.unlinkFailed'));
                // Confirm the tab list + refresh the header badge.
                await Promise.all([evidenceSWR.mutate(), refetch()]);
            },
            undoAction: () => {
                if (previous) {
                    evidenceSWR.mutate(previous, { revalidate: false });
                }
            },
            onError: () => {
                if (previous) {
                    evidenceSWR.mutate(previous, { revalidate: false });
                }
            },
        });
    };

    // Loading / error / empty states render through the shared
    // EntityDetailLayout — same skeleton + same error/empty copy
    // every detail page in Inflect uses.
    if (loading) {
        // RQ3-OB-B — structured skeleton instead of an empty shell.
        // Mirrors the risk detail page; the empty children left a
        // flash of bare layout chrome before the page-data SWR call
        // resolved.
        return (
            <EntityDetailLayout loading title="">
                <SkeletonDetailPage />
            </EntityDetailLayout>
        );
    }
    if (error) {
        return (
            <EntityDetailLayout error={error} title="">
                {null}
            </EntityDetailLayout>
        );
    }
    if (!control) {
        return (
            <EntityDetailLayout empty={{ message: tx('detailPage.notFound') }} title="">
                {null}
            </EntityDetailLayout>
        );
    }

    // Tab badge counts + Overview progress now read `_count` off the
    // header payload (#102 item 1) — the relation arrays no longer
    // ride on page-data. The Evidence badge is `links + evidence`
    // counts; the prior exact de-dup of file-backed evidence already
    // linked is dropped — a badge tolerates the rare double-count.
    const totalTasks = control._count?.controlTasks ?? 0;
    const doneTasks = control.doneControlTasks ?? 0;
    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: tx('detailPage.tabOverview') },
        { key: 'tasks', label: tx('detailPage.tabTasks'), count: totalTasks },
        {
            key: 'evidence',
            label: tx('detailPage.tabEvidence'),
            count:
                (control._count?.evidenceLinks ?? 0) +
                // EP-3 — Evidence entities reach the control through the join.
                (control._count?.evidenceControlLinks ?? 0),
        },
        // Tab KEY stays 'mappings' (URLs/state depend on it); only the
        // visible LABEL is "Requirements" — this tab holds control↔requirement
        // links, while the Traceability tab holds risks + assets.
        { key: 'mappings', label: tx('detailPage.tabRequirements'), count: control._count?.frameworkMappings ?? 0 },
        { key: 'traceability', label: tx('detailPage.tabTraceability') },
        { key: 'activity', label: tx('detailPage.tabActivity') },
        { key: 'tests', label: tx('detailPage.tabTests') },
        { key: 'checks', label: tx('detailPage.tabChecks') },
    ];

    // ── Header meta strip (Polish PR-1) ──
    //
    // Replaced a 6-badge fragment with the shared <MetaStrip>
    // primitive. Sync-state indicators (CONFLICT / FAILED / SYNCED)
    // moved OUT of meta into a per-page InlineNotice — they're
    // alerts, not metadata. The exception badge stays as a
    // status-shaped meta entry; the per-control code stays as a
    // copyable text entry.
    const headerMeta = (
        <MetaStrip
            items={[
                ...(control.code
                    ? [
                          {
                              label: tx('detailPage.metaCode'),
                              value: (
                                  <CopyText
                                      value={control.code}
                                      label={tx('detailPage.copyCodeAria', { code: control.code })}
                                      successMessage={tx('detailPage.codeCopied')}
                                      className="text-xs text-content-subtle"
                                  >
                                      {control.code}
                                  </CopyText>
                              ),
                          } as const,
                      ]
                    : []),
                {
                    kind: 'status' as const,
                    id: 'control-status',
                    label: tx('status'),
                    value: STATUS_LABELS[control.status] ?? control.status,
                    variant:
                        CONTROL_STATUS_VARIANT[control.status] ?? 'neutral',
                },
                {
                    kind: 'status' as const,
                    id: 'control-applicability',
                    label: tx('detailPage.metaApplicability'),
                    value:
                        control.applicability === 'NOT_APPLICABLE'
                            ? tx('notApplicable')
                            : tx('applicable'),
                    variant:
                        control.applicability === 'NOT_APPLICABLE'
                            ? 'warning'
                            : 'success',
                },
            ]}
        />
    );

    // Sync state migrated out of the meta strip — shown as a banner
    // below the page header so the meta strip stays at 3 stable
    // items.
    const syncBanner = (
        <>
            {syncStatus === 'CONFLICT' && (
                <Tooltip
                    title={tx('detailPage.syncConflictTitle')}
                    content={syncError ?? tx('detailPage.syncConflictContent')}
                >
                    <StatusBadge variant="error" className="flex items-center gap-1 cursor-help" id="sync-conflict-badge">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                        {tx('detailPage.syncConflictBadge')}
                    </StatusBadge>
                </Tooltip>
            )}
            {syncStatus === 'FAILED' && (
                <Tooltip
                    title={tx('detailPage.syncFailedTitle')}
                    content={syncError ?? tx('detailPage.syncFailedContent')}
                >
                    <StatusBadge variant="error" className="flex items-center gap-1 cursor-help" id="sync-failed-badge">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
                        {tx('detailPage.syncFailedBadge')}
                    </StatusBadge>
                </Tooltip>
            )}
            {syncStatus === 'SYNCED' && (
                <Tooltip content={syncLastAt ? tx('detailPage.lastSynced', { time: formatDateTime(syncLastAt) }) : tx('detailPage.synced')}>
                    <StatusBadge variant="success" className="flex items-center gap-1 cursor-help" id="sync-ok-badge">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                        {tx('detailPage.synced')}
                    </StatusBadge>
                </Tooltip>
            )}
            <ControlExceptionHeaderBadge
                tenantSlug={tenantSlug}
                controlId={control.id}
            />
        </>
    );

    // ── Header actions (right side) ──
    const headerActions = (
        <>
            {/* Epic P2-PR-C — Where used in process maps. Visible to
                all viewers (readers + auditors need it most). */}
            <Button
                variant="secondary"
                onClick={() => setReverseLookupOpen(true)}
                id="control-where-used-btn"
                data-testid="control-where-used-btn"
            >
                {tx('detailPage.whereUsed')}
            </Button>
            {permissions.canWrite && (
                <>
                    <Combobox
                        hideSearch
                        id="control-status-select"
                        selected={STATUS_CB_OPTIONS.find(o => o.value === control.status) ?? null}
                        setSelected={(opt) => { if (opt) changeStatus(opt.value); }}
                        options={STATUS_CB_OPTIONS}
                        disabled={changingStatus}
                        placeholder={tx('status')}
                        // Item 29 — brand-color the status action (matches the
                        // primary "+ …" create buttons).
                        buttonProps={{ variant: 'primary', className: 'text-sm' }}
                    />
                    <Button variant="secondary" onClick={() => { setAppChoice(control.applicability); setAppJustification(control.applicabilityJustification || ''); setShowApplicability(!showApplicability); }} id="toggle-applicability-btn">
                        {tx('detailPage.applicabilityButton')}
                    </Button>
                </>
            )}
        </>
    );

    return (
        <EntityDetailLayout
            id="control-detail-page"
            back={{ smart: true }}
            breadcrumbs={[
                { label: tx('detailPage.breadcrumbDashboard'), href: tenantHref('/dashboard') },
                { label: tx('detailPage.breadcrumbControls'), href: tenantHref('/controls') },
                { label: control.name },
            ]}
            title={<span id="control-title">{control.name}</span>}
            meta={headerMeta}
            actions={headerActions}
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
            rail={
                <AsidePanel
                    title={tx('detailPage.aiSuggestions')}
                    surfaceKey="controls-detail-ai"
                    defaultCollapsed
                    icon={<Sparkle3 className="h-4 w-4" />}
                >
                    <AutomationSuggestionsRail />
                </AsidePanel>
            }
        >
            {/* Sync state + exception badges (moved out of meta strip
                in Polish PR-1). Renders inline above tab content. */}
            {syncStatus !== 'NONE' && (
                <div className="flex flex-wrap gap-tight" data-testid="control-sync-banner">
                    {syncBanner}
                </div>
            )}
            {/* Applicability modal */}
            {showApplicability && permissions.canWrite && (
                <div className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                    <Heading level={3}>{tx('setApplicability')}</Heading>
                    <RadioGroup value={appChoice} onValueChange={setAppChoice} className="flex gap-default">
                        <div className="flex items-center gap-tight">
                            <RadioGroupItem value="APPLICABLE" id="applicability-applicable" size="sm" />
                            <Label htmlFor="applicability-applicable" className="cursor-pointer">{tx('applicable')}</Label>
                        </div>
                        <div className="flex items-center gap-tight">
                            <RadioGroupItem value="NOT_APPLICABLE" id="applicability-not-applicable" size="sm" />
                            <Label htmlFor="applicability-not-applicable" className="cursor-pointer">{tx('notApplicable')}</Label>
                        </div>
                    </RadioGroup>
                    {appChoice === 'NOT_APPLICABLE' && (
                        <FormField label="">
                            <Textarea
                                id="applicability-justification"
                                rows={2}
                                placeholder={tx('detailPage.justificationRequiredPlaceholder')}
                                value={appJustification}
                                onChange={(e) => setAppJustification(e.target.value)}
                            />
                        </FormField>
                    )}
                    <Button variant="primary" onClick={saveApplicability} disabled={savingApp || (appChoice === 'NOT_APPLICABLE' && !appJustification.trim())} id="save-applicability-btn">
                        {savingApp ? tx('detailPage.saving') : tx('detailPage.save')}
                    </Button>
                </div>
            )}

            {/* Tab content — tab bar is rendered by EntityDetailLayout */}
            {/* R2-P2 — control health synthesis: status + applicability +
                latest test + latest check + effectiveness + coverage, so the
                "is it implemented and operating?" answer is in one place. */}
            {tab === 'overview' && <ControlHealthCard controlId={controlId} />}
            {tab === 'overview' && <ControlRoiCard controlId={controlId} />}

            {/* Conditional BIA surface (continuity section / process-impact chip /
                nothing) — the no-dead-tab contract lives inside the component. */}
            {tab === 'overview' && <ControlBiaSurface controlId={controlId} />}

            {tab === 'overview' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {/* Overview header with Edit button */}
                    {permissions.canWrite && (
                        <div className="flex justify-end -mt-1 -mb-2">
                            <Tooltip content={tx('detailPage.editControl')}>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    onClick={openEditModal}
                                    data-testid="control-edit-button"
                                    id="control-edit-button"
                                    aria-label={tx('detailPage.editControl')}
                                >
                                    {/* B2 — icon-only edit affordance,
                                        canonical unified pattern. */}
                                    <Pencil size={16} />
                                </Button>
                            </Tooltip>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-section">
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowObjective')}</span>
                            <p className="text-sm text-content-default mt-1 whitespace-pre-line">{control.objective || tx('detailPage.objectiveEmpty')}</p>
                        </div>
                        <div>
                            <ConceptEyebrow label={tx('detailPage.eyebrowSuccessCriteria')} help={tx('conceptHelp.successCriteria')} helpLabel={tx('conceptHelp.successCriteriaHelp')} />
                            <p className="text-sm text-content-default mt-1 whitespace-pre-line">{control.successCriteria || '—'}</p>
                        </div>
                        <div>
                            <ConceptEyebrow label={tx('editModal.categoryLabel')} help={tx('conceptHelp.category')} helpLabel={tx('conceptHelp.categoryHelp')} />
                            <p className="text-sm text-content-default mt-1">{control.category || '—'}</p>
                        </div>
                        <div>
                            <ConceptEyebrow label={tx('detailPage.eyebrowFrequency')} help={tx('conceptHelp.frequency')} helpLabel={tx('conceptHelp.frequencyHelp')} />
                            <p className="text-sm text-content-default mt-1">{control.frequency ? FREQ_LABELS[control.frequency] || control.frequency : '—'}</p>
                        </div>
                        <div>
                            <ConceptEyebrow label={tx('detailPage.eyebrowAutomationType')} help={tx('conceptHelp.automationType')} helpLabel={tx('conceptHelp.automationTypeHelp')} />
                            <p className="text-sm text-content-default mt-1">{control.automationType ? AUTOMATION_TYPE_LABELS[control.automationType] || control.automationType : '—'}</p>
                        </div>
                        <div>
                            <ConceptEyebrow label={tx('detailPage.eyebrowMitigationType')} help={tx('conceptHelp.mitigationType')} helpLabel={tx('conceptHelp.mitigationTypeHelp')} />
                            <p className="text-sm text-content-default mt-1">{control.mitigationType ? MITIGATION_TYPE_LABELS[control.mitigationType] || control.mitigationType : '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowOwner')}</span>
                            <p className="text-sm text-content-default mt-1">{control.owner?.name || '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowTasksProgress')}</span>
                            <p className="text-sm text-content-default mt-1">{tx('detailPage.tasksProgressValue', { done: doneTasks, total: totalTasks })}</p>
                        </div>
                        {control.applicability === 'NOT_APPLICABLE' && control.applicabilityJustification && (
                            <div className="col-span-2">
                                <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowNaJustification')}</span>
                                <p className="text-sm text-content-warning mt-1">{control.applicabilityJustification}</p>
                            </div>
                        )}
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowContributors')}</span>
                            <div className="text-sm text-content-default mt-1 flex flex-wrap items-center gap-tight">
                                {(control.contributors?.length ?? 0) > 0 ? control.contributors?.map((c: ContributorDTO) => (
                                    <StatusBadge variant="neutral" key={c.user.id} className="inline-flex items-center gap-1">
                                        {c.user.name ?? '—'}
                                        {permissions.canWrite && (
                                            <button
                                                type="button"
                                                onClick={() => removeContributor(c.user.id)}
                                                disabled={savingContributor}
                                                aria-label={tx('detailPage.removeContributor', { name: c.user.name ?? '' })}
                                                id={`remove-contributor-${c.user.id}`}
                                                className="text-content-subtle hover:text-content-error leading-none"
                                            >
                                                &times;
                                            </button>
                                        )}
                                    </StatusBadge>
                                )) : <span className="text-content-subtle">—</span>}
                            </div>
                            {permissions.canWrite && (
                                <div className="mt-2 flex items-center gap-tight">
                                    <div className="min-w-0 flex-1">
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            selectedId={addContributorId}
                                            onChange={(userId) => setAddContributorId(userId)}
                                            placeholder={tx('detailPage.addContributorPlaceholder')}
                                            size="sm"
                                            filter={(m) =>
                                                !(control.contributors ?? []).some((c) => c.user.id === m.id)
                                            }
                                        />
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={addContributor}
                                        disabled={!addContributorId || savingContributor}
                                        id="add-contributor-btn"
                                    >
                                        {tx('detailPage.addContributor')}
                                    </Button>
                                </div>
                            )}
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowLastTested')}</span>
                            <p className="text-sm text-content-default mt-1">{control.lastTested ? formatDate(control.lastTested) : '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowNextDue')}</span>
                            <p className="text-sm text-content-default mt-1">{control.nextDueAt ? formatDate(control.nextDueAt) : '—'}</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Control Modal — extracted to _modals/EditControlModal.tsx
                in Elevation PR-2. Page still owns state + mutation; the
                modal is presentational. */}
            <EditControlModal
                open={showEditModal}
                setOpen={setShowEditModal}
                form={editForm}
                setForm={setEditForm}
                saving={savingEdit}
                error={editError}
                tenantSlug={tenantSlug}
                categoryOptions={CATEGORY_CB_OPTIONS}
                frequencyOptions={FREQ_CB_OPTIONS}
                onCancel={handleEditCancel}
                onSubmit={handleEditSave}
            />

            {/* Epic P2-PR-C — Where used (process maps) modal */}
            <ControlReverseLookupModal
                controlId={control.id}
                tenantSlug={tenantSlug}
                open={reverseLookupOpen}
                onOpenChange={setReverseLookupOpen}
            />

            {tab === 'tasks' && (
                // B4 (2026-06-07): the Control Tasks tab now matches the
                // Asset + Risk Tasks tabs exactly — a single card-wrapped
                // <LinkedTasksPanel>. The divergent legacy "Control tasks
                // (legacy)" DataTable (the old per-control ControlTask
                // model) was removed; tasks live in the unified Tasks table,
                // linked back via TaskLink.
                <div className={cardVariants()} id="control-tasks-tab">
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="CONTROL"
                        entityId={controlId}
                        tenantHref={tenantHref}
                        canWrite={permissions.canWrite}
                    />
                </div>
            )}

            {tab === 'evidence' && (
                <div className="space-y-default">
                    <EvidenceAddForm
                        ids={{
                            trigger: 'link-evidence-btn',
                            form: 'control-evidence-form',
                            title: 'control-upload-title',
                            file: 'control-file-input',
                            url: 'evidence-url-input',
                            note: 'evidence-note-input',
                            error: 'control-evidence-error',
                            submit: 'submit-evidence-btn',
                        }}
                        canWrite={permissions.canWrite}
                        show={showEvidenceForm}
                        onToggleShow={() => { setShowEvidenceForm(!showEvidenceForm); setFileUploadError(''); }}
                        file={fileToUpload}
                        onFileChange={setFileToUpload}
                        fileInputRef={fileUploadRef}
                        title={fileUploadTitle}
                        onTitleChange={setFileUploadTitle}
                        url={evidenceUrl}
                        onUrlChange={setEvidenceUrl}
                        note={evidenceNote}
                        onNoteChange={setEvidenceNote}
                        onSubmit={addEvidence}
                        error={fileUploadError}
                        uploading={fileUploading}
                        saving={savingEvidence}
                    />
                    <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                        {evidenceSWR.error ? (
                            <InlineEmptyState
                                title={tx('detailPage.couldntLoadEvidence')}
                                description={tx('detailPage.couldntLoadEvidenceDesc')}
                            />
                        ) : (
                            <EvidenceSubTable
                                data={evidenceSWR.data}
                                loading={evidenceSWR.isLoading && !evidenceSWR.data}
                                canWrite={permissions.canWrite}
                                onUnlink={unlinkEvidence}
                                tenantHref={tenantHref}
                            />
                        )}
                    </div>
                </div>
            )}

            {tab === 'mappings' && (
                <ControlMappingsTab
                    controlId={controlId}
                    canWrite={permissions.canWrite}
                    onMutated={refetch}
                />
            )}

            {tab === 'traceability' && (
                <div className="space-y-section">
                    <TraceabilityPanel
                        apiBase={apiUrl('')}
                        entityType="control"
                        entityId={controlId}
                        canWrite={permissions.canWrite}
                        tenantHref={tenantHref}
                    />
                    <div className="border-t border-border-subtle pt-default">
                        <LinkedVendorsPanel entityType="CONTROL" entityId={controlId} />
                    </div>
                </div>
            )}

            {tab === 'activity' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    {activityLoading ? (
                        <div className="p-8 text-center text-content-subtle animate-pulse">{tx('detailPage.loadingActivity')}</div>
                    ) : activityError ? (
                        <InlineEmptyState
                            title={tx('detailPage.couldntLoadActivity')}
                            description={tx('detailPage.couldntLoadActivityDesc')}
                        />
                    ) : activity.length === 0 ? (
                        <InlineEmptyState
                            title={tx('detailPage.noActivity')}
                            description={tx('detailPage.activityEmptyDesc')}
                        />
                    ) : (
                        <div className="divide-y divide-border-default/50" id="activity-feed">
                            {activity.map((ev: AuditLogEntry) => (
                                <div key={ev.id} className="px-5 py-3 flex items-start gap-compact">
                                    <div className="mt-0.5">
                                        <StatusBadge variant="info">{EVENT_LABELS[ev.action] || ev.action}</StatusBadge>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-content-default">{ev.details}</p>
                                        <p className="text-xs text-content-subtle mt-0.5">
                                            {ev.user?.name || tx('detailPage.systemActor')} · {formatDateTime(ev.createdAt)}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {tab === 'tests' && (
                <div className="space-y-default">
                    {/* R2-P2 — clarify Tests (manual) vs Checks (automated). */}
                    <p className="text-sm text-content-muted">{tx('detailPage.testsVsChecks')}</p>
                    {control.testingMethodology && (
                        <div className={cardVariants({ density: 'compact' })}>
                            <span className="text-xs text-content-subtle uppercase">{tx('detailPage.eyebrowTestingMethodology')}</span>
                            <p className="text-sm text-content-default mt-1 whitespace-pre-line">{control.testingMethodology}</p>
                        </div>
                    )}
                    <div className={cardVariants({ density: 'compact' })}>
                        <TestPlansPanel controlId={controlId} />
                    </div>
                </div>
            )}

            {tab === 'checks' && (
                <div className="space-y-default">
                    {/* R2-P2 — Checks are automated; note the check→test bridge. */}
                    <p className="text-sm text-content-muted">{tx('detailPage.checksVsTests')}</p>
                    <ControlChecksTab controlId={controlId} />
                </div>
            )}

            {/* Read-only Policies section — control ↔ policy links surfaced on
              * the Overview tab. Backend populates control.policyLinks; this
              * card only lists them (title link + status badge). */}
            {tab === 'overview' && (
                <div className={cn(cardVariants({ density: 'compact' }), 'mt-6')} id="control-policies-section">
                    <Heading level={3}>{tx('detailPage.policiesTitle')}</Heading>
                    {(control.policyLinks?.length ?? 0) > 0 ? (
                        <div className="mt-default space-y-tight" id="control-policies-list">
                            {control.policyLinks?.map((link) => (
                                <div key={link.id} className="flex items-center justify-between gap-compact">
                                    <a
                                        href={tenantHref(`/policies/${link.policy.id}`)}
                                        className="text-sm text-content-link hover:underline truncate"
                                    >
                                        {link.policy.title}
                                    </a>
                                    <StatusBadge variant={POLICY_STATUS_BADGE_VARIANT[link.policy.status] ?? 'neutral'}>
                                        {link.policy.status}
                                    </StatusBadge>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-default">
                            <InlineEmptyState
                                title={tx('detailPage.policiesEmptyTitle')}
                                description={tx('detailPage.policiesEmptyDesc')}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Epic G-5 — Control exceptions section. Scoped to the
              * Overview tab only: the request-exception workflow is
              * control-level metadata, not per-sub-tab, so it would
              * read as noise repeated under Tasks / Evidence / etc. */}
            {tab === 'overview' && (
                <div id="control-exceptions" className={cn(cardVariants({ density: 'compact' }), 'mt-6 scroll-mt-24')}>
                    <ControlExceptionsPanel
                        tenantSlug={tenantSlug}
                        controlId={controlId}
                        compensatingControlChoices={compensatingControlChoices}
                        defaultRiskAcceptedByUserId={control.ownerUserId ?? ''}
                        canWrite={permissions.canWrite}
                        canAdmin={permissions.canAdmin}
                    />
                </div>
            )}
        </EntityDetailLayout>
    );
}

// Evidence sub-table is extracted to `@/components/controls-shared/EvidenceSubTable`
// per the page-size ratchet (R10-PR3 follow-up).

// Evidence sub-table extracted; see @/components/controls-shared/EvidenceSubTable.
