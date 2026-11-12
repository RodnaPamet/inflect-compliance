/**
 * `/api/admin/agent-kill-switch` — the platform-wide stop, through its route
 * and against the real table (#5376).
 *
 * The library functions behind it are exercised by the kill-switch drill and
 * the in-flight-run suite. Nothing ran the ROUTE, and the route is where the
 * two properties an operator depends on live:
 *
 *   - the platform key gate: no key, a wrong key, or a key of the right
 *     length but the wrong value is a 401 with NOTHING written — the table is
 *     counted before and after, for every verb;
 *   - idempotency, both ways, as the route's own header comment states it: an
 *     engage while one is in force answers 200 with `alreadyInForce: true` and
 *     the existing row (201 the first time); a lift with nothing in force is
 *     200 with `lifted: false`. That includes two engages racing each other —
 *     "an operator hammering a stop button during an incident must get 'yes,
 *     it is stopped' rather than a 500".
 *
 * The table is global, so the suite clears it before and after.
 */
import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';

const KEY = 'platform-kill-route-test-key-0123456789abcdef';
const describeFn = DB_AVAILABLE ? describe : describe.skip;

type Handler = (req: NextRequest, ctx: unknown) => Promise<Response>;
type Route = { GET: Handler; POST: Handler; PATCH: Handler };

describeFn('platform kill-switch route (real DB)', () => {
    let prisma: PrismaClient;
    let route: Route;
    const savedKey = process.env.PLATFORM_ADMIN_API_KEY;

    function req(method: string, key: string | null, body?: unknown): NextRequest {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (key !== null) headers['x-platform-admin-key'] = key;
        return new NextRequest('https://app.example/api/admin/agent-kill-switch', {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }

    const call = (verb: keyof Route, key: string | null, body?: unknown) =>
        route[verb](req(verb, key, body), {});

    const ENGAGE = { reason: 'incident drill', engagedByRef: 'INC-5376' };
    const LIFT = { liftReason: 'drill over', liftedByRef: 'INC-5376' };

    function rowCount(): Promise<number> {
        return prisma.platformAgentKillSwitch.count();
    }

    beforeAll(async () => {
        // `@/env` snapshots process.env when it is first loaded, so the key
        // is set before the route (and through it `@/env`) is imported.
        // Not `jest.resetModules()`: a second Prisma engine in one worker
        // fails its queries.
        process.env.PLATFORM_ADMIN_API_KEY = KEY;
        route = (await import('@/app/api/admin/agent-kill-switch/route')) as unknown as Route;
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    beforeEach(async () => {
        await prisma.platformAgentKillSwitch.deleteMany({});
    });

    afterAll(async () => {
        await prisma.platformAgentKillSwitch.deleteMany({}).catch(() => {});
        await prisma.$disconnect();
        if (savedKey === undefined) delete process.env.PLATFORM_ADMIN_API_KEY;
        else process.env.PLATFORM_ADMIN_API_KEY = savedKey;
    });

    describe('the platform key gate', () => {
        const BAD_KEYS: Array<[string, string | null]> = [
            ['no key', null],
            ['an empty key', ''],
            ['a wrong key of a different length', 'nope'],
            ['a wrong key of the same length', KEY.slice(0, -1) + (KEY.endsWith('f') ? 'e' : 'f')],
        ];

        it.each(BAD_KEYS)('%s: engage is 401 and writes nothing', async (_n, key) => {
            const res = await call('POST', key, ENGAGE);
            expect(res.status).toBe(401);
            const text = await res.text();
            expect(text).not.toContain(KEY);
            expect(await rowCount()).toBe(0);
        });

        it.each(BAD_KEYS)('%s: lift is 401 and lifts nothing', async (_n, key) => {
            await call('POST', KEY, ENGAGE);
            const res = await call('PATCH', key, LIFT);
            expect(res.status).toBe(401);
            const rows = await prisma.platformAgentKillSwitch.findMany();
            expect(rows).toHaveLength(1);
            expect(rows[0].liftedAt).toBeNull();
        });

        it.each(BAD_KEYS)('%s: read is 401 and says nothing about the switch', async (_n, key) => {
            await call('POST', KEY, ENGAGE);
            const res = await call('GET', key);
            expect(res.status).toBe(401);
            const text = await res.text();
            expect(text).not.toContain('inForce');
            expect(text).not.toContain(ENGAGE.engagedByRef);
        });

        it('a valid key with an invalid body writes nothing', async () => {
            const res = await call('POST', KEY, { reason: '', engagedByRef: 'INC-1' });
            expect(res.status).toBe(400);
            expect(await rowCount()).toBe(0);
        });
    });

    describe('GET reflects the switch in force', () => {
        it('nothing in force, then the engaged row, then nothing after a lift', async () => {
            let res = await call('GET', KEY);
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ inForce: false, kill: null });

            const engaged = await (await call('POST', KEY, ENGAGE)).json();
            res = await call('GET', KEY);
            const body = await res.json();
            expect(body.inForce).toBe(true);
            expect(body.kill).toEqual(expect.objectContaining({
                id: engaged.id,
                reason: ENGAGE.reason,
                engagedByRef: ENGAGE.engagedByRef,
            }));

            await call('PATCH', KEY, LIFT);
            res = await call('GET', KEY);
            await expect(res.json()).resolves.toEqual({ inForce: false, kill: null });
        });
    });

    describe('idempotent both ways', () => {
        it('engage is 201 the first time, then 200 alreadyInForce with the SAME row', async () => {
            const first = await call('POST', KEY, ENGAGE);
            expect(first.status).toBe(201);
            const a = await first.json();
            expect(a.alreadyInForce).toBe(false);

            const second = await call('POST', KEY, { reason: 'again', engagedByRef: 'INC-other' });
            expect(second.status).toBe(200);
            const b = await second.json();
            expect(b).toEqual(expect.objectContaining({ id: a.id, alreadyInForce: true }));

            expect(await rowCount()).toBe(1);
            // The second engage did not rewrite who pulled it, or why. (Read
            // through the route: `reason` is encrypted at rest.)
            const read = await (await call('GET', KEY)).json();
            expect(read.kill).toEqual(expect.objectContaining({
                id: a.id,
                reason: ENGAGE.reason,
                engagedByRef: ENGAGE.engagedByRef,
            }));
        });

        it('concurrent engages: every caller is told it is stopped, and one row is in force', async () => {
            // Several rounds of many callers: the race is between the read of
            // "nothing in force" and the insert, and one round may not land in
            // it. Before #5376 the index's refusal of the losers escaped as 500.
            for (let round = 0; round < 3; round++) {
                await prisma.platformAgentKillSwitch.deleteMany({});
                const responses = await Promise.all(
                    Array.from({ length: 20 }, (_, i) =>
                        call('POST', KEY, { reason: `hammer ${i}`, engagedByRef: `INC-${round}-${i}` }),
                    ),
                );
                const statuses = responses.map((r) => r.status);
                expect(statuses.filter((s) => s === 201)).toHaveLength(1);
                expect(statuses.filter((s) => s === 200)).toHaveLength(19);

                const bodies = await Promise.all(responses.map((r) => r.json()));
                expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
                expect(bodies.filter((b) => b.alreadyInForce === false)).toHaveLength(1);
                expect(await prisma.platformAgentKillSwitch.count({ where: { liftedAt: null } })).toBe(1);
            }
        });

        it('a lift with nothing in force is 200 lifted:false; a second lift does not re-lift', async () => {
            let res = await call('PATCH', KEY, LIFT);
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ inForce: false, lifted: false, id: null });

            const { id } = await (await call('POST', KEY, ENGAGE)).json();
            res = await call('PATCH', KEY, LIFT);
            await expect(res.json()).resolves.toEqual({ inForce: false, lifted: true, id });

            res = await call('PATCH', KEY, { liftReason: 'again', liftedByRef: 'INC-other' });
            await expect(res.json()).resolves.toEqual({ inForce: false, lifted: false, id: null });
            const row = await prisma.platformAgentKillSwitch.findUniqueOrThrow({ where: { id } });
            expect(row.liftedByRef).toBe(LIFT.liftedByRef);
        });

        it('after a lift, an engage pulls a NEW switch', async () => {
            const { id: first } = await (await call('POST', KEY, ENGAGE)).json();
            await call('PATCH', KEY, LIFT);
            const res = await call('POST', KEY, ENGAGE);
            expect(res.status).toBe(201);
            const { id: second } = await res.json();
            expect(second).not.toBe(first);
        });
    });
});
