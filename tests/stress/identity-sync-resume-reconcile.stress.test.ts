/**
 * Tier V — the multi-run resume pass, and the reconcile that could ruin it.
 *
 * This is the file guarding the scariest failure in the subsystem: wrongful mass
 * deprovisioning. The resume feature made it newly reachable, because under
 * resume a run's `seen` set holds only the LAST slice of the directory — so the
 * pre-resume predicate (`externalUserId notIn seen`) would have deprovisioned
 * every account from every earlier run of the same pass.
 *
 * The shipped predicate is `syncedAt < passStartedAt`. That is **untested
 * today**: `tests/unit/identity-sync.test.ts` mocks `updateMany` to a canned
 * `{count: 3}`, so it asserts the query SHAPE and never its effect on rows. The
 * boundary between `lt` and `lte` is the whole ballgame and only a real database
 * can settle it — measured, `lte` matches every account in the directory, i.e.
 * it would deprovision 100% of every tenant on every successful sync.
 *
 * A fake `IdentitySyncProvider` is used deliberately here rather than the real
 * socket: these scenarios need a directory bigger than the enumeration cap
 * across three runs, the HTTP layer is already covered by Tier H, and — the
 * hard constraint — the whole usecase is ONE Prisma interactive transaction with
 * a 5 s server-side expiry, so account volume is bounded by upsert round-trips,
 * not by transport.
 *
 * @see tests/stress/README.md
 */
import { randomUUID } from 'node:crypto';
import {
    requireStressDb,
    stressPrisma,
    teardownTenant,
    STRESS_SCALE,
    recordTrend,
} from './helpers/stress-env';
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import type {
    IdentitySyncProvider,
    ListAccountsResult,
    NormalizedIdentityAccount,
} from '@/app-layer/integrations/providers/identity/types';

jest.setTimeout(180_000);

/** Accounts per run. Bounded by upsert round-trips inside the 5s transaction. */
const PER_RUN = 120 * STRESS_SCALE;

const prisma = stressPrisma();
const TAG = `stressv${Date.now().toString(36)}`;
const TENANT_ID = `t-${TAG}`;

let connectionId: string;

function acct(id: string): NormalizedIdentityAccount {
    return {
        externalUserId: id,
        email: `${id}@acme.test`,
        status: 'ACTIVE',
        isAdmin: false,
        mfaEnrolled: true,
        ssoEnrolled: true,
        groups: [],
        lastActiveAt: new Date(),
    };
}

/** Serves fixed slices, reporting partial until the last one. */
function pagedProvider(slices: string[][]): IdentitySyncProvider & { calls: Array<string | null | undefined> } {
    let i = 0;
    const calls: Array<string | null | undefined> = [];
    return {
        calls,
        async listAccounts(_config, resumeFrom): Promise<ListAccountsResult> {
            calls.push(resumeFrom);
            const slice = slices[Math.min(i, slices.length - 1)];
            const isLast = i >= slices.length - 1;
            i += 1;
            return {
                accounts: slice.map(acct),
                complete: isLast,
                resumeToken: isLast ? null : `cursor-${i}`,
            };
        },
    };
}

async function seedConnection(): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: TENANT_ID,
            provider: 'okta',
            name: `okta-${randomUUID().slice(0, 8)}`,
            isEnabled: true,
            configJson: { orgUrl: 'https://acme.okta.com', apiToken: 'x', enrichPerUser: 'false' },
            secretEncrypted: null,
        },
        select: { id: true },
    });
    return conn.id;
}

const connRow = () =>
    prisma.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { syncCursor: true, syncPassStartedAt: true },
    });

const countByStatus = async (status: string) =>
    prisma.connectedIdentityAccount.count({ where: { tenantId: TENANT_ID, status } });

beforeAll(async () => {
    requireStressDb();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `stress ${TAG}`, slug: TAG },
    });
});

afterAll(async () => {
    await teardownTenant(prisma, TENANT_ID);
    await prisma.$disconnect();
});

beforeEach(async () => {
    connectionId = await seedConnection();
});

afterEach(async () => {
    await prisma.connectedIdentityAccount.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
});

describe('a single complete pass deprovisions exactly what vanished', () => {
    it('THRESHOLD 11 — a clean sync of an unchanged directory deprovisions NOTHING', async () => {
        // The `lte` catastrophe. Measured: with `lte`, this deprovisions every
        // account in the directory — 100% of every tenant, on every success.
        // The unit test cannot see it: it mocks updateMany to a canned count.
        const ids = Array.from({ length: PER_RUN }, (_, i) => `u${i}`);

        const first = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([ids]) });
        expect(first.status).toBe('PASSED');
        expect(await countByStatus('ACTIVE')).toBe(PER_RUN);

        const second = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([ids]) });

        expect(second.status).toBe('PASSED');
        expect(second.deprovisioned).toBe(0);
        expect(await countByStatus('DEPROVISIONED')).toBe(0);
        expect(await countByStatus('ACTIVE')).toBe(PER_RUN);
    });

    it('and deprovisions EXACTLY the accounts that disappeared', async () => {
        // Paired with the negative above on purpose: `=== 0` alone also passes
        // if the reconcile were deleted outright. The exact positive is what
        // proves it still runs.
        const all = Array.from({ length: PER_RUN }, (_, i) => `u${i}`);
        const REMOVED = 7;
        const survivors = all.slice(0, PER_RUN - REMOVED);

        await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([all]) });
        const r = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([survivors]) });

        expect(r.status).toBe('PASSED');
        expect(r.deprovisioned).toBe(REMOVED);
        expect(await countByStatus('DEPROVISIONED')).toBe(REMOVED);
        expect(await countByStatus('ACTIVE')).toBe(PER_RUN - REMOVED);
    });
});

describe('a resumed pass does not deprovision its own earlier runs', () => {
    it('THRESHOLD 10 — three-run pass over a directory bigger than one run', async () => {
        // THE assertion this file exists for. Runs 1 and 2 are partial; run 3
        // completes and reconciles. Every account from runs 1 and 2 has
        // `syncedAt >= passStartedAt` and must survive.
        const a = Array.from({ length: PER_RUN }, (_, i) => `a${i}`);
        const b = Array.from({ length: PER_RUN }, (_, i) => `b${i}`);
        const c = Array.from({ length: PER_RUN }, (_, i) => `c${i}`);
        const total = PER_RUN * 3;

        const startedAt = Date.now();
        const r1 = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([a, b, c]) });
        expect(r1.status).toBe('PARTIAL');
        const afterR1 = await connRow();
        expect(afterR1?.syncCursor).toBe('cursor-1');
        expect(afterR1?.syncPassStartedAt).not.toBeNull();
        const passStart = afterR1!.syncPassStartedAt;

        // Provider slice 2 — a fresh instance, but the stored cursor is handed
        // back to it, which is what makes the pass continue rather than restart.
        const p2 = pagedProvider([b, c]);
        const r2 = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: p2 });
        expect(r2.status).toBe('PARTIAL');
        expect(p2.calls[0]).toBe('cursor-1'); // the cursor actually travelled
        // THE pass timestamp must NOT be reset by a resumed run.
        expect((await connRow())?.syncPassStartedAt).toEqual(passStart);

        const p3 = pagedProvider([c]);
        const r3 = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: p3 });

        expect(r3.status).toBe('PASSED');
        // Nothing genuinely vanished, so nothing may be deprovisioned — even
        // though run 3's own `seen` set contains only the last third.
        expect(r3.deprovisioned).toBe(0);
        expect(await countByStatus('DEPROVISIONED')).toBe(0);
        expect(await countByStatus('ACTIVE')).toBe(total);

        // The pass is closed, so the next run starts fresh rather than resuming
        // from the end and enumerating nothing forever.
        const done = await connRow();
        expect(done?.syncCursor).toBeNull();
        expect(done?.syncPassStartedAt).toBeNull();

        recordTrend('resume_pass_3run_ms', Date.now() - startedAt, 'ms');
    });

    it('THRESHOLD 12 — a partial run performs NO reconcile at all', async () => {
        // Accounts past the cursor were never observed; deprovisioning on a
        // partial run is the wrongful-mass-deprovision bug in its original form.
        const a = Array.from({ length: PER_RUN }, (_, i) => `a${i}`);
        await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([a]) });
        expect(await countByStatus('ACTIVE')).toBe(PER_RUN);

        // Now a partial run that reports a completely different slice.
        const other = Array.from({ length: 3 }, (_, i) => `z${i}`);
        const r = await runIdentitySync({
            tenantId: TENANT_ID,
            connectionId,
            provider: pagedProvider([other, other]),
        });

        expect(r.status).toBe('PARTIAL');
        expect(r.deprovisioned).toBe(0);
        // Not one of the original accounts touched, despite none being seen.
        expect(await countByStatus('DEPROVISIONED')).toBe(0);
    });

    it('a non-resumable partial stays loud, and still does not reconcile', async () => {
        // Active Directory's shape: truncated with no cursor. Must report ERROR
        // + noRetry (retrying truncates identically) and leave rows alone.
        const a = Array.from({ length: PER_RUN }, (_, i) => `a${i}`);
        await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: pagedProvider([a]) });

        const noCursor: IdentitySyncProvider = {
            async listAccounts() {
                return { accounts: [acct('z0')], complete: false, resumeToken: null };
            },
        };
        const r = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider: noCursor });

        expect(r.status).toBe('ERROR');
        expect(r.noRetry).toBe(true);
        expect(await countByStatus('DEPROVISIONED')).toBe(0);
        expect((await connRow())?.syncCursor).toBeNull();
    });
});
