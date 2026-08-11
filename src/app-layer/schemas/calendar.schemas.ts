/**
 * Epic 49 — Compliance Calendar schemas + DTOs.
 *
 * Defines the unified CalendarEvent DTO that powers the heatmap,
 * monthly grid, and Gantt timeline; plus the Zod query schema for the
 * `GET /api/t/[tenantSlug]/calendar` route.
 *
 * Design principles:
 *
 *   1. ONE event shape for many views. Heatmap counts events per day,
 *      Month renders dots per day with click-through, Gantt projects
 *      events with a `start..end` window. The same DTO serves all.
 *
 *   2. Sources are pre-existing entities (no new tables). Each entity
 *      contributes a date field; the usecase normalises them all into
 *      this shape.
 *
 *   3. Click-through is encoded as `href` (tenant-relative). The UI
 *      doesn't need to know how to build URLs per entity type.
 *
 *   4. `category` drives color/icon — UI-stable enum; never echo a raw
 *      Prisma status enum here.
 */

import { z } from 'zod';

// ─── Event categories ────────────────────────────────────────────────

/**
 * High-level category that drives icon + dot color in the UI. Each
 * category corresponds to a domain area; the UI maps category → color
 * via a single token table (avoids per-entity-type styling drift).
 */
export const CALENDAR_EVENT_CATEGORIES = [
    'evidence',
    'policy',
    'vendor',
    'audit',
    'control',
    'task',
    'risk',
    'finding',
] as const;

export type CalendarEventCategory =
    (typeof CALENDAR_EVENT_CATEGORIES)[number];

/**
 * Specific event type — finer-grained than category. Powers tooltip
 * copy ("Vendor renewal", "Policy review", …). Each maps to exactly
 * one category; many events of different types may share a category.
 *
 * Category is the COLOUR/grouping axis, not the identity axis — the
 * palette has four status tones and eight categories already consume
 * them, so the sources added later reuse the nearest existing category
 * rather than inventing a category with no distinct token:
 *
 *   - `access-review-due`        → `audit`   (recertification is an
 *                                             attestation activity)
 *   - `training-due`             → `task`    (an assignment with an
 *                                             owner and a due date)
 *   - `incident-notification-due`→ `finding` (something went wrong and
 *                                             a clock is running on the
 *                                             response — the NIS2 Art.23
 *                                             regulatory notification SLA)
 *
 * The `type` stays distinct in every case, so filters and tooltip copy
 * can still address these precisely.
 */
export const CALENDAR_EVENT_TYPES = [
    // evidence
    //
    // NOTE: there is deliberately no `evidence-expiry` type. It existed
    // here for a long time with no loader ever emitting it — a filter
    // value that always returned zero events. `Evidence.expiredAt` is
    // stamped by the retention job AT the moment of expiry, so it is a
    // past-tense receipt, not a forward deadline; `nextReviewDate` is the
    // deadline and it ships as `evidence-review`.
    'evidence-review',
    // policy
    'policy-review',
    // vendor
    'vendor-review',
    'vendor-renewal',
    'vendor-document-expiry',
    'vendor-assessment-review',
    // audit
    'audit-cycle',
    'access-review-due',
    // control
    'control-review',
    'control-test-due',
    'control-exception-expiry',
    // personnel
    'training-due',
    // incident
    'incident-notification-due',
    // task
    'task-due',
    // risk
    'risk-review',
    'risk-target',
    // Epic G-7 — treatment plans + milestones live under the risk
    // category but get their own type so the tooltip + colour can
    // distinguish them from review/target events on the parent risk.
    'treatment-milestone-due',
    'treatment-plan-target',
    // finding
    'finding-due',
] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

/**
 * Status drives whether the event renders in muted (`done`),
 * neutral (`scheduled`), warning (`upcoming`/`due_soon`), or danger
 * (`overdue`) styling. `unknown` is for events whose linked entity
 * doesn't carry a clear status semantic.
 */
export const CALENDAR_EVENT_STATUSES = [
    'scheduled',
    'due_soon',
    'overdue',
    'done',
    'unknown',
] as const;

export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

// ─── Public DTO ──────────────────────────────────────────────────────

/**
 * One unified compliance-calendar event. Every event is either a
 * point-in-time (`date`) or a duration (`start` + `end`). Renderers
 * can branch on the presence of `end` to decide between dot vs bar.
 */
export interface CalendarEvent {
    /** Stable composite id: `${entityType}:${entityId}:${type}`. */
    id: string;
    type: CalendarEventType;
    category: CalendarEventCategory;
    /**
     * Server-composed English title (`"Evidence review: X"`). Retained for
     * back-compat + as the client's fallback; the UI prefers to recompose the
     * display title from `type` + `entityName` through next-intl so labels are
     * translatable. See `@/lib/calendar-labels`.
     */
    title: string;
    /**
     * The bare entity noun the title is built around (evidence title, vendor
     * name, risk title, …) — the translatable-title input. Absent only on
     * events from a cached pre-migration response.
     */
    entityName?: string;
    /**
     * Point-in-time date for events without a duration. ISO 8601 date
     * string (UTC midnight) for day-resolution events; ISO datetime is
     * accepted but truncated to day in the UI.
     */
    date: string;
    /** End date for duration events (Gantt). When set, `date` is the start. */
    end?: string;
    status: CalendarEventStatus;
    /** Source entity classification (drives detail navigation). */
    entityType:
        | 'EVIDENCE'
        | 'POLICY'
        | 'VENDOR'
        | 'VENDOR_DOCUMENT'
        | 'VENDOR_ASSESSMENT'
        | 'AUDIT_CYCLE'
        | 'ACCESS_REVIEW'
        | 'CONTROL'
        | 'CONTROL_TEST_PLAN'
        | 'CONTROL_EXCEPTION'
        | 'TRAINING_ASSIGNMENT'
        | 'INCIDENT_NOTIFICATION'
        | 'TASK'
        | 'RISK'
        | 'RISK_TREATMENT_PLAN'
        | 'TREATMENT_MILESTONE'
        | 'FINDING';
    entityId: string;
    /**
     * Tenant-relative href for click-through. The route handler builds
     * these with the resolved `tenantSlug`; UI consumers do NOT
     * concatenate slugs themselves.
     */
    href: string;
    /** Optional extra context for tooltips (assignee, framework, …). */
    detail?: string;
    /**
     * Optional owner user id — the accountable person for this deadline.
     *
     * Consumed by the "My deadlines" filter. It does NOT feed the deadline
     * monitor's notification routing, despite what this comment used to say:
     * `jobs/calendar-deadlines.ts` and `jobs/deadline-monitor.ts` build their
     * own `DueItem.ownerUserId` from independent queries and never import this
     * usecase. Widening a loader here cannot change who gets emailed.
     *
     * Sixteen of the seventeen sources populate this. Where an entity has no
     * user column of its own it inherits its parent's owner (a vendor document
     * from its vendor, an incident notification from its incident, a treatment
     * milestone from its plan). The exception is listed below.
     */
    ownerUserId?: string;
}

/**
 * Sources that structurally cannot carry an owner, so "My deadlines" can say
 * so instead of silently hiding them.
 *
 * `training` is the only one: a `TrainingAssignment` belongs to an `Employee`,
 * and the Employee model has no link to a platform `User` — only `workEmail`.
 * There is no id to compare against the viewer's, and inventing one by matching
 * on email would be a guess presented as an assignment.
 *
 * If an Employee↔User link is ever added, delete this entry and the notice it
 * drives — do not extend the list to paper over a loader that simply forgot to
 * select its owner column, which is the bug this list was born from.
 */
export const SOURCES_WITHOUT_OWNER = ['training'] as const;

// ─── Zod schemas ─────────────────────────────────────────────────────

/**
 * Accepted `from`/`to` forms. A bare day (`YYYY-MM-DD`) is a UTC calendar
 * day; a full datetime MUST carry an explicit timezone (`Z` or `±HH:MM`).
 * A no-timezone datetime like `2026-01-15T00:00:00` is REJECTED — `new
 * Date()` parses it in the server's LOCAL zone, so the same string would
 * mean different instants on different hosts.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Normalize a `from`/`to` string into a concrete instant. The day form is
 * anchored in UTC: `from` at the START of the day (00:00:00.000Z) and `to`
 * at the END of the day (23:59:59.999Z) so an INCLUSIVE `lte: to` covers the
 * whole `to` day — a bare `to=YYYY-MM-DD` at UTC midnight would otherwise
 * drop every event later than 00:00 on that day. Returns `null` for an
 * unparseable / timezone-ambiguous string.
 */
export function normalizeCalendarBound(
    value: string,
    edge: 'start' | 'end',
): Date | null {
    if (DAY_RE.test(value)) {
        return new Date(
            `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`,
        );
    }
    if (ISO_DT_RE.test(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/**
 * Query string for `GET /calendar`. Range is required so the API never
 * scans unbounded date ranges. `from`/`to` are accepted as either YYYY-MM-DD
 * (UTC calendar day) or a timezone-qualified ISO datetime. The parsed,
 * normalized instants are exposed as `fromDate` / `toDate` so the route
 * never re-parses (and never re-introduces the local-timezone ambiguity).
 */
export const CalendarQuerySchema = z
    .object({
        from: z.string().min(8, 'from is required (YYYY-MM-DD or ISO date)'),
        to: z.string().min(8, 'to is required (YYYY-MM-DD or ISO date)'),
        types: z
            .preprocess(
                (v) => (typeof v === 'string' ? v.split(',') : v),
                z.array(z.enum(CALENDAR_EVENT_TYPES)),
            )
            .optional(),
        categories: z
            .preprocess(
                (v) => (typeof v === 'string' ? v.split(',') : v),
                z.array(z.enum(CALENDAR_EVENT_CATEGORIES)),
            )
            .optional(),
    })
    .superRefine((data, ctx) => {
        const from = normalizeCalendarBound(data.from, 'start');
        const to = normalizeCalendarBound(data.to, 'end');
        if (from === null) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['from'],
                message:
                    'from must be YYYY-MM-DD or a timezone-qualified ISO datetime',
            });
        }
        if (to === null) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message:
                    'to must be YYYY-MM-DD or a timezone-qualified ISO datetime',
            });
        }
        if (from !== null && to !== null && to.getTime() < from.getTime()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: 'to must be on or after from',
            });
        }
        // Hard cap: 2 years. Keeps the aggregation bounded — heatmap
        // typically asks for 12 months, Gantt for 6 months. Anyone
        // asking for more is probably making a mistake.
        const MAX_RANGE_MS = 366 * 2 * 86_400_000;
        if (
            from !== null &&
            to !== null &&
            to.getTime() - from.getTime() > MAX_RANGE_MS
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['to'],
                message: 'date range exceeds 2-year cap',
            });
        }
    })
    .transform((data) => ({
        ...data,
        // Non-null after superRefine (it fails the parse on unparseable input).
        fromDate: normalizeCalendarBound(data.from, 'start') as Date,
        toDate: normalizeCalendarBound(data.to, 'end') as Date,
    }));

export type CalendarQueryInput = z.infer<typeof CalendarQuerySchema>;

/**
 * Response payload — `events` plus a small summary that the heatmap
 * pre-aggregates client-side, but the API surface includes counts so
 * a low-bandwidth client (e.g., mobile widget) doesn't need every event.
 */
/**
 * Names of the per-source loaders, as reported by `truncation.sources`.
 * Stable strings — the UI shows them when it explains what was hidden.
 */
export const CALENDAR_SOURCE_NAMES = [
    'evidence',
    'policy',
    'vendor',
    'vendor-document',
    'vendor-assessment',
    'audit-cycle',
    'control',
    'control-test-plan',
    'control-exception',
    'access-review',
    'training',
    'incident-notification',
    'task',
    'risk',
    'finding',
    'treatment-milestone',
    'treatment-plan',
] as const;

export type CalendarSourceName = (typeof CALENDAR_SOURCE_NAMES)[number];

export interface CalendarResponse {
    events: CalendarEvent[];
    counts: {
        total: number;
        byCategory: Record<CalendarEventCategory, number>;
        byStatus: Record<CalendarEventStatus, number>;
        /**
         * True when at least one source hit its per-source cap, so these
         * totals count only what survived truncation. The UI must not
         * present a partial count as authoritative.
         */
        partial: boolean;
    };
    /**
     * Truncation report. Each source is capped at `perSourceLimit` and
     * ordered ascending by its date column, so what survives a cap is the
     * NEAREST N deadlines — but the ones past the cap are still real, and
     * the UI is expected to say so rather than silently drop them.
     */
    truncation: {
        capped: boolean;
        sources: CalendarSourceName[];
        perSourceLimit: number;
        /** Hard cap on the total serialized event count. */
        totalCap: number;
        /** True when the total cap trimmed the furthest-out events. */
        totalCapped: boolean;
    };
    /**
     * Sources the caller lacks permission to see, hidden from the result.
     * The UI shows "some sources hidden by your permissions" rather than
     * presenting a permission-filtered result as the complete picture.
     */
    omittedSources: CalendarSourceName[];
    range: {
        from: string;
        to: string;
    };
}
