/**
 * Epic G-7 — operational visibility integration.
 *
 * Coverage
 * --------
 *   1. deadline-monitor scans treatment plans whose targetDate is
 *      past or in-window AND emits one DueItem each with the right
 *      shape (ownerUserId, urgency, daysRemaining).
 *   2. deadline-monitor scans treatment milestones independently
 *      (each non-completed in-window milestone is its own DueItem).
 *   3. Tenant scoping — a single-tenant invocation never emits items
 *      for another tenant's plans/milestones.
 *   4. COMPLETED plans are excluded from the monitor.
 *   5. Dashboard `getTreatmentPlanSummary` returns the right buckets
 *      for the populated tenant.
 *   6. Compliance calendar surfaces both milestone-due AND
 *      plan-target events for the configured month.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { DashboardRepository } from '@/app-layer/repositories/DashboardRepository';
import { runInTenantContext } from '@/lib/db-context';
import { runDeadlineMonitor } from '@/app-layer/jobs/deadline-monitor';
import { getComplianceCalendarEvents } from '@/app-layer/usecases/compliance-calendar';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g7m-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let admin: { userId: string };
let foreignAdmin: { userId: string };
let RISK_A_ID = '';
let RISK_B_ID = '';

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_A_ID },
        update: {},
        create: { id: TENANT_A_ID, name: `t ${SUITE_TAG}-a`, slug: `${SUITE_TAG}-a` },
    });
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_B_ID },
        update: {},
        create: { id: TENANT_B_ID, name: `t ${SUITE_TAG}-b`, slug: `${SUITE_TAG}-b` },
    });
    admin = await makeUser('admin');
    foreignAdmin = await makeUser('foreign');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_A_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_B_ID, userId: foreignAdmin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        ],
    });
    const ra = await globalPrisma.risk.create({
        data: { tenantId: TENANT_A_ID, title: 'Risk A' },
    });
    RISK_A_ID = ra.id;
    const rb = await globalPrisma.risk.create({
        data: { tenantId: TENANT_B_ID, title: 'Risk B' },
    });
    RISK_B_ID = rb.id;
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.treatmentMilestone.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.riskTreatmentPlan.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.risk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    const userIds = [admin, foreignAdmin]
        .filter(Boolean)
        .map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const futureDate = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const pastDate = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

interface PlanFixture {
    riskId: string;
    targetDate: Date;
    status?: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'OVERDUE';
    tenantId?: string;
    ownerUserId?: string;
}

async function makePlan(p: PlanFixture) {
    const tenantId = p.tenantId ?? TENANT_A_ID;
    const ownerUserId = p.ownerUserId ?? admin.userId;
    const isCompleted = p.status === 'COMPLETED';
    return globalPrisma.riskTreatmentPlan.create({
        data: {
            tenantId,
            riskId: p.riskId,
            strategy: 'MITIGATE',
            ownerUserId,
            targetDate: p.targetDate,
            createdByUserId: ownerUserId,
            status: p.status ?? 'ACTIVE',
            ...(isCompleted
                ? {
                      completedAt: new Date(),
                      completedByUserId: ownerUserId,
                      closingRemark: 'auto-fixture',
                  }
                : {}),
        },
    });
}

describeFn('Epic G-7 — operational visibility', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.treatmentMilestone.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
        await globalPrisma.riskTreatmentPlan.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
    });

    // ── 1. deadline-monitor — treatment plan ────────────────────────

    it('deadline-monitor scans treatment plans + emits TREATMENT_PLAN DueItems', async () => {
        // Three plans: one overdue, one urgent, one out-of-window.
        await makePlan({ riskId: RISK_A_ID, targetDate: pastDate(5) });
        await makePlan({ riskId: RISK_A_ID, targetDate: futureDate(3) });
        await makePlan({ riskId: RISK_A_ID, targetDate: futureDate(60) });
        const { items } = await runDeadlineMonitor({
            tenantId: TENANT_A_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        const planItems = items.filter((i) => i.entityType === 'TREATMENT_PLAN');
        // Only the overdue + urgent plans land — out-of-window (60d)
        // is past the 30-day window.
        expect(planItems).toHaveLength(2);
        expect(planItems.find((i) => i.urgency === 'OVERDUE')).toBeDefined();
        expect(planItems.find((i) => i.urgency === 'URGENT')).toBeDefined();
        // Owner attribution propagates from the plan.
        for (const i of planItems) {
            expect(i.ownerUserId).toBe(admin.userId);
        }
    });

    // ── 2. deadline-monitor — milestones ────────────────────────────

    it('deadline-monitor scans milestones independently of plan target dates', async () => {
        const plan = await makePlan({
            riskId: RISK_A_ID,
            targetDate: futureDate(120), // out of window
        });
        await globalPrisma.treatmentMilestone.createMany({
            data: [
                {
                    tenantId: TENANT_A_ID,
                    treatmentPlanId: plan.id,
                    title: 'overdue m',
                    dueDate: pastDate(2),
                    sortOrder: 0,
                },
                {
                    tenantId: TENANT_A_ID,
                    treatmentPlanId: plan.id,
                    title: 'completed m',
                    dueDate: pastDate(5),
                    sortOrder: 1,
                    completedAt: pastDate(3),
                    completedByUserId: admin.userId,
                },
                {
                    tenantId: TENANT_A_ID,
                    treatmentPlanId: plan.id,
                    title: 'urgent m',
                    dueDate: futureDate(2),
                    sortOrder: 2,
                },
            ],
        });
        const { items } = await runDeadlineMonitor({
            tenantId: TENANT_A_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        const milestones = items.filter(
            (i) => i.entityType === 'TREATMENT_MILESTONE',
        );
        // Two non-completed milestones in window.
        expect(milestones.map((m) => m.name).sort()).toEqual(
            ['overdue m', 'urgent m'].sort(),
        );
        // Completed milestone is filtered out.
        expect(milestones.find((m) => m.name === 'completed m')).toBeUndefined();
    });

    // ── 3. Tenant scoping ────────────────────────────────────────────

    it('tenant-scoped invocation does not emit items from other tenants', async () => {
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: pastDate(2),
            tenantId: TENANT_A_ID,
        });
        await makePlan({
            riskId: RISK_B_ID,
            targetDate: pastDate(2),
            tenantId: TENANT_B_ID,
            ownerUserId: foreignAdmin.userId,
        });
        const { items } = await runDeadlineMonitor({
            tenantId: TENANT_A_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        const planItems = items.filter((i) => i.entityType === 'TREATMENT_PLAN');
        for (const i of planItems) {
            expect(i.tenantId).toBe(TENANT_A_ID);
        }
    });

    // ── 4. COMPLETED plans excluded ─────────────────────────────────

    it('COMPLETED plans are excluded from the monitor', async () => {
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: pastDate(60),
            status: 'COMPLETED',
        });
        const { items } = await runDeadlineMonitor({
            tenantId: TENANT_A_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        expect(
            items.find((i) => i.entityType === 'TREATMENT_PLAN'),
        ).toBeUndefined();
    });

    // ── 5. Dashboard summary ────────────────────────────────────────

    it('getTreatmentPlanSummary returns the right buckets', async () => {
        // Mix: 1 active+future, 1 overdue, 1 within-7, 1 completed.
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: futureDate(60),
        });
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: pastDate(3),
        });
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: futureDate(5),
        });
        await makePlan({
            riskId: RISK_A_ID,
            targetDate: futureDate(60),
            status: 'COMPLETED',
        });
        const ctx = makeRequestContext(Role.ADMIN, {
            userId: admin.userId,
            tenantId: TENANT_A_ID,
        });
        const summary = await runInTenantContext(ctx, (db) =>
            DashboardRepository.getTreatmentPlanSummary(db, ctx),
        );
        // 60d future + 5d future are activeOnTrack (status DRAFT/ACTIVE
        // + targetDate > now).
        expect(summary.activeOnTrack).toBe(2);
        // pastDate(3) is overdue.
        expect(summary.overdue).toBe(1);
        // 5d + 60d are both within "active on track"; only 5d is
        // within the 30-day forward window, and only 5d is within 7d.
        expect(summary.dueWithin30).toBe(1);
        expect(summary.dueWithin7).toBe(1);
        expect(summary.completed).toBe(1);
    });

    // ── 6. Compliance calendar ──────────────────────────────────────

    it('compliance calendar surfaces milestone-due AND plan-target events', async () => {
        const plan = await makePlan({
            riskId: RISK_A_ID,
            targetDate: futureDate(15),
        });
        await globalPrisma.treatmentMilestone.create({
            data: {
                tenantId: TENANT_A_ID,
                treatmentPlanId: plan.id,
                title: 'cal milestone',
                dueDate: futureDate(7),
                sortOrder: 0,
            },
        });
        const ctx = makeRequestContext(Role.ADMIN, {
            userId: admin.userId,
            tenantId: TENANT_A_ID,
        });
        const today = new Date();
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const monthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0);
        const result = await getComplianceCalendarEvents(ctx, {
            from: monthStart,
            to: monthEnd,
        });
        const milestoneEvents = result.events.filter(
            (e) => e.type === 'treatment-milestone-due',
        );
        const planEvents = result.events.filter(
            (e) => e.type === 'treatment-plan-target',
        );
        expect(milestoneEvents.length).toBeGreaterThanOrEqual(1);
        expect(planEvents.length).toBeGreaterThanOrEqual(1);
        // Milestone event links back to the parent risk's detail page.
        expect(milestoneEvents[0].href).toContain(`/risks/${RISK_A_ID}`);
        expect(milestoneEvents[0].entityType).toBe('TREATMENT_MILESTONE');
        expect(planEvents[0].entityType).toBe('RISK_TREATMENT_PLAN');
    });
});
