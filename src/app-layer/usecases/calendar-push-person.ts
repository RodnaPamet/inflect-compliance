/**
 * One person's calendar, end to end: the nightly push, the nightly retry of an
 * unfinished disconnect, and the disconnect itself (#5937 step 2).
 *
 * The pieces already existed and are not rebuilt here: what to push is
 * `generatePushableEvents` (the calendar's own aggregation, under the person's
 * live membership), what to change is `reconcileCalendarEvents`, applying it is
 * `sweepUserCalendar`, and stopping a connection whose consent is gone is
 * `runUserPushGuarded`. This module supplies what they were waiting for: a
 * token, a provider writer and a database-backed mapping store.
 *
 * ═══ THE TOKEN ═══
 *
 * Read under a NON-bypass tenant context (`calendarJobRun` in the job,
 * `calendarRequestRun` on a disconnect), because the token column is sealed
 * under the workspace's DEK and a bypass label would hand back ciphertext. It
 * is refreshed through `resolveCalendarAccessToken`, which PERSISTS a rotated
 * token before it is used — Microsoft invalidates the refresh token it
 * replaces, so a crash after the refresh must not lose the new one.
 *
 * ═══ DISCONNECT: EVENTS FIRST, TOKEN AFTER ═══
 *
 * The pushed events are removed while there is still a token to reach them,
 * and only then is the token destroyed. Reversed, they would be stranded in the
 * person's calendar with nothing left to remove them. When some removals do
 * not succeed — a provider outage, a throttle, more events than one request
 * removes — the connection is marked as disconnecting and KEEPS its token; the
 * nightly run retries only the removals, and revokes when they are done or
 * after `DISCONNECT_RETRY_DAYS`, whichever is first. What could not be removed
 * stays recorded in the mapping table, and the connection read reports how
 * many (`undeletedEventCount`).
 *
 * @module usecases/calendar-push-person
 */
import type { RequestContext } from '../types';
import { logger } from '@/lib/observability/logger';
import { logEvent } from '../events/audit';
import type { Locale } from '@/lib/locale-constants';
import {
    resolveCalendarAccessToken,
    revokeGoogleCalendarToken,
} from '../integrations/providers/calendar/token';
import type { CalendarAccessTokens, CalendarHttpDeps } from '../integrations/providers/calendar/calendar-http';
import { createGoogleCalendarWriter } from '../integrations/providers/calendar/google-writer';
import { createGraphCalendarWriter } from '../integrations/providers/calendar/graph-writer';
import { IntegrationAuthError, IntegrationRateLimitedError } from '../integrations/http-resilience';
import { sweepUserCalendar, removeAllPushedEvents, type CalendarWriter } from './calendar-reconcile-sweep';
import { createPrismaMappingStore } from './calendar-mapping-store';
import type { generatePushableEvents } from './calendar-push-generate';
import {
    calendarRequestRun,
    markCalendarDisconnecting,
    persistCalendarTokenForPush,
    readCalendarConnectionForPush,
    revokeCalendarConnection,
    revokeCalendarConnectionForPush,
    stampCalendarPushed,
    type CalendarConnectionIdentity,
    type CalendarProviderId,
    type CalendarTenantRun,
    type CalendarTokenPayload,
} from './user-calendar-connection';

/**
 * Provider calls one person's connection may make in one run. Writes for a
 * person are sequential, so this bounds a run's time per person as well as its
 * share of the provider's quota: a first push of a long backlog spreads over
 * several nights. Removals go first (`applyActions`), so the cap never holds a
 * removal behind new deadlines.
 */
export const PUSH_ACTIONS_PER_PERSON_PER_RUN = 50;

/**
 * Removals one disconnect REQUEST attempts before handing the rest to the
 * nightly run. The person is waiting on the answer; the nightly run is not.
 */
export const DISCONNECT_INLINE_REMOVALS = 25;

/**
 * Days a disconnect keeps its token while removals fail. After this the token
 * is destroyed anyway: a disconnect the person asked for must end, and an
 * event that has failed to delete for a week will not succeed on day eight.
 */
export const DISCONNECT_RETRY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The revoke reasons the settings surface shows. Fixed phrases, never a provider body. */
export const DISCONNECTED_REASON = 'disconnected by user';
export const DISCONNECTED_WITH_REMAINDER_REASON =
    'disconnected by user; some events could not be removed from the calendar';

/** Test seams for the provider writers. Production passes none. */
export interface CalendarPushDeps {
    http?: CalendarHttpDeps;
    /** Replace the provider writer outright (unit tests of the orchestration). */
    writerFor?: (provider: CalendarProviderId, tokens: CalendarAccessTokens) => CalendarWriter;
    refresh?: (provider: CalendarProviderId, refreshToken: string) => Promise<CalendarTokenPayload>;
    revokeGoogle?: typeof revokeGoogleCalendarToken;
    /** Replace the generation (unit tests; production runs the real aggregation). */
    generate?: typeof generatePushableEvents;
    now?: () => Date;
}

/** The provider writer for a connection. */
export function buildCalendarWriter(
    provider: CalendarProviderId,
    tokens: CalendarAccessTokens,
    deps: CalendarPushDeps = {},
): CalendarWriter {
    if (deps.writerFor) return deps.writerFor(provider, tokens);
    return provider === 'google-calendar'
        ? createGoogleCalendarWriter({ tokens, deps: deps.http })
        : createGraphCalendarWriter({ tokens, deps: deps.http });
}

/**
 * The token a writer uses: valid now, refreshed when inside the skew, and
 * refreshed on demand after a 401. Every rotation is persisted BEFORE the new
 * token is handed out, and the supplier keeps the newest pair so a run that
 * refreshes twice never refreshes from a token the provider has retired.
 */
export function calendarAccessTokens(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    initial: CalendarTokenPayload,
    entraTenantId: string | undefined,
    deps: CalendarPushDeps = {},
): CalendarAccessTokens {
    let token = initial;
    const resolve = async (current: CalendarTokenPayload) => {
        const { accessToken, rotated } = await resolveCalendarAccessToken(
            current,
            { provider: identity.provider, entraTenantId },
            {
                refresh: deps.refresh ? (rt) => deps.refresh!(identity.provider, rt) : undefined,
                persist: async (next) => {
                    await persistCalendarTokenForPush(run, identity, next);
                    token = next;
                },
            },
        );
        if (rotated) token = rotated;
        return accessToken;
    };
    return {
        current: () => resolve(token),
        // An expiry in the past forces the refresh, whatever was recorded.
        refresh: () => resolve({ ...token, expiresAt: 0 }),
    };
}

/** What a person's nightly run did. */
export type PersonPushResult =
    | { kind: 'skipped' }
    | {
          kind: 'pushed';
          changed: boolean;
          inserted: number;
          patched: number;
          deleted: number;
          deferred: number;
          failures: number;
      }
    | { kind: 'disconnect'; changed: boolean; deleted: number; remaining: number; finished: boolean };

/**
 * One connection's nightly run, under the job's tenant context.
 *
 * Throws what the sweep throws for the CONNECTION (a refused token, a
 * throttle); the caller wraps it in `runUserPushGuarded`, which turns those
 * into a revoked or throttled outcome and keeps one person's failure out of
 * everybody else's run.
 */
export async function pushOneConnection(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    opts: { locale: Locale; publicOrigin: string | null },
    deps: CalendarPushDeps = {},
): Promise<PersonPushResult> {
    const now = deps.now ?? (() => new Date());
    const conn = await readCalendarConnectionForPush(run, identity);
    if (!conn) return { kind: 'skipped' };

    const tokens = calendarAccessTokens(run, identity, conn.token, conn.entraTenantId, deps);
    const writer = buildCalendarWriter(identity.provider, tokens, deps);
    const store = createPrismaMappingStore(run, identity, now);

    if (conn.disconnectRequestedAt) {
        return continueDisconnect(run, identity, {
            store,
            writer,
            // Google's refresh token does not rotate, and only Google's is
            // revoked at the provider.
            refreshToken: conn.token.refreshToken,
            requestedAt: conn.disconnectRequestedAt,
            now: now(),
            deps,
        });
    }

    const result = await sweepUserCalendar(
        { ...identity, locale: opts.locale, publicOrigin: opts.publicOrigin },
        { store, writer, now, maxActions: PUSH_ACTIONS_PER_PERSON_PER_RUN, generate: deps.generate },
    );
    await stampCalendarPushed(run, identity, now());
    return {
        kind: 'pushed',
        changed: result.changed,
        inserted: result.inserted,
        patched: result.patched,
        deleted: result.deleted,
        deferred: result.deferred,
        failures: result.pushFailures + result.deleteFailures,
    };
}

/** The nightly retry of a disconnect: removals only, then the token goes. */
async function continueDisconnect(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    args: {
        store: ReturnType<typeof createPrismaMappingStore>;
        writer: CalendarWriter;
        refreshToken: string;
        requestedAt: Date;
        now: Date;
        deps: CalendarPushDeps;
    },
): Promise<PersonPushResult> {
    const expired = args.now.getTime() - args.requestedAt.getTime() >= DISCONNECT_RETRY_DAYS * DAY_MS;
    let removal = { deleted: 0, remaining: 0 };
    try {
        removal = await removeAllPushedEvents({
            store: args.store,
            writer: args.writer,
            maxActions: PUSH_ACTIONS_PER_PERSON_PER_RUN,
        });
    } catch (err) {
        // A throttle or a refused token: the window decides. Inside it, try
        // again tomorrow (a refused token still revokes, via the guard).
        if (!expired) throw err;
        removal = { deleted: 0, remaining: -1 };
    }
    const finished = removal.remaining === 0;
    if (finished || expired) {
        await revokeCalendarConnectionForPush(
            run,
            identity,
            finished ? DISCONNECTED_REASON : DISCONNECTED_WITH_REMAINDER_REASON,
        );
        await revokeAtProvider(identity, args.refreshToken, args.deps);
        logger.info('calendar disconnect finished', {
            component: 'calendar-push',
            tenantId: identity.tenantId,
            provider: identity.provider,
            outcome: finished ? 'all-removed' : 'window-closed',
        });
    }
    return {
        kind: 'disconnect',
        changed: removal.deleted > 0 || finished || expired,
        deleted: removal.deleted,
        remaining: Math.max(0, removal.remaining),
        finished: finished || expired,
    };
}

/** Google only; Microsoft has no per-token revocation for a delegated grant. */
async function revokeAtProvider(
    identity: CalendarConnectionIdentity,
    refreshToken: string,
    deps: CalendarPushDeps,
): Promise<void> {
    if (identity.provider !== 'google-calendar') return;
    const outcome = await (deps.revokeGoogle ?? revokeGoogleCalendarToken)(refreshToken);
    logger.info('calendar token revoked at the provider', {
        component: 'calendar-push',
        tenantId: identity.tenantId,
        provider: identity.provider,
        outcome,
    });
}

/** What a disconnect request answered. */
export type CalendarDisconnectResult =
    | { status: 'disconnected'; removed: number }
    | { status: 'disconnecting'; removed: number; remaining: number };

/**
 * A person disconnects their calendar.
 *
 * Removes the pushed events FIRST (up to `DISCONNECT_INLINE_REMOVALS` in the
 * request), and destroys the token only when none is left. Otherwise the
 * connection is marked as disconnecting and the nightly run finishes the job.
 * A refused token cannot remove anything, so it ends the connection at once
 * and the events stay recorded as not removed. Audited either way.
 */
export async function disconnectCalendar(
    ctx: RequestContext,
    provider: CalendarProviderId,
    deps: CalendarPushDeps = {},
): Promise<CalendarDisconnectResult> {
    const now = deps.now ?? (() => new Date());
    const run = calendarRequestRun(ctx);
    const identity: CalendarConnectionIdentity = { tenantId: ctx.tenantId, userId: ctx.userId, provider };

    const conn = await readCalendarConnectionForPush(run, identity);
    if (!conn) {
        // Already revoked (nothing can be removed without a token), or never
        // connected — the latter is the usecase's 404.
        await revokeCalendarConnection(ctx, provider, DISCONNECTED_REASON);
        await auditDisconnect(ctx, provider, { outcome: 'disconnected', removed: 0, remaining: 0 });
        return { status: 'disconnected', removed: 0 };
    }

    const tokens = calendarAccessTokens(run, identity, conn.token, conn.entraTenantId, deps);
    const writer = buildCalendarWriter(provider, tokens, deps);
    const store = createPrismaMappingStore(run, identity, now);

    let removed = 0;
    let remaining: number;
    try {
        const r = await removeAllPushedEvents({ store, writer, maxActions: DISCONNECT_INLINE_REMOVALS });
        removed = r.deleted;
        remaining = r.remaining;
    } catch (err) {
        if (err instanceof IntegrationAuthError) {
            // The token is refused: nothing can be removed with it, now or
            // later. End the connection; the events stay recorded.
            await revokeCalendarConnection(ctx, provider, DISCONNECTED_WITH_REMAINDER_REASON);
            await auditDisconnect(ctx, provider, { outcome: 'token-refused', removed: 0, remaining: -1 });
            return { status: 'disconnected', removed: 0 };
        }
        if (!(err instanceof IntegrationRateLimitedError)) throw err;
        remaining = -1;
    }

    if (remaining === 0) {
        await revokeCalendarConnection(ctx, provider, DISCONNECTED_REASON);
        await revokeAtProvider(identity, conn.token.refreshToken, deps);
        await auditDisconnect(ctx, provider, { outcome: 'disconnected', removed, remaining: 0 });
        return { status: 'disconnected', removed };
    }

    await markCalendarDisconnecting(run, identity, now());
    const left = remaining < 0 ? await countRecorded(run, identity) : remaining;
    await auditDisconnect(ctx, provider, { outcome: 'disconnecting', removed, remaining: left });
    return { status: 'disconnecting', removed, remaining: left };
}

async function countRecorded(run: CalendarTenantRun, identity: CalendarConnectionIdentity): Promise<number> {
    return run((db) =>
        db.userCalendarEventMapping.count({
            where: {
                tenantId: identity.tenantId,
                userId: identity.userId,
                provider: identity.provider,
                NOT: { remoteEventId: '' },
            },
        }),
    );
}

async function auditDisconnect(
    ctx: RequestContext,
    provider: CalendarProviderId,
    detail: { outcome: 'disconnected' | 'disconnecting' | 'token-refused'; removed: number; remaining: number },
): Promise<void> {
    await calendarRequestRun(ctx)(async (db) => {
        await logEvent(db, ctx, {
            action: 'CALENDAR_DISCONNECTED',
            entityType: 'User',
            entityId: ctx.userId,
            details: `Personal calendar disconnect (${provider}: ${detail.outcome})`,
            detailsJson: {
                category: 'access',
                operation: 'revoke',
                summary: `Personal calendar disconnect (${provider}: ${detail.outcome})`,
            },
            // Counts only: never a token, an event id or an event's title.
            metadata: { provider, outcome: detail.outcome, removed: detail.removed, remaining: detail.remaining },
        });
    });
}
