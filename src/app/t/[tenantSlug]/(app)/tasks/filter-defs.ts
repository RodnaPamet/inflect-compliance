/**
 * Epic 53 — Tasks list page filter configuration.
 *
 * Keys align with `TaskQuerySchema`: status, type, severity, priority,
 * assigneeUserId, controlId, due.
 *
 * `due` is a pseudo-enum chip ("overdue" / "next7d") that the server
 * understands directly — no transform needed.
 *
 * i18n (filter-defs factory): display labels resolve through next-intl at
 * render via `buildTaskFilters(tasks, t, tGroup)` — `t` scoped to `tasks`,
 * `tGroup` to the shared `common.filterGroups`. The URL-sync KEYS stay static;
 * option VALUES (enum members + due chips) are unchanged — only labels are
 * localized.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { AlertCircle, CircleDot, Clock, Flag, Inbox, Layers, UserCheck, UserCircle2 } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('tasks')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;
/**
 * Key-only resolver for the label maps. Deliberately looser than `T`:
 * these builders never interpolate, and `T`'s `values?: Record<string,
 * unknown>` parameter is wider than next-intl's own `Translator` accepts,
 * so a raw `useTranslations(...)` result is not assignable to `T`. The
 * label builders are exported and called with exactly that, so they take
 * the narrower shape they actually use.
 */
type TLabel = (key: string) => string;

// ─── Labels (resolved at render) ─────────────────────────────────────

// The status filter offers EXACTLY the eight TaskStatus values.
// IN_REVIEW (TP-2) is a real reviewer-sign-off state now, so a reviewed
// task awaiting sign-off is filterable.
function taskStatusLabels(t: T): Record<string, string> {
    return {
        OPEN: t('filterEnums.status.OPEN'),
        TRIAGED: t('filterEnums.status.TRIAGED'),
        IN_PROGRESS: t('filterEnums.status.IN_PROGRESS'),
        IN_REVIEW: t('filterEnums.status.IN_REVIEW'),
        BLOCKED: t('filterEnums.status.BLOCKED'),
        // RESOLVED is retired from the two status PICKERS (the detail
        // page's SELECTABLE_STATUSES and the bulk bar) because CLOSED
        // made it a redundant intermediate. It is NOT retired from the
        // model: it is still a live TaskStatus, WORK_ITEM_TRANSITIONS
        // still permits moving into it, the API still accepts it, and
        // the repository's metrics still count it as done. Rows in this
        // state therefore exist — legacy ones, plus anything set through
        // the API, automation, or the /issues surface. A filter's job is
        // to find rows, not to offer transitions, so dropping this option
        // would make a reachable state unfindable.
        RESOLVED: t('filterEnums.status.RESOLVED'),
        CLOSED: t('filterEnums.status.CLOSED'),
        CANCELED: t('filterEnums.status.CANCELED'),
    };
}

function taskTypeLabels(t: T): Record<string, string> {
    return {
        TASK: t('filterEnums.type.TASK'),
        AUDIT_FINDING: t('filterEnums.type.AUDIT_FINDING'),
        CONTROL_GAP: t('filterEnums.type.CONTROL_GAP'),
        INCIDENT: t('filterEnums.type.INCIDENT'),
        IMPROVEMENT: t('filterEnums.type.IMPROVEMENT'),
    };
}

// TP-5 — the work SOURCE that raised the task. Values are EXACTLY the
// `TaskSource` enum members; the universal-inbox filter lets you slice
// /tasks by where the work came from (manual entry vs the automated sweeps
// that route audit findings, policy reviews, and expiring evidence in).
/**
 * The full `TaskSource` enum, labelled. Exported because the table
 * renders the same enum in its Source column — it used to keep a private
 * copy that had drifted (RISK_MONITOR missing), so a risk-monitor task's
 * filter chip read "Risk Monitor" while its row showed the raw
 * `RISK_MONITOR`. One definition, both consumers.
 */
export function taskSourceLabels(t: TLabel): Record<string, string> {
    return {
        MANUAL: t('filterEnums.source.MANUAL'),
        TEMPLATE: t('filterEnums.source.TEMPLATE'),
        POLICY_REVIEW: t('filterEnums.source.POLICY_REVIEW'),
        AUDIT: t('filterEnums.source.AUDIT'),
        INTEGRATION: t('filterEnums.source.INTEGRATION'),
        EVIDENCE_EXPIRY: t('filterEnums.source.EVIDENCE_EXPIRY'),
        RISK_MONITOR: t('filterEnums.source.RISK_MONITOR'),
    };
}

/**
 * Exported for the same reason as `taskSourceLabels` — the Severity
 * column rendered the raw enum (`CRITICAL`) while the filter chip
 * rendered "Critical". Sharing one map keeps the two in step.
 */
export function taskSeverityLabels(t: TLabel): Record<string, string> {
    return {
        // INFO is a real TaskSeverity (automation can raise INFO tasks);
        // offered here so those tasks are filterable, matching the create form.
        INFO: t('filterEnums.severity.INFO'),
        LOW: t('filterEnums.severity.LOW'),
        MEDIUM: t('filterEnums.severity.MEDIUM'),
        HIGH: t('filterEnums.severity.HIGH'),
        CRITICAL: t('filterEnums.severity.CRITICAL'),
    };
}

function taskDueLabels(t: T): Record<string, string> {
    return {
        overdue: t('filterEnums.due.overdue'),
        next7d: t('filterEnums.due.next7d'),
    };
}

function taskFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(taskStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        type: {
            label: t('filters.type'),
            description: t('filters.typeDesc'),
            group: tGroup('attributes'),
            icon: Layers,
            options: optionsFromEnum(taskTypeLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        severity: {
            label: t('filters.severity'),
            description: t('filters.severityDesc'),
            group: tGroup('quantitative'),
            icon: Flag,
            options: optionsFromEnum(taskSeverityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        source: {
            label: t('filters.source'),
            description: t('filters.sourceDesc'),
            group: tGroup('attributes'),
            icon: Inbox,
            options: optionsFromEnum(taskSourceLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        due: {
            label: t('filters.due'),
            description: t('filters.dueDesc'),
            group: tGroup('timeline'),
            icon: Clock,
            options: optionsFromEnum(taskDueLabels(t)),
            // Single-select — the chip semantics are mutually exclusive.
            resetBehavior: 'clearable',
        },
        // B2-4 — "whose sign-off is this waiting on". A people facet, but
        // a compound predicate server-side: IN_REVIEW *and* that user is
        // the named reviewer. Its options are supplied at render (there
        // is exactly one that matters — the signed-in user), the same way
        // assignee/control options are derived rather than enumerated
        // here. It needs a def, not just a registered key: an active
        // value with no def is a chip the toolbar cannot render.
        awaitingReviewBy: {
            label: t('filters.awaitingReview'),
            description: t('filters.awaitingReviewDesc'),
            group: tGroup('people'),
            icon: UserCheck,
            options: null, // derived at render time (the signed-in user)
            resetBehavior: 'clearable',
        },
        assigneeUserId: {
            label: t('filters.assignee'),
            labelPlural: t('filters.assigneePlural'),
            description: t('filters.assigneeDesc'),
            group: tGroup('people'),
            icon: UserCircle2,
            options: null, // derived at render time
            multiple: true,
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
        controlId: {
            label: t('filters.linkedControl'),
            description: t('filters.linkedControlDesc'),
            group: tGroup('linked'),
            icon: AlertCircle,
            options: null, // derived at render time
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized task filter defs. `t` = `useTranslations('tasks')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildTaskFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(taskFilterDefsInput(t, tGroup));
}

/**
 * B2-4 — the key behind both the "Awaiting my review" quick toggle and
 * the matching filter card. It carries a userId, exactly like
 * `assigneeUserId` behind "Assigned to me", and rides the same
 * `FilterProvider` state → URL → `toApiSearchParams` pipeline.
 */
export const AWAITING_REVIEW_FILTER_KEY = 'awaitingReviewBy';

// The URL-sync KEYS are label-independent — derive them once with an identity
// resolver so callers keep importing a stable `TASK_FILTER_KEYS` constant.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const TASK_FILTER_KEYS = buildTaskFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

interface TaskAssigneeLike {
    assigneeUserId?: string | null;
    assignee?: { id: string; name: string | null; email: string | null } | null;
}

interface TaskControlLike {
    controlId?: string | null;
    control?: { id: string; name: string | null; annexId: string | null; code: string | null } | null;
}

export function assigneeOptionsFromTasks(
    tasks: ReadonlyArray<TaskAssigneeLike>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const t of tasks) {
        const a = t.assignee;
        if (!a?.id || seen.has(a.id)) continue;
        const name = a.name?.trim() || a.email?.trim() || 'Unknown';
        seen.set(a.id, {
            value: a.id,
            label: a.email ? `${name} — ${a.email}` : name,
            displayLabel: name,
        });
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function controlOptionsFromTasks(
    tasks: ReadonlyArray<TaskControlLike>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const t of tasks) {
        const c = t.control;
        if (!c?.id || seen.has(c.id)) continue;
        const prefix = c.annexId || c.code || '';
        seen.set(c.id, {
            value: c.id,
            label: prefix ? `${prefix}: ${c.name ?? ''}` : (c.name ?? c.id),
            displayLabel: prefix || c.name || c.id,
        });
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function buildTaskFilters(
    tasks: ReadonlyArray<TaskAssigneeLike & TaskControlLike>,
    t: T,
    tGroup: TGroup,
    /**
     * B2-4 — the signed-in user, when known. The awaiting-review facet
     * offers exactly one option: yourself. Another person's sign-off
     * queue is not a view this product has a reason to browse, and
     * leaving the option list empty would render a card that cannot be
     * used and a chip that cannot be labelled.
     */
    currentUserId?: string | null,
) {
    const assigneeOpts = assigneeOptionsFromTasks(tasks);
    const controlOpts = controlOptionsFromTasks(tasks);
    // "Me" — the card is already labelled "Awaiting review", so the chip
    // reads "Awaiting review: Me". Repeating the whole phrase here would
    // also collide with the quick toggle's own accessible name.
    const reviewOpts: FilterOption[] = currentUserId
        ? [{ value: currentUserId, label: t('list.awaitingMyReviewOption') }]
        : [];
    return buildTaskFilterDefs(t, tGroup).filters.map((f) => {
        if (f.key === 'assigneeUserId') return { ...f, options: assigneeOpts };
        if (f.key === 'controlId') return { ...f, options: controlOpts };
        if (f.key === AWAITING_REVIEW_FILTER_KEY) return { ...f, options: reviewOpts };
        return f;
    });
}
