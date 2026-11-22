/**
 * The generic readiness profile (any framework but ISO 27001 and NIS2) asked
 * Prisma for controls whose applicability was 'APPLIES', a value the
 * `Applicability` enum does not have (#5062). Prisma refuses an unknown enum
 * value, so every SOC 2, DORA or custom-framework cycle failed to score at all.
 *
 * Real DB, because the defect was invisible to a mocked client: the mock
 * returned rows whatever the filter said.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { scoreReadiness } from '@/app-layer/usecases/audit-readiness/scoring';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `rg-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const FW_KEY = `GENERIC_${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

describeFn('generic readiness profile (real DB)', () => {
    let cycleId: string;
    let frameworkId: string;

    beforeAll(async () => {
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({
            where: { id: ctx.userId }, update: {},
            create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
        });
        const fw = await prisma.framework.create({ data: { key: FW_KEY, name: 'Generic test framework', version: '1' } });
        frameworkId = fw.id;
        const [r1, r2] = await Promise.all([
            prisma.frameworkRequirement.create({ data: { frameworkId, code: 'R-1', title: 'Mapped to an applicable control' } }),
            prisma.frameworkRequirement.create({ data: { frameworkId, code: 'R-2', title: 'Mapped only to an excluded control' } }),
        ]);
        const applicable = await prisma.control.create({ data: { tenantId: TENANT, name: 'Applicable', code: 'C-A', applicability: 'APPLICABLE' } });
        const excluded = await prisma.control.create({ data: { tenantId: TENANT, name: 'Excluded', code: 'C-N', applicability: 'NOT_APPLICABLE' } });
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: TENANT, controlId: applicable.id, requirementId: r1.id },
                { tenantId: TENANT, controlId: excluded.id, requirementId: r2.id },
            ],
        });
        const cycle = await prisma.auditCycle.create({
            data: { tenant: { connect: { id: TENANT } }, frameworkKey: FW_KEY, frameworkVersion: '1', name: 'Cycle', createdBy: { connect: { id: ctx.userId } } },
        });
        cycleId = cycle.id;
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.auditCycle.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        if (frameworkId) {
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } });
            await prisma.framework.deleteMany({ where: { id: frameworkId } });
        }
        await prisma.$disconnect();
    });

    it('scores the cycle, counting only requirements mapped to an applicable control', async () => {
        const result = await scoreReadiness(ctx, cycleId);

        expect(result.frameworkKey).toBe(FW_KEY);
        expect(result.breakdown.coverage).toMatchObject({ mapped: 1, total: 2, score: 50 });
        // The excluded control is not in the evidence population either.
        expect(result.breakdown.evidence).toMatchObject({ withEvidence: 0, total: 1 });
        expect(result.gaps.filter((g) => g.type === 'UNMAPPED_REQUIREMENT').map((g) => g.title)).toEqual([
            'R-2: Mapped only to an excluded control',
        ]);
    });
});
