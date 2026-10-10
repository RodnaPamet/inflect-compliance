/**
 * Step 5b: creating a legacy recertification campaign.
 *
 * Five refusals, each with its own test, because each is a different way the
 * campaign's central claim — "somebody certified a known population at a known
 * moment" — could be false, and a shared assertion would pass on the wrong one.
 *
 * Plus the FREEZE: a later pull must change nothing in an open campaign. That
 * one is asserted by actually pulling again, not by reading the code.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import {
    LEGACY_CAMPAIGN_REFUSALS,
    SNAPSHOT_FRESHNESS_MS,
    createLegacyAccessReview,
} from '@/app-layer/usecases/access-review-legacy';
import { closeConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { verifySnapshotPayloadHash } from '@/app-layer/usecases/legacy-access-verify';
import { computePayloadHash } from '@/lib/legacy-access/canonical';

const prisma: PrismaClient = prismaTestClient();
const T = 'lar-tenant';
const ctx = (role = 'ADMIN') => makeRequestContext(role, { tenantId: T });

let connectionId = '';
let reviewerId = '';
let employeeId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.legacyIdentityAlias.deleteMany({ where: t });
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyAccount.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
}

/** A COMPLETE, fresh snapshot with one account and one resolution. */
async function seedHappyPath(opts: {
    status?: 'COMPLETE' | 'PARTIAL';
    completedAt?: Date | null;
    withAccounts?: boolean;
    withResolution?: boolean;
} = {}) {
    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: T, connectionId, remoteSnapshotId: `snap-${Date.now()}`,
            mappingVersion: 3, columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'a'.repeat(64), rowCount: 1, rowsReceived: 1,
            status: opts.status ?? 'COMPLETE',
            completedAt: opts.completedAt === undefined ? new Date() : opts.completedAt,
        },
    });
    if (opts.withAccounts !== false) {
        await prisma.legacyAccount.create({
            data: {
                tenantId: T, snapshotId: snap.id, accountKey: 'jsmith',
                displayName: 'Jane Smith', email: 'jane@lar.test',
                department: 'Finance', status: 'ACTIVE', accountType: 'HUMAN',
                isPrivileged: true, entitlements: ['admin'],
                lastLoginAt: new Date(),
            },
        });
    }
    if (opts.withResolution !== false) {
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T, connectionId, status: 'PASSED',
                provider: 'legacy-mcp', automationKey: 'legacy-mcp.reconcile',
                executedAt: new Date(), completedAt: new Date(),
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T, executionId: exec.id, snapshotId: snap.id,
                accountKey: 'jsmith', outcome: 'LINKED', method: 'EMAIL_EXACT',
                employeeId, signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });
    }
    return snap;
}

const create = (over: Record<string, unknown> = {}) =>
    createLegacyAccessReview(ctx(), {
        name: 'Q4 legacy recertification',
        connectionId,
        reviewerUserId: reviewerId,
        ...over,
    });

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.upsert({
        where: { id: T }, update: {},
        create: { id: T, name: 'Legacy Review Tenant', slug: T },
    });
    await prisma.user.upsert({
        where: { id: 'user-1' }, update: {},
        create: { id: 'user-1', email: 'reviewer@lar.test', name: 'Reviewer' },
    });
    reviewerId = 'user-1';
});

beforeEach(async () => {
    await clearOwnRows();
    connectionId = (await prisma.integrationConnection.create({
        data: { tenantId: T, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
    })).id;
    employeeId = (await prisma.employee.create({
        data: {
            tenantId: T, fullName: 'Jane Smith', workEmail: 'jane@lar.test',
            status: 'ACTIVE', department: 'Finance',
        },
    })).id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the five refusals, each named', () => {
    it('NO_SNAPSHOT — the application has never been pulled', async () => {
        await expect(create()).rejects.toThrow(/NO_SNAPSHOT/);
    });

    it('SNAPSHOT_INCOMPLETE — the pull did not cover the population', async () => {
        await seedHappyPath({ status: 'PARTIAL' });
        await expect(create()).rejects.toThrow(/SNAPSHOT_INCOMPLETE/);
    });

    it('SNAPSHOT_STALE — the pull is outside the freshness window', async () => {
        await seedHappyPath({
            completedAt: new Date(Date.now() - SNAPSHOT_FRESHNESS_MS * 2),
        });
        await expect(create()).rejects.toThrow(/SNAPSHOT_STALE/);
    });

    it('INCOMPLETE is reported BEFORE staleness, not after', async () => {
        // A torn pull usually has no completedAt, so asking about freshness
        // first would report staleness and send somebody to re-pull rather
        // than to look at why the pull tore.
        await seedHappyPath({ status: 'PARTIAL', completedAt: null });
        await expect(create()).rejects.toThrow(/SNAPSHOT_INCOMPLETE/);
    });

    it('NOT_RECONCILED — no resolution exists for the snapshot', async () => {
        await seedHappyPath({ withResolution: false });
        await expect(create()).rejects.toThrow(/NOT_RECONCILED/);
    });

    it('NO_SUBJECTS — the snapshot holds no accounts', async () => {
        await seedHappyPath({ withAccounts: false, withResolution: false });
        // Reconcile it so the subject check is what fires, not NOT_RECONCILED.
        const snap = await prisma.legacyAccessSnapshot.findFirstOrThrow({ where: { tenantId: T } });
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T, connectionId, status: 'PASSED', provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', executedAt: new Date(), completedAt: new Date(),
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T, executionId: exec.id, snapshotId: snap.id,
                accountKey: 'ghost', outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
                signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });
        await expect(create()).rejects.toThrow(/NO_SUBJECTS/);
    });

    it('every declared refusal is reachable', async () => {
        // The denominator: a sixth refusal added to the union with no test
        // would otherwise sit there unexercised.
        expect(LEGACY_CAMPAIGN_REFUSALS).toHaveLength(5);
        expect([...LEGACY_CAMPAIGN_REFUSALS].sort()).toEqual([
            'NOT_RECONCILED', 'NO_SNAPSHOT', 'NO_SUBJECTS',
            'SNAPSHOT_INCOMPLETE', 'SNAPSHOT_STALE',
        ]);
    });
});

describe('a created campaign', () => {
    it('freezes the subject with its canonical fields, resolution, HR and findings', async () => {
        const snap = await seedHappyPath();
        const r = await create();

        expect(r.subjectCount).toBe(1);
        expect(r.snapshotId).toBe(snap.id);
        expect(r.snapshotTruncated).toBe(false);

        const d = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { tenantId: T, accessReviewId: r.accessReviewId },
        });
        expect(d.subjectRef).toBe(`${connectionId}:jsmith`);
        // NULL on purpose — a legacy account has no ConnectedIdentityAccount,
        // and inventing one would put a row in the directory tables.
        expect(d.connectedAccountId).toBeNull();

        const s = d.snapshotJson as Record<string, unknown>;
        expect(s.accountKey).toBe('jsmith');
        expect(s.department).toBe('Finance');
        expect((s.resolution as Record<string, unknown>).method).toBe('EMAIL_EXACT');
        expect((s.hr as Record<string, unknown>).employmentStatus).toBe('ACTIVE');
        // The provenance an auditor ties the campaign to.
        expect((s.provenance as Record<string, unknown>).payloadHash).toBe('a'.repeat(64));
        expect((s.provenance as Record<string, unknown>).mappingVersion).toBe(3);
        // PRIVILEGED, from the fixture's isPrivileged.
        expect(s.findings).toContain('PRIVILEGED');
    });

    it('reports the finding counts to the creator', async () => {
        await seedHappyPath();
        const r = await create();
        expect(r.findingCounts.PRIVILEGED).toBe(1);
    });

    it('records the payload hash in a hash-chained audit row', async () => {
        await seedHappyPath();
        const r = await create();
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T, action: 'LEGACY_ACCESS_REVIEW_CREATED' },
        });
        const d = row.detailsJson as Record<string, unknown>;
        expect(d.payloadHash).toBe('a'.repeat(64));
        expect(d.snapshotId).toBe(r.snapshotId);
        expect(d.scope).toBe('LEGACY_APP');
    });

    it('is FROZEN: a later pull changes nothing in the open campaign', async () => {
        await seedHappyPath();
        const r = await create();
        const before = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { tenantId: T, accessReviewId: r.accessReviewId },
        });

        // A second pull that says something different about the same account.
        const snap2 = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: T, connectionId, remoteSnapshotId: 'snap-later',
                mappingVersion: 4, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: 'b'.repeat(64), rowCount: 1, rowsReceived: 1,
                status: 'COMPLETE', completedAt: new Date(),
            },
        });
        await prisma.legacyAccount.create({
            data: {
                tenantId: T, snapshotId: snap2.id, accountKey: 'jsmith',
                displayName: 'Jane Smith-Jones', department: 'Engineering',
                status: 'DISABLED', accountType: 'HUMAN', isPrivileged: false,
                entitlements: [],
            },
        });

        const after = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { tenantId: T, accessReviewId: r.accessReviewId },
        });
        // Byte-identical. The decision is against the state somebody SAW.
        expect(after.snapshotJson).toEqual(before.snapshotJson);
        expect((after.snapshotJson as Record<string, unknown>).department).toBe('Finance');
    });

    it('refuses a non-admin', async () => {
        await seedHappyPath();
        await expect(
            createLegacyAccessReview(ctx('READER'), {
                name: 'nope', connectionId, reviewerUserId: reviewerId,
            })
        ).rejects.toThrow();
    });
});

describe('closing a LEGACY_APP campaign', () => {
    /** Decide every subject so the pending guard does not fire. */
    async function decideAll(accessReviewId: string, decision: 'CONFIRM' | 'REVOKE') {
        await prisma.accessReviewConnectedDecision.updateMany({
            where: { tenantId: T, accessReviewId },
            data: { decision, decidedAt: new Date(), decidedByUserId: reviewerId },
        });
    }

    it('routes through the connected close rather than a third implementation', async () => {
        await seedHappyPath();
        const r = await create();
        await decideAll(r.accessReviewId, 'CONFIRM');

        const closed = await closeConnectedAccessReview(ctx(), r.accessReviewId);
        expect(closed).toBeTruthy();
        const review = await prisma.accessReview.findFirstOrThrow({
            where: { id: r.accessReviewId, tenantId: T },
        });
        expect(review.status).toBe('CLOSED');
    });

    it('a REVOKE raises one task, and closing twice raises no second one', async () => {
        await seedHappyPath();
        const r = await create();
        await decideAll(r.accessReviewId, 'REVOKE');

        await closeConnectedAccessReview(ctx(), r.accessReviewId);
        const first = await prisma.task.count({ where: { tenantId: T } });
        expect(first).toBe(1);

        // A second close is refused outright, which is the strongest form of
        // idempotence available here — but the executedAt stamps are what make
        // a PARTIAL re-entry safe, so assert the task count either way.
        await expect(closeConnectedAccessReview(ctx(), r.accessReviewId)).rejects.toThrow();
        expect(await prisma.task.count({ where: { tenantId: T } })).toBe(first);
    });

    it("the revoke task tells the reviewer to act in the LEGACY app, not a directory", async () => {
        // Wording is an instruction. "in the identity provider" would invite
        // somebody to wait for an automation that will never run — nothing of
        // ours writes to a legacy application.
        await seedHappyPath();
        const r = await create();
        await decideAll(r.accessReviewId, 'REVOKE');
        await closeConnectedAccessReview(ctx(), r.accessReviewId);

        // `Task.description` is in the encryption manifest, so the raw client
        // returns ciphertext. Assert it was WRITTEN and is encrypted here; the
        // wording itself is asserted against `remediationDescription` in
        // tests/unit/legacy-findings.test.ts, where it is plaintext.
        const task = await prisma.task.findFirstOrThrow({ where: { tenantId: T } });
        expect(task.description).not.toBeNull();
        expect(task.description).toMatch(/^v\d+:/);
        expect(task.title).toContain('jsmith');
    });

    it('the stored payload hash re-derives from the stored rows', async () => {
        // The hardening item, through the usecase an AUDITOR would use rather
        // than a re-implementation of the derivation in the test — which would
        // only prove the test agrees with itself.
        const accounts = [
            {
                accountKey: 'aaa', username: 'aaa', displayName: 'A A', givenName: 'A',
                familyName: 'A', email: 'a@lar.test', employeeNumber: null,
                department: 'Finance', title: null, managerRef: null, status: 'ACTIVE' as const,
                lastLoginAt: new Date('2026-10-01T00:00:00.000Z'), sourceCreatedAt: null,
                expiresAt: null, entitlements: ['reader'], isPrivileged: false,
                accountType: 'HUMAN' as const,
            },
            {
                accountKey: 'bbb', username: 'bbb', displayName: 'B B', givenName: 'B',
                familyName: 'B', email: 'b@lar.test', employeeNumber: null,
                department: 'Ops', title: null, managerRef: null, status: 'ACTIVE' as const,
                lastLoginAt: new Date('2026-10-02T00:00:00.000Z'), sourceCreatedAt: null,
                expiresAt: null, entitlements: [], isPrivileged: true,
                accountType: 'HUMAN' as const,
            },
        ];
        const realHash = computePayloadHash(accounts as never);

        const snap = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: T, connectionId, remoteSnapshotId: 'snap-hash',
                mappingVersion: 7, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: realHash, rowCount: accounts.length,
                rowsReceived: accounts.length, status: 'COMPLETE', completedAt: new Date(),
            },
        });
        await prisma.legacyAccount.createMany({
            data: accounts.map((a) => ({ tenantId: T, snapshotId: snap.id, ...a })),
        });

        const verdict = await verifySnapshotPayloadHash(ctx('OWNER'), snap.id);
        // `verified`, and the two hashes equal. Asserting the boolean alone
        // would pass against a verifier that returned true unconditionally.
        expect(verdict).toMatchObject({ verified: true, reason: null });
        expect(verdict.recomputedHash).toBe(realHash);
        expect(verdict.storedHash).toBe(verdict.recomputedHash);
        expect(verdict.rowCount).toBe(accounts.length);
    });

    it('and that same hash reaches the campaign subjects as provenance', async () => {
        // The join an auditor makes: the artefact's provenance must name the
        // hash that re-derives, not some other snapshot's.
        const accounts = [{
            accountKey: 'ccc', username: 'ccc', displayName: 'C C', givenName: 'C',
            familyName: 'C', email: 'c@lar.test', employeeNumber: null,
            department: 'Finance', title: null, managerRef: null, status: 'ACTIVE' as const,
            lastLoginAt: new Date('2026-10-03T00:00:00.000Z'), sourceCreatedAt: null,
            expiresAt: null, entitlements: [], isPrivileged: false, accountType: 'HUMAN' as const,
        }];
        const realHash = computePayloadHash(accounts as never);
        const snap = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: T, connectionId, remoteSnapshotId: 'snap-prov',
                mappingVersion: 9, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: realHash, rowCount: 1, rowsReceived: 1,
                status: 'COMPLETE', completedAt: new Date(),
            },
        });
        await prisma.legacyAccount.createMany({
            data: accounts.map((a) => ({ tenantId: T, snapshotId: snap.id, ...a })),
        });
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T, connectionId, status: 'PASSED', provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', executedAt: new Date(), completedAt: new Date(),
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T, executionId: exec.id, snapshotId: snap.id,
                accountKey: 'ccc', outcome: 'LINKED', method: 'MANUAL',
                employeeId, signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });

        const r = await create({ name: 'hash provenance campaign' });
        const d = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { tenantId: T, accessReviewId: r.accessReviewId },
        });
        const prov = (d.snapshotJson as Record<string, unknown>).provenance as Record<string, unknown>;
        expect(prov.payloadHash).toBe(realHash);
        expect(prov.mappingVersion).toBe(9);
        // And the resolution METHOD, which is what the PDF's "Attributed by"
        // column renders — an auditor is entitled to know whether a person said
        // so or a similarity scorer did.
        expect((d.snapshotJson as Record<string, unknown>).resolution)
            .toMatchObject({ method: 'MANUAL' });
    });
});
