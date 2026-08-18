/**
 * Epic 49 — `getComplianceCalendarEvents` usecase.
 *
 * Single aggregation that fans out across the date-bearing entities and
 * normalises every result into the unified `CalendarEvent` shape:
 *
 *   - Evidence            (nextReviewDate)
 *   - Policy              (nextReviewAt)
 *   - Vendor              (nextReviewAt, contractRenewalAt)
 *   - VendorDocument      (validTo)
 *   - VendorAssessment    (nextReviewAt)
 *   - AuditCycle          (periodStartAt → periodEndAt — the only duration source today)
 *   - Control             (nextDueAt)
 *   - ControlTestPlan     (nextDueAt)
 *   - ControlException    (expiresAt)
 *   - AccessReview        (dueAt)
 *   - TrainingAssignment  (dueAt)
 *   - IncidentNotification(dueAt — the NIS2 Art.23 notification SLA)
 *   - Task                (dueAt)
 *   - Risk                (nextReviewAt, targetDate)
 *   - Finding             (dueDate)
 *   - RiskTreatmentPlan   (targetDate) + TreatmentMilestone (dueDate)
 *
 * Deliberately OUT of scope — `ReportSchedule.nextRunAt`. It is a system
 * automation trigger ("the platform will generate this report"), not an
 * obligation a person can miss or act on; putting it beside real
 * deadlines would dilute "what's due". Revisit only if scheduled reports
 * gain a human approval step.
 *
 * `Evidence.expiredAt` is likewise NOT a source: the retention job stamps
 * it at the moment of expiry, so it is a past-tense receipt rather than a
 * forward deadline. `nextReviewDate` is the evidence deadline.
 *
 * Tenant isolation: every Prisma query starts with `tenantId: ctx.tenantId`.
 *
 * Range bounding: the schema guarantees `from <= to <= from + 2y`. Inside
 * the usecase we issue parallel point queries with date predicates so the
 * DB can use the per-entity indexes on the date columns + `(tenantId, …)`.
 *
 * Truncation: each source is capped at `perSourceLimit` (default 500).
 * EVERY loader therefore orders ascending by its date column, so a cap
 * that bites keeps the NEAREST deadlines rather than an arbitrary set the
 * planner happened to return. A capped source reports itself so the
 * response can say so out loud instead of silently under-reporting —
 * see `CalendarSourceResult.capped` and `CalendarResponse.truncation`.
 *
 * Status mapping: each source maps its lifecycle status into one of
 * `scheduled | due_soon | overdue | done | unknown`. The map is local
 * to the source (one place to look when a new entity is added).
 */


import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability';
import { internal } from '@/lib/errors/types';
import { assertCanRead } from '../../policies/common';
import { TERMINAL_TASK_STATUSES } from '../../domain/task-status';
import {
    evidenceExpiryScopeWhere,
    EVIDENCE_REVIEWED_STATUS,
} from '../../domain/evidence-expiry';
import {
    CONTROL_TEST_ELIGIBILITY,
    isControlTestSatisfied,
} from '../../domain/control-test-due';
import { effectiveDueAt } from '../due-planning';
import { urgencyFromDaysUntil, DAY_MS } from '@/lib/urgency';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-key';
import { env } from '@/env';
import type { TaskStatus } from '@prisma/client';
import type { RequestContext } from '../../types';
import {
    type CalendarEvent,
    type CalendarEventCategory,
    type CalendarEventStatus,
    type CalendarEventType,
    type CalendarResponse,
    type CalendarSourceName,
    CALENDAR_EVENT_CATEGORIES,
    CALENDAR_EVENT_STATUSES,
} from '../../schemas/calendar.schemas';

import {
    DEFAULT_TOTAL_CAP,
    SOURCE_CONCURRENCY,
    PER_SOURCE_TIMEOUT_MS,
    todayYmdInTz,
    countSummaries,
    type CalendarSourceDef,
    type CalendarSourceResult,
} from './shared';
export { todayYmdInTz } from './shared';
import { loadAssetVulnerabilityEvents, loadAuditEvents } from './loaders-asset-audit';
import {
    loadEvidenceEvents, loadPolicyEvents, loadVendorEvents, loadVendorDocumentEvents,
    loadAuditCycleEvents, loadControlEvents, loadTestPlanEvents, loadTaskEvents,
    loadRiskEvents, loadFindingEvents,
} from './loaders-core';
import { loadTreatmentMilestoneEvents, loadTreatmentPlanEvents } from './loaders-risk-treatment';
import {
    loadAccessReviewEvents, loadTrainingEvents, loadIncidentNotificationEvents,
    loadControlExceptionEvents, loadVendorAssessmentEvents,
} from './loaders-reminder-backed';

// ─── Public entry point ──────────────────────────────────────────────

export interface GetCalendarEventsInput {
    from: Date;
    to: Date;
    /** Optional filter — when set, only these types are returned. */
    types?: ReadonlyArray<CalendarEventType>;
    /** Optional filter — when set, only these categories are returned. */
    categories?: ReadonlyArray<CalendarEventCategory>;
    /** Override "now" for tests. Default: new Date(). */
    now?: Date;
    /**
     * Per-source result cap. Default: 500. Stops a runaway entity (one
     * tenant with 50k overdue tasks) from overwhelming the response.
     */
    perSourceLimit?: number;
    /**
     * Hard cap on the total serialized event count across all sources.
     * Default: {@link DEFAULT_TOTAL_CAP}. Events are date-ascending, so a
     * cap that bites drops the furthest-out deadlines, mirroring the
     * per-source "nearest survive" contract.
     */
    totalCap?: number;
}

/**
 * What one loader hands back. `capped` is true when the source returned
 * exactly `limit` rows — i.e. there are almost certainly more deadlines
 * past the cap. Because every loader orders by its date column ascending,
 * the ones that survived truncation are the NEAREST ones; the ones hidden
 * are further out.
 */

const CALENDAR_SOURCES: readonly CalendarSourceDef[] = [
    { name: 'evidence', permission: 'evidence.view', category: 'evidence', types: ['evidence-review'], load: loadEvidenceEvents },
    { name: 'policy', permission: 'policies.view', category: 'policy', types: ['policy-review'], load: loadPolicyEvents },
    { name: 'vendor', permission: 'vendors.view', category: 'vendor', types: ['vendor-review', 'vendor-renewal'], load: loadVendorEvents },
    { name: 'vendor-document', permission: 'vendors.view', category: 'vendor', types: ['vendor-document-expiry'], load: loadVendorDocumentEvents },
    { name: 'vendor-assessment', permission: 'vendors.view', category: 'vendor', types: ['vendor-assessment-review'], load: loadVendorAssessmentEvents },
    { name: 'audit-cycle', permission: 'audits.view', category: 'audit', types: ['audit-cycle'], load: loadAuditCycleEvents },
    { name: 'control', permission: 'controls.view', category: 'control', types: ['control-review'], load: loadControlEvents },
    { name: 'control-test-plan', permission: 'tests.view', category: 'control', types: ['control-test-due'], load: loadTestPlanEvents },
    { name: 'control-exception', permission: 'controls.view', category: 'control', types: ['control-exception-expiry'], load: loadControlExceptionEvents },
    { name: 'asset-vulnerability', permission: 'assets.view', category: 'control', types: ['vulnerability-remediation-due'], load: loadAssetVulnerabilityEvents },
    { name: 'audit', permission: 'audits.view', category: 'audit', types: ['audit-scheduled'], load: loadAuditEvents },
    { name: 'access-review', permission: 'audits.view', category: 'audit', types: ['access-review-due'], load: loadAccessReviewEvents },
    { name: 'training', permission: 'personnel.view', category: 'task', types: ['training-due'], load: loadTrainingEvents },
    { name: 'incident-notification', permission: 'incidents.view', category: 'finding', types: ['incident-notification-due'], load: loadIncidentNotificationEvents },
    { name: 'task', permission: 'tasks.view', category: 'task', types: ['task-due'], load: loadTaskEvents },
    { name: 'risk', permission: 'risks.view', category: 'risk', types: ['risk-review', 'risk-target'], load: loadRiskEvents },
    { name: 'finding', permission: 'audits.view', category: 'finding', types: ['finding-due'], load: loadFindingEvents },
    // Epic G-7 — milestones contribute one event per milestone; plans one per non-completed plan target.
    { name: 'treatment-milestone', permission: 'risks.view', category: 'risk', types: ['treatment-milestone-due'], load: loadTreatmentMilestoneEvents },
    { name: 'treatment-plan', permission: 'risks.view', category: 'risk', types: ['treatment-plan-target'], load: loadTreatmentPlanEvents },
] as const;

/**
 * Distinct baseline permission keys — a caller must hold AT LEAST ONE to
 * reach the calendar at all. Wired into the route via `requireAnyPermission`
 * so a scopeless API key (e.g. `mcp:read`, which maps to no PermissionSet
 * flags) is denied outright with an AUTHZ_DENIED audit, instead of reading
 * the whole tenant deadline stream.
 */
export const CALENDAR_BASELINE_PERMISSIONS: readonly PermissionKey[] = Array.from(
    new Set(CALENDAR_SOURCES.map((s) => s.permission)),
) as PermissionKey[];

/** Bounded-concurrency map — preserves input order, at most `concurrency` in flight. */
async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fn(items[i], i);
        }
    }
    const lanes = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return results;
}

export async function getComplianceCalendarEvents(
    ctx: RequestContext,
    input: GetCalendarEventsInput,
): Promise<CalendarResponse> {
    // Authorization is per-source (below), NOT one coarse `assertCanRead`
    // gate — `ctx.permissions.canRead` is `true` for every role, so it
    // would let a principal denied a domain read that domain's deadlines.
    const now = input.now ?? new Date();
    const limit = input.perSourceLimit ?? 500;
    const totalCap = input.totalCap ?? DEFAULT_TOTAL_CAP;
    const range = { from: input.from, to: input.to };

    const typeFilter =
        input.types && input.types.length > 0 ? new Set<string>(input.types) : null;
    const catFilter =
        input.categories && input.categories.length > 0
            ? new Set<string>(input.categories)
            : null;

    // Per-source permission gate + filter push-down. A source runs only if
    // the caller holds its domain `.view` (custom-role denials AND API-key
    // scopes both flow through `appPermissions`, so this one predicate
    // closes both amplifiers) AND it can contribute to the requested filter.
    const omittedSources: CalendarSourceName[] = [];
    const eligible: CalendarSourceDef[] = [];
    for (const src of CALENDAR_SOURCES) {
        if (!hasPermission(ctx.appPermissions, src.permission)) {
            omittedSources.push(src.name);
            continue;
        }
        // Skip a source that can contribute nothing to the filtered result,
        // so `truncation.sources` only names sources that actually ran.
        if (catFilter && !catFilter.has(src.category)) continue;
        if (typeFilter && !src.types.some((t) => typeFilter.has(t))) continue;
        eligible.push(src);
    }

    // Each loader runs in its OWN read-only context so the fan-out genuinely
    // parallelises across pooled connections rather than serialising behind one
    // pinned connection.
    //
    // The catch is what makes a per-source failure survivable. Without it, one
    // loader breaching its 8s budget (P2028) — or exhausting the pool (P2024),
    // or throwing for any reason at all — rejected the whole `Promise.all` and
    // 500'd the entire calendar: seventeen domains, all three views, for a
    // fault in one.
    //
    // The sentinel is index-aligned deliberately. `cappedSources` below reads
    // `results[i]` positionally against `eligible`, so a filtered (shorter)
    // array would leave `results[i]` undefined for the tail and turn a
    // partial-data problem into a TypeError — a worse outage than the one being
    // fixed.
    const settled = await mapWithConcurrency(eligible, SOURCE_CONCURRENCY, async (src) => {
        try {
            return await runInTenantReadContext(
                ctx,
                (db) => src.load(db, ctx, range, now, limit),
                { timeout: PER_SOURCE_TIMEOUT_MS },
            );
        } catch (err: unknown) {
            // Never silent: this trades a loud 500 for a quiet degradation, so
            // a chronically-broken source has to remain visible to operators.
            // The user-facing half is `failedSources` in the response.
            logger.warn('calendar source failed — omitted from this response', {
                component: 'compliance-calendar',
                source: src.name,
                tenantId: ctx.tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    });

    const failedSources = eligible
        .map((src, i) => (settled[i] === null ? src.name : null))
        .filter((n): n is CalendarSourceName => n !== null);

    // Every source failing is not a partial result — it is an outage wearing
    // the costume of an empty calendar. An empty grid plus a notice reads as
    // "nothing is due"; on a deadline product that is the most dangerous thing
    // this surface can say. Fail loudly instead.
    if (eligible.length > 0 && failedSources.length === eligible.length) {
        throw internal(
            `compliance-calendar: every source failed (${failedSources.join(', ')})`,
        );
    }

    const results: CalendarSourceResult[] = settled.map(
        (r) => r ?? { events: [], capped: false },
    );

    const cappedSources = eligible
        .map((src, i) => (results[i].capped ? src.name : null))
        .filter((n): n is CalendarSourceName => n !== null);

    let all: CalendarEvent[] = results.flatMap((r) => r.events);

    // A source may emit multiple types (vendor → review + renewal); a type
    // filter still needs a post-filter so a partially-matching source
    // contributes only its requested types.
    if (typeFilter) all = all.filter((e) => typeFilter.has(e.type));
    if (catFilter) all = all.filter((e) => catFilter.has(e.category));

    // Stable order: ascending by date — heatmap + month rendering consume
    // events chronologically.
    all.sort((a, b) => a.date.localeCompare(b.date));

    // Hard total cap on the serialized payload. Events are date-ascending, so
    // a cap that bites drops the furthest-out deadlines.
    const totalCapped = all.length > totalCap;
    if (totalCapped) all = all.slice(0, totalCap);

    return {
        events: all,
        // `partial` propagates any truncation into the summary so the UI
        // never presents a post-truncation undercount as authoritative.
        counts: {
            ...countSummaries(all),
            // A failed source is a partial result in exactly the sense this
            // flag exists for — the summary is an undercount.
            partial: cappedSources.length > 0 || totalCapped || failedSources.length > 0,
        },
        truncation: {
            capped: cappedSources.length > 0 || totalCapped,
            sources: cappedSources,
            perSourceLimit: limit,
            totalCap,
            totalCapped,
        },
        // Sources the caller lacks permission to see. The UI says "some
        // sources hidden by your permissions" rather than under-reporting.
        omittedSources,
        // Sources that ERRORED. Deliberately distinct from `omittedSources`:
        // "you cannot see this" and "this failed to load" are different facts,
        // and only one of them is worth retrying.
        failedSources,
        // The day every `status` above was judged against. Published so the
        // client's "today" marker uses the SAME day the dots do, instead of the
        // viewer's browser day — which made an event sit in one cell, be ringed
        // as today in another, and be classified against a third.
        todayYmd: todayYmdInTz(now, env.NOTIFICATIONS_TZ),
        range: {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
        },
    };
}


// ─── Lightweight badge query ─────────────────────────────────────────

/**
 * Cheap count of the caller's tasks that NEED ATTENTION, used by the
 * sidebar Calendar nav badge.
 *
 * Scope is deliberately narrow and personal — "how much is on *my*
 * plate", not "how many tenant deadlines exist". The Calendar PAGE is
 * tenant-wide across every source; this badge is not, so the UI labels it
 * explicitly as my-tasks (see the `calendarBadgeLabel` copy) rather than
 * letting a user read a small number as "the tenant is fine".
 *
 *   - Tasks ONLY — not controls / evidence / policies / vendors. Counting
 *     16 sources on every sidebar render would be a fan-out per page view;
 *     the page owns the tenant-wide view.
 *   - Assigned to the caller (`assigneeUserId = ctx.userId`).
 *   - OVERDUE **and** upcoming. Overdue used to be excluded (`dueAt > now`),
 *     which meant a user whose work was entirely late saw an EMPTY badge —
 *     the worst possible state rendered as the calmest. "Needs attention"
 *     has to include the things that are already late.
 *   - Non-terminal status (open work only).
 *
 * `horizonDays` caps the FUTURE side only; overdue is always included
 * regardless of horizon, because an old overdue task doesn't stop needing
 * attention just because the caller asked for a 7-day view.
 *
 * Caps at `MAX_BADGE_COUNT` so the badge never renders a huge number that's
 * effectively noise (we render `99+` past the cap on the UI side). Returns 0
 * when nothing needs attention — the sidebar hook then hides the badge.
 */
const MAX_BADGE_COUNT = 99;

/**
 * The nav badge's number: **the caller's own open TASKS**, overdue plus a
 * forward horizon.
 *
 * Renamed from `getUpcomingDeadlineCount`, which was a lie of scope. The
 * calendar page beside it aggregates NINETEEN sources tenant-wide; this counts
 * one model, filtered to `assigneeUserId === ctx.userId`. Those are different
 * questions and the divergence is INTENTIONAL — the badge answers "what do I
 * personally owe?", the page answers "what does the org owe?" — but the old
 * name promised the page's answer, so the two numbers looked like a bug every
 * time someone compared them.
 *
 * If the badge should ever mirror the page, that is a product decision and a
 * behaviour change to the most-glanced-at number in the app; it is not a
 * rename. `tests/unit/compliance-calendar.test.ts` pins the divergence
 * deliberately so a future reader finds an assertion rather than a discrepancy.
 */
export async function getMyUpcomingTaskCount(
    ctx: RequestContext,
    options: { now?: Date; horizonDays?: number } = {},
): Promise<number> {
    assertCanRead(ctx);
    const now = options.now ?? new Date();
    // Overdue is ALWAYS in scope (no lower bound) — the badge means "needs
    // attention", and late work needs it most. `horizonDays` caps only how
    // far FORWARD we look, so a 7-day horizon reads as "everything late,
    // plus the next week" rather than hiding a backlog.
    const dueAt =
        options.horizonDays != null
            ? {
                  not: null,
                  lte: new Date(now.getTime() + options.horizonDays * 86_400_000),
              }
            : { not: null };

    // Count, don't fetch — we only need a number for the badge. The
    // `take: MAX_BADGE_COUNT + 1` pattern lets us know if the real
    // number exceeds the cap without doing a full COUNT. Wrapped in
    // `runInTenantContext` so the read goes through RLS-bound `app_user`.
    const tasks = await runInTenantContext(ctx, (db) =>
        db.task.count({
            where: {
                tenantId: ctx.tenantId,
                // Personal badge: only the caller's own tasks.
                assigneeUserId: ctx.userId,
                dueAt,
                status: {
                    // Cast through readonly → mutable TaskStatus[]
                    // because Prisma's `notIn` rejects the `as const`
                    // literal type, and the shared ACTIVE_STATUS_FILTER
                    // constant types its payload as `string[]` which
                    // Prisma's newer generated client also rejects.
                    notIn: [...TERMINAL_TASK_STATUSES] as TaskStatus[],
                },
            },
            take: MAX_BADGE_COUNT + 1,
        }),
    );

    return Math.min(MAX_BADGE_COUNT + 1, tasks);
}

