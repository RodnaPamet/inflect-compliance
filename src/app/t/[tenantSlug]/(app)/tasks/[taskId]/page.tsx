'use client';

import { formatDate, formatDateTime } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { textLinkVariants } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { DataTable, createColumns } from '@/components/ui/table';
import { LinkedVendorsPanel } from '@/components/LinkedVendorsPanel';
import {
    EntityPicker,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { SkeletonLine } from '@/components/ui/skeleton';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { UserCombobox } from '@/components/ui/user-combobox';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { CopyText } from '@/components/ui/copy-text';
import {
    TERMINAL_WORK_ITEM_STATUSES,
    WORK_ITEM_TRANSITIONS,
    type WorkItemStatusValue,
} from '@/app-layer/domain/work-item-status';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { TASK_SEVERITY_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import { taskStatusVariant, TASK_STATUS_BADGE } from '@/lib/task-status-badge';
import { cardVariants } from '@/components/ui/card';
// Shared evidence sub-table — lives under the control detail route's
// `_tabs/` (kept there so existing guard exemptions + a unit test keyed
// on that path stay valid). Imported here via the `@/app` alias.
import { EvidenceSubTable, type EvidenceTabData } from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/EvidenceSubTable';
import { EvidenceAddForm } from '@/components/EvidenceAddForm';
// TP-4 — the task edit surface is now the shared inline autosave
// TaskEditPanel (form variant), retiring the divergent EditTaskModal.
import { TaskEditPanel } from '@/app/t/[tenantSlug]/(app)/controls/TaskEditPanel';
import { Pen2, Xmark } from '@/components/ui/icons/nucleo';
import { IconAction } from '@/components/ui/icon-action';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';
// Shared with the list's Severity column and the Severity filter — this
// page rendered the raw enum (`CRITICAL`) next to a filter chip reading
// "Critical".
import { taskSeverityLabels } from '../filter-defs';

// Status tone AND label both come from the shared `TASK_STATUS_BADGE` map
// (TP-1) — tone via `taskStatusVariant`, copy via the map's `labelKey`.
// Deriving the label record from that map (rather than hand-listing the
// statuses) is what keeps IN_REVIEW — the reviewer-gate linchpin — from
// silently going missing: adding a WorkItemStatus now populates every
// surface automatically. Severity tone stays `TASK_SEVERITY_VARIANT`.
const buildStatusLabels = (t: (k: string) => string): Record<string, string> =>
    Object.fromEntries(
        Object.entries(TASK_STATUS_BADGE).map(([status, spec]) => [status, t(spec.labelKey)]),
    );
const buildPriorityLabels = (t: (k: string) => string): Record<string, string> => ({
    P0: t('priorityLabels.P0'), P1: t('priorityLabels.P1'), P2: t('priorityLabels.P2'), P3: t('priorityLabels.P3'),
});
const buildTypeLabels = (t: (k: string) => string): Record<string, string> => ({
    AUDIT_FINDING: t('typeLabels.AUDIT_FINDING'), CONTROL_GAP: t('typeLabels.CONTROL_GAP'),
    INCIDENT: t('typeLabels.INCIDENT'), IMPROVEMENT: t('typeLabels.IMPROVEMENT'), TASK: t('typeLabels.TASK'),
});
// Every option here MUST resolve in `<EntityPicker>` — an offered target the
// picker can't fetch renders an empty dropdown and cannot be linked.
// `FILE` is deliberately absent: `TaskLinkEntityType` accepts it, but there is
// no file LIST endpoint (only `/files/{fileName}` by-name and a per-evidence
// download), so it can't be picked. Files are attached through the Evidence
// tab instead. Re-add it here the day a file list endpoint exists.
//
// `FRAMEWORK_REQUIREMENT` is absent for the same reason: the picker only
// resolves it when the caller supplies a `frameworkKey` in `extraQuery` (there
// is no global "all requirements" endpoint — only per-framework
// `/frameworks/{key}/tree`), and this page passes none, so it rendered an empty
// dropdown. Re-add it once the picker grows a framework selector; requirements
// remain linkable from the framework tree in the meantime.
const ENTITY_TYPE_OPTIONS = ['CONTROL', 'RISK', 'ASSET', 'EVIDENCE', 'POLICY', 'VENDOR', 'AUDIT_PACK', 'INCIDENT'];
const ENTITY_TYPE_CB_OPTIONS: ComboboxOption[] = ENTITY_TYPE_OPTIONS.map(t => ({ value: t, label: t }));
const RELATION_OPTIONS = ['RELATES_TO', 'CAUSED_BY', 'MITIGATED_BY', 'EVIDENCE_FOR'];
const RELATION_CB_OPTIONS: ComboboxOption[] = RELATION_OPTIONS.map(r => ({ value: r, label: r.replace(/_/g, ' ') }));
// RESOLVED retired from the picker — it was redundant with CLOSED.
// Kept in STATUS_LABELS so a legacy RESOLVED task still shows the right
// badge; just not offered as a choice (a RESOLVED task is closed via
// the CLOSED option). CLOSED + CANCELED prompt for a resolution note.
const SELECTABLE_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'CLOSED', 'CANCELED'];
// `|| val` fallback — a status missing from the label map renders its raw
// value rather than a BLANK option. (Before the map derived from
// TASK_STATUS_BADGE, IN_REVIEW hit exactly this hole and shipped an
// unlabelled, unpickable entry in the status combobox.)
/**
 * Options the picker offers from `current`.
 *
 * The picker used to list every SELECTABLE_STATUSES entry regardless of
 * where the task actually was, so it advertised moves the server rejects:
 * a CLOSED task (terminal — no legal transitions out) still offered all
 * seven, and picking one 400'd. Filtering against the same
 * WORK_ITEM_TRANSITIONS graph the usecase enforces means the menu can
 * only ever contain moves that will be accepted.
 *
 * `current` itself is always retained: the Combobox resolves its
 * displayed selection by finding `task.status` in this list, so dropping
 * it would blank the control. It is not a legal transition (`from ===
 * to` is a no-op the gate rejects) — it is the "you are here" entry, and
 * `requestStatusChange` ignores a re-pick of it.
 */
const buildTaskStatusCbOptions = (
    statusLabels: Record<string, string>,
    current?: string,
): ComboboxOption[] => {
    const reachable =
        current && current in WORK_ITEM_TRANSITIONS
            ? WORK_ITEM_TRANSITIONS[current as WorkItemStatusValue]
            : null;
    return SELECTABLE_STATUSES.filter(
        (val) => !reachable || val === current || reachable.has(val as WorkItemStatusValue),
    ).map((val) => ({ value: val, label: statusLabels[val] || val }));
};

/**
 * Terminal status → the imperative verb for the confirm dialog. Kept
 * separate from STATUS_LABELS, which holds the past-tense STATE names
 * ("Closed") used on badges — the two are different registers and
 * conflating them is what produced "Closed task?" as an action prompt.
 */
/**
 * Message to show for a caught error, falling back to localized copy.
 *
 * The call sites used to spell `e instanceof Error ? e.message : t(...)`
 * inline. Every throw site here constructs an Error, so the `t(...)` arm
 * was unreachable — and the arm that DID run happily rendered an empty
 * string when the Error carried no message (`new Error()`, or a server
 * body whose `error` field was ""), producing a blank toast. Checking the
 * message itself rather than the instance makes the fallback reachable
 * for the case that actually occurs.
 */
function errorMessage(e: unknown, fallback: string): string {
    return e instanceof Error && e.message.trim() ? e.message : fallback;
}

const TERMINAL_STATUS_VERB_KEY: Record<string, string> = {
    CLOSED: 'detail.close',
    CANCELED: 'detail.cancelVerb',
};

type Tab = 'overview' | 'evidence' | 'links' | 'comments' | 'activity';

const buildFindingSourceLabels = (t: (k: string) => string): Record<string, string> => ({
    INTERNAL: t('findingSourceLabels.INTERNAL'), EXTERNAL_AUDITOR: t('findingSourceLabels.EXTERNAL_AUDITOR'), PEN_TEST: t('findingSourceLabels.PEN_TEST'), INCIDENT: t('findingSourceLabels.INCIDENT'),
});
const buildGapTypeLabels = (t: (k: string) => string): Record<string, string> => ({
    DESIGN: t('gapTypeLabels.DESIGN'), OPERATING_EFFECTIVENESS: t('gapTypeLabels.OPERATING_EFFECTIVENESS'), DOCUMENTATION: t('gapTypeLabels.DOCUMENTATION'),
});


// getTask → WorkItemRepository.getById (full Task + relations + _count).
interface TaskDetail {
    id: string;
    title: string;
    description: string | null;
    type: string;
    severity: string;
    priority: string;
    status: string;
    dueAt: string | null;
    createdAt: string;
    completedAt: string | null;
    resolution: string | null;
    key: string | null;
    assigneeUserId: string | null;
    reviewerUserId: string | null;
    metadataJson: { findingSource?: string | null; controlGapType?: string | null } | null;
    assignee: { name: string | null } | null;
    createdBy: { name: string | null } | null;
    // TP-6 — reviewer + watchers, both returned by getById.
    reviewer: { id: string; name: string | null; email: string | null } | null;
    watchers: {
        id: string;
        userId: string;
        user: { id: string; name: string | null; email: string | null } | null;
    }[];
    control: { id: string; code: string | null; name: string } | null;
    // TP-4 — the originating source(s), for the provenance back-link.
    findingId: string | null;
    finding: { id: string; title: string; status: string } | null;
    remediatedVulnerabilities: {
        id: string;
        cveId: string;
        status: string;
        asset: { id: string; name: string } | null;
    }[];
    _count: { evidence: number; links: number; comments: number };
}

// Comments tab — TaskCommentRepository.listByTask (include createdBy).
interface TaskCommentRow {
    id: string;
    body: string;
    createdAt: string;
    createdBy: { name: string | null } | null;
}

// Activity tab — auditLog.findMany (include user).
interface TaskActivityRow {
    id: string;
    action: string;
    details: string | null;
    createdAt: string;
    user: { name: string | null } | null;
}

export default function TaskDetailPage() {
    const t = useTranslations('tasks');
    const STATUS_LABELS = buildStatusLabels(t);
    const PRIORITY_LABELS = buildPriorityLabels(t);
    const TYPE_LABELS = buildTypeLabels(t);
    const FINDING_SOURCE_LABELS = buildFindingSourceLabels(t);
    const GAP_TYPE_LABELS = buildGapTypeLabels(t);
    const SEVERITY_LABELS = taskSeverityLabels(t);
    const params = useParams();
    const router = useRouter();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions, role, tenantSlug, userId } = useTenantContext();
    const taskId = params?.taskId as string;
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();

    const [tab, setTab] = useState<Tab>('overview');

    // Mutation in-flight flags (UI-disable only — not data).
    const [changingStatus, setChangingStatus] = useState(false);
    // Terminal-status close prompt: the status awaiting a resolution
    // note (null = no prompt open) + the note draft + last error.
    const [pendingTerminalStatus, setPendingTerminalStatus] = useState<string | null>(null);
    const [resolutionDraft, setResolutionDraft] = useState('');
    const [statusError, setStatusError] = useState('');
    const [assigning, setAssigning] = useState(false);
    // Assignee-picker draft. `undefined` = untouched (mirror the
    // task's persisted assignee); `string | null` = an explicit pick.
    const [assigneeDraft, setAssigneeDraft] = useState<string | null | undefined>(undefined);
    // TP-6 — reviewer-picker draft (same three-state contract as the
    // assignee draft) + in-flight flag.
    const [reviewerDraft, setReviewerDraft] = useState<string | null | undefined>(undefined);
    const [savingReviewer, setSavingReviewer] = useState(false);
    // TP-6 — watch/unwatch in-flight flag (UI-disable only).
    const [watchPending, setWatchPending] = useState(false);

    // Link form state.
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [linkEntityType, setLinkEntityType] = useState('CONTROL');
    const [linkEntityId, setLinkEntityId] = useState('');
    const [linkRelation, setLinkRelation] = useState('RELATES_TO');
    const [savingLink, setSavingLink] = useState(false);

    // Evidence form state — mirrors the control "+ Evidence" form: a
    // single form that either uploads a file OR links a URL.
    const [showEvidenceForm, setShowEvidenceForm] = useState(false);
    const [evidenceUrl, setEvidenceUrl] = useState('');
    const [evidenceNote, setEvidenceNote] = useState('');
    const [fileToUpload, setFileToUpload] = useState<File | null>(null);
    const [fileUploadTitle, setFileUploadTitle] = useState('');
    const [evidenceError, setEvidenceError] = useState('');
    const [savingEvidence, setSavingEvidence] = useState(false);
    const fileUploadRef = useRef<HTMLInputElement>(null);

    // Comment form state.
    const [commentBody, setCommentBody] = useState('');
    const [savingComment, setSavingComment] = useState(false);

    // Edit-task modal state — hosts the shared inline autosave
    // TaskEditPanel (form variant). No local form/save state: the panel
    // owns its own autosave lifecycle.
    const [showEditModal, setShowEditModal] = useState(false);

    const canComment = role !== 'READER';

    // #102 item 5 — the page read the task and each tab via raw
    // useState + useEffect + fetch, and every mutation re-fetched the
    // whole task. Migrated to `useTenantSWR` (Epic 69 — the pattern
    // this file's own TODO asked for, and the one the sibling
    // control-detail page uses). Tab data fetches lazily through a
    // null SWR key while its tab is inactive; mutations write the
    // cache through `mutate` — optimistic for instant feedback, then
    // revalidate to reconcile server-derived fields.
    const taskQuery = useTenantSWR<TaskDetail>(taskId ? `/tasks/${taskId}` : null);
    const task = taskQuery.data ?? null;
    const loading = taskQuery.isLoading;
    const error = taskQuery.error
        ? errorMessage(taskQuery.error, t('detail.notFound'))
        : '';

    const linksQuery = useTenantSWR<TaskLinkRow[]>(
        taskId && tab === 'links' ? `/tasks/${taskId}/links` : null,
    );
    const links = linksQuery.data ?? [];
    const linksLoading = linksQuery.isLoading;

    // Task Evidence tab — same `{ links, evidence }` payload the control
    // evidence tab fetches, so the shared <EvidenceSubTable> renders it.
    const evidenceQuery = useTenantSWR<EvidenceTabData>(
        taskId && tab === 'evidence' ? `/tasks/${taskId}/evidence` : null,
    );

    const commentsQuery = useTenantSWR<TaskCommentRow[]>(
        taskId && tab === 'comments' ? `/tasks/${taskId}/comments` : null,
    );
    const comments = commentsQuery.data ?? [];
    const commentsLoading = commentsQuery.isLoading;

    const activityQuery = useTenantSWR<TaskActivityRow[]>(
        taskId && tab === 'activity' ? `/tasks/${taskId}/activity` : null,
    );
    const activity = activityQuery.data ?? [];
    const activityLoading = activityQuery.isLoading;

    // Effective assignee for the picker — the draft if the user has
    // touched it, otherwise the task's persisted assignee.
    const assigneeValue: string | null =
        assigneeDraft !== undefined
            ? assigneeDraft
            : (task?.assigneeUserId ?? null);

    // A terminal status (CLOSED / CANCELED) requires a resolution note
    // server-side (S8 audit control). Picking one opens a small prompt
    // for the note; non-terminal changes commit immediately.
    const requestStatusChange = (status: string) => {
        setStatusError('');
        // Re-picking the status the task already has is a no-op the
        // server rejects (`from === to`). The option is only in the list
        // so the Combobox can display the current selection.
        if (status === taskQuery.data?.status) return;
        if ((TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status)) {
            setResolutionDraft('');
            setPendingTerminalStatus(status);
            return;
        }
        void commitStatus(status, null);
    };

    const commitStatus = async (status: string, resolution: string | null) => {
        setChangingStatus(true);
        setStatusError('');
        try {
            // Optimistic — the new status shows instantly, no spinner.
            await taskQuery.mutate(
                (cur: TaskDetail | undefined) => (cur ? { ...cur, status } : cur),
                { revalidate: false },
            );
            const res = await fetch(apiUrl(`/tasks/${taskId}/status`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    resolution ? { status, resolution } : { status },
                ),
            });
            if (!res.ok) {
                // Surface the reason instead of silently reverting — the
                // old flow swallowed the 4xx and the optimistic patch
                // snapped back, so "nothing happened" on close.
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    (typeof data?.error === 'string' && data.error) ||
                        data?.message ||
                        t('detail.failedStatus'),
                );
            }
            setPendingTerminalStatus(null);
        } catch (e) {
            const message =
                errorMessage(e, t('detail.failedStatus'));
            setStatusError(message);
            // `statusError` only renders inside the terminal-status modal.
            // A non-terminal change (OPEN → IN_PROGRESS, a reviewer-gate
            // 403, …) has no modal open, so the banner had nowhere to
            // show: the optimistic patch just snapped back and the user
            // saw nothing. Toast covers that path; the modal keeps its
            // inline banner, which stays visible next to the note field.
            if (pendingTerminalStatus === null) {
                toast.error(message);
            }
        } finally {
            setChangingStatus(false);
            // Reconcile — pick up server-derived fields (completedAt,
            // resolution) the optimistic patch can't know (and revert
            // the optimistic status if the write failed).
            await taskQuery.mutate();
        }
    };

    const handleAssign = async () => {
        setAssigning(true);
        const assigneeUserId = assigneeValue || null;
        try {
            await taskQuery.mutate(
                (cur: TaskDetail | undefined) => (cur ? { ...cur, assigneeUserId } : cur),
                { revalidate: false },
            );
            const res = await fetch(apiUrl(`/tasks/${taskId}/assign`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assigneeUserId }),
            });
            // TP-6 — surface the failure instead of swallowing it. The
            // optimistic patch reverts on the reconcile mutate() below.
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    (typeof data?.error === 'string' && data.error) ||
                        data?.message ||
                        t('detail.assignFailed'),
                );
            }
        } catch (e) {
            toast.error(errorMessage(e, t('detail.assignFailed')));
            // Drop the rejected pick. `assigneeValue` prefers the draft
            // over the server value, so leaving it set would keep showing
            // the assignee the server just refused — while the reconcile
            // below reverts `task.assigneeUserId` to the real one. The
            // label and the picker would name two different people until
            // the page remounts. `undefined` (not null) is the reset:
            // null is a real value meaning "unassigned".
            setAssigneeDraft(undefined);
        } finally {
            setAssigning(false);
            await taskQuery.mutate();
        }
    };

    // TP-6 — set/clear the reviewer via the shared task update path
    // (PATCH /tasks/:id { reviewerUserId }). Surfaces failures via toast.
    const reviewerValue: string | null =
        reviewerDraft !== undefined
            ? reviewerDraft
            : (task?.reviewerUserId ?? null);
    const handleAssignReviewer = async () => {
        setSavingReviewer(true);
        const reviewerUserId = reviewerValue || null;
        try {
            await taskQuery.mutate(
                (cur: TaskDetail | undefined) => (cur ? { ...cur, reviewerUserId } : cur),
                { revalidate: false },
            );
            const res = await fetch(apiUrl(`/tasks/${taskId}`), {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reviewerUserId }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    (typeof data?.error === 'string' && data.error) ||
                        data?.message ||
                        t('detail.reviewerFailed'),
                );
            }
        } catch (e) {
            toast.error(errorMessage(e, t('detail.reviewerFailed')));
            // Same reset as handleAssign — see the note there.
            setReviewerDraft(undefined);
        } finally {
            setSavingReviewer(false);
            await taskQuery.mutate();
        }
    };

    // TP-6 — watch/unwatch toggle for the current user, plus per-row
    // remove. Both revalidate the task detail (its `watchers` array
    // drives the list). Failures surface via toast; no fire-and-forget.
    const isWatching = !!task?.watchers?.some((w) => w.userId === userId);
    const toggleWatch = async () => {
        setWatchPending(true);
        try {
            const res = isWatching
                ? await fetch(apiUrl(`/tasks/${taskId}/watchers?userId=${encodeURIComponent(userId)}`), { method: 'DELETE' })
                : await fetch(apiUrl(`/tasks/${taskId}/watchers`), {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                  });
            if (!res.ok) throw new Error(t('detail.watchFailed'));
        } catch (e) {
            toast.error(errorMessage(e, t('detail.watchFailed')));
        } finally {
            setWatchPending(false);
            await taskQuery.mutate();
        }
    };
    // Epic 67 — delayed-commit watcher removal, matching `removeLink` and
    // `removeEvidence`. This was a bare fire-and-forget DELETE: one click
    // and the watcher was gone with no confirm and no way back, even
    // though the undo-toast hook was already imported and used by the two
    // sibling remove flows on this very page.
    const removeWatcher = (watcherUserId: string) => {
        const previous = taskQuery.data;
        // Optimistic drop so the row disappears on click; the undo path
        // and the failure path both restore this snapshot.
        void taskQuery.mutate(
            (cur: TaskDetail | undefined) =>
                cur
                    ? {
                          ...cur,
                          watchers: (cur.watchers ?? []).filter(
                              (w) => w.userId !== watcherUserId,
                          ),
                      }
                    : cur,
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('detail.watcherRemoved'),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(
                        `/tasks/${taskId}/watchers?userId=${encodeURIComponent(watcherUserId)}`,
                    ),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(t('detail.watchFailed'));
                await taskQuery.mutate();
            },
            undoAction: () => {
                void taskQuery.mutate(previous, { revalidate: false });
            },
            onError: () => {
                void taskQuery.mutate(previous, { revalidate: false });
            },
        });
    };

    /**
     * Delete this task (soft — recoverable from the list's Deleted view).
     *
     * Navigates back to the list immediately: leaving the user on the
     * detail page of a row that is now deleted would be a dead end. The
     * undo window still runs from the list, and Undo simply cancels the
     * commit — nothing to restore, because the DELETE never fired.
     */
    const handleDeleteTask = () => {
        const title = taskQuery.data?.title ?? '';
        router.push(tenantHref('/tasks'));
        triggerUndoToast({
            message: t('detail.taskDeleted', { title }),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/tasks/${taskId}`), {
                    method: 'DELETE',
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(
                        (typeof data?.error === 'string' && data.error) ||
                            t('detail.deleteFailed'),
                    );
                }
            },
            onError: (err: unknown) => {
                toast.error(
                    errorMessage(err, t('detail.deleteFailed')),
                );
            },
        });
    };

    const addLink = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!linkEntityId.trim()) return;
        setSavingLink(true);
        try {
            const res = await fetch(apiUrl(`/tasks/${taskId}/links`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: linkEntityType, entityId: linkEntityId, relation: linkRelation }),
            });
            // TP-6 — a failed link add used to be swallowed, leaving the
            // form "succeeding" with nothing linked. Surface it.
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    (typeof data?.error === 'string' && data.error) ||
                        data?.message ||
                        t('detail.addLinkFailed'),
                );
            }
            setLinkEntityId('');
            setShowLinkForm(false);
        } catch (e) {
            toast.error(errorMessage(e, t('detail.addLinkFailed')));
        } finally {
            setSavingLink(false);
            // Refresh the links list + the task (its _count.links
            // drives the Links tab badge).
            await Promise.all([linksQuery.mutate(), taskQuery.mutate()]);
        }
    };

    // Epic 67 — delayed-commit link removal. Optimistic SWR cache
    // filter so the row disappears immediately; undo restores it,
    // commit-failure rolls back.
    const removeLink = (linkId: string) => {
        const previous = linksQuery.data ?? [];
        void linksQuery.mutate(
            previous.filter((l) => l.id !== linkId),
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('detail.linkRemoved'),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/tasks/${taskId}/links/${linkId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(t('detail.removeLinkFailed'));
                // The Links tab badge reads `task._count.links`, which
                // lives on the TASK payload — not on `linksQuery`. Without
                // this the row vanished but the badge kept the old count
                // until a full reload. Mirrors `removeEvidence`.
                await Promise.all([linksQuery.mutate(), taskQuery.mutate()]);
            },
            undoAction: () => {
                void linksQuery.mutate(previous, { revalidate: false });
            },
            onError: () => {
                void linksQuery.mutate(previous, { revalidate: false });
            },
        });
    };

    const resetEvidenceForm = () => {
        setEvidenceUrl('');
        setEvidenceNote('');
        setFileToUpload(null);
        setFileUploadTitle('');
        setEvidenceError('');
        if (fileUploadRef.current) fileUploadRef.current.value = '';
        setShowEvidenceForm(false);
    };

    // Unified "+ Evidence" submit — mirrors the control evidence form. A
    // chosen file uploads via /evidence/uploads (FileRecord + Evidence
    // tagged with this taskId); otherwise a non-empty URL links a LINK
    // evidence row to the task. Both land in this task's Evidence tab
    // AND the Evidence Library.
    const addEvidence = async (e: React.FormEvent) => {
        e.preventDefault();
        setEvidenceError('');

        if (fileToUpload) {
            setSavingEvidence(true);
            try {
                const formData = new FormData();
                formData.append('file', fileToUpload);
                if (fileUploadTitle) formData.append('title', fileUploadTitle);
                formData.append('taskId', taskId);
                const res = await fetch(apiUrl('/evidence/uploads'), {
                    method: 'POST',
                    body: formData,
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: t('detail.uploadFailed') }));
                    throw new Error(err.error || err.message || t('detail.uploadFailed'));
                }
                resetEvidenceForm();
                await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
            } catch (err: unknown) {
                setEvidenceError(errorMessage(err, t('detail.uploadFailed')));
            } finally {
                setSavingEvidence(false);
            }
            return;
        }

        if (!evidenceUrl.trim()) {
            setEvidenceError(t('detail.chooseFileOrUrl'));
            return;
        }
        setSavingEvidence(true);
        try {
            const res = await fetch(apiUrl(`/tasks/${taskId}/evidence`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: evidenceUrl.trim(), note: evidenceNote || undefined }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || err.message || t('detail.linkEvidenceFailed'));
            }
            resetEvidenceForm();
            await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
        } catch (err: unknown) {
            setEvidenceError(errorMessage(err, t('detail.linkEvidenceFailed')));
        } finally {
            setSavingEvidence(false);
        }
    };

    // Epic 67 — delayed-commit evidence removal (detach Evidence.taskId).
    // Optimistic SWR filter so the row disappears immediately; undo
    // restores it, commit-failure rolls back.
    const removeEvidence = (evidenceId: string) => {
        const previous = evidenceQuery.data;
        void evidenceQuery.mutate(
            previous
                ? { ...previous, evidence: (previous.evidence ?? []).filter((ev) => ev.id !== evidenceId) }
                : previous,
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('detail.evidenceRemoved'),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/tasks/${taskId}/evidence/${evidenceId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error(t('detail.removeEvidenceFailed'));
                await Promise.all([evidenceQuery.mutate(), taskQuery.mutate()]);
            },
            undoAction: () => {
                void evidenceQuery.mutate(previous, { revalidate: false });
            },
            onError: () => {
                void evidenceQuery.mutate(previous, { revalidate: false });
            },
        });
    };

    const addComment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!commentBody.trim()) return;
        setSavingComment(true);
        try {
            const res = await fetch(apiUrl(`/tasks/${taskId}/comments`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: commentBody }),
            });
            // TP-6 — surface a failed comment post instead of clearing
            // the box as if it succeeded.
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    (typeof data?.error === 'string' && data.error) ||
                        data?.message ||
                        t('detail.addCommentFailed'),
                );
            }
            setCommentBody('');
        } catch (e) {
            toast.error(errorMessage(e, t('detail.addCommentFailed')));
        } finally {
            setSavingComment(false);
            await Promise.all([commentsQuery.mutate(), taskQuery.mutate()]);
        }
    };

    const breadcrumbs = [
        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
        { label: t('crumb.tasks'), href: tenantHref('/tasks') },
        { label: task?.title ?? t('detail.crumbTaskFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error) {
        return (
            <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!task) {
        return (
            <EntityDetailLayout empty={{ message: t('detail.notFoundEmpty') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: t('detail.tabOverview') },
        { key: 'evidence', label: t('detail.tabEvidence'), count: evidenceQuery.data?.evidence?.length ?? task._count?.evidence },
        { key: 'links', label: t('detail.tabLinks'), count: task._count?.links ?? links.length },
        { key: 'comments', label: t('detail.tabComments'), count: task._count?.comments ?? comments.length },
        { key: 'activity', label: t('detail.tabActivity') },
    ];

    // The confirm title needs the IMPERATIVE verb ("Close task"), not the
    // status LABEL — interpolating STATUS_LABELS gave "Closed task" /
    // "Canceled task", which reads as a description of a finished state
    // rather than the action about to be taken. TERMINAL_STATUS_VERB_KEY
    // maps each terminal status to its verb.
    const terminalActionTitle = t('detail.terminalTitle', {
        verb:
            pendingTerminalStatus &&
            TERMINAL_STATUS_VERB_KEY[pendingTerminalStatus]
                ? t(TERMINAL_STATUS_VERB_KEY[pendingTerminalStatus])
                : t('detail.close'),
    });

    // Built here, not at the top of the component, because it depends on
    // the CURRENT status — the reachable set differs per task, and `task`
    // is only non-null past the guards above.
    const TASK_STATUS_CB_OPTIONS = buildTaskStatusCbOptions(
        STATUS_LABELS,
        task.status,
    );

    const isOverdue = task.dueAt && new Date(task.dueAt) < new Date() && !(TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(task.status);
    const metadata = task.metadataJson || {};

    // TP-4 — resolve the task's provenance into a single prominent
    // back-link + a plain-language "why this task exists / what
    // completing it does" line. Priority: vulnerability → finding →
    // control-gap (mostly mutually exclusive; a NIS2 gap-task carries
    // both a control and a finding, and closing the finding is the
    // meaningful completion effect, so finding wins over control).
    const primaryVuln = task.remediatedVulnerabilities?.[0] ?? null;
    const source: {
        label: string;
        href: string | null;
        why: string;
        linkId: string;
    } | null = primaryVuln
        ? {
              label: primaryVuln.asset
                  ? t('source.vulnLabel', { cve: primaryVuln.cveId, asset: primaryVuln.asset.name })
                  : t('source.vulnLabelNoAsset', { cve: primaryVuln.cveId }),
              href: primaryVuln.asset ? tenantHref(`/assets/${primaryVuln.asset.id}`) : null,
              why: t('source.vulnWhy', { cve: primaryVuln.cveId }),
              linkId: 'task-source-vuln-link',
          }
        : task.finding
          ? {
                label: t('source.findingLabel', { title: task.finding.title }),
                href: tenantHref('/findings'),
                why: t('source.findingWhy', { title: task.finding.title }),
                linkId: 'task-source-finding-link',
            }
          : task.control && task.type === 'CONTROL_GAP'
            ? {
                  label: task.control.code
                      ? t('source.controlLabel', { control: `${task.control.code} — ${task.control.name}` })
                      : t('source.controlLabel', { control: task.control.name }),
                  href: tenantHref(`/controls/${task.control.id}`),
                  why: t('source.controlWhy', {
                      control: task.control.code ?? task.control.name,
                  }),
                  linkId: 'task-source-control-link',
              }
            : null;

    return (
        <EntityDetailLayout
            id="task-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={<span id="task-title">{task.title}</span>}
            meta={
                <MetaStrip
                    items={[
                        ...(task.key
                            ? [
                                  {
                                      label: t('detail.keyLabel'),
                                      value: (
                                          <CopyText
                                              value={task.key}
                                              label={t('detail.copyKeyAria', { key: task.key })}
                                              successMessage={t('detail.keyCopied')}
                                              className="text-xs text-content-subtle"
                                          >
                                              {task.key}
                                          </CopyText>
                                      ),
                                  } as const,
                              ]
                            : []),
                        {
                            kind: 'status' as const,
                            id: 'task-status',
                            label: t('detail.status'),
                            value:
                                STATUS_LABELS[task.status] ?? task.status,
                            variant: taskStatusVariant(task.status),
                        },
                        {
                            kind: 'status' as const,
                            id: 'task-severity',
                            label: t('detail.severity'),
                            value: SEVERITY_LABELS[task.severity] ?? task.severity,
                            variant:
                                TASK_SEVERITY_VARIANT[task.severity] ??
                                'neutral',
                        },
                        {
                            label: t('detail.type'),
                            value: TYPE_LABELS[task.type] ?? task.type,
                        },
                        ...(isOverdue
                            ? [
                                  {
                                      kind: 'status' as const,
                                      label: t('detail.sla'),
                                      value: t('detail.overdue'),
                                      variant: 'error' as const,
                                  },
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                permissions.canWrite && (
                    <div className="flex items-center gap-tight">
                        <Combobox
                            hideSearch
                            id="task-status-select"
                            selected={TASK_STATUS_CB_OPTIONS.find(o => o.value === task.status) ?? null}
                            setSelected={(opt) => { if (opt) requestStatusChange(opt.value); }}
                            options={TASK_STATUS_CB_OPTIONS}
                            disabled={changingStatus}
                            placeholder={t('detail.statusPlaceholder')}
                            // Item 29 — brand-color the status action (matches the
                            // primary "+ …" create buttons).
                            buttonProps={{ variant: 'primary', className: 'text-sm' }}
                        />
                        {/* Single-task delete. `deleteTask` has existed in
                            the usecase layer all along with no UI reaching
                            it, so the only way to delete one task was to
                            select it in the list and use the bulk bar.
                            Soft delete → Epic 67 undo-toast, same as every
                            other routine destructive action here. */}
                        <Button
                            variant="secondary"
                            size="sm"
                            id="delete-task-btn"
                            onClick={handleDeleteTask}
                        >
                            {t('detail.deleteTask')}
                        </Button>
                    </div>
                )
            }
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
        >
            {/* TP-4 — provenance banner: front-and-center back-link to
                the source that raised this task + a plain-language
                explanation of what completing the task does. Generic
                manual tasks (no source) render no banner. */}
            {source && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'border-border-emphasis space-y-1')}
                    id="task-source-banner"
                    data-testid="task-source-banner"
                >
                    <div className="flex items-center gap-tight">
                        <span className="text-xs text-content-subtle uppercase">{t('source.heading')}</span>
                        {source.href ? (
                            <Link href={source.href} className={textLinkVariants({ tone: 'link' })} id={source.linkId}>
                                {source.label}
                            </Link>
                        ) : (
                            <span className="text-sm font-medium text-content-emphasis" id={source.linkId}>
                                {source.label}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-content-muted">{source.why}</p>
                </div>
            )}

            {/* Assignee / reviewer / watcher cards belong to the Overview
                tab — previously they rendered on every tab (evidence, links,
                comments, activity). Guarded here so they only show on Overview. */}
            {tab === 'overview' && (
            <>
            {/* Assignment controls */}
            {permissions.canWrite && (
                <div className={cardVariants({ density: 'compact' })}>
                    <div className="flex items-center gap-compact">
                        <span className="text-sm text-content-muted">{t('detail.assigneeLabel')}</span>
                        <span className="text-sm text-content-emphasis font-medium" id="task-assignee">
                            {task.assignee?.name || task.assigneeUserId || t('detail.unassigned')}
                        </span>
                        <div className="w-64">
                            <UserCombobox
                                id="task-assignee-input"
                                name="assigneeUserId"
                                tenantSlug={tenantSlug}
                                selectedId={assigneeValue}
                                onChange={(userId) =>
                                    setAssigneeDraft(userId ?? null)
                                }
                                placeholder={t('detail.unassigned')}
                                forceDropdown={false}
                            />
                        </div>
                        <Button variant="secondary" onClick={handleAssign} disabled={assigning} id="assign-task-btn">
                            {assigning ? t('detail.saving') : t('detail.assign')}
                        </Button>
                    </div>
                </div>
            )}

            {/* TP-6 — Reviewer assignment. Surfaces the previously
                dead `reviewerUserId` field: a people-picker to set the
                reviewer + a display of the current one. Wired through the
                shared task update path (PATCH /tasks/:id). */}
            {permissions.canWrite && (
                <div className={cardVariants({ density: 'compact' })}>
                    <div className="flex items-center gap-compact">
                        <span className="text-sm text-content-muted">{t('detail.reviewerLabel')}</span>
                        <span className="text-sm text-content-emphasis font-medium" id="task-reviewer">
                            {task.reviewer?.name || task.reviewerUserId || t('detail.noReviewer')}
                        </span>
                        <div className="w-64">
                            <UserCombobox
                                id="task-reviewer-input"
                                name="reviewerUserId"
                                tenantSlug={tenantSlug}
                                selectedId={reviewerValue}
                                onChange={(uid) => setReviewerDraft(uid ?? null)}
                                placeholder={t('detail.noReviewer')}
                                forceDropdown={false}
                            />
                        </div>
                        <Button variant="secondary" onClick={handleAssignReviewer} disabled={savingReviewer} id="assign-reviewer-btn">
                            {savingReviewer ? t('detail.saving') : t('detail.setReviewer')}
                        </Button>
                    </div>
                </div>
            )}

            {/* TP-6 — Watchers. Surfaces the previously dead
                TaskWatcher model: a watch/unwatch toggle for the current
                user + the watcher list with per-row remove (own row, or
                any row for OWNER/ADMIN). */}
            <div className={cardVariants({ density: 'compact' })} id="task-watchers">
                <div className="flex items-center gap-compact flex-wrap">
                    <span className="text-sm text-content-muted">{t('detail.watchersLabel')}</span>
                    {(task.watchers ?? []).length === 0 ? (
                        <span className="text-sm text-content-subtle" id="task-watchers-empty">{t('detail.noWatchers')}</span>
                    ) : (
                        <div className="flex items-center gap-compact flex-wrap">
                            {(task.watchers ?? []).map((w) => {
                                const canRemove =
                                    !!permissions.canWrite &&
                                    (w.userId === userId || role === 'OWNER' || role === 'ADMIN');
                                return (
                                    <span key={w.id} className="inline-flex items-center gap-tight">
                                        <StatusBadge variant="neutral">
                                            {w.user?.name || w.user?.email || t('detail.unknown')}
                                        </StatusBadge>
                                        {canRemove && (
                                            // IconAction, not a bare <button> with a
                                            // "×" text glyph: it supplies the tooltip,
                                            // the aria-label, and the focus ring the
                                            // raw element lacked.
                                            <IconAction
                                                variant="ghost"
                                                icon={<Xmark className="size-3" />}
                                                label={t('detail.removeWatcher')}
                                                className="text-content-subtle hover:text-content-error"
                                                id={`remove-watcher-${w.userId}`}
                                                onClick={() => removeWatcher(w.userId)}
                                            />
                                        )}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                    {permissions.canWrite && (
                        <Button
                            variant={isWatching ? 'secondary' : 'primary'}
                            size="sm"
                            onClick={toggleWatch}
                            disabled={watchPending}
                            aria-pressed={isWatching}
                            id="watch-toggle-btn"
                        >
                            {isWatching ? t('detail.unwatch') : t('detail.watch')}
                        </Button>
                    )}
                </div>
            </div>
            </>
            )}

            {/* Overview Tab */}
            {tab === 'overview' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {/* Overview header with Edit button — mirrors the
                        control detail overview edit affordance. */}
                    {permissions.canWrite && (
                        <div className="flex justify-end -mt-1 -mb-2">
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={() => setShowEditModal(true)}
                                data-testid="task-edit-button"
                                id="task-edit-button"
                                aria-label={t('detail.editAria')}
                                title={t('detail.editAria')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-section">
                        <div className="col-span-2">
                            <span className="text-xs text-content-subtle uppercase">{t('detail.description')}</span>
                            <p className="text-sm text-content-default mt-1 whitespace-pre-wrap">{task.description || t('detail.descriptionEmpty')}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.type')}</span>
                            <p className="text-sm text-content-default mt-1">{TYPE_LABELS[task.type] || task.type}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.priority')}</span>
                            <p className="text-sm text-content-default mt-1">{PRIORITY_LABELS[task.priority] || task.priority}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.assignee')}</span>
                            <p className="text-sm text-content-default mt-1">{task.assignee?.name || '—'}</p>
                        </div>
                        {/* "Reporter" removed — it bound the same createdBy.name
                            as "Created By" below (no separate reporter concept on
                            the Task model), so the row was a pure duplicate. */}
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.dueDate')}</span>
                            <p className="text-sm text-content-default mt-1">{task.dueAt ? formatDate(task.dueAt) : '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.created')}</span>
                            <p className="text-sm text-content-default mt-1">{formatDateTime(task.createdAt)}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('detail.createdBy')}</span>
                            <p className="text-sm text-content-default mt-1">{task.createdBy?.name || '—'}</p>
                        </div>
                        {task.control && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('detail.control')}</span>
                                <p className="text-sm mt-1">
                                    <Link
                                        href={tenantHref(`/controls/${task.control.id}`)}
                                        className={textLinkVariants({ tone: 'link' })}
                                        id="task-control-link"
                                    >
                                        {task.control.code} — {task.control.name}
                                    </Link>
                                </p>
                            </div>
                        )}
                        {task.completedAt && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('detail.completedAt')}</span>
                                <p className="text-sm text-content-success mt-1">{formatDateTime(task.completedAt)}</p>
                            </div>
                        )}
                        {task.resolution && (
                            <div className="col-span-2">
                                <span className="text-xs text-content-subtle uppercase">{t('detail.resolution')}</span>
                                <p className="text-sm text-content-default mt-1 whitespace-pre-wrap">{task.resolution}</p>
                            </div>
                        )}
                    </div>

                    {/* Audit / Finding Fields from metadataJson */}
                    {(task.type === 'AUDIT_FINDING' || task.type === 'CONTROL_GAP') && (metadata.findingSource || metadata.controlGapType) && (
                        <div className="border-t border-border-default pt-4 mt-4">
                            <Heading level={3} className="mb-3">{t('detail.auditDetails')}</Heading>
                            <div className="grid grid-cols-2 gap-default">
                                {metadata.findingSource && (
                                    <div>
                                        <span className="text-xs text-content-subtle uppercase">{t('detail.findingSource')}</span>
                                        <p className="text-sm text-content-default mt-1">{FINDING_SOURCE_LABELS[metadata.findingSource] || metadata.findingSource}</p>
                                    </div>
                                )}
                                {metadata.controlGapType && (
                                    <div>
                                        <span className="text-xs text-content-subtle uppercase">{t('detail.controlGapType')}</span>
                                        <p className="text-sm text-content-default mt-1">{GAP_TYPE_LABELS[metadata.controlGapType] || metadata.controlGapType}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Evidence Tab — same look + behaviour as the control
                Evidence tab: upload a file OR link a URL, both scoped to
                this task via Evidence.taskId. */}
            {tab === 'evidence' && (
                <div className="space-y-default">
                    <EvidenceAddForm
                        ids={{
                            trigger: 'add-evidence-btn',
                            form: 'task-evidence-form',
                            title: 'task-upload-title',
                            file: 'evidence-file-input',
                            url: 'evidence-url-input',
                            note: 'evidence-note-input',
                            error: 'task-evidence-error',
                            submit: 'submit-evidence-btn',
                        }}
                        canWrite={!!permissions.canWrite}
                        show={showEvidenceForm}
                        onToggleShow={() => setShowEvidenceForm(!showEvidenceForm)}
                        file={fileToUpload}
                        onFileChange={(f) => {
                            setFileToUpload(f);
                            if (f && !fileUploadTitle) setFileUploadTitle(f.name);
                        }}
                        fileInputRef={fileUploadRef}
                        title={fileUploadTitle}
                        onTitleChange={setFileUploadTitle}
                        url={evidenceUrl}
                        onUrlChange={setEvidenceUrl}
                        note={evidenceNote}
                        onNoteChange={setEvidenceNote}
                        onSubmit={addEvidence}
                        error={evidenceError}
                        uploading={savingEvidence && !!fileToUpload}
                        saving={savingEvidence && !fileToUpload}
                    />
                    {evidenceQuery.error ? (
                        <InlineEmptyState
                            title={t('detail.evidenceLoadErrorTitle')}
                            description={t('detail.evidenceLoadErrorDesc')}
                        />
                    ) : (
                        /* No `onUnlink` prop: that handler detaches a
                           ControlEvidenceLink join row, and tasks have no
                           such join — `getTaskEvidenceTab` always returns
                           `links: []` because evidence points at a task
                           directly via `Evidence.taskId`. This used to pass
                           `() => {}`, wiring a visible "Remove" button to a
                           no-op. Removing a task's evidence goes through
                           `onUnlinkEvidence`. */
                        <EvidenceSubTable
                            data={evidenceQuery.data}
                            loading={evidenceQuery.isLoading && !evidenceQuery.data}
                            canWrite={!!permissions.canWrite}
                            onUnlinkEvidence={removeEvidence}
                            tenantHref={tenantHref}
                        />
                    )}
                </div>
            )}

            {/* Links Tab */}
            {tab === 'links' && (
                <div className="space-y-default">
                    {permissions.canWrite && (
                        <div className="flex justify-end">
                            <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowLinkForm(!showLinkForm)} id="add-link-btn">
                                {t('detail.addLink')}
                            </Button>
                        </div>
                    )}
                    {showLinkForm && permissions.canWrite && (
                        <form onSubmit={addLink} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <div className="grid grid-cols-3 gap-compact">
                                <Combobox hideSearch id="link-entity-type" selected={ENTITY_TYPE_CB_OPTIONS.find(o => o.value === linkEntityType) ?? null} setSelected={(opt) => setLinkEntityType(opt?.value ?? linkEntityType)} options={ENTITY_TYPE_CB_OPTIONS} matchTriggerWidth />
                                {/* PR-D — entity picker replaces the
                                    legacy "Paste ID" `<input>`. The
                                    type Combobox to the left drives
                                    which candidate set the picker
                                    fetches; selecting from the list
                                    writes the cuid into linkEntityId
                                    so the existing addLink handler
                                    is unchanged. */}
                                <EntityPicker
                                    tenantSlug={tenantSlug}
                                    entityType={linkEntityType as EntityPickerKind}
                                    value={linkEntityId}
                                    onChange={setLinkEntityId}
                                    id="link-entity-id"
                                    testId="task-link-entity-picker"
                                    placeholder={t('detail.selectEntity')}
                                />
                                <Combobox hideSearch id="link-relation" selected={RELATION_CB_OPTIONS.find(o => o.value === linkRelation) ?? null} setSelected={(opt) => setLinkRelation(opt?.value ?? linkRelation)} options={RELATION_CB_OPTIONS} matchTriggerWidth />
                            </div>
                            <Button type="submit" variant="primary" icon={savingLink ? undefined : <Plus className="-ml-0.5 -mr-2.5" />} disabled={savingLink} id="submit-link-btn">
                                {savingLink ? t('detail.linking') : t('detail.link')}
                            </Button>
                        </form>
                    )}
                    <TaskLinksTable
                        links={links}
                        loading={linksLoading}
                        canWrite={!!permissions.canWrite}
                        onRemove={removeLink}
                        tenantHref={tenantHref}
                    />
                    <div className="border-t border-border-subtle pt-default">
                        {/* entityType="ISSUE" is CORRECT here, not a bug: the
                            vendor-link system keys tasks under ISSUE (issue ids
                            ARE task ids — issues redirect to tasks), and
                            VendorLinkEntityType has no TASK member. Passing "TASK"
                            would 400 at the /vendors/linked route. Verified against
                            vendor.ts (type==='ISSUE' → db.task.findMany). */}
                        <LinkedVendorsPanel entityType="ISSUE" entityId={taskId} />
                    </div>
                </div>
            )}

            {/* Comments Tab */}
            {tab === 'comments' && (
                <div className="space-y-default">
                    {canComment && (
                        <form onSubmit={addComment} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <Textarea
                                rows={3}
                                placeholder={t('detail.commentPlaceholder')}
                                value={commentBody}
                                onChange={e => setCommentBody(e.target.value)}
                                required
                                id="comment-body"
                            />
                            <Button type="submit" variant="primary" icon={savingComment ? undefined : <Plus className="-ml-0.5 -mr-2.5" />} disabled={savingComment} id="submit-comment-btn">
                                {savingComment ? t('detail.posting') : t('detail.comment')}
                            </Button>
                        </form>
                    )}
                    <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="comments-list">
                        {commentsLoading ? (
                            <div className="p-4 space-y-compact">
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <div key={i} className="space-y-1">
                                        <SkeletonLine className="w-32" />
                                        <SkeletonLine className="w-full" />
                                    </div>
                                ))}
                            </div>
                        ) : comments.length === 0 ? (
                            <InlineEmptyState
                                title={t('detail.commentsEmptyTitle')}
                                description={t('detail.commentsEmptyDesc')}
                            />
                        ) : (
                            <div className="divide-y divide-border-default/50">
                                {comments.map((c) => (
                                    <div key={c.id} className="px-5 py-3">
                                        <div className="flex items-center gap-tight mb-1">
                                            <span className="text-sm font-medium text-content-emphasis">{c.createdBy?.name || t('detail.unknown')}</span>
                                            <span className="text-xs text-content-subtle">{formatDateTime(c.createdAt)}</span>
                                        </div>
                                        <p className="text-sm text-content-default whitespace-pre-wrap">{c.body}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Activity Tab */}
            {tab === 'activity' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="activity-list">
                    {activityLoading ? (
                        <div className="p-4 space-y-compact">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i} className="flex items-start gap-compact">
                                    <div className="animate-pulse rounded-full bg-bg-elevated/60 w-2 h-2 mt-2" />
                                    <div className="flex-1 space-y-1">
                                        <SkeletonLine className="w-48" />
                                        <SkeletonLine className="w-full" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : activity.length === 0 ? (
                        <InlineEmptyState
                            title={t('detail.activityEmptyTitle')}
                            description={t('detail.activityEmptyDesc')}
                        />
                    ) : (
                        <div className="divide-y divide-border-default/50">
                            {activity.map((evt) => (
                                <div key={evt.id} className="px-5 py-3 flex items-start gap-compact">
                                    <div className="w-2 h-2 rounded-full bg-[var(--brand-default)] mt-2 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-tight mb-0.5">
                                            <span className="text-sm font-medium text-content-emphasis">{evt.user?.name || t('detail.system')}</span>
                                            <StatusBadge variant="neutral">{evt.action?.replace(/_/g, ' ')}</StatusBadge>
                                        </div>
                                        <p className="text-xs text-content-muted truncate">{evt.details?.split('\n')[0]}</p>
                                        <span className="text-xs text-content-subtle">{formatDateTime(evt.createdAt)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Resolution prompt — moving a task to a terminal status
                (CLOSED / CANCELED) records a resolution note on the
                audit trail (S8). Collected here so closing actually
                works instead of silently reverting on the 4xx. */}
            <Modal
                showModal={pendingTerminalStatus !== null}
                setShowModal={(next) => {
                    if (next === false && !changingStatus) {
                        setPendingTerminalStatus(null);
                    }
                }}
                size="sm"
                title={terminalActionTitle}
                description={t('detail.terminalDesc')}
                preventDefaultClose={changingStatus}
            >
                <Modal.Header
                    title={terminalActionTitle}
                    description={t('detail.terminalHeaderDesc')}
                />
                <Modal.Body>
                    {statusError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            id="task-status-error"
                        >
                            {statusError}
                        </div>
                    )}
                    <FormField label={t('detail.resolution')} required>
                        <Textarea
                            id="task-resolution-input"
                            rows={3}
                            placeholder={t('detail.resolutionPlaceholder')}
                            value={resolutionDraft}
                            onChange={(e) => setResolutionDraft(e.target.value)}
                            disabled={changingStatus}
                        />
                    </FormField>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPendingTerminalStatus(null)}
                        disabled={changingStatus}
                        id="task-status-cancel-btn"
                    >
                        {t('detail.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        id="confirm-task-status-btn"
                        disabled={!resolutionDraft.trim() || changingStatus}
                        onClick={() =>
                            pendingTerminalStatus &&
                            commitStatus(
                                pendingTerminalStatus,
                                resolutionDraft.trim(),
                            )
                        }
                    >
                        {changingStatus
                            ? t('detail.savingEllipsis')
                            : terminalActionTitle}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/* TP-4 — the ONE task edit surface: the shared inline
                autosave TaskEditPanel (form variant), hosted in a modal
                container. Full field set (title / description / status /
                type / severity / priority / due / assignee), autosave on
                change, no explicit Save button. Status routes through
                setTaskStatus (state machine + TP-3 reconciliation). */}
            <Modal
                showModal={showEditModal}
                setShowModal={setShowEditModal}
                size="lg"
                title={t('edit.title')}
                description={t('edit.desc')}
            >
                <Modal.Header title={t('edit.title')} description={t('edit.desc')} />
                <Modal.Body>
                    <TaskEditPanel
                        variant="form"
                        tenantSlug={tenantSlug}
                        task={{
                            id: task.id,
                            title: task.title,
                            status: task.status,
                            severity: task.severity,
                            key: task.key ?? undefined,
                        }}
                        canWrite={!!permissions.canWrite}
                        onSaved={() => void taskQuery.mutate()}
                    />
                </Modal.Body>
            </Modal>
        </EntityDetailLayout>
    );
}

// R11-PR8 — task links sub-table routed through DataTable. Inline
// columns derive from the same fields the prior raw <table> rendered;
// canWrite gates the Remove action column. `loading` proxies to
// DataTable's built-in skeleton (which inherits R11-PR2's shimmer).
interface TaskLinkRow {
    id: string;
    entityType: string;
    entityId: string;
    relation?: string | null;
    createdAt: string;
    // TP-4 — resolved by the loader (listByTaskResolved).
    name?: string | null;
    path?: string | null;
}

function TaskLinksTable({
    links,
    loading,
    canWrite,
    onRemove,
    tenantHref,
}: {
    links: TaskLinkRow[];
    loading: boolean;
    canWrite: boolean;
    onRemove: (id: string) => void;
    tenantHref: (path: string) => string;
}) {
    const t = useTranslations('tasks');
    const columns = useMemo(
        () =>
            createColumns<TaskLinkRow>([
                {
                    id: 'entityType',
                    header: t('detail.linkTypeHeader'),
                    cell: ({ row }) => (
                        <StatusBadge variant="info">{row.original.entityType}</StatusBadge>
                    ),
                },
                {
                    id: 'entityId',
                    // TP-4 — render the resolved entity NAME as a real
                    // link, not a raw cuid. Falls back to the id (mono)
                    // only when the entity could not be resolved.
                    header: t('detail.linkEntityHeader'),
                    cell: ({ row }) => {
                        const { name, path, entityId } = row.original;
                        if (name && path) {
                            return (
                                <Link
                                    href={tenantHref(path)}
                                    className={textLinkVariants({ tone: 'link' })}
                                >
                                    {name}
                                </Link>
                            );
                        }
                        if (name) {
                            return <span className="text-sm text-content-default">{name}</span>;
                        }
                        return (
                            <span className="text-sm text-content-subtle font-mono">{entityId}</span>
                        );
                    },
                },
                {
                    id: 'relation',
                    header: t('detail.linkRelationHeader'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.relation?.replace(/_/g, ' ') || '—'}
                        </span>
                    ),
                },
                {
                    id: 'createdAt',
                    header: t('detail.linkCreatedHeader'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {formatDate(row.original.createdAt)}
                        </span>
                    ),
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: t('detail.linkActionsHeader'),
                              cell: ({ row }) => (
                                  // Platform Button rather than a bare
                                  // <button>: it carries the focus ring,
                                  // disabled semantics, and destructive
                                  // tone the raw element had to fake with
                                  // colour classes alone.
                                  <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-content-error"
                                      id={`remove-link-${row.original.id}`}
                                      onClick={() => onRemove(row.original.id)}
                                  >
                                      {t('detail.removeLink')}
                                  </Button>
                              ),
                          } as Parameters<typeof createColumns<TaskLinkRow>>[0][number],
                      ]
                    : []),
            ]),
        [canWrite, onRemove, t, tenantHref],
    );
    return (
        <DataTable
            data={links}
            columns={columns}
            getRowId={(l) => l.id}
            loading={loading}
            emptyState={
                <InlineEmptyState
                    title={t('detail.linksEmptyTitle')}
                    description={t('detail.linksEmptyDesc')}
                />
            }
            resourceName={(p) => (p ? t('detail.linksResourcePlural') : t('detail.linksResourceSingular'))}
            data-testid="task-links-table"
        />
    );
}
