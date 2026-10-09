/**
 * The reconciliation run: three gates, and what each refusal costs.
 *
 * Every gate here refuses the WHOLE run and writes no resolutions. That is the
 * point rather than an implementation detail: a partial reconciliation produces
 * resolutions for some accounts and silence for others, and silence is
 * indistinguishable from `UNMATCHED` on the surface a reviewer reads.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { runLegacyReconcile, ROSTER_FRESHNESS_MS } from '@/app-layer/usecases/legacy-reconcile';

const prisma: PrismaClient = prismaTestClient();
const TENANT = 'lgrc-tenant';
const ctx = () => makeRequestContext('OWNER', { tenantId: TENANT });

let connectionId: string;
let snapshotId: string;
let employeeId: string;

const freshAgo = () => new Date(Date.now() - ROSTER_FRESHNESS_MS / 2);
const staleAgo = () => new Date(Date.now() - ROSTER_FRESHNESS_MS * 2);

/** A PASSED HRIS sync, which gate 2 looks for. */
async function hrisSync(completedAt: Date) {
    return prisma.integrationExecution.create({
        data: {
            tenantId: TENANT, provider: 'bamboohr', automationKey: 'bamboohr.sync',
            status: 'PASSED', triggeredBy: 'scheduled',
            executedAt: completedAt, completedAt,
        },
    });
}

async function clearRun(): Promise<void> {
    await prisma.legacyAccountResolution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId: TENANT } });
}

async function clearAll(): Promise<void> {
    await prisma.legacyAccountResolution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyIdentityAlias.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccount.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccessSnapshot.deleteMany({ where: { tenantId: TENANT } });
    await prisma.identityAccountLink.deleteMany({ where: { tenantId: TENANT } });
    await prisma.connectedIdentityAccount.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.employee.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearAll();
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Reconcile Tenant', slug: TENANT },
    });
    // The audit writer's FK. Seeded here rather than inherited from a sibling
    // suite — see the note in legacy-access-profile.test.ts.
    await prisma.user.upsert({
        where: { id: 'user-1' },
        update: {},
        create: { id: 'user-1', email: 'reconciler@lgrc.test', name: 'Reconciler' },
    });
});

beforeEach(async () => {
    await clearAll();
    const conn = await prisma.integrationConnection.create({
        data: { tenantId: TENANT, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
    });
    connectionId = conn.id;

    const employee = await prisma.employee.create({
        data: {
            tenantId: TENANT, fullName: 'Jane Smith', givenName: 'Jane', familyName: 'Smith',
            workEmail: 'jane.smith@corp.test', employeeNumber: '4417', status: 'ACTIVE',
        },
    });
    employeeId = employee.id;

    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: TENANT, connectionId: conn.id, remoteSnapshotId: 'snap-1',
            mappingVersion: 1, columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'h'.repeat(64), rowCount: 2, rowsReceived: 2,
            status: 'COMPLETE', completedAt: new Date(),
        },
    });
    snapshotId = snap.id;

    await prisma.legacyAccount.createMany({
        data: [
            {
                tenantId: TENANT, snapshotId: snap.id, accountKey: 'jsmith',
                email: 'jane.smith@corp.test', displayName: 'Jane Smith',
                status: 'ACTIVE', accountType: 'HUMAN', entitlements: ['reader'],
            },
            {
                tenantId: TENANT, snapshotId: snap.id, accountKey: 'nobody',
                displayName: 'Nobody At All', status: 'ACTIVE',
                accountType: 'HUMAN', entitlements: [],
            },
        ],
    });

    await hrisSync(freshAgo());
});

afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
});

describe('a resolvable run', () => {
    it('resolves every account exactly once and records the method', async () => {
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.status).toBe('RESOLVED');
        expect(r.resolved).toBe(2);

        const rows = await prisma.legacyAccountResolution.findMany({
            where: { tenantId: TENANT }, orderBy: { accountKey: 'asc' },
        });
        expect(rows.map((x) => x.accountKey)).toEqual(['jsmith', 'nobody']);
        // Every row carries a method, including the non-links — "nobody matched"
        // and "several matched and I refused" are both non-links wanting
        // different responses.
        for (const row of rows) expect(row.method).toBeTruthy();
    });

    it('links on an exact email and leaves the unmatched account unlinked', async () => {
        await runLegacyReconcile(ctx(), { snapshotId });
        const jsmith = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
        });
        expect(jsmith.outcome).toBe('LINKED');
        expect(jsmith.method).toBe('EMAIL_EXACT');
        expect(jsmith.employeeId).toBe(employeeId);

        const nobody = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'nobody' },
        });
        expect(nobody.outcome).not.toBe('LINKED');
        expect(nobody.employeeId).toBeNull();
    });

    it('reports counts per outcome', async () => {
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        // The engine's own tally, not a count of the write loop.
        expect(Object.values(r.byOutcome).reduce((a, b) => a + b, 0)).toBe(2);
        expect(r.byOutcome.LINKED).toBe(1);
    });

    it('records the run as an IntegrationExecution that PASSED', async () => {
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        const exec = await prisma.integrationExecution.findUniqueOrThrow({
            where: { id: r.executionId! },
        });
        expect(exec.status).toBe('PASSED');
        expect(exec.automationKey).toBe('legacy-mcp.reconcile');
        expect(exec.completedAt).not.toBeNull();
    });

    it('stores the EVIDENCE, so a reviewer can see why', async () => {
        await runLegacyReconcile(ctx(), { snapshotId });
        const jsmith = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
        });
        const signals = jsmith.signalsJson as Array<{ kind: string; evidence: string }>;
        expect(signals.some((s) => s.kind === 'EMAIL_EXACT')).toBe(true);
        // The evidence for an exact-email match IS the email key. That is why
        // these rows are classified PII and why encrypting them would make the
        // surface that exists to show a reviewer the reason useless.
        expect(JSON.stringify(signals)).toContain('jane.smith@corp.test');
    });
});

describe('gate 1 — the snapshot must be COMPLETE', () => {
    it.each(['PENDING', 'PARTIAL'] as const)('refuses a %s snapshot and writes nothing', async (status) => {
        await prisma.legacyAccessSnapshot.update({ where: { id: snapshotId }, data: { status } });
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.status).toBe('REFUSED');
        expect(r.refusal).toBe('SNAPSHOT_NOT_COMPLETE');
        expect(await prisma.legacyAccountResolution.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('refuses a snapshot that does not exist', async () => {
        const r = await runLegacyReconcile(ctx(), { snapshotId: 'nope' });
        expect(r.refusal).toBe('SNAPSHOT_NOT_FOUND');
    });

    it('refuses an EMPTY snapshot — zero is never complete, one level up', async () => {
        await prisma.legacyAccount.deleteMany({ where: { tenantId: TENANT } });
        await prisma.legacyAccessSnapshot.update({ where: { id: snapshotId }, data: { rowCount: 0 } });
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.refusal).toBe('EMPTY_SNAPSHOT');
        expect(await prisma.legacyAccountResolution.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('records a refusal as PARTIAL on the execution, not ERROR', async () => {
        // The run reached a VERDICT about whether it was safe to resolve, which is
        // what it was asked to do. ERROR would read as "the reconciler is broken"
        // where "the snapshot is not complete" is the actionable fact.
        await prisma.legacyAccessSnapshot.update({ where: { id: snapshotId }, data: { status: 'PARTIAL' } });
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        const exec = await prisma.integrationExecution.findUniqueOrThrow({
            where: { id: r.executionId! },
        });
        expect(exec.status).toBe('PARTIAL');
        expect(exec.errorMessage).toBe('SNAPSHOT_NOT_COMPLETE');
    });
});

describe('gate 2 — the roster must be fresh', () => {
    it('refuses NO_FRESH_ROSTER when the latest HRIS sync is STALE, and writes nothing', async () => {
        await clearRun();
        await hrisSync(staleAgo());
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.refusal).toBe('NO_FRESH_ROSTER');
        expect(await prisma.legacyAccountResolution.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('refuses when the latest HRIS sync is fresh but did NOT pass', async () => {
        // A truncated sync leaves a roster that is recent and wrong, which is the
        // worse of the two failures: it looks current.
        await clearRun();
        await prisma.integrationExecution.create({
            data: {
                tenantId: TENANT, provider: 'bamboohr', automationKey: 'bamboohr.sync',
                status: 'PARTIAL', triggeredBy: 'scheduled',
                executedAt: freshAgo(), completedAt: freshAgo(),
            },
        });
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.refusal).toBe('NO_FRESH_ROSTER');
    });

    it('refuses when there has been no HRIS sync at all', async () => {
        await clearRun();
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        expect(r.refusal).toBe('NO_FRESH_ROSTER');
    });

    it('accepts a fresh PASSED sync from ANY supported HRIS provider', async () => {
        // The denominator: without this, a bug that always refused would pass
        // every assertion above.
        for (const provider of ['bamboohr', 'workday', 'orangehrm']) {
            await clearRun();
            await prisma.integrationExecution.create({
                data: {
                    tenantId: TENANT, provider, automationKey: `${provider}.sync`,
                    status: 'PASSED', triggeredBy: 'scheduled',
                    executedAt: freshAgo(), completedAt: freshAgo(),
                },
            });
            const r = await runLegacyReconcile(ctx(), { snapshotId });
            expect({ provider, status: r.status }).toEqual({ provider, status: 'RESOLVED' });
        }
    });
});

describe('gate 3 — the directory bridge is fresh per link', () => {
    /** A directory account whose login matches the legacy account key. */
    async function directoryAccount(opts: { lastVerifiedAt: Date; contradictedAt: Date | null }) {
        const account = await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: TENANT, provider: 'entra-id', connectionId,
                externalUserId: 'ext-1', email: 'j.smith@corp.test',
                samAccountName: 'jsmith', syncedAt: new Date(),
            },
        });
        await prisma.identityAccountLink.create({
            data: {
                tenantId: TENANT, employeeId, connectedAccountId: account.id,
                matchMethod: 'EMAIL_EXACT',
                lastVerifiedAt: opts.lastVerifiedAt,
                contradictedAt: opts.contradictedAt,
            },
        });
        return account;
    }

    it('does NOT cross a STALE link', async () => {
        // The legacy account has no email here, so the bridge is its only route
        // to a LINKED — which makes the stale case observable.
        await prisma.legacyAccount.updateMany({
            where: { tenantId: TENANT, accountKey: 'jsmith' }, data: { email: null },
        });
        await directoryAccount({ lastVerifiedAt: staleAgo(), contradictedAt: null });
        const r = await runLegacyReconcile(ctx(), { snapshotId });
        const jsmith = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
        });
        expect(r.status).toBe('RESOLVED');
        expect(jsmith.method).not.toBe('DIRECTORY_BRIDGE');
        expect(jsmith.outcome).not.toBe('LINKED');
    });

    it('does NOT cross a CONTRADICTED link, however fresh', async () => {
        await prisma.legacyAccount.updateMany({
            where: { tenantId: TENANT, accountKey: 'jsmith' }, data: { email: null },
        });
        await directoryAccount({ lastVerifiedAt: freshAgo(), contradictedAt: new Date() });
        await runLegacyReconcile(ctx(), { snapshotId });
        const jsmith = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
        });
        expect(jsmith.method).not.toBe('DIRECTORY_BRIDGE');
    });

    it('DOES cross a fresh uncontradicted link — the denominator', async () => {
        // Without this the two assertions above would pass for a bridge that
        // never works at all.
        await prisma.legacyAccount.updateMany({
            where: { tenantId: TENANT, accountKey: 'jsmith' }, data: { email: null },
        });
        await directoryAccount({ lastVerifiedAt: freshAgo(), contradictedAt: null });
        await runLegacyReconcile(ctx(), { snapshotId });
        const jsmith = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'jsmith' },
        });
        expect(jsmith.outcome).toBe('LINKED');
        expect(jsmith.method).toBe('DIRECTORY_BRIDGE');
    });

    it('writes NOTHING to the directory tables — invariant 1', async () => {
        const account = await directoryAccount({ lastVerifiedAt: freshAgo(), contradictedAt: null });
        const before = await prisma.identityAccountLink.findFirstOrThrow({
            where: { connectedAccountId: account.id },
        });
        const accountBefore = await prisma.connectedIdentityAccount.findUniqueOrThrow({
            where: { id: account.id },
        });

        await runLegacyReconcile(ctx(), { snapshotId });

        const after = await prisma.identityAccountLink.findFirstOrThrow({
            where: { connectedAccountId: account.id },
        });
        const accountAfter = await prisma.connectedIdentityAccount.findUniqueOrThrow({
            where: { id: account.id },
        });
        // Byte-for-byte, including the timestamps a sync would have moved. A row
        // written by a matcher that guessed would not look wrong — it would look
        // like a sync had found it.
        expect(after).toEqual(before);
        expect(accountAfter).toEqual(accountBefore);
        expect(await prisma.identityAccountLink.count({ where: { tenantId: TENANT } })).toBe(1);
    });
});

describe('aliases are READ, never written', () => {
    it('resolves CONFIRMED_ALIAS from an existing active alias', async () => {
        await prisma.legacyIdentityAlias.create({
            data: {
                tenantId: TENANT, connectionId, accountKey: 'nobody',
                employeeId, method: 'CONFIRMED_ALIAS',
                confirmedAt: new Date(), signalsJson: [],
            },
        });
        await runLegacyReconcile(ctx(), { snapshotId });
        const nobody = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'nobody' },
        });
        expect(nobody.outcome).toBe('LINKED');
        expect(nobody.method).toBe('CONFIRMED_ALIAS');
    });

    it('ignores a SUSPENDED alias', async () => {
        await prisma.legacyIdentityAlias.create({
            data: {
                tenantId: TENANT, connectionId, accountKey: 'nobody',
                employeeId, method: 'CONFIRMED_ALIAS', status: 'SUSPENDED',
                confirmedAt: new Date(), signalsJson: [],
            },
        });
        await runLegacyReconcile(ctx(), { snapshotId });
        const nobody = await prisma.legacyAccountResolution.findFirstOrThrow({
            where: { tenantId: TENANT, accountKey: 'nobody' },
        });
        expect(nobody.method).not.toBe('CONFIRMED_ALIAS');
        expect(nobody.outcome).not.toBe('LINKED');
    });

    it('creates no alias of its own — Step 4b writes them', async () => {
        await runLegacyReconcile(ctx(), { snapshotId });
        expect(await prisma.legacyIdentityAlias.count({ where: { tenantId: TENANT } })).toBe(0);
    });
});

describe('results are immutable', () => {
    it('a second run writes a NEW set and leaves the first untouched', async () => {
        const first = await runLegacyReconcile(ctx(), { snapshotId });
        const firstRows = await prisma.legacyAccountResolution.findMany({
            where: { tenantId: TENANT, executionId: first.executionId! },
            orderBy: { accountKey: 'asc' },
        });

        // Change the world between runs, so the second genuinely differs: confirm
        // an alias for the account that did not match.
        await prisma.legacyIdentityAlias.create({
            data: {
                tenantId: TENANT, connectionId, accountKey: 'nobody',
                employeeId, method: 'CONFIRMED_ALIAS',
                confirmedAt: new Date(), signalsJson: [],
            },
        });

        const second = await runLegacyReconcile(ctx(), { snapshotId });
        expect(second.executionId).not.toBe(first.executionId);

        const firstAgain = await prisma.legacyAccountResolution.findMany({
            where: { tenantId: TENANT, executionId: first.executionId! },
            orderBy: { accountKey: 'asc' },
        });
        // The old verdict is byte-identical. "Why was this suggested in March?" is
        // a question about what the engine saw in March.
        expect(firstAgain).toEqual(firstRows);

        const secondRows = await prisma.legacyAccountResolution.findMany({
            where: { tenantId: TENANT, executionId: second.executionId! },
        });
        expect(secondRows).toHaveLength(2);
        expect(secondRows.find((r) => r.accountKey === 'nobody')!.outcome).toBe('LINKED');
        // Both sets coexist against the same snapshot.
        expect(await prisma.legacyAccountResolution.count({ where: { tenantId: TENANT } })).toBe(4);
    });
});
