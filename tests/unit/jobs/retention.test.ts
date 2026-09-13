/**
 * Branch coverage for the evidence retention sweep job
 * (`src/app-layer/jobs/retention.ts` — runEvidenceRetentionSweep).
 *
 * DB-backed: the executor is a plain async function that drives
 * `@/lib/prisma` directly (no BullMQ Job wrapper), so we seed real
 * Evidence rows via prismaTestClient and assert the effects.
 *
 * Cross-link: the per-tenant DEK rotation lifecycle is covered by
 * `tests/integration/tenant-dek-rotation.test.ts`; the cross-model
 * retention SWEEP variant lives in
 * `tests/unit/jobs/data-lifecycle.test.ts`. This file focuses on the
 * Evidence-specific archival branches of retention.ts only.
 *
 * Branches exercised:
 *   - empty batch (no eligible evidence) → scanned 0.
 *   - dryRun early-return branch (counts but no writes).
 *   - found rows: sets isArchived + expiredAt when expiredAt is null
 *     (the `!ev.expiredAt` branch → expired++ + EVIDENCE_EXPIRED audit).
 *   - idempotency: a row already carrying expiredAt is archived but
 *     NOT re-expired (the else side of `!ev.expiredAt`).
 *   - tenantId-scoped vs all-tenant `where` branch.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { runEvidenceRetentionSweep } from '@/app-layer/jobs/retention';
import { deleteAuditRowsForTenants } from '../../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `ret-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const PAST = new Date(Date.now() - 86_400_000); // yesterday

describeFn('runEvidenceRetentionSweep (real DB)', () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
    });

    afterAll(async () => {
        await cleanupTenant(prisma, TENANT);
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await cleanupTenant(prisma, TENANT);
    });

    async function seedEvidence(overrides: Record<string, unknown> = {}) {
        return prisma.evidence.create({
            data: {
                tenantId: TENANT,
                type: 'FILE',
                title: `ev-${randomUUID().slice(0, 6)}`,
                retentionUntil: PAST,
                isArchived: false,
                ...overrides,
            },
        });
    }

    it('returns scanned=0 when nothing is eligible (empty batch)', async () => {
        const res = await runEvidenceRetentionSweep({ tenantId: TENANT });
        expect(res).toEqual({ scanned: 0, expired: 0, archived: 0, dryRun: false });
    });

    it('dryRun reports counts without mutating rows', async () => {
        await seedEvidence();
        const res = await runEvidenceRetentionSweep({ tenantId: TENANT, dryRun: true });
        expect(res.dryRun).toBe(true);
        expect(res.scanned).toBe(1);
        // No write happened — row is still not archived.
        const rows = await prisma.evidence.findMany({ where: { tenantId: TENANT } });
        expect(rows[0].isArchived).toBe(false);
        expect(rows[0].expiredAt).toBeNull();
    });

    it('archives expired evidence and sets expiredAt when previously null', async () => {
        const ev = await seedEvidence();
        const res = await runEvidenceRetentionSweep({ tenantId: TENANT });
        expect(res.scanned).toBe(1);
        expect(res.expired).toBe(1);
        expect(res.archived).toBe(1);

        const after = await prisma.evidence.findUnique({ where: { id: ev.id } });
        expect(after?.isArchived).toBe(true);
        expect(after?.expiredAt).not.toBeNull();

        // Two audit rows: EVIDENCE_EXPIRED + EVIDENCE_ARCHIVED.
        const actions = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, entityId: ev.id },
            select: { action: true },
        });
        const set = new Set(actions.map((a) => a.action));
        expect(set.has('EVIDENCE_EXPIRED')).toBe(true);
        expect(set.has('EVIDENCE_ARCHIVED')).toBe(true);
    });

    it('is idempotent: a row already carrying expiredAt is archived but not re-expired', async () => {
        const ev = await seedEvidence({ expiredAt: PAST });
        const res = await runEvidenceRetentionSweep({ tenantId: TENANT });
        expect(res.scanned).toBe(1);
        expect(res.archived).toBe(1);
        // expiredAt already set → not counted as a fresh expiry.
        expect(res.expired).toBe(0);

        const actions = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, entityId: ev.id },
            select: { action: true },
        });
        const set = new Set(actions.map((a) => a.action));
        // Only the ARCHIVED row is written (no EVIDENCE_EXPIRED).
        expect(set.has('EVIDENCE_ARCHIVED')).toBe(true);
        expect(set.has('EVIDENCE_EXPIRED')).toBe(false);
    });

    it('the all-tenant path (no tenantId option) still picks up our row', async () => {
        const ev = await seedEvidence();
        const res = await runEvidenceRetentionSweep({});
        // Other suites may seed evidence too; assert our row was handled.
        expect(res.scanned).toBeGreaterThanOrEqual(1);
        const after = await prisma.evidence.findUnique({ where: { id: ev.id } });
        expect(after?.isArchived).toBe(true);
    });
});

async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
    await deleteAuditRowsForTenants(prisma, tenantId);
    await prisma.evidence.deleteMany({ where: { tenantId } });
}
