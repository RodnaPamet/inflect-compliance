/**
 * The calendar push fan-out: a cron dispatcher, and a per-TENANT child.
 *
 * ═══ WHY TWO JOBS, AND WHY THE CHILD IS PER-TENANT NOT PER-USER ═══
 *
 * The obvious shape is one job per connection, copying `identity-sync`. Three
 * facts say otherwise, and the first is mechanical rather than aesthetic.
 *
 * 1. `JOB_DEFAULTS` IS INERT ON THE CRON PATH. `registerSchedules` calls
 *    `upsertJobScheduler(name, repeatOpts, { name, data })` with no `opts`, and
 *    BullMQ merges `Object.assign({}, this.jobsOpts, jobTemplate?.opts)` — so a
 *    directly-scheduled job runs the queue default (`attempts: 3`, exponential)
 *    whatever its JOB_DEFAULTS entry says. All 29 scheduled jobs are in that
 *    state today. `enqueue()` DOES apply the entry.
 *
 *    So work that touches Google or Graph must arrive as an ENQUEUED CHILD, or
 *    it silently gets three attempts against a rate-limited provider. That
 *    alone forces two job names. (Filed separately as the general defect.)
 *
 * 2. THE PER-TENANT SHAPE IS WHAT THE INDEX WAS BUILT FOR.
 *    `UserCalendarConnection` carries `@@index([tenantId, provider, revokedAt])`
 *    and the index ratchet's written justification says, in as many words, "the
 *    push fan-out's (tenantId, provider, revokedAt) scan". A global
 *    `identity-sync`-style drain has no tenantId predicate, leaves the leading
 *    column unconstrained, and makes that recorded reason false.
 *
 * 3. `runUserPushGuarded` EXISTS ONLY TO ISOLATE ONE USER INSIDE A BATCH. If
 *    every user were their own BullMQ job the queue would provide that
 *    isolation and the function would be dead weight. The shipped code already
 *    assumes an in-process per-user loop, so the job shape should match what
 *    was designed rather than the reverse.
 *
 * ═══ WHY THIS IS NOT THE ServiceNow S3 DECLINE ═══
 *
 * S3 was closed by REFUSING to add a dispatcher, because `automation-runner`
 * already dispatched the work. That rationale draws its line at providers which
 * materialise remote rows keyed on a connection — and the calendar push does
 * exactly that, into `UserCalendarEventMapping` keyed on
 * `UserCalendarConnection`. It sits on the identity-sync side of the line, and
 * no existing runner has a (tenant, user) unit of work: of 29 scheduled jobs,
 * none carries a userId as its fan-out key.
 *
 * @module jobs/calendar-push
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import type { CalendarPushDispatchPayload, CalendarPushTenantPayload } from './types';

/** Tenants visited per dispatch. Bounded like every other fan-out here. */
const MAX_TENANTS = 5000;

/**
 * Cross-tenant fan-out: one per-tenant push per tenant with a live connection.
 *
 * `distinct` on tenantId rather than a Tenant scan, because the population is
 * "tenants where somebody actually connected a calendar", which is a small
 * fraction of tenants and stays that way. Scanning every tenant would enqueue a
 * job per tenant to discover it has no connections.
 */
export async function runCalendarPushDispatch(_payload: CalendarPushDispatchPayload) {
    const rows = await prisma.userCalendarConnection.findMany({
        where: { revokedAt: null },
        select: { tenantId: true },
        distinct: ['tenantId'],
        take: MAX_TENANTS,
    });

    const { dispatched, failed } = await fanOut(
        rows,
        'calendar-push',
        ({ tenantId }) => ({ tenantId }),
        ({ tenantId }) =>
            enqueue(
                'calendar-push-tenant',
                { tenantId },
                // Deterministic per (tenant, UTC day): a re-run of the
                // dispatcher inside the same bucket is a no-op rather than a
                // second pass over everyone's calendar.
                { jobId: dispatchJobId('calendar-push-tenant', tenantId, DAILY_BUCKET_MS) },
            ),
    );

    logger.info('calendar-push-dispatch complete', {
        component: 'calendar-push',
        tenants: rows.length,
        dispatched,
        failed,
    });

    // `fanOut` never throws — it isolates per item and reports counts — so the
    // caller decides what a total failure means. All-failed is a real outage
    // (Redis down); some-failed is one tenant's problem and the next run
    // retries it.
    if (failed > 0 && dispatched === 0) {
        throw new Error(`calendar-push-dispatch: all ${failed} enqueues failed`);
    }
    return { tenants: rows.length, dispatched, failed };
}

/**
 * One tenant's push. Visits its connected users IN PROCESS.
 *
 * The per-user loop lives here rather than in the queue because
 * `runUserPushGuarded` already provides the isolation a per-user job would buy,
 * and because one BullMQ job per employee across every tenant is a queue-depth
 * problem with no compensating benefit.
 *
 * NOTE this is currently a bounded enumeration and nothing more. The actual
 * push needs a provider WRITER — the Google / Graph client — which is C2, and
 * C2 is blocked on an unresolved consent-model decision. Wiring the loop to a
 * writer that does not exist would mean either a stub that silently no-ops in
 * production or a fake that makes the job look tested when it is not. So the
 * job is registered, scheduled and enumerating, and the writer is the one
 * remaining seam.
 */
export async function runCalendarPushTenant(payload: CalendarPushTenantPayload) {
    if (!payload.tenantId) throw new Error('calendar-push-tenant requires tenantId');

    const connections = await prisma.userCalendarConnection.findMany({
        // Exactly the shape the recorded index justification describes.
        where: { tenantId: payload.tenantId, revokedAt: null },
        select: { id: true, userId: true, provider: true },
        orderBy: { id: 'asc' },
        take: 10_000,
    });

    logger.info('calendar-push-tenant enumerated', {
        component: 'calendar-push',
        tenantId: payload.tenantId,
        connections: connections.length,
    });

    return { tenantId: payload.tenantId, connections: connections.length, pushed: 0 };
}
