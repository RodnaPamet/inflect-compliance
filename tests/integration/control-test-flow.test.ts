/**
 * Integration tests for Control Test feature — requires a running PostgreSQL.
 *
 * Tests the full lifecycle: create plan → create run → complete run → evidence linking.
 * Also tests tenant isolation.
 *
 * RUN: npx jest tests/integration/control-test-flow.test.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { computeNextDueAt } from '@/app-layer/utils/cadence';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = withPiiEncryptionExtension(new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
}));

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Control Test Flow — Integration', () => {
    const testRunId = randomUUID();
    let tenantAId: string;
    let tenantBId: string;
    let userAId: string;
    let userBId: string;
    let controlAId: string;
    let controlBId: string;

    beforeAll(async () => {
        // Create two tenants for isolation testing
        const userA = await prisma.user.create({
            data: { email: `ctf-a-${testRunId}@test.com`, name: 'Test User A' },
        });
        userAId = userA.id;

        const userB = await prisma.user.create({
            data: { email: `ctf-b-${testRunId}@test.com`, name: 'Test User B' },
        });
        userBId = userB.id;

        const tenantA = await prisma.tenant.create({
            data: { name: `CTF Tenant A ${testRunId}`, slug: `ctf-a-${testRunId}`, industry: 'Tech', maxRiskScale: 5 },
        });
        tenantAId = tenantA.id;

        const tenantB = await prisma.tenant.create({
            data: { name: `CTF Tenant B ${testRunId}`, slug: `ctf-b-${testRunId}`, industry: 'Tech', maxRiskScale: 5 },
        });
        tenantBId = tenantB.id;

        // Create a control in each tenant
        const controlA = await prisma.control.create({
            data: { tenantId: tenantAId, name: `Test Control A ${testRunId}`, createdByUserId: userAId },
        });
        controlAId = controlA.id;

        const controlB = await prisma.control.create({
            data: { tenantId: tenantBId, name: `Test Control B ${testRunId}`, createdByUserId: userBId },
        });
        controlBId = controlB.id;
    });

    afterAll(async () => {
        if (tenantAId) {
            try {
                await deleteAuditRowsForTenants(prisma, [tenantAId, tenantBId]);
                await prisma.$executeRawUnsafe(`DELETE FROM "ControlTestEvidenceLink" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "ControlTestStep" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "ControlTestRun" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "ControlTestPlan" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" IN ($1, $2)`, tenantAId, tenantBId);
                await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ($1, $2)`, userAId, userBId);
            } catch (e) {
                console.warn('[control-test-flow] cleanup error:', e);
            }
        }
        await prisma.$disconnect().catch(() => {});
    });

    // ─── Test Plan CRUD ───

    it('creates a test plan with steps', async () => {
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                name: 'Quarterly Access Review',
                description: 'Verify all user access is appropriate',
                method: 'MANUAL',
                frequency: 'QUARTERLY',
                createdByUserId: userAId,
            },
        });

        expect(plan.id).toBeDefined();
        expect(plan.tenantId).toBe(tenantAId);
        expect(plan.controlId).toBe(controlAId);
        expect(plan.frequency).toBe('QUARTERLY');
        expect(plan.status).toBe('ACTIVE');

        // Create steps
        await prisma.controlTestStep.createMany({
            data: [
                { tenantId: tenantAId, testPlanId: plan.id, sortOrder: 0, instruction: 'Pull user access report' },
                { tenantId: tenantAId, testPlanId: plan.id, sortOrder: 1, instruction: 'Compare with HR records' },
            ],
        });

        const steps = await prisma.controlTestStep.findMany({
            where: { testPlanId: plan.id },
            orderBy: { sortOrder: 'asc' },
        });
        expect(steps).toHaveLength(2);
        expect(steps[0].instruction).toBe('Pull user access report');
    });

    // ─── Test Run Lifecycle ───

    it('creates a run, completes it with PASS, and updates nextDueAt', async () => {
        // Create a plan with MONTHLY frequency
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                name: 'Monthly Backup Verification',
                frequency: 'MONTHLY',
                createdByUserId: userAId,
            },
        });

        // Create a run
        const run = await prisma.controlTestRun.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                testPlanId: plan.id,
                createdByUserId: userAId,
            },
        });
        expect(run.status).toBe('PLANNED');
        expect(run.result).toBeNull();

        // Complete the run with PASS
        const now = new Date();
        const completedRun = await prisma.controlTestRun.update({
            where: { id: run.id },
            data: {
                status: 'COMPLETED',
                result: 'PASS',
                executedAt: now,
                executedByUserId: userAId,
                notes: 'Backups verified successfully',
            },
        });
        expect(completedRun.status).toBe('COMPLETED');
        expect(completedRun.result).toBe('PASS');
        expect(completedRun.executedAt).toBeTruthy();

        // Update nextDueAt
        const nextDueAt = computeNextDueAt('MONTHLY', now);
        await prisma.controlTestPlan.update({
            where: { id: plan.id },
            data: { nextDueAt },
        });

        const updatedPlan = await prisma.controlTestPlan.findUnique({ where: { id: plan.id } });
        expect(updatedPlan!.nextDueAt).toBeTruthy();

        // Verify nextDueAt is approximately 1 month from now
        const diff = updatedPlan!.nextDueAt!.getTime() - now.getTime();
        const daysDiff = diff / (1000 * 60 * 60 * 24);
        expect(daysDiff).toBeGreaterThanOrEqual(28);
        expect(daysDiff).toBeLessThanOrEqual(31);
    });

    // ─── Evidence Linking ───

    it('links and unlinks evidence to a test run', async () => {
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                name: 'Evidence Test Plan',
                createdByUserId: userAId,
            },
        });

        const run = await prisma.controlTestRun.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                testPlanId: plan.id,
                createdByUserId: userAId,
            },
        });

        // Link a URL evidence
        const link = await prisma.controlTestEvidenceLink.create({
            data: {
                tenantId: tenantAId,
                testRunId: run.id,
                kind: 'LINK',
                url: 'https://example.com/evidence',
                note: 'External screenshot',
                createdByUserId: userAId,
            },
        });
        expect(link.kind).toBe('LINK');
        expect(link.url).toBe('https://example.com/evidence');

        // List evidence for run
        const links = await prisma.controlTestEvidenceLink.findMany({
            where: { testRunId: run.id },
        });
        expect(links).toHaveLength(1);

        // Unlink
        await prisma.controlTestEvidenceLink.delete({ where: { id: link.id } });
        const afterUnlink = await prisma.controlTestEvidenceLink.findMany({
            where: { testRunId: run.id },
        });
        expect(afterUnlink).toHaveLength(0);
    });

    // ─── Tenant Isolation ───

    it('plans in tenant A are not visible when querying tenant B', async () => {
        // Create a plan in tenant A
        await prisma.controlTestPlan.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                name: `Isolation Test Plan ${testRunId}`,
                createdByUserId: userAId,
            },
        });

        // Query plans for tenant B's control — should not include tenant A's plans
        const tenantBPlans = await prisma.controlTestPlan.findMany({
            where: { tenantId: tenantBId },
        });

        const leakedPlan = tenantBPlans.find(p => p.name.includes(testRunId));
        expect(leakedPlan).toBeUndefined();
    });

    it('FAIL result creates expected data structure', async () => {
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                name: 'Fail Test Plan',
                frequency: 'QUARTERLY',
                ownerUserId: userAId,
                createdByUserId: userAId,
            },
        });

        const run = await prisma.controlTestRun.create({
            data: {
                tenantId: tenantAId,
                controlId: controlAId,
                testPlanId: plan.id,
                status: 'COMPLETED',
                result: 'FAIL',
                executedAt: new Date(),
                executedByUserId: userAId,
                findingSummary: 'Access logs show unauthorized access',
                createdByUserId: userAId,
            },
        });

        expect(run.result).toBe('FAIL');
        expect(run.findingSummary).toBe('Access logs show unauthorized access');
        expect(run.status).toBe('COMPLETED');
    });
});
