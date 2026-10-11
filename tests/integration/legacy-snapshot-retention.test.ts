/**
 * #3317 — the legacy access snapshot TTL, against a real database.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST WITH A DOUBLE.
 *
 * The thing under test is a Prisma predicate:
 *
 *     resolutions: { some: {} },
 *     NOT: { resolutions: { some: { createdAt: { gte: consumedCutoff } } } }
 *
 * which is "MAX(resolution.createdAt) < cutoff" expressed as a relation filter.
 * An in-memory double would have to reimplement nested `some`/`none`/`NOT`
 * semantics, and then the test would be asserting that my reimplementation
 * agrees with itself. The two clocks in #3317 are exactly the kind of thing a
 * self-authored double gets wrong in the same direction as the code.
 *
 * So: real rows, real cutoffs, and the assertions are about which rows SURVIVE.
 *
 * The two traps the decision named are tests 1 and 4 — they are the reason this
 * file exists, not incidental coverage.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS,
    DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS,
    DEFAULT_LEGACY_SNAPSHOT_UNCONSUMED_RETENTION_DAYS,
    purgeLegacyAccessSnapshotsOlderThan,
} from '@/app-layer/jobs/data-lifecycle';

const prisma: PrismaClient = prismaTestClient();
const T = 'lsr-tenant';

/** A fixed clock, so "40 days ago" means the same thing on every run. */
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

let connectionId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyAccount.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
}

/**
 * One snapshot, `accounts` accounts, and a resolution per entry in
 * `consumedAt` — so "never consumed" is an empty array rather than a flag,
 * which is the shape the predicate actually distinguishes.
 */
async function seedSnapshot(opts: {
    tag: string;
    pulledAt: Date;
    consumedAt?: Date[];
    accounts?: number;
}): Promise<string> {
    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: T,
            connectionId,
            remoteSnapshotId: `rs-${opts.tag}`,
            mappingVersion: 1,
            columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'h'.repeat(64),
            rowCount: opts.accounts ?? 1,
            rowsReceived: opts.accounts ?? 1,
            status: 'COMPLETE',
            pulledAt: opts.pulledAt,
            completedAt: opts.pulledAt,
        },
        select: { id: true },
    });

    for (let i = 0; i < (opts.accounts ?? 1); i += 1) {
        await prisma.legacyAccount.create({
            data: {
                tenantId: T,
                snapshotId: snap.id,
                accountKey: `${opts.tag}-acct-${i}`,
                displayName: 'Jane Smith',
                email: `jane${i}@lsr.test`,
                status: 'ACTIVE',
                accountType: 'HUMAN',
            },
        });
    }

    for (const [i, at] of (opts.consumedAt ?? []).entries()) {
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T,
                connectionId,
                status: 'PASSED',
                provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile',
                executedAt: at,
                completedAt: at,
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T,
                executionId: exec.id,
                snapshotId: snap.id,
                accountKey: `${opts.tag}-acct-0`,
                outcome: 'UNMATCHED',
                // NO_CANDIDATES, not 'NONE' — there is no NONE in LegacyMatchMethod.
                method: 'NO_CANDIDATES',
                signalsJson: [],
                candidatesJson: [],
                vetoesJson: [],
                // The CLOCK. Set explicitly rather than left to @default(now()),
                // which is the whole point of the consumed window.
                createdAt: at,
            },
        });
        void i;
    }
    return snap.id;
}

const survives = async (id: string): Promise<boolean> =>
    (await prisma.legacyAccessSnapshot.count({ where: { tenantId: T, id } })) === 1;

const purge = (over: Record<string, unknown> = {}) =>
    purgeLegacyAccessSnapshotsOlderThan({ tenantId: T, now: NOW, ...over });

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.upsert({
        where: { id: T }, update: {},
        create: { id: T, name: 'Legacy Snapshot Retention', slug: T },
    });
});

beforeEach(async () => {
    await clearOwnRows();
    connectionId = (await prisma.integrationConnection.create({
        data: { tenantId: T, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
    })).id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the clock is the CONSUMING RUN, not pulledAt', () => {
    it('a snapshot pulled 200 days ago but consumed 10 days ago SURVIVES', async () => {
        // THE FIRST TRAP the decision named. Keying off `pulledAt` would delete
        // this the week it became relevant: its dispute window opened 10 days
        // ago, when a reviewer was first shown suggestions derived from it.
        const id = await seedSnapshot({
            tag: 'late-consume', pulledAt: daysAgo(200), consumedAt: [daysAgo(10)],
        });
        await purge();
        expect(await survives(id)).toBe(true);
    });

    it('a snapshot consumed 120 days ago is deleted, and its accounts with it', async () => {
        const id = await seedSnapshot({
            tag: 'stale', pulledAt: daysAgo(130), consumedAt: [daysAgo(120)], accounts: 3,
        });
        await purge();
        expect(await survives(id)).toBe(false);
        // The accounts are the PII this issue was filed about. Asserted
        // separately rather than trusted to CASCADE: the cascade is declared in
        // the schema, and a schema change could remove it without touching this
        // job at all.
        expect(await prisma.legacyAccount.count({ where: { tenantId: T, snapshotId: id } }))
            .toBe(0);
    });

    it('it is the LAST consuming run, not the first', async () => {
        // Consumed once long ago and once recently. The recent run is the one
        // whose suggestions a reviewer might dispute, so the window reopened.
        // A MIN or a "first resolution" reading would delete this.
        const id = await seedSnapshot({
            tag: 'reconsumed',
            pulledAt: daysAgo(300),
            consumedAt: [daysAgo(250), daysAgo(5)],
        });
        await purge();
        expect(await survives(id)).toBe(true);
    });

    it('a snapshot consumed exactly at the cutoff is kept, not deleted', async () => {
        // The boundary is `< cutoff`, so a run AT the cutoff survives. Asserted
        // because an off-by-one here destroys a day of other people's evidence
        // and nothing would ever report it.
        const id = await seedSnapshot({
            tag: 'boundary',
            pulledAt: daysAgo(100),
            consumedAt: [daysAgo(DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS)],
        });
        await purge();
        expect(await survives(id)).toBe(true);
    });
});

describe('an unconsumed snapshot still ages out, on its own shorter clock', () => {
    it('pulled 40 days ago and never consumed — deleted', async () => {
        // THE SECOND TRAP. Without this, a connection that pulls and never
        // reconciles keeps named people forever, which is the case #3317 was
        // filed about.
        const id = await seedSnapshot({ tag: 'orphan', pulledAt: daysAgo(40), accounts: 5 });
        await purge();
        expect(await survives(id)).toBe(false);
        expect(await prisma.legacyAccount.count({ where: { tenantId: T } })).toBe(0);
    });

    it('pulled 10 days ago and never consumed — survives', async () => {
        const id = await seedSnapshot({ tag: 'fresh-orphan', pulledAt: daysAgo(10) });
        await purge();
        expect(await survives(id)).toBe(true);
    });

    it('BEING CONSUMED GRANTS THE LONGER WINDOW, which is the disambiguation that matters', async () => {
        // Pulled and consumed 40 days ago: past the 30-day unconsumed clock,
        // inside the 90-day consumed one. The consumed clock must win.
        //
        // Get this wrong and the sweep destroys evidence inside its dispute
        // window while reporting a successful run — the two predicates are
        // disjoint precisely so this cannot happen, and this test is what says
        // they still are.
        const id = await seedSnapshot({
            tag: 'between', pulledAt: daysAgo(40), consumedAt: [daysAgo(40)],
        });
        await purge();
        expect(await survives(id)).toBe(true);
    });
});

describe('the windows are tenant settings', () => {
    it('a tenant row shortens the consumed window', async () => {
        const id = await seedSnapshot({
            tag: 'tenant-short', pulledAt: daysAgo(60), consumedAt: [daysAgo(50)],
        });
        await prisma.tenantSecuritySettings.create({
            data: { tenantId: T, legacySnapshotRetentionDays: 30 },
        });
        await purge();
        expect(await survives(id)).toBe(false);
    });

    it('a tenant row lengthens it, and the same snapshot then survives', async () => {
        // The positive control for the test above. Without it, a settings read
        // that silently returned 0 days would also "pass" the shortening case.
        const id = await seedSnapshot({
            tag: 'tenant-long', pulledAt: daysAgo(400), consumedAt: [daysAgo(200)],
        });
        await prisma.tenantSecuritySettings.create({
            data: { tenantId: T, legacySnapshotRetentionDays: 365 },
        });
        await purge();
        expect(await survives(id)).toBe(true);
    });

    it('a tenant with NO settings row is still swept', async () => {
        // "No settings" must not be an opt-out of retention nobody chose. A
        // tenant that never opened the security page has no row at all.
        expect(await prisma.tenantSecuritySettings.count({ where: { tenantId: T } })).toBe(0);
        const id = await seedSnapshot({ tag: 'no-settings', pulledAt: daysAgo(90) });
        await purge();
        expect(await survives(id)).toBe(false);
    });
});

describe('what the run reports and records', () => {
    it('a dry run destroys nothing and still counts what it would', async () => {
        const id = await seedSnapshot({ tag: 'dry', pulledAt: daysAgo(90), accounts: 4 });
        const results = await purge({ dryRun: true });
        expect(await survives(id)).toBe(true);

        const snap = results.find((r) => r.model === 'LegacyAccessSnapshot');
        const acct = results.find((r) => r.model === 'LegacyAccount');
        expect(snap).toMatchObject({ scanned: 1, purged: 0, dryRun: true });
        // The ACCOUNT count is the figure this issue is about, and it has to be
        // read before the delete because the rows go by CASCADE.
        expect(acct).toMatchObject({ scanned: 4, purged: 0, dryRun: true });
    });

    it('a real run writes an attestation naming BOTH models', async () => {
        await seedSnapshot({ tag: 'attest', pulledAt: daysAgo(90), accounts: 2 });
        await purge();
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T, action: 'DATA_PURGED' },
            select: { entity: true, details: true },
        });
        expect(rows.map((r) => r.entity).sort())
            .toEqual(['LegacyAccessSnapshot', 'LegacyAccount'].sort());
        const acct = rows.find((r) => r.entity === 'LegacyAccount');
        expect(JSON.parse(acct?.details ?? '{}').purged).toBe(2);
    });

    it('a run that finds nothing writes no attestation', async () => {
        // An attestation for a destruction that did not happen is worse than
        // none: it makes the audit trail claim data was purged that still exists.
        await seedSnapshot({ tag: 'keep', pulledAt: daysAgo(5) });
        await purge();
        expect(await prisma.auditLog.count({
            where: { tenantId: T, action: 'DATA_PURGED' },
        })).toBe(0);
    });
});

describe('the cross-sweep coupling', () => {
    it('the consumed window fits inside the identity-artefact retention', () => {
        // LegacyAccountResolution CASCADEs from IntegrationExecution, which
        // purgeIdentityArtefactsOlderThan deletes. So the CONSUMPTION SIGNAL is
        // itself perishable: shorten that window below this one and a consumed
        // snapshot silently reclassifies as unconsumed, then dies on the SHORTER
        // clock — inside its own dispute window, with nothing reporting it.
        //
        // Asserted rather than left as a comment because the two numbers live in
        // different parts of the file and the failure is silent.
        expect(DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS)
            .toBeLessThan(DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS);
        expect(DEFAULT_LEGACY_SNAPSHOT_UNCONSUMED_RETENTION_DAYS)
            .toBeLessThan(DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS);
    });
});
