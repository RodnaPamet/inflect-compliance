/**
 * #2501 against a REAL database, with REAL transactions.
 *
 * ═══ WHY THIS CANNOT BE A UNIT TEST ═══
 *
 * `tests/unit/sync-transaction-shape.test.ts` proves the SHAPE — where
 * transactions open, what is inside them, that a dead client is never written
 * to. It proves all of that against a runner this repo wrote, so it cannot
 * prove the thing the runner is a model OF: that Prisma 7.10.0's interactive
 * transaction really does expire at 5,000 ms when nobody passes a timeout, and
 * really does take the rows written inside it when it does.
 *
 * That claim is measured here, once, as a control (the first test). Everything
 * after it then means something: the same fixture that kills a 5-second
 * transaction is handed to the fixed syncs and they complete.
 *
 * ═══ AND WHY THE RESUME PASS IS EXERCISED HERE TOO ═══
 *
 * Fixing the budget makes `MAX_USERS` / `MAX_EMPLOYEES` reachable for the
 * first time, which wakes the resume/PARTIAL machinery in both syncs — code
 * that has never executed in production. A unit test of a path that has never
 * run is the exact shape that keeps failing: green over an unreachable
 * mechanism. So the multi-leg pass below runs against real rows, with the
 * cursor genuinely round-tripping through Postgres, and its first leg is
 * larger than SYNC_UPSERT_CHUNK_SIZE so the newly-introduced multi-transaction
 * write path is what carries it.
 *
 * Two halves of "hitting the cap" are proved in different places, deliberately:
 * that a provider AT its cap returns `complete: false` plus a token is a
 * provider fact, already measured against 5,000 fixture users in
 * `tests/unit/integrations/okta-directory-enumeration.test.ts`; that the token
 * survives the database and the next leg continues from it is a usecase fact,
 * and it is measured here.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import { SYNC_UPSERT_CHUNK_SIZE } from '@/app-layer/integrations/sync-transaction';
import type { NormalizedEmployee, HrisSyncProvider } from '@/app-layer/integrations/providers/hris';
import type { IdentitySyncProvider, NormalizedIdentityAccount } from '@/app-layer/integrations/providers/identity/types';

jest.setTimeout(180_000);

const prisma: PrismaClient = prismaTestClient();
const T = 'sync-tx-budget-tenant';

const DB_AVAILABLE = process.env.DATABASE_URL !== undefined;
const d = DB_AVAILABLE ? describe : describe.skip;

/**
 * Prisma 7.10.0's interactive-transaction default — the budget both syncs used
 * to inherit. Not exported by Prisma, which is exactly why nobody chose it.
 */
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

/**
 * How long the fake provider holds the roster read.
 *
 * Comfortably past the default above and comfortably UNDER `DEFAULT_TIMEOUT_MS`
 * (30 s), the budget a single HTTP request is already allowed — so this is not
 * a pathological read, it is an ordinary one. That is the point: an ordinary
 * read blew the transaction.
 */
const SLOW_ROSTER_READ_MS = 6_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ctx = makeRequestContext('ADMIN', { tenantId: T, tenantSlug: 'sync-tx-budget' });

async function clearOwnRows(): Promise<void> {
    const where = { tenantId: T };
    await prisma.identityAccountLink.deleteMany({ where });
    await prisma.connectedIdentityAccount.deleteMany({ where });
    await prisma.integrationExecution.deleteMany({ where });
    await prisma.employee.updateMany({ where, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where });
    await prisma.integrationConnection.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
}

async function seedConnection(provider: string): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: { tenantId: T, provider, name: `${provider}-${Date.now()}`, isEnabled: true, configJson: {}, secretEncrypted: null },
        select: { id: true },
    });
    return conn.id;
}

const connRow = (id: string) =>
    prisma.integrationConnection.findUnique({ where: { id }, select: { syncCursor: true, syncPassStartedAt: true } });

// ── Fixtures ─────────────────────────────────────────────────────────────

function emp(id: string): NormalizedEmployee {
    return { externalId: id, fullName: `Person ${id}`, workEmail: `${id}@acme.test`, status: 'ACTIVE', managerEmail: null, startDate: null, endDate: null };
}

function acct(id: string): NormalizedIdentityAccount {
    return { externalUserId: id, email: `${id}@acme.test`, status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, onPremisesSyncEnabled: null, groups: [], lastActiveAt: new Date() };
}

/**
 * Serves fixed legs, reporting the traversal unfinished until the last one.
 *
 * `tokenPrefix` makes each INSTANCE mint distinguishable cursors, which is
 * what lets an assertion tell "leg 2 was handed the token leg 1 stored" apart
 * from "leg 2 minted a token that happens to look the same". Every leg of a
 * real pass is served by a different worker process, so a fresh instance per
 * leg is the faithful shape.
 */
function pagedHris(legs: string[][], tokenPrefix = 'h', delayMs = 0): HrisSyncProvider & { cursors: Array<string | null | undefined> } {
    let i = 0;
    const cursors: Array<string | null | undefined> = [];
    return {
        cursors,
        async listEmployees(_config: Record<string, unknown>, resumeFrom?: string | null) {
            cursors.push(resumeFrom);
            if (delayMs) await sleep(delayMs);
            const leg = legs[Math.min(i, legs.length - 1)];
            const isLast = i >= legs.length - 1;
            i += 1;
            return { employees: leg.map(emp), complete: isLast, resumeToken: isLast ? null : `${tokenPrefix}-cursor-${i}` };
        },
    } as HrisSyncProvider & { cursors: Array<string | null | undefined> };
}

/** Identity twin of {@link pagedHris} — same `tokenPrefix` reasoning. */
function pagedIdentity(legs: string[][], tokenPrefix = 'i', delayMs = 0): IdentitySyncProvider & { cursors: Array<string | null | undefined> } {
    let i = 0;
    const cursors: Array<string | null | undefined> = [];
    return {
        cursors,
        async listAccounts(_config: Record<string, unknown>, resumeFrom?: string | null) {
            cursors.push(resumeFrom);
            if (delayMs) await sleep(delayMs);
            const leg = legs[Math.min(i, legs.length - 1)];
            const isLast = i >= legs.length - 1;
            i += 1;
            return { accounts: leg.map(acct), complete: isLast, resumeToken: isLast ? null : `${tokenPrefix}-cursor-${i}` };
        },
    } as IdentitySyncProvider & { cursors: Array<string | null | undefined> };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.tenant.upsert({
        where: { id: T },
        update: {},
        create: { id: T, name: 'sync tx budget', slug: 'sync-tx-budget' },
    });
    await clearOwnRows();
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await clearOwnRows();
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

beforeEach(async () => {
    await clearOwnRows();
});

// ── 1. The control: the mechanism, measured ──────────────────────────────

d('the 5-second default is real, and it erases its own evidence', () => {
    it('aborts a six-second body, rolls back the RUNNING row, and kills the client the catch would use', async () => {
        // THE ENTIRE DEFECT, in one test, against the real Prisma version.
        //
        // Everything downstream of this file rests on the claim that a sync
        // wrapped in one un-budgeted transaction could not survive an ordinary
        // provider read. That claim is not asserted here — it is measured.
        let escaped: PrismaTx | null = null;
        let createdId: string | null = null;
        let thrown: unknown;

        try {
            await runInTenantContext(
                ctx,
                async (db) => {
                    escaped = db;
                    const row = await db.integrationExecution.create({
                        data: { tenantId: T, provider: 'bamboohr', automationKey: 'bamboohr.sync', status: 'RUNNING', triggeredBy: 'scheduled' },
                        select: { id: true },
                    });
                    createdId = row.id;
                    // Stands in for the provider read the old shape held here.
                    await db.$executeRawUnsafe(`SELECT pg_sleep(${SLOW_ROSTER_READ_MS / 1000})`);
                },
                { timeout: PRISMA_DEFAULT_TX_TIMEOUT_MS },
            );
        } catch (e) {
            thrown = e;
        }

        // POSITIVE CONTROLS FIRST. If the body never ran, or the transaction
        // never expired, the two assertions after them would pass vacuously.
        expect(createdId).not.toBeNull();
        expect(thrown).toBeDefined();

        // The RUNNING row went with the rollback.
        expect(await prisma.integrationExecution.findUnique({ where: { id: createdId! } })).toBeNull();

        // And the catch that would have recorded the failure cannot: its `db`
        // is the same closed client. THIS is why the observable was an absence
        // rather than an ERROR row.
        await expect(
            (escaped as unknown as PrismaTx).integrationExecution.update({
                where: { id: createdId! },
                data: { status: 'ERROR', errorMessage: 'the catch that could not write' },
            }),
        ).rejects.toThrow();
    });
});

// ── 2. The fix: an ordinary-but-slow read now completes ──────────────────

d('a provider read longer than the old budget no longer destroys the run', () => {
    it('hris-sync completes and leaves a PASSED execution row', async () => {
        const connectionId = await seedConnection('bamboohr');
        const started = Date.now();

        const r = await runHrisSync({ tenantId: T, connectionId, provider: pagedHris([['a1', 'a2']], 'h', SLOW_ROSTER_READ_MS) });

        // The read really did outlive the old budget — measured, not assumed,
        // so a future change that drops the delay cannot leave this green while
        // proving nothing.
        expect(Date.now() - started).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(2);
        const exec = await prisma.integrationExecution.findUnique({ where: { id: r.executionId } });
        expect(exec?.status).toBe('PASSED');
        expect(await prisma.employee.count({ where: { tenantId: T, status: 'ACTIVE' } })).toBe(2);
    });

    it('identity-sync completes and leaves a PASSED execution row', async () => {
        const connectionId = await seedConnection('okta');
        const started = Date.now();

        const r = await runIdentitySync({ tenantId: T, connectionId, provider: pagedIdentity([['a1', 'a2']], 'i', SLOW_ROSTER_READ_MS) });

        expect(Date.now() - started).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(2);
        const exec = await prisma.integrationExecution.findUnique({ where: { id: r.executionId } });
        expect(exec?.status).toBe('PASSED');
    });
});

// ── 3. A failed write LEAVES EVIDENCE ────────────────────────────────────

d('a write that fails mid-phase still records the run', () => {
    it('hris-sync finishes the execution row as ERROR rather than vanishing', async () => {
        const connectionId = await seedConnection('bamboohr');
        // A value the EmploymentStatus column cannot hold. Prisma rejects it
        // inside the write transaction — a real write failure, not a mocked
        // one. Under the old shape the rollback took the RUNNING row too and
        // the run left nothing at all behind.
        const broken: HrisSyncProvider = {
            async listEmployees() {
                return {
                    employees: [{ ...emp('x1'), status: 'NOT_A_REAL_STATUS' as NormalizedEmployee['status'] }],
                    complete: true,
                    resumeToken: null,
                };
            },
        } as HrisSyncProvider;

        const r = await runHrisSync({ tenantId: T, connectionId, provider: broken });

        expect(r.status).toBe('ERROR');
        const exec = await prisma.integrationExecution.findUnique({ where: { id: r.executionId } });
        expect(exec).not.toBeNull();
        expect(exec!.status).toBe('ERROR');
        expect(exec!.errorMessage).toBeTruthy();
        expect(exec!.completedAt).not.toBeNull();
        // Not RUNNING-forever, and not absent: the two states an operator
        // cannot tell apart from a dispatcher that never fired.
        expect(await prisma.integrationExecution.count({ where: { tenantId: T, status: 'RUNNING' } })).toBe(0);
    });
});

// ── 4. The resume pass, exercised deliberately ───────────────────────────

d('a multi-leg HRIS pass resumes and reconciles exactly what left', () => {
    it('carries a leg wider than one write chunk, round-trips the cursor, and terminates only the genuinely absent', async () => {
        const connectionId = await seedConnection('bamboohr');

        // Pass 1 — the tenant as it stands: 30 employees, one complete run.
        const base = Array.from({ length: 30 }, (_, i) => `b${i}`);
        const first = await runHrisSync({ tenantId: T, connectionId, provider: pagedHris([base]) });
        expect(first.status).toBe('PASSED');
        expect(await prisma.employee.count({ where: { tenantId: T, status: 'ACTIVE' } })).toBe(30);

        // Pass 2 — three legs. Leg 1 is deliberately WIDER than one write
        // chunk, so the leg that stores the cursor is also the leg carried by
        // more than one transaction. Five of the original thirty never appear.
        const wide = Array.from({ length: SYNC_UPSERT_CHUNK_SIZE + 1 }, (_, i) => `n${i}`);
        const survivors = base.slice(0, 25);
        const departed = base.slice(25); // b25..b29 — gone from the HRIS

        const p1 = pagedHris([wide, survivors, []], 'legA');
        const leg1 = await runHrisSync({ tenantId: T, connectionId, provider: p1 });
        expect(leg1.status).toBe('PARTIAL');
        expect(leg1.upserted).toBe(SYNC_UPSERT_CHUNK_SIZE + 1);
        // Larger than one write transaction can carry — this leg exercised the
        // chunked write path, not a single-transaction one.
        expect(leg1.upserted).toBeGreaterThan(SYNC_UPSERT_CHUNK_SIZE);
        const afterLeg1 = await connRow(connectionId);
        expect(afterLeg1?.syncCursor).toBe('legA-cursor-1');
        expect(afterLeg1?.syncPassStartedAt).not.toBeNull();
        const passStart = afterLeg1!.syncPassStartedAt;
        // A partial leg reconciles nothing — the rows it has not reached were
        // never observed.
        expect(await prisma.employee.count({ where: { tenantId: T, status: 'TERMINATED' } })).toBe(0);

        // Leg 2 — a FRESH provider instance, so the only way it can continue
        // is by being handed the cursor the database kept.
        const p2 = pagedHris([survivors, []], 'legB');
        const leg2 = await runHrisSync({ tenantId: T, connectionId, provider: p2 });
        expect(leg2.status).toBe('PARTIAL');
        expect(p2.cursors[0]).toBe('legA-cursor-1'); // leg 1's token, read back out of Postgres
        expect((await connRow(connectionId))?.syncPassStartedAt).toEqual(passStart);
        expect(await prisma.employee.count({ where: { tenantId: T, status: 'TERMINATED' } })).toBe(0);

        // Leg 3 — the empty final page. `complete: true` with nothing in hand,
        // which is what a roster whose size is an exact multiple of the per-run
        // cap looks like, and the case the pass-level guard exists for.
        const p3 = pagedHris([[]], 'legC');
        const leg3 = await runHrisSync({ tenantId: T, connectionId, provider: p3 });

        expect(leg3.status).toBe('PASSED');
        expect(p3.cursors[0]).toBe('legB-cursor-1');
        // EXACTLY the five that vanished, and not one of the 501 rows leg 1
        // wrote — the wrongful-mass-termination the resume feature would
        // otherwise have introduced.
        expect(leg3.managersLinked).toBe(0);
        const terminated = await prisma.employee.findMany({ where: { tenantId: T, status: 'TERMINATED' }, select: { externalId: true } });
        expect(terminated.map((e) => e.externalId).sort()).toEqual([...departed].sort());
        expect(await prisma.employee.count({ where: { tenantId: T, status: 'ACTIVE' } })).toBe(SYNC_UPSERT_CHUNK_SIZE + 1 + survivors.length);

        // The pass is closed, so the next run starts fresh rather than
        // resuming from the end and enumerating nothing forever.
        const done = await connRow(connectionId);
        expect(done?.syncCursor).toBeNull();
        expect(done?.syncPassStartedAt).toBeNull();
    });
});

d('a multi-leg identity pass resumes and deprovisions exactly what left', () => {
    it('carries a leg wider than one write chunk, round-trips the cursor, and spares every earlier leg', async () => {
        const connectionId = await seedConnection('okta');

        const base = Array.from({ length: 30 }, (_, i) => `b${i}`);
        const first = await runIdentitySync({ tenantId: T, connectionId, provider: pagedIdentity([base]) });
        expect(first.status).toBe('PASSED');
        expect(await prisma.connectedIdentityAccount.count({ where: { tenantId: T, status: 'ACTIVE' } })).toBe(30);

        const wide = Array.from({ length: SYNC_UPSERT_CHUNK_SIZE + 1 }, (_, i) => `n${i}`);
        const survivors = base.slice(0, 25);
        const gone = base.slice(25);

        const p1 = pagedIdentity([wide, survivors, []], 'legA');
        const leg1 = await runIdentitySync({ tenantId: T, connectionId, provider: p1 });
        expect(leg1.status).toBe('PARTIAL');
        expect(leg1.upserted).toBeGreaterThan(SYNC_UPSERT_CHUNK_SIZE);
        const afterLeg1 = await connRow(connectionId);
        expect(afterLeg1?.syncCursor).toBe('legA-cursor-1');
        const passStart = afterLeg1!.syncPassStartedAt;
        expect(passStart).not.toBeNull();
        expect(await prisma.connectedIdentityAccount.count({ where: { tenantId: T, status: 'DEPROVISIONED' } })).toBe(0);

        const p2 = pagedIdentity([survivors, []], 'legB');
        const leg2 = await runIdentitySync({ tenantId: T, connectionId, provider: p2 });
        expect(leg2.status).toBe('PARTIAL');
        expect(p2.cursors[0]).toBe('legA-cursor-1'); // leg 1's token, read back out of Postgres
        expect((await connRow(connectionId))?.syncPassStartedAt).toEqual(passStart);

        const p3 = pagedIdentity([[]], 'legC');
        const leg3 = await runIdentitySync({ tenantId: T, connectionId, provider: p3 });

        // PASSED, not PARTIAL: five of 526 is under the share cap and not past
        // DEPROVISION_SHARE_FLOOR, so neither rail refuses — and the
        // zero-enumeration floor is satisfied by the pass marker an earlier leg
        // left, which is the clause resume made load-bearing.
        expect(leg3.status).toBe('PASSED');
        expect(leg3.deprovisioned).toBe(gone.length);
        const deprovisioned = await prisma.connectedIdentityAccount.findMany({ where: { tenantId: T, status: 'DEPROVISIONED' }, select: { externalUserId: true } });
        expect(deprovisioned.map((a) => a.externalUserId).sort()).toEqual([...gone].sort());
        expect(await prisma.connectedIdentityAccount.count({ where: { tenantId: T, status: 'ACTIVE' } })).toBe(SYNC_UPSERT_CHUNK_SIZE + 1 + survivors.length);

        const done = await connRow(connectionId);
        expect(done?.syncCursor).toBeNull();
        expect(done?.syncPassStartedAt).toBeNull();
    });
});
