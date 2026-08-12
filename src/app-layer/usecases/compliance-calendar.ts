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
import { assertCanRead } from '../policies/common';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import {
    evidenceExpiryScopeWhere,
    EVIDENCE_REVIEWED_STATUS,
} from '../domain/evidence-expiry';
import {
    CONTROL_TEST_ELIGIBILITY,
    isControlTestSatisfied,
} from '../domain/control-test-due';
import { effectiveDueAt } from './due-planning';
import { urgencyFromDaysUntil, DAY_MS } from '@/lib/urgency';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-middleware';
import { env } from '@/env';
import type { WorkItemStatus } from '@prisma/client';
import type { RequestContext } from '../types';
import {
    type CalendarEvent,
    type CalendarEventCategory,
    type CalendarEventStatus,
    type CalendarEventType,
    type CalendarResponse,
    type CalendarSourceName,
    CALENDAR_EVENT_CATEGORIES,
    CALENDAR_EVENT_STATUSES,
} from '../schemas/calendar.schemas';

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
interface CalendarSourceResult {
    events: CalendarEvent[];
    capped: boolean;
}

/**
 * Wrap a loader's mapped events with the truncation signal. `rowCount` is
 * the number of DB ROWS (not events) — a source like Vendor emits two
 * events per row, so events.length is not the right thing to compare.
 */
function sourceResult(
    events: CalendarEvent[],
    rowCount: number,
    limit: number,
): CalendarSourceResult {
    return { events, capped: rowCount >= limit };
}

/**
 * Fetch the nearest-`limit` rows for a source with MORE THAN ONE candidate
 * date column, keeping the soonest by effective (earliest in-range) date.
 *
 * A single `orderBy: [a, b]` is wrong: Postgres sorts NULLs LAST on ASC, so
 * a row matching only on `b` (its `a` is NULL/out-of-range) sorts after every
 * row matching on `a` and is truncated FIRST — the opposite of "nearest
 * survive". Instead we take each column's own nearest-`limit` and union them.
 * This is provably complete: a row whose effective date ranks in the global
 * top-`limit` has that date equal to one of its columns, so it is in that
 * column's top-`limit`. `capped` is conservative — true if ANY sub-query
 * filled its page, i.e. there may be further-out rows past the cap.
 */
async function fetchNearest<Row extends { id: string }>(
    queries: ReadonlyArray<() => Promise<Row[]>>,
    limit: number,
): Promise<{ rows: Row[]; capped: boolean }> {
    const parts = await Promise.all(queries.map((q) => q()));
    const byId = new Map<string, Row>();
    for (const part of parts) for (const r of part) byId.set(r.id, r);
    return { rows: [...byId.values()], capped: parts.some((p) => p.length >= limit) };
}

/** Hard cap on the total serialized event count (see {@link GetCalendarEventsInput.totalCap}). */
const DEFAULT_TOTAL_CAP = 5000;
/**
 * How many source loaders run concurrently. Each loader now runs in its
 * OWN read-only transaction (its own pooled connection), so this bounds
 * peak connection pressure per calendar request while still fanning out —
 * a single interactive transaction pins ONE connection and serialises,
 * which is the bug this replaces.
 */
const SOURCE_CONCURRENCY = 6;
/**
 * Per-source read timeout, passed as the Prisma interactive-transaction budget.
 *
 * Breaching it REJECTS (P2028) — the timeout bounds one source's work, it does
 * not make the failure survivable on its own. Isolation comes from the
 * try/catch at the fan-out below, which converts a rejected source into a
 * reported `failedSources` entry. This comment used to claim "one slow source
 * fails alone, not the whole calendar", which was false: there was no catch
 * anywhere in the file, so any rejection took all seventeen domains with it.
 */
const PER_SOURCE_TIMEOUT_MS = 8_000;

/** A calendar source loader's call signature. */
type CalendarLoader = (
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
) => Promise<CalendarSourceResult>;

/**
 * Static metadata for every calendar source. The `permission` is the
 * `appPermissions` key the caller must hold to see this source — it mirrors
 * the gate the source's own PAGE enforces, so the aggregator can never leak
 * a domain a principal is denied. `category` + `types` drive the filter
 * push-down (a source that can contribute nothing to a filtered request is
 * never queried).
 *
 * NOTE `permission` is the DOMAIN owning the data (what a custom role or an
 * API-key scope can deny); `category` is the UI colour bucket the events
 * render under — the two deliberately differ (training → personnel.view but
 * category `task`; incident-notification → incidents.view but category
 * `finding`). `finding`/`access-review` have no dedicated PermissionSet
 * domain, so they gate on `audits.view` — the closest compliance-attestation
 * domain every human role holds and the audits scope can grant.
 */
interface CalendarSourceDef {
    name: CalendarSourceName;
    permission: PermissionKey;
    category: CalendarEventCategory;
    types: readonly CalendarEventType[];
    load: CalendarLoader;
}

/**
 * Vulnerability remediation deadlines (`AssetVulnerability.remediationDueAt`).
 *
 * A projection gap, not a new feature: the column is written by
 * `vulnerability.ts` and EDITED BY USERS through an inline DatePicker on the
 * asset's vulnerability list. Someone set a remediation date and then could not
 * see it on the one surface whose job is "what is due".
 *
 * The parent asset is soft-deletable and this model is not, so the nested
 * predicate is mandatory (see `loadVendorDocumentEvents`).
 */
async function loadAssetVulnerabilityEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.assetVulnerability.findMany({
        where: {
            tenantId: ctx.tenantId,
            remediationDueAt: { not: null, gte: range.from, lte: range.to },
            asset: { deletedAt: null },
        },
        select: {
            id: true,
            cveId: true,
            status: true,
            remediationDueAt: true,
            ownerUserId: true,
            assetId: true,
            asset: { select: { name: true } },
        },
        orderBy: { remediationDueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.remediationDueAt)
        .map((r): CalendarEvent => {
            const date = r.remediationDueAt as Date;
            return {
                id: `ASSET_VULNERABILITY:${r.id}:vulnerability-remediation-due`,
                type: 'vulnerability-remediation-due',
                category: 'control',
                title: `Remediation due: ${r.cveId}`,
                entityName: r.cveId,
                detail: r.asset.name,
                date: date.toISOString(),
                // RESOLVED/ACCEPTED extinguish the remediation obligation the
                // date encodes — unlike a control's status, which does not.
                status: classifyStatus(
                    date,
                    now,
                    r.status === 'RESOLVED' || r.status === 'ACCEPTED',
                ),
                entityType: 'ASSET_VULNERABILITY',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/assets/${r.assetId}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Scheduled audit dates (`Audit.schedule`).
 *
 * Distinct from `audit-cycle`, which spans months — this is the day fieldwork
 * on one audit begins. The cycle being on the calendar made the omission easy
 * to miss: the surface looked like it covered audits already.
 */
async function loadAuditEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.audit.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            schedule: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            schedule: true,
            status: true,
        },
        orderBy: { schedule: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.schedule)
        .map((r): CalendarEvent => {
            const date = r.schedule as Date;
            return {
                id: `AUDIT:${r.id}:audit-scheduled`,
                type: 'audit-scheduled',
                category: 'audit',
                title: `Audit: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                // A completed audit has no scheduled start left to meet.
                status: classifyStatus(date, now, r.status === 'COMPLETED'),
                entityType: 'AUDIT',
                entityId: r.id,
                // The hub is a master-detail page with a ?selected= deep link;
                // there is no /audits/[id] route.
                href: tenantHrefFromCtx(ctx, `/audits?selected=${r.id}`),
            };
        });
    return sourceResult(events, rows.length, limit);
}

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

// ─── Helpers ─────────────────────────────────────────────────────────

interface DateRange {
    from: Date;
    to: Date;
}

/**
 * Formatters are cached per timezone.
 *
 * `civilDayInTz` used to construct a fresh `Intl.DateTimeFormat` on every
 * call, and it is called once per non-done event — the single most expensive
 * thing the aggregation did per row, and pure waste: an `Intl.DateTimeFormat`
 * is stateless with respect to the instant it formats (the UTC offset is
 * resolved per `formatToParts` call), so caching it is DST-correct and correct
 * across day boundaries.
 *
 * Keyed on `tz`, which in production is one env-derived value and never user
 * input — there is no unbounded-growth path. A Map rather than a single slot so
 * a test that flips zone mid-run stays correct.
 */
const CIVIL_DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function civilDayFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = CIVIL_DAY_FORMATTERS.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        CIVIL_DAY_FORMATTERS.set(tz, fmt);
    }
    return fmt;
}

/**
 * The civil calendar day of an instant in `tz`, expressed as whole days
 * since the Unix epoch. Two instants on the same wall-clock date in `tz`
 * return the same integer regardless of time-of-day.
 */
function civilDayInTz(d: Date, tz: string): number {
    const parts = civilDayFormatter(tz).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

/**
 * The UTC day of a stored deadline, as whole days since the epoch.
 *
 * This is deliberately NOT zoned. Day-resolution deadlines are stored at UTC
 * midnight, and the whole client renders their day identity as
 * `event.date.slice(0, 10)` — a UTC date string. Re-dating the target into
 * another zone made the status disagree with the cell the event is drawn in:
 * for a negative-offset zone, an event could sit in one grid cell and be
 * classified against the previous day. Reading the target's day the same way
 * the grid does makes them agree by construction.
 */
function utcDayOf(d: Date): number {
    return Math.floor(d.getTime() / DAY_MS);
}

/**
 * Memoised civil day for `now`.
 *
 * Half of every `daysUntilInTz` call recomputed an identical value — the zone's
 * today — once per event. Keyed on BOTH inputs so it stays a pure-function
 * memo: dropping `tz` from the key would break any caller that classifies the
 * same instant under two zones, which is exactly what the timezone tests do.
 */
let nowDayMemo: { ms: number; tz: string; day: number } | null = null;
function civilDayForNow(now: Date, tz: string): number {
    const ms = now.getTime();
    if (nowDayMemo && nowDayMemo.ms === ms && nowDayMemo.tz === tz) return nowDayMemo.day;
    const day = civilDayInTz(now, tz);
    nowDayMemo = { ms, tz, day };
    return day;
}

/**
 * Whole calendar-day distance from `now` to `target` (0 = same day).
 *
 * ONE definition of "day" for the whole surface: the target's day is its UTC
 * day (what the grid draws), and `now`'s day is civil in `tz` (what "today"
 * means operationally). The zone applies to the observer, not to the deadline.
 */
function daysUntilInTz(target: Date, now: Date, tz: string): number {
    return utcDayOf(target) - civilDayForNow(now, tz);
}

/** The civil day in `tz`, as `YYYY-MM-DD` — the day statuses were judged against. */
export function todayYmdInTz(now: Date, tz: string): string {
    return new Date(civilDayForNow(now, tz) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Map a date+status into a calendar status. `now` is the comparison
 * anchor. `done` is decided by the caller's domain logic and passes
 * through verbatim.
 *
 * Comparison is at DAY granularity in the notification timezone
 * (`NOTIFICATIONS_TZ`, the same zone the reminder jobs bucket by), NOT at
 * instant granularity: day-resolution deadlines are stored at UTC midnight,
 * so an instant compare flips them to `overdue` at 00:00:01 UTC — the
 * previous afternoon for a westward tenant. Same-day (`daysUntil === 0`) is
 * `due_soon`, never `overdue`.
 *
 * The due-soon window comes from the shared `URGENCY_DAYS` scale rather than
 * a local literal — the calendar's `due_soon` IS the product-wide `urgent`
 * level.
 */
function classifyStatus(
    eventDate: Date,
    now: Date,
    isDone: boolean,
): CalendarEventStatus {
    if (isDone) return 'done';
    const urgency = urgencyFromDaysUntil(
        daysUntilInTz(eventDate, now, env.NOTIFICATIONS_TZ),
    );
    if (urgency === 'overdue') return 'overdue';
    if (urgency === 'urgent') return 'due_soon';
    return 'scheduled';
}

function tenantHrefFromCtx(ctx: RequestContext, path: string): string {
    // Usecases don't know the slug, only the tenantId. The route handler
    // resolves slug; we leave a `/t/{slug}` placeholder that the route
    // handler rewrites. Keeping it server-side stops every UI from
    // re-implementing the same prefix.
    if (!ctx.tenantSlug) return path;
    return `/t/${ctx.tenantSlug}${path.startsWith('/') ? path : `/${path}`}`;
}

function countSummaries(events: CalendarEvent[]) {
    const byCategory: Record<CalendarEventCategory, number> = Object.fromEntries(
        CALENDAR_EVENT_CATEGORIES.map((c) => [c, 0]),
    ) as Record<CalendarEventCategory, number>;
    const byStatus: Record<CalendarEventStatus, number> = Object.fromEntries(
        CALENDAR_EVENT_STATUSES.map((s) => [s, 0]),
    ) as Record<CalendarEventStatus, number>;
    for (const e of events) {
        byCategory[e.category]++;
        byStatus[e.status]++;
    }
    return { total: events.length, byCategory, byStatus };
}

// ─── Per-source loaders ──────────────────────────────────────────────

async function loadEvidenceEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.evidence.findMany({
        where: {
            // Shared expiry scope — soft-deleted + archived evidence is
            // gone, so a review deadline for it is a phantom. This is the
            // same predicate the dashboard's evidence KPI uses.
            ...evidenceExpiryScopeWhere(ctx.tenantId),
            nextReviewDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewDate: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewDate: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewDate)
        .map((r): CalendarEvent => {
            const date = r.nextReviewDate as Date;
            const isDone = r.status === EVIDENCE_REVIEWED_STATUS && date > now;
            return {
                id: `EVIDENCE:${r.id}:evidence-review`,
                type: 'evidence-review',
                category: 'evidence',
                title: `Evidence review: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'EVIDENCE',
                entityId: r.id,
                // Evidence has no `/evidence/[id]` route — detail opens as a
                // sheet keyed off `?ev=`. This is the canonical deep-link
                // (EvidenceClient / EvidenceSubTable use the same).
                href: tenantHrefFromCtx(ctx, `/evidence?ev=${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

async function loadPolicyEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.policy.findMany({
        where: {
            tenantId: ctx.tenantId,
            nextReviewAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewAt: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewAt)
        .map((r): CalendarEvent => {
            const date = r.nextReviewAt as Date;
            const isDone = r.status === 'ARCHIVED';
            return {
                id: `POLICY:${r.id}:policy-review`,
                type: 'policy-review',
                category: 'policy',
                title: `Policy review: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'POLICY',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/policies/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

async function loadVendorEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const select = {
        id: true,
        name: true,
        nextReviewAt: true,
        contractRenewalAt: true,
        status: true,
        ownerUserId: true,
    } as const;
    // Two date columns → fetch each column's nearest-`limit` and union, so a
    // vendor whose only in-range date is the renewal isn't truncated behind
    // vendors with a review date (see `fetchNearest`).
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.vendor.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        nextReviewAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextReviewAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.vendor.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        contractRenewalAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { contractRenewalAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isOffboarded = r.status === 'OFFBOARDED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-review`,
                type: 'vendor-review',
                category: 'vendor',
                title: `Vendor review: ${r.name}`,
                entityName: r.name,
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isOffboarded),
                entityType: 'VENDOR',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/vendors/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
        if (
            r.contractRenewalAt &&
            r.contractRenewalAt >= range.from &&
            r.contractRenewalAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-renewal`,
                type: 'vendor-renewal',
                category: 'vendor',
                title: `Contract renewal: ${r.name}`,
                entityName: r.name,
                date: r.contractRenewalAt.toISOString(),
                status: classifyStatus(
                    r.contractRenewalAt,
                    now,
                    isOffboarded,
                ),
                entityType: 'VENDOR',
                entityId: r.id,
                // Land on the contract/renewal field so this is a distinct
                // destination from the vendor-review event (which lands on the
                // overview root). The field carries `id="vendor-contract-renewal"`.
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.id}?tab=overview#vendor-contract-renewal`,
                ),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
    }
    return { events, capped };
}

async function loadVendorDocumentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.vendorDocument.findMany({
        where: {
            tenantId: ctx.tenantId,
            validTo: { not: null, gte: range.from, lte: range.to },
            // The soft-delete extension injects `deletedAt: null` into the
            // TOP-LEVEL where only — it never descends into a relation. This
            // model has no `deletedAt` of its own (correctly: it is not
            // independently deletable), and its parent's soft delete is an
            // UPDATE, so the schema's `onDelete: Cascade` never fires either.
            // Without this predicate a deleted vendor's document expiries stay
            // on the calendar, attributed to a vendor that no longer exists.
            vendor: { deletedAt: null },
        },
        select: {
            id: true,
            type: true,
            validTo: true,
            vendorId: true,
            // A document row's only user column is `uploadedByUserId`, which
            // records who filed it, not who is accountable for renewing it.
            // Inherit the vendor's owner — the same person `vendor-review` and
            // `vendor-renewal` already route to.
            vendor: { select: { name: true, ownerUserId: true } },
        },
        orderBy: { validTo: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.validTo)
        .map((r): CalendarEvent => {
            const date = r.validTo as Date;
            return {
                id: `VENDOR_DOCUMENT:${r.id}:vendor-document-expiry`,
                type: 'vendor-document-expiry',
                category: 'vendor',
                title: `${r.type} expires: ${r.vendor.name}`,
                entityName: r.vendor.name,
                detail: r.type,
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'VENDOR_DOCUMENT',
                entityId: r.id,
                // Land on the Documents tab, not the vendor root — the
                // expiring document is what the user came for.
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.vendorId}?tab=documents`,
                ),
                ownerUserId: r.vendor.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

async function loadAuditCycleEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    // AuditCycle is the only duration source today: emits an event with
    // `start` (periodStartAt) and `end` (periodEndAt). Either bound
    // intersecting the queried range surfaces the cycle.
    const select = {
        id: true,
        name: true,
        frameworkKey: true,
        periodStartAt: true,
        periodEndAt: true,
        status: true,
        // A cycle has no owner column; `createdByUserId` (non-null) is the
        // audit lead who scheduled it, and is what `calendar-deadlines.ts`
        // already routes cycle reminders to.
        createdByUserId: true,
    } as const;
    // Cycles are ranges intersecting the window three ways: starting in it,
    // ending in it, or straddling it entirely. Query each and union so a
    // cap keeps the nearest of each kind — a single `orderBy [start, end]`
    // would drop end-in-range/straddling cycles (NULL/earlier start sorts
    // them last) even when they are the soonest to matter.
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        periodStartAt: { gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { periodStartAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        periodEndAt: { gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { periodEndAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        // Already running: began before the window and ends after it.
                        periodStartAt: { lte: range.from },
                        periodEndAt: { gte: range.to },
                    },
                    select,
                    orderBy: { periodStartAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events = rows
        .filter((r) => r.periodStartAt || r.periodEndAt)
        .map((r): CalendarEvent => {
            const start = r.periodStartAt ?? r.periodEndAt!;
            const end =
                r.periodEndAt && r.periodStartAt && r.periodEndAt !== r.periodStartAt
                    ? r.periodEndAt
                    : undefined;
            const isDone = r.status === 'COMPLETE';
            return {
                id: `AUDIT_CYCLE:${r.id}:audit-cycle`,
                type: 'audit-cycle',
                category: 'audit',
                title: `Audit cycle: ${r.name}`,
                entityName: r.name,
                date: start.toISOString(),
                end: end?.toISOString(),
                status: classifyStatus(end ?? start, now, isDone),
                entityType: 'AUDIT_CYCLE',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/audits/cycles/${r.id}`),
                detail: r.frameworkKey,
                ownerUserId: r.createdByUserId,
            };
        });
    return { events, capped };
}

async function loadControlEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.control.findMany({
        where: {
            tenantId: ctx.tenantId,
            // Shared with `deadline-monitor.ts::scanControls` so the two
            // surfaces cannot drift on WHICH rows carry a test deadline,
            // having already drifted on how they judge them.
            ...CONTROL_TEST_ELIGIBILITY,
            nextDueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            nextDueAt: true,
            // `status` is deliberately NOT selected: it used to drive `isDone`
            // here, which is the defect `control-test-due.ts` exists to state.
            ownerUserId: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextDueAt)
        .map((r): CalendarEvent => {
            const date = r.nextDueAt as Date;
            return {
                id: `CONTROL:${r.id}:control-review`,
                type: 'control-review',
                category: 'control',
                title: `Control review: ${r.name}`,
                entityName: r.name,
                date: date.toISOString(),
                // `nextDueAt` is the next TEST due date, and no ControlStatus
                // satisfies it — an IMPLEMENTED control is precisely the one
                // that must be tested on cadence. This used to pass
                // `status === 'IMPLEMENTED'`, which short-circuited
                // `classifyStatus` before any date comparison and rendered a
                // lapsed test as `done` while deadline-monitor emailed the very
                // same row as overdue.
                status: classifyStatus(date, now, isControlTestSatisfied()),
                entityType: 'CONTROL',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/controls/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

async function loadTestPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    // A test plan carries TWO due clocks — `nextDueAt` (frequency-derived)
    // and `nextRunAt` (cron-derived). The scheduling-model-unify note
    // mandates `effectiveDueAt = min(nextDueAt, nextRunAt)` on every due
    // surface: the live MANUAL path advances only `nextRunAt`, so reading
    // `nextDueAt` alone renders cron-scheduled plans permanently overdue.
    // Fetch each clock's nearest-`limit` (see `fetchNearest`), then emit at
    // the effective (earliest) date if that date falls in the window.
    // One shared `select` for both sub-queries — forking it would let the two
    // clocks emit different fields for the same plan.
    const select = {
        id: true,
        name: true,
        nextDueAt: true,
        nextRunAt: true,
        controlId: true,
        ownerUserId: true,
        control: { select: { name: true } },
    } as const;
    // Shared for the same reason as `select` above — the two clocks must agree
    // on which plans exist, not just on which fields they carry. The plan's own
    // `deletedAt` is auto-injected (ControlTestPlan is in SOFT_DELETE_MODELS);
    // the parent's is not, because the extension never descends into relations.
    // Deleting a control does not touch its plans, so without this a deleted
    // control's test deadlines keep appearing.
    const baseWhere = {
        tenantId: ctx.tenantId,
        status: 'ACTIVE',
        control: { deletedAt: null },
    } as const;
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.controlTestPlan.findMany({
                    where: {
                        ...baseWhere,
                        nextDueAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextDueAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.controlTestPlan.findMany({
                    where: {
                        ...baseWhere,
                        nextRunAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextRunAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const date = effectiveDueAt(r);
        // The effective clock may be a column NOT in the window (e.g. a past
        // `nextDueAt` earlier than an in-range `nextRunAt`) — that plan is
        // overdue before the window, not due inside it, so skip it.
        if (!date || date < range.from || date > range.to) continue;
        events.push({
            id: `CONTROL_TEST_PLAN:${r.id}:control-test-due`,
            type: 'control-test-due',
            category: 'control',
            title: `Test due: ${r.name}`,
            entityName: r.name,
            date: date.toISOString(),
            status: classifyStatus(date, now, false),
            entityType: 'CONTROL_TEST_PLAN',
            entityId: r.id,
            href: tenantHrefFromCtx(ctx, `/controls/${r.controlId}/tests/${r.id}`),
            detail: r.control.name,
            ownerUserId: r.ownerUserId ?? undefined,
        });
    }
    return { events, capped };
}

async function loadTaskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.task.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueAt: true,
            status: true,
            assigneeUserId: true,
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            // The imported constant, not a third copy of the same three
            // strings. This file already imports it and uses it correctly 240
            // lines below; a hand-written twin drifts silently — add a
            // terminal status to the enum and this list keeps calling those
            // tasks open, on the surface that reports what is due.
            const isDone = (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(
                r.status,
            );
            return {
                id: `TASK:${r.id}:task-due`,
                type: 'task-due',
                category: 'task',
                title: `Task due: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TASK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/tasks/${r.id}`),
                ownerUserId: r.assigneeUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

async function loadRiskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const select = {
        id: true,
        title: true,
        nextReviewAt: true,
        targetDate: true,
        status: true,
        ownerUserId: true,
    } as const;
    // Two date columns — fetch each column's nearest-`limit` and union so a
    // risk whose only in-range date is the mitigation target isn't truncated
    // behind risks with a review date (see `fetchNearest`).
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.risk.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        nextReviewAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextReviewAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.risk.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        targetDate: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { targetDate: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isClosed = r.status === 'CLOSED' || r.status === 'ACCEPTED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-review`,
                type: 'risk-review',
                category: 'risk',
                title: `Risk review: ${r.title}`,
                entityName: r.title,
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
        if (
            r.targetDate &&
            r.targetDate >= range.from &&
            r.targetDate <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-target`,
                type: 'risk-target',
                category: 'risk',
                title: `Risk mitigation target: ${r.title}`,
                entityName: r.title,
                date: r.targetDate.toISOString(),
                status: classifyStatus(r.targetDate, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                // The mitigation target lives on the assessment tab (where the
                // treatment strategy + target date are shown), NOT the overview
                // where risk-review lands — deep-link so the four risk event
                // types don't all collapse to the same destination.
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}?tab=assessment`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
    }
    return { events, capped };
}

async function loadFindingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.finding.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            status: true,
            // `assigneeUserId`, NOT the legacy free-text `owner`. See the emit
            // below — this selected `owner` and published it as `ownerUserId`.
            assigneeUserId: true,
        },
        orderBy: { dueDate: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueDate)
        .map((r): CalendarEvent => {
            const date = r.dueDate as Date;
            const isDone = r.status === 'CLOSED';
            return {
                id: `FINDING:${r.id}:finding-due`,
                type: 'finding-due',
                category: 'finding',
                title: `Finding due: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'FINDING',
                entityId: r.id,
                // Findings have no `/findings/[id]` detail route — land on the
                // findings list rather than a 404.
                href: tenantHrefFromCtx(ctx, `/findings`),
                // `Finding.owner` is a legacy free-text NAME — the schema says
                // so in the comment directly above `assigneeUserId`, which
                // supersedes it. Publishing it as `ownerUserId` meant a value
                // that can never equal a cuid, so "My deadlines" matched no
                // finding for anyone, including its actual assignee.
                //
                // Deliberately no `?? r.owner` fallback: a NAME in this field
                // is strictly worse than absence. Absent, the digest routes the
                // item to tenant admins; a name resolves to no user and the
                // item is dropped as unroutable.
                ownerUserId: r.assigneeUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
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
                    // Cast through readonly → mutable WorkItemStatus[]
                    // because Prisma's `notIn` rejects the `as const`
                    // literal type, and the shared ACTIVE_STATUS_FILTER
                    // constant types its payload as `string[]` which
                    // Prisma's newer generated client also rejects.
                    notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[],
                },
            },
            take: MAX_BADGE_COUNT + 1,
        }),
    );

    return Math.min(MAX_BADGE_COUNT + 1, tasks);
}

// ─── Epic G-7 — treatment plan + milestone calendar loaders ─────────

/**
 * Each non-completed milestone contributes one calendar event keyed
 * by its `dueDate`. Completed milestones surface with status `done`
 * so the heatmap can show "this was on the calendar; here's the
 * receipt". Click-through lands on the parent risk's detail page,
 * scrolled to the treatment-plan card section.
 */
async function loadTreatmentMilestoneEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.treatmentMilestone.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueDate: { gte: range.from, lte: range.to },
            // Skip milestones whose parent plan was soft-deleted, AND those
            // whose grandparent risk was. The plan predicate alone was a
            // half-filter: a milestone's click-through lands on
            // `/risks/{riskId}`, so a live plan under a deleted risk produced a
            // calendar entry pointing at a page the user cannot open.
            //
            // (Note this filters DELETION only, not the risk's status — a
            // milestone under a live plan still surfaces for an open risk in
            // any state, which is the original intent.)
            treatmentPlan: { deletedAt: null, risk: { deletedAt: null } },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            completedAt: true,
            sortOrder: true,
            treatmentPlan: {
                select: {
                    id: true,
                    riskId: true,
                    // A milestone has no owner column of its own (only
                    // `completedByUserId`, which is a receipt, not an
                    // assignment). It inherits the plan's owner — the person
                    // accountable for the treatment the milestone belongs to.
                    ownerUserId: true,
                    risk: { select: { title: true } },
                },
            },
        },
        orderBy: { dueDate: 'asc' },
        take: limit,
    });
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const riskId = r.treatmentPlan?.riskId;
        // A milestone whose plan lost its risk link would emit a bare
        // `/risks/` href — a list-page URL masquerading as a deep link.
        // Omit it rather than ship a misleading click target.
        if (!riskId) continue;
        const date = r.dueDate;
        const isDone = r.completedAt !== null;
        const riskTitle = r.treatmentPlan?.risk?.title ?? 'Risk';
        events.push({
            id: `TREATMENT_MILESTONE:${r.id}:treatment-milestone-due`,
            type: 'treatment-milestone-due',
            category: 'risk',
            title: `Milestone: ${r.title}`,
            entityName: r.title,
            date: date.toISOString(),
            status: classifyStatus(date, now, isDone),
            entityType: 'TREATMENT_MILESTONE',
            entityId: r.id,
            // Land on the risk's treatment-plan (assessment tab), not the
            // overview root — a milestone is a treatment-plan artefact.
            href: tenantHrefFromCtx(ctx, `/risks/${riskId}?tab=assessment`),
            detail: riskTitle,
            ownerUserId: r.treatmentPlan?.ownerUserId,
        });
    }
    return sourceResult(events, rows.length, limit);
}

/**
 * Treatment plans contribute one event per non-completed plan keyed
 * by `targetDate` so the calendar shows the plan-level deadline next
 * to its constituent milestone deadlines.
 */
async function loadTreatmentPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.riskTreatmentPlan.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            // The plan outlives a soft-deleted risk; without this its target
            // date keeps surfacing under a risk nobody can open.
            risk: { deletedAt: null },
            status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
            targetDate: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            riskId: true,
            strategy: true,
            targetDate: true,
            // NON-NULL on this model — every plan has an accountable owner.
            ownerUserId: true,
            risk: { select: { title: true } },
        },
        orderBy: { targetDate: 'asc' },
        take: limit,
    });
    const events = rows.map((r): CalendarEvent => {
        const date = r.targetDate;
        return {
            id: `RISK_TREATMENT_PLAN:${r.id}:treatment-plan-target`,
            type: 'treatment-plan-target',
            category: 'risk',
            title: `Plan target: ${r.risk?.title ?? 'Risk'}`,
            entityName: r.risk?.title ?? 'Risk',
            date: date.toISOString(),
            status: classifyStatus(date, now, false),
            entityType: 'RISK_TREATMENT_PLAN',
            entityId: r.id,
            // The plan target belongs on the assessment tab (treatment plan),
            // distinct from the risk-review destination.
            href: tenantHrefFromCtx(ctx, `/risks/${r.riskId}?tab=assessment`),
            detail: `${r.strategy} strategy`,
            ownerUserId: r.ownerUserId,
        };
    });
    return sourceResult(events, rows.length, limit);
}

// ─── Deadline sources that already had reminder jobs but no calendar ──
//
// Each of these entities drives a reminder/escalation job, so the platform
// already treated its date as a deadline — the calendar just wasn't
// showing it. Same contract as every loader above: tenant-scoped, ordered
// ascending by the date column, capped, reporting its own truncation.

/**
 * Access-review recertification deadlines (`AccessReview.dueAt`). Backed
 * by `access-review-reminder` + `access-review-overdue-escalation`.
 * A CLOSED review is done; soft-deleted reviews are excluded.
 */
async function loadAccessReviewEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.accessReview.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            dueAt: true,
            status: true,
            reviewerUserId: true,
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            return {
                id: `ACCESS_REVIEW:${r.id}:access-review-due`,
                type: 'access-review-due',
                category: 'audit',
                title: `Access review: ${r.name}`,
                entityName: r.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, r.status === 'CLOSED'),
                entityType: 'ACCESS_REVIEW',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/access-reviews/${r.id}`),
                ownerUserId: r.reviewerUserId,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Training assignment due dates (`TrainingAssignment.dueAt`). COMPLETED
 * assignments surface as `done` (the receipt), everything else carries the
 * live deadline.
 */
async function loadTrainingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.trainingAssignment.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            dueAt: true,
            status: true,
            completedAt: true,
            course: { select: { name: true } },
            employee: { select: { fullName: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            const isDone = r.status === 'COMPLETED' || r.completedAt !== null;
            return {
                id: `TRAINING_ASSIGNMENT:${r.id}:training-due`,
                type: 'training-due',
                category: 'task',
                title: `Training due: ${r.course.name}`,
                entityName: r.course.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TRAINING_ASSIGNMENT',
                entityId: r.id,
                // Training lives under /admin/training — there is no top-level
                // /training route (this href used to 404).
                href: tenantHrefFromCtx(ctx, `/admin/training`),
                // Employee is an HR record, not a platform User (no userId
                // on the model), so there is no ownerUserId to route
                // notifications by — the assignee shows as detail copy.
                detail: r.employee.fullName,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Incident-notification SLA deadlines (`IncidentNotification.dueAt`) —
 * the NIS2 Art.23 early-warning / full-notification clock, already driven
 * by the `incident-notification-deadlines` job. SUBMITTED and
 * NOT_REQUIRED are terminal, so they render as `done`.
 *
 * `dueAt` is non-null on this model, so there is no null guard.
 */
async function loadIncidentNotificationEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.incidentNotification.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            kind: true,
            dueAt: true,
            status: true,
            incidentId: true,
            // A notification row carries no user column at all. It inherits the
            // incident's commander — the person accountable for the incident
            // whose regulatory clock this is.
            incident: { select: { title: true, ownerUserId: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows.map((r): CalendarEvent => {
        const isDone = r.status === 'SUBMITTED' || r.status === 'NOT_REQUIRED';
        return {
            id: `INCIDENT_NOTIFICATION:${r.id}:incident-notification-due`,
            type: 'incident-notification-due',
            category: 'finding',
            title: `Incident notification (${r.kind}): ${r.incident.title}`,
            entityName: r.incident.title,
            date: r.dueAt.toISOString(),
            status: classifyStatus(r.dueAt, now, isDone),
            entityType: 'INCIDENT_NOTIFICATION',
            entityId: r.id,
            // Deep-link to the specific Art.23 notification obligation on the
            // incident overview (each notification carries a matching anchor id),
            // not the incident root — the calendar is advertising the
            // notification deadline, so the page should surface it.
            href: tenantHrefFromCtx(
                ctx,
                `/incidents/${r.incidentId}#incident-notification-${r.id}`,
            ),
            ownerUserId: r.incident.ownerUserId ?? undefined,
        };
    });
    return sourceResult(events, rows.length, limit);
}

/**
 * Control-exception expiry (`ControlException.expiresAt`) — when an
 * accepted exception lapses the control snaps back to non-compliant, so
 * the expiry is a real deadline. Backed by `exception-expiry-monitor`.
 * Only APPROVED exceptions have a live clock; REQUESTED/REJECTED aren't
 * in force and EXPIRED has already lapsed.
 */
async function loadControlExceptionEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.controlException.findMany({
        where: {
            tenantId: ctx.tenantId,
            // Hand-written because ControlException is NOT in
            // SOFT_DELETE_MODELS despite having the column…
            deletedAt: null,
            // …and this one is needed because the extension would not have
            // reached it even if it were: relations are never filtered.
            // A deleted control's exceptions are not deleted with it.
            control: { deletedAt: null },
            status: 'APPROVED',
            expiresAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            expiresAt: true,
            controlId: true,
            // `riskAcceptedByUserId` (non-null) rather than `createdByUserId`
            // or the parent control's owner: it names whoever accepted the risk
            // this exception carries, and it is the PRIMARY recipient
            // `exception-expiry-monitor` already emails about this same date.
            // The calendar and the reminder now agree on whose deadline it is.
            riskAcceptedByUserId: true,
            control: { select: { name: true } },
        },
        orderBy: { expiresAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.expiresAt)
        .map((r): CalendarEvent => {
            const date = r.expiresAt as Date;
            return {
                id: `CONTROL_EXCEPTION:${r.id}:control-exception-expiry`,
                type: 'control-exception-expiry',
                category: 'control',
                title: `Exception expires: ${r.control.name}`,
                entityName: r.control.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'CONTROL_EXCEPTION',
                entityId: r.id,
                // Anchor to the exceptions panel on the control overview
                // (default tab) so an expiring exception lands on the exception,
                // not a control root that shows no sign of it.
                href: tenantHrefFromCtx(ctx, `/controls/${r.controlId}#control-exceptions`),
                ownerUserId: r.riskAcceptedByUserId,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Vendor reassessment dates (`VendorAssessment.nextReviewAt`) — distinct
 * from `Vendor.nextReviewAt` (the vendor-level review): this is the date
 * a specific completed assessment falls due for redoing. CLOSED
 * assessments are done.
 */
async function loadVendorAssessmentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.vendorAssessment.findMany({
        where: {
            tenantId: ctx.tenantId,
            nextReviewAt: { not: null, gte: range.from, lte: range.to },
            // See `loadVendorDocumentEvents`: nested relations are outside the
            // soft-delete extension's reach, and this model has no `deletedAt`.
            vendor: { deletedAt: null },
        },
        select: {
            id: true,
            nextReviewAt: true,
            status: true,
            vendorId: true,
            // The assessment's own user columns are workflow receipts
            // (requestedBy / sentBy / reviewedBy / decidedBy / closedBy).
            // Accountability for redoing it sits with the vendor's owner.
            vendor: { select: { name: true, ownerUserId: true } },
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewAt)
        .map((r): CalendarEvent => {
            const date = r.nextReviewAt as Date;
            return {
                id: `VENDOR_ASSESSMENT:${r.id}:vendor-assessment-review`,
                type: 'vendor-assessment-review',
                category: 'vendor',
                title: `Vendor reassessment: ${r.vendor.name}`,
                entityName: r.vendor.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, r.status === 'CLOSED'),
                entityType: 'VENDOR_ASSESSMENT',
                entityId: r.id,
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.vendorId}?tab=assessments`,
                ),
                ownerUserId: r.vendor.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}
