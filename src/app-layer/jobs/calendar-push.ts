/**
 * The calendar push fan-out: a cron dispatcher, and a per-TENANT child.
 *
 * ═══ WHY TWO JOBS, AND WHY THE CHILD IS PER-TENANT NOT PER-USER ═══
 *
 * The obvious shape is one job per connection, copying `identity-sync`. Three
 * facts say otherwise, and the first is mechanical rather than aesthetic.
 *
 * 1. (HISTORICAL — FIXED.) `JOB_DEFAULTS` used to be INERT on the cron path:
 *    `registerSchedules` called `upsertJobScheduler(name, repeatOpts,
 *    { name, data })` with no `opts`, and BullMQ merges
 *    `Object.assign({}, this.jobsOpts, jobTemplate?.opts)` — so a
 *    directly-scheduled job ran the queue default (`attempts: 3`, exponential)
 *    whatever its entry said, while `enqueue()` applied the entry.
 *
 *    That asymmetry was the ORIGINAL first reason for two job names: work
 *    touching Google or Graph had to arrive as an enqueued child or it
 *    silently got three attempts against a rate-limited provider.
 *
 *    `registerSchedules` now passes `opts`, so this reason is GONE. It is kept
 *    here rather than deleted because the shape it produced is still the one in
 *    the code, and a reader comparing this job to `identity-sync` deserves to
 *    know which of its justifications are live. Reasons 2 and 3 are, and they
 *    are sufficient on their own.
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
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { readWorkspaceLocale } from '@/lib/i18n/workspace-text';
import { runUserPushGuarded, type PushOutcome } from '../usecases/calendar-consent-health';
import { pushOneConnection, type CalendarPushDeps } from '../usecases/calendar-push-person';
import {
    calendarJobRun,
    isCalendarProviderId,
    type CalendarConnectionIdentity,
} from '../usecases/user-calendar-connection';
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
 * One tenant's push. Visits its connected users IN PROCESS, one at a time.
 *
 * The per-user loop lives here rather than in the queue because
 * `runUserPushGuarded` already provides the isolation a per-user job would buy,
 * and because one BullMQ job per employee across every tenant is a queue-depth
 * problem with no compensating benefit.
 *
 * For each live connection (docs/calendar-push-design.md, "Wiring"):
 *
 *   1. the token is read under `runInTenantJobContext` with the job's OWN
 *      source (`calendar-push`), so the workspace's DEK resolves — under a
 *      bypass label the read would be refused rather than parse ciphertext;
 *   2. the provider's writer is built over it;
 *   3. `sweepUserCalendar` reconciles the person's own deadlines against the
 *      `UserCalendarEventMapping` rows, at most
 *      `PUSH_ACTIONS_PER_PERSON_PER_RUN` provider calls, removals first;
 *   4. `lastPushedAt` is stamped.
 *
 * A connection the person asked to disconnect, whose removals did not all
 * succeed, gets only the removals retried (`pushOneConnection`).
 *
 * People are visited SEQUENTIALLY, and so are each person's writes: Graph
 * allows four concurrent requests per mailbox, Google a per-user-per-minute
 * quota, and a nightly job has no reason to race either. A refused token stops
 * that person's connection (revoked, once); a throttle stops that person's run
 * for tonight and the next run resumes from the mapping table; anything else
 * is counted `failed`. None of them stops the next person.
 */
export async function runCalendarPushTenant(
    payload: CalendarPushTenantPayload,
    deps: CalendarPushDeps & { push?: typeof pushOneConnection } = {},
) {
    if (!payload.tenantId) throw new Error('calendar-push-tenant requires tenantId');
    const tenantId = payload.tenantId;

    const connections = await prisma.userCalendarConnection.findMany({
        // Exactly the shape the recorded index justification describes.
        where: { tenantId, revokedAt: null },
        select: { id: true, userId: true, provider: true },
        orderBy: { id: 'asc' },
        take: 10_000,
    });

    const outcomes: Record<PushOutcome, number> = {
        pushed: 0,
        'nothing-to-do': 0,
        revoked: 0,
        throttled: 0,
        failed: 0,
    };
    if (connections.length === 0) {
        return { tenantId, connections: 0, pushed: 0, outcomes };
    }

    const run = calendarJobRun(tenantId);
    // Read once per tenant: every person in a workspace reads the workspace's
    // language (owner decision 2026-11-25), and a job sees no browser cookie.
    const locale = await run((db) => readWorkspaceLocale(db, tenantId));
    // The link back to the item is read OUTSIDE Inflect, so it is absolute,
    // from the deployment's configured origin — never a request header. With
    // none configured the event carries no link rather than a broken one.
    const publicOrigin = env.APP_URL?.trim() || null;
    const push = deps.push ?? pushOneConnection;

    for (const c of connections) {
        if (!isCalendarProviderId(c.provider)) continue;
        const identity: CalendarConnectionIdentity = { tenantId, userId: c.userId, provider: c.provider };
        let outcome: PushOutcome;
        try {
            outcome = await runUserPushGuarded({ tenantId, userId: c.userId }, c.provider, async () => {
                const r = await push(run, identity, { locale, publicOrigin }, deps);
                return { changed: r.kind !== 'skipped' && r.changed };
            });
        } catch (err) {
            // `runUserPushGuarded` returns rather than throws, except when
            // recording a revocation itself fails. That is still ONE person.
            logger.error('calendar push: recording an outcome failed', {
                component: 'calendar-push',
                tenantId,
                provider: c.provider,
                err: err instanceof Error ? err : new Error(String(err)),
            });
            outcome = 'failed';
        }
        outcomes[outcome] += 1;
    }

    logger.info('calendar-push-tenant complete', {
        component: 'calendar-push',
        tenantId,
        connections: connections.length,
        ...outcomes,
    });

    return { tenantId, connections: connections.length, pushed: outcomes.pushed, outcomes };
}
