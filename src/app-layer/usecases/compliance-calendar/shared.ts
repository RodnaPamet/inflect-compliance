/**
 * Shared types, caps and date helpers for the calendar aggregation.
 *
 * Extracted when `compliance-calendar.ts` was split — the loaders need these
 * and the entry point needs the loaders, so leaving them in `index.ts` would
 * be a cycle. Nothing here is behaviour: it is the same code, in the one place
 * both sides can reach.
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
import { hasPermission, type PermissionKey } from '@/lib/security/permission-middleware';
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


export interface CalendarSourceResult {
    events: CalendarEvent[];
    capped: boolean;
}

/**
 * Wrap a loader's mapped events with the truncation signal. `rowCount` is
 * the number of DB ROWS (not events) — a source like Vendor emits two
 * events per row, so events.length is not the right thing to compare.
 */
export function sourceResult(
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
export async function fetchNearest<Row extends { id: string }>(
    queries: ReadonlyArray<() => Promise<Row[]>>,
    limit: number,
): Promise<{ rows: Row[]; capped: boolean }> {
    const parts = await Promise.all(queries.map((q) => q()));
    const byId = new Map<string, Row>();
    for (const part of parts) for (const r of part) byId.set(r.id, r);
    return { rows: [...byId.values()], capped: parts.some((p) => p.length >= limit) };
}

/** Hard cap on the total serialized event count (see {@link GetCalendarEventsInput.totalCap}). */
export const DEFAULT_TOTAL_CAP = 5000;
/**
 * How many source loaders run concurrently. Each loader now runs in its
 * OWN read-only transaction (its own pooled connection), so this bounds
 * peak connection pressure per calendar request while still fanning out —
 * a single interactive transaction pins ONE connection and serialises,
 * which is the bug this replaces.
 */
export const SOURCE_CONCURRENCY = 6;
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
export const PER_SOURCE_TIMEOUT_MS = 8_000;

/** A calendar source loader's call signature. */

export type CalendarLoader = (
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
export interface CalendarSourceDef {
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

// ─── Helpers ─────────────────────────────────────────────────────────

export interface DateRange {
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
export const CIVIL_DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
export function civilDayFormatter(tz: string): Intl.DateTimeFormat {
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
export function civilDayInTz(d: Date, tz: string): number {
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
export function utcDayOf(d: Date): number {
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
export function civilDayForNow(now: Date, tz: string): number {
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
export function daysUntilInTz(target: Date, now: Date, tz: string): number {
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
export function classifyStatus(
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

export function tenantHrefFromCtx(ctx: RequestContext, path: string): string {
    // Usecases don't know the slug, only the tenantId. The route handler
    // resolves slug; we leave a `/t/{slug}` placeholder that the route
    // handler rewrites. Keeping it server-side stops every UI from
    // re-implementing the same prefix.
    if (!ctx.tenantSlug) return path;
    return `/t/${ctx.tenantSlug}${path.startsWith('/') ? path : `/${path}`}`;
}

export function countSummaries(events: CalendarEvent[]) {
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

