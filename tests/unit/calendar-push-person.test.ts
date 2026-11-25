/**
 * One person's calendar, end to end, over an in-memory database (#5937 step 2):
 * the nightly push (per-person cap, removals first, rotated token persisted
 * BEFORE use), the nightly retry of a disconnect, and the disconnect itself
 * (events removed FIRST, token dropped AFTER).
 *
 * The real store, sweep and reconciler run; only the database, the provider
 * writer and the generation are fakes. The integration suite
 * `tests/integration/calendar-push-writer.test.ts` runs the same path on a real
 * database under RLS.
 */
const logEvent = jest.fn(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

import {
    pushOneConnection,
    disconnectCalendar,
    PUSH_ACTIONS_PER_PERSON_PER_RUN,
    DISCONNECT_RETRY_DAYS,
    DISCONNECTED_REASON,
    DISCONNECTED_WITH_REMAINDER_REASON,
} from '@/app-layer/usecases/calendar-push-person';
import type { CalendarWriter } from '@/app-layer/usecases/calendar-reconcile-sweep';
import type { PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';
import type { CalendarTenantRun } from '@/app-layer/usecases/user-calendar-connection';
import { IntegrationAuthError, IntegrationRateLimitedError } from '@/app-layer/integrations/http-resilience';
import { makeRequestContext } from '../helpers/make-context';

const TENANT = 't1';
const USER = 'u1';
const NOW = new Date('2026-11-25T03:00:00.000Z');
const FRESH = { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(NOW.getTime() / 1000) + 3600 };

type Row = Record<string, unknown>;

/** Just enough of Prisma for the push path, with a log of every write. */
function memoryDb(connection: Row | null) {
    const writes: string[] = [];
    const mappings: Row[] = [];
    const conn = connection ? { ...connection } : null;
    const matches = (row: Row, where: Row): boolean =>
        Object.entries(where).every(([k, v]): boolean => {
            if (k === 'NOT') return !matches(row, v as Row);
            return row[k] === v;
        });
    const db = {
        userCalendarConnection: {
            findUnique: async () => (conn ? { ...conn } : null),
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                if (!conn || !matches(conn, where)) return { count: 0 };
                Object.assign(conn, data);
                writes.push(`connection:${Object.keys(data).sort().join(',')}`);
                return { count: 1 };
            },
        },
        tenantCalendarConsent: { findUnique: async () => ({ externalTenantId: 'entra-dir-1' }) },
        tenant: { findUnique: async () => ({ defaultLocale: 'bg' }) },
        userCalendarEventMapping: {
            findMany: async ({ where }: { where: Row }) => mappings.filter((m) => matches(m, where)).map((m) => ({ ...m })),
            count: async ({ where }: { where: Row }) => mappings.filter((m) => matches(m, where)).length,
            upsert: async ({ where, create, update }: { where: { tenantId_userId_provider_sourceKey_sourceEntityId: Row }; create: Row; update: Row }) => {
                const key = where.tenantId_userId_provider_sourceKey_sourceEntityId;
                const found = mappings.find((m) => matches(m, key));
                if (found) Object.assign(found, update);
                else mappings.push({ ...create });
                writes.push('mapping:upsert');
            },
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                mappings.filter((m) => matches(m, where)).forEach((m) => Object.assign(m, data));
                writes.push(`mapping:${String(data.state)}`);
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const i = mappings.findIndex((m) => matches(m, where));
                if (i >= 0) mappings.splice(i, 1);
                writes.push('mapping:drop');
            },
        },
    };
    const run: CalendarTenantRun = (cb) => cb(db as never);
    return { db, run, conn: () => conn, mappings, writes };
}

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => currentDb.run(cb as never),
    runInTenantJobContext: (_job: unknown, cb: (db: unknown) => unknown) => currentDb.run(cb as never),
}));
let currentDb: ReturnType<typeof memoryDb>;

function connection(over: Row = {}): Row {
    return {
        id: 'conn-1', tenantId: TENANT, userId: USER, provider: 'google-calendar',
        tokenEncrypted: JSON.stringify(FRESH), revokedAt: null, disconnectRequestedAt: null, ...over,
    };
}

/** A calendar that really holds events, and records the order of calls. */
function fakeWriter(log: string[], opts: { failRemove?: Set<string>; throwOnRemove?: Error } = {}) {
    const events = new Set<string>();
    const writer: CalendarWriter = {
        async insert({ clientEventId }) {
            log.push(`insert:${clientEventId.slice(0, 6)}`);
            events.add(clientEventId);
            return { remoteEventId: clientEventId };
        },
        async patch({ remoteEventId }) {
            log.push(`patch:${remoteEventId.slice(0, 6)}`);
        },
        async remove({ remoteEventId }) {
            if (opts.throwOnRemove) throw opts.throwOnRemove;
            if (opts.failRemove?.has(remoteEventId)) throw new Error('remove failed');
            log.push(`remove:${remoteEventId.slice(0, 6)}`);
            events.delete(remoteEventId);
        },
    };
    return { writer, events };
}

const event = (i: number): PushableEvent => ({
    sourceKey: 'task-due',
    sourceEntityId: `task-${String(i).padStart(3, '0')}`,
    title: `Task ${i}`,
    startsAt: '2026-12-01T00:00:00.000Z',
    endsAt: null,
    description: null,
});
const generated = (events: PushableEvent[]) =>
    jest.fn(async () => ({ kind: 'generated' as const, events, omittedSources: [] }));

const identity = { tenantId: TENANT, userId: USER, provider: 'google-calendar' as const };
const OPTS = { locale: 'bg' as const, publicOrigin: 'https://app.example.test' };

beforeEach(() => jest.clearAllMocks());

describe('the nightly push', () => {
    it('makes at most PUSH_ACTIONS_PER_PERSON_PER_RUN provider calls, and the next run carries on', async () => {
        currentDb = memoryDb(connection());
        const log: string[] = [];
        const { writer, events } = fakeWriter(log);
        const desired = Array.from({ length: PUSH_ACTIONS_PER_PERSON_PER_RUN + 10 }, (_, i) => event(i));
        const deps = { writerFor: () => writer, generate: generated(desired) as never, now: () => NOW };

        const first = await pushOneConnection(currentDb.run, identity, OPTS, deps);
        expect(first).toMatchObject({ kind: 'pushed', inserted: PUSH_ACTIONS_PER_PERSON_PER_RUN, deferred: 10 });
        expect(log).toHaveLength(PUSH_ACTIONS_PER_PERSON_PER_RUN);

        const second = await pushOneConnection(currentDb.run, identity, OPTS, deps);
        expect(second).toMatchObject({ kind: 'pushed', inserted: 10, deferred: 0 });
        expect(events.size).toBe(PUSH_ACTIONS_PER_PERSON_PER_RUN + 10);
        expect(currentDb.mappings).toHaveLength(PUSH_ACTIONS_PER_PERSON_PER_RUN + 10);

        // An unchanged calendar makes no provider call at all.
        log.length = 0;
        const third = await pushOneConnection(currentDb.run, identity, OPTS, deps);
        expect(third).toMatchObject({ kind: 'pushed', changed: false });
        expect(log).toEqual([]);
    });

    it('the cap never holds a REMOVAL behind a backlog of new deadlines', async () => {
        currentDb = memoryDb(connection());
        const log: string[] = [];
        const { writer } = fakeWriter(log);
        // One event pushed earlier, which the person may no longer see…
        await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => writer, generate: generated([event(999)]) as never, now: () => NOW,
        });
        log.length = 0;
        // …and a backlog larger than the cap arriving the same night.
        const backlog = Array.from({ length: PUSH_ACTIONS_PER_PERSON_PER_RUN + 5 }, (_, i) => event(i));
        await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => writer, generate: generated(backlog) as never, now: () => NOW,
        });
        expect(log[0]).toMatch(/^remove:/);
    });

    it('passes the workspace language and the public origin to the generation', async () => {
        currentDb = memoryDb(connection());
        const generate = generated([]);
        await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => fakeWriter([]).writer, generate: generate as never, now: () => NOW,
        });
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: TENANT, userId: USER, locale: 'bg', publicOrigin: 'https://app.example.test' }),
            expect.anything(),
        );
    });

    it('stamps lastPushedAt', async () => {
        currentDb = memoryDb(connection());
        await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => fakeWriter([]).writer, generate: generated([]) as never, now: () => NOW,
        });
        expect(currentDb.conn()?.lastPushedAt).toEqual(NOW);
    });

    it('a revoked connection is skipped, and nothing is written', async () => {
        currentDb = memoryDb(connection({ revokedAt: NOW }));
        const out = await pushOneConnection(currentDb.run, identity, OPTS, { writerFor: () => fakeWriter([]).writer });
        expect(out).toEqual({ kind: 'skipped' });
        expect(currentDb.writes).toEqual([]);
    });

    it('an expired token is refreshed and PERSISTED before the writer uses it', async () => {
        const expired = { ...FRESH, expiresAt: Math.floor(NOW.getTime() / 1000) - 10 };
        currentDb = memoryDb(connection({ provider: 'outlook-calendar', tokenEncrypted: JSON.stringify(expired) }));
        const order: string[] = [];
        const refresh = jest.fn(async (_p: string, rt: string) => {
            order.push(`refresh:${rt}`);
            return { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: expired.expiresAt + 7200 };
        });
        const writerFor = (_p: string, tokens: { current(): Promise<string> }) => ({
            async insert() {
                const token = await tokens.current();
                order.push(`stored:${JSON.parse(String(currentDb.conn()?.tokenEncrypted)).refreshToken}`);
                order.push(`insert-with:${token}`);
                return { remoteEventId: 'r1' };
            },
            async patch() {},
            async remove() {},
        });
        await pushOneConnection(currentDb.run, { ...identity, provider: 'outlook-calendar' }, OPTS, {
            writerFor: writerFor as never, refresh, generate: generated([event(1)]) as never, now: () => NOW,
        });
        // Microsoft rotates the refresh token: the new one is on disk before
        // the access token is used.
        expect(order).toEqual(['refresh:rt', 'stored:rt-2', 'insert-with:at-2']);
    });
});

describe('disconnect — events FIRST, token AFTER', () => {
    async function pushed(n: number, provider: 'google-calendar' | 'outlook-calendar' = 'google-calendar') {
        currentDb = memoryDb(connection({ provider }));
        const { writer } = fakeWriter([]);
        await pushOneConnection(currentDb.run, { ...identity, provider }, OPTS, {
            writerFor: () => writer,
            generate: generated(Array.from({ length: n }, (_, i) => event(i))) as never,
            now: () => NOW,
        });
        currentDb.writes.length = 0;
    }
    const ctx = makeRequestContext('EDITOR', { tenantId: TENANT, userId: USER });

    it('removes every pushed event, THEN destroys the token, THEN revokes at Google', async () => {
        await pushed(3);
        const log: string[] = [];
        const { writer } = fakeWriter(log);
        const revokeGoogle = jest.fn(async (rt: string) => {
            log.push(`google-revoke:${rt}`);
            log.push(`token-at-revoke:${String(currentDb.conn()?.tokenEncrypted)}`);
            return 'revoked' as const;
        });
        const out = await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => writer, revokeGoogle, now: () => NOW });

        expect(out).toEqual({ status: 'disconnected', removed: 3 });
        expect(log.slice(0, 3).every((l) => l.startsWith('remove:'))).toBe(true);
        // The local token was already gone when Google was asked.
        expect(log.slice(3)).toEqual(['google-revoke:rt', 'token-at-revoke:']);
        expect(currentDb.conn()).toMatchObject({ tokenEncrypted: '', revokedReason: DISCONNECTED_REASON });
        expect(currentDb.mappings).toHaveLength(0);
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({ action: 'CALENDAR_DISCONNECTED', metadata: expect.objectContaining({ outcome: 'disconnected', removed: 3 }) }),
        );
    });

    it('Microsoft has no per-token revocation: the token is destroyed and nothing else is called', async () => {
        await pushed(1, 'outlook-calendar');
        const revokeGoogle = jest.fn();
        await disconnectCalendar(ctx, 'outlook-calendar', { writerFor: () => fakeWriter([]).writer, revokeGoogle, now: () => NOW });
        expect(revokeGoogle).not.toHaveBeenCalled();
        expect(currentDb.conn()?.tokenEncrypted).toBe('');
    });

    it('when a removal fails the connection KEEPS its token and is marked disconnecting', async () => {
        await pushed(2);
        const failing = String(currentDb.mappings[0].remoteEventId);
        const { writer } = fakeWriter([], { failRemove: new Set([failing]) });
        const revokeGoogle = jest.fn();
        const out = await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => writer, revokeGoogle, now: () => NOW });

        expect(out).toEqual({ status: 'disconnecting', removed: 1, remaining: 1 });
        expect(currentDb.conn()).toMatchObject({ revokedAt: null, disconnectRequestedAt: NOW });
        expect(JSON.parse(String(currentDb.conn()?.tokenEncrypted))).toEqual(FRESH);
        expect(currentDb.mappings).toEqual([expect.objectContaining({ remoteEventId: failing, state: 'PENDING_DELETE' })]);
        expect(revokeGoogle).not.toHaveBeenCalled();
    });

    it('a throttle mid-disconnect also keeps the token for the nightly run', async () => {
        await pushed(2);
        const { writer } = fakeWriter([], { throwOnRemove: new IntegrationRateLimitedError('https://x', 60_000, 429) });
        const out = await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => writer, now: () => NOW });
        expect(out).toEqual({ status: 'disconnecting', removed: 0, remaining: 2 });
        expect(currentDb.conn()?.revokedAt).toBeNull();
    });

    it('a REFUSED token can remove nothing: the connection ends at once and the events stay recorded', async () => {
        await pushed(2);
        const { writer } = fakeWriter([], { throwOnRemove: new IntegrationAuthError(401, 'https://x') });
        const out = await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => writer, now: () => NOW });
        expect(out).toEqual({ status: 'disconnected', removed: 0 });
        expect(currentDb.conn()).toMatchObject({ tokenEncrypted: '', revokedReason: DISCONNECTED_WITH_REMAINDER_REASON });
        expect(currentDb.mappings).toHaveLength(2);
    });

    it('the nightly run retries ONLY the removals, then finishes the disconnect', async () => {
        await pushed(2);
        const failing = String(currentDb.mappings[0].remoteEventId);
        await disconnectCalendar(ctx, 'google-calendar', {
            writerFor: () => fakeWriter([], { failRemove: new Set([failing]) }).writer, now: () => NOW,
        });

        const log: string[] = [];
        const generate = jest.fn();
        const revokeGoogle = jest.fn(async () => 'revoked' as const);
        const out = await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => fakeWriter(log).writer, generate: generate as never, revokeGoogle,
            now: () => new Date(NOW.getTime() + 86_400_000),
        });
        expect(generate).not.toHaveBeenCalled();
        expect(log).toEqual([`remove:${failing.slice(0, 6)}`]);
        expect(out).toMatchObject({ kind: 'disconnect', finished: true, remaining: 0 });
        expect(currentDb.conn()).toMatchObject({ tokenEncrypted: '', revokedReason: DISCONNECTED_REASON, disconnectRequestedAt: null });
        expect(revokeGoogle).toHaveBeenCalledWith('rt');
    });

    it(`after ${DISCONNECT_RETRY_DAYS} days the token is dropped anyway, and what is left stays recorded`, async () => {
        await pushed(1);
        const stuck = String(currentDb.mappings[0].remoteEventId);
        const failRemove = new Set([stuck]);
        await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => fakeWriter([], { failRemove }).writer, now: () => NOW });

        const later = new Date(NOW.getTime() + DISCONNECT_RETRY_DAYS * 86_400_000);
        const out = await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => fakeWriter([], { failRemove }).writer, revokeGoogle: jest.fn(async () => 'revoked' as const), now: () => later,
        });
        expect(out).toMatchObject({ kind: 'disconnect', finished: true, remaining: 1 });
        expect(currentDb.conn()).toMatchObject({ tokenEncrypted: '', revokedReason: DISCONNECTED_WITH_REMAINDER_REASON });
        expect(currentDb.mappings).toEqual([expect.objectContaining({ remoteEventId: stuck, state: 'PENDING_DELETE' })]);
    });

    it('inside the window a failing removal leaves the connection disconnecting for another night', async () => {
        await pushed(1);
        const failRemove = new Set([String(currentDb.mappings[0].remoteEventId)]);
        await disconnectCalendar(ctx, 'google-calendar', { writerFor: () => fakeWriter([], { failRemove }).writer, now: () => NOW });
        const out = await pushOneConnection(currentDb.run, identity, OPTS, {
            writerFor: () => fakeWriter([], { failRemove }).writer, now: () => new Date(NOW.getTime() + 86_400_000),
        });
        expect(out).toMatchObject({ kind: 'disconnect', finished: false, remaining: 1 });
        expect(currentDb.conn()?.revokedAt).toBeNull();
    });
});
