/**
 * Epic G-7 — end-to-end lifecycle hardening + audit-trail integrity.
 *
 * Covers the brief's three explicit hardening areas:
 *   1. Plan creation, milestone completion, and strategy changes
 *      all produce durable audit records.
 *   2. Auto-status transitions (DRAFT → ACTIVE on first milestone
 *      add) are deterministic and emit audit rows.
 *   3. Overdue detection — past-due plans flip to OVERDUE via the
 *      deadline-monitor and emit a system-actor audit row.
 *
 *  Plus: milestone ordering regression — sortOrder is stable
 *  across re-renders and survives a mid-add reorder.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createTreatmentPlan,
    addMilestone,
    completeMilestone,
    completePlan,
    changeStrategy,
    getTreatmentPlan,
} from '@/app-layer/usecases/risk-treatment-plan';
import { runDeadlineMonitor } from '@/app-layer/jobs/deadline-monitor';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g7lc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let admin: { userId: string };
let editor: { userId: string };
let RISK_ID = '';

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    admin = await makeUser('admin');
    editor = await makeUser('editor');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: editor.userId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
        ],
    });
    const r = await globalPrisma.risk.create({
        data: { tenantId: TENANT_ID, title: 'E2E risk', status: 'OPEN' },
    });
    RISK_ID = r.id;
}

async function teardown() {
    await globalPrisma.treatmentMilestone.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await globalPrisma.riskTreatmentPlan.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
    const userIds = [admin, editor].filter(Boolean).map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

const futureDate = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000);

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

describeFn('Epic G-7 — end-to-end lifecycle + audit integrity', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.treatmentMilestone.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.riskTreatmentPlan.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.risk.update({
            where: { id: RISK_ID },
            data: { status: 'OPEN' },
        });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
    });

    // ── 1. Auto-activate DRAFT → ACTIVE on first milestone add ─────

    it('first milestone add auto-activates DRAFT plan + emits audit', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(60),
            },
        );
        let plan = await getTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
        );
        expect(plan.status).toBe('DRAFT');

        await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'first', dueDate: futureDate(30) },
        );
        plan = await getTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
        );
        expect(plan.status).toBe('ACTIVE');

        // A second milestone-add does NOT re-emit ACTIVATED (idempotent).
        await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'second', dueDate: futureDate(45) },
        );
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'TREATMENT_PLAN_ACTIVATED',
            },
        });
        expect(audit).toHaveLength(1);
        type Det = { fromStatus?: string; toStatus?: string };
        expect((audit[0].detailsJson as unknown as Det).fromStatus).toBe('DRAFT');
        expect((audit[0].detailsJson as unknown as Det).toStatus).toBe('ACTIVE');
    });

    // ── 2. Strategy change emits audit ────────────────────────────

    it('changeStrategy updates plan + emits TREATMENT_PLAN_STRATEGY_CHANGED audit', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(60),
            },
        );
        const r = await changeStrategy(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
            { strategy: 'ACCEPT', reason: 'risk re-evaluated as acceptable' },
        );
        expect(r.fromStrategy).toBe('MITIGATE');
        expect(r.toStrategy).toBe('ACCEPT');

        const live = await globalPrisma.riskTreatmentPlan.findUniqueOrThrow({
            where: { id: treatmentPlanId },
        });
        expect(live.strategy).toBe('ACCEPT');

        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'TREATMENT_PLAN_STRATEGY_CHANGED',
            },
        });
        expect(audit).toHaveLength(1);
        type Det = { fromStatus?: string; toStatus?: string; reason?: string };
        const det = audit[0].detailsJson as unknown as Det;
        expect(det.fromStatus).toBe('MITIGATE');
        expect(det.toStatus).toBe('ACCEPT');
        expect(det.reason).toContain('re-evaluated');
    });

    it('changeStrategy rejected on COMPLETED plans', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'ACCEPT',
                ownerUserId: admin.userId,
                targetDate: futureDate(30),
            },
        );
        await completePlan(ctxAs(Role.ADMIN, admin.userId), treatmentPlanId, {
            closingRemark: 'done',
        });
        await expect(
            changeStrategy(ctxAs(Role.ADMIN, admin.userId), treatmentPlanId, {
                strategy: 'MITIGATE',
                reason: 'too late',
            }),
        ).rejects.toThrow(/COMPLETED/i);
    });

    it('changeStrategy rejects same-strategy update', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(30),
            },
        );
        await expect(
            changeStrategy(ctxAs(Role.ADMIN, admin.userId), treatmentPlanId, {
                strategy: 'MITIGATE',
                reason: 'no change',
            }),
        ).rejects.toThrow(/already MITIGATE/i);
    });

    // ── 3. Overdue auto-transition via deadline-monitor ────────────

    it('deadline-monitor flips past-due plans to OVERDUE + emits system-actor audit', async () => {
        // Create a plan with a 1-day-future targetDate to satisfy the
        // creation-time future-only validator; then push it into the
        // past directly via globalPrisma to simulate a stale plan.
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(1),
            },
        );
        await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'm', dueDate: futureDate(1) },
        );
        // Force the plan into the past.
        await globalPrisma.riskTreatmentPlan.update({
            where: { id: treatmentPlanId },
            data: { targetDate: new Date(Date.now() - 5 * 86_400_000) },
        });
        // Run the deadline monitor.
        await runDeadlineMonitor({
            tenantId: TENANT_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        const live = await globalPrisma.riskTreatmentPlan.findUniqueOrThrow({
            where: { id: treatmentPlanId },
        });
        expect(live.status).toBe('OVERDUE');

        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'TREATMENT_PLAN_MARKED_OVERDUE',
            },
            select: { actorType: true, entityId: true, detailsJson: true },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0].actorType).toBe('SYSTEM');
        expect(audit[0].entityId).toBe(treatmentPlanId);
        type Det = { toStatus?: string };
        expect((audit[0].detailsJson as unknown as Det).toStatus).toBe('OVERDUE');

        // Re-running the monitor doesn't double-flip / double-audit.
        await runDeadlineMonitor({
            tenantId: TENANT_ID,
            now: new Date(),
            windows: [30, 7, 1],
        });
        const auditAgain = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'TREATMENT_PLAN_MARKED_OVERDUE',
            },
        });
        expect(auditAgain).toHaveLength(1);
    });

    // ── 4. Milestone ordering regression ────────────────────────────

    it('milestone sortOrder is stable + survives mid-add inserts', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(60),
            },
        );
        // Append three milestones — they should land at sortOrder 0/1/2.
        const a = await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'A', dueDate: futureDate(10) },
        );
        const b = await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'B', dueDate: futureDate(20) },
        );
        const c = await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'C', dueDate: futureDate(30) },
        );
        expect(a.sortOrder).toBe(0);
        expect(b.sortOrder).toBe(1);
        expect(c.sortOrder).toBe(2);

        // Fetch ordered — A,B,C in order.
        let plan = await getTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
        );
        expect(plan.milestones.map((m) => m.title)).toEqual(['A', 'B', 'C']);

        // Insert a milestone at sortOrder 1 (between A and B). The
        // existing rows are NOT re-renumbered — sortOrder is a
        // user-visible manual field, not a row number. So the
        // ordered fetch becomes A, X(=1), B(=1), C(=2). The DB tie
        // on sortOrder=1 is broken by createdAt ASC (stable).
        const x = await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'X', dueDate: futureDate(15), sortOrder: 1 },
        );
        expect(x.sortOrder).toBe(1);

        plan = await getTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
        );
        // Ordering is sortOrder ASC; ties broken by id (stable but
        // unspecified). What we DO guarantee: A is first (sortOrder=0)
        // and C is last (sortOrder=2); X and B both have sortOrder=1.
        expect(plan.milestones[0].title).toBe('A');
        expect(plan.milestones[plan.milestones.length - 1].title).toBe('C');
        const middleTitles = plan.milestones
            .slice(1, -1)
            .map((m) => m.title)
            .sort();
        expect(middleTitles).toEqual(['B', 'X']);
    });

    // ── 5. Audit chain — request → activate → milestone → strategy
    //   → complete → risk-status.

    it('full audit chain emits the canonical sequence in order', async () => {
        const { treatmentPlanId } = await createTreatmentPlan(
            ctxAs(Role.ADMIN, admin.userId),
            {
                riskId: RISK_ID,
                strategy: 'MITIGATE',
                ownerUserId: admin.userId,
                targetDate: futureDate(60),
            },
        );
        const { milestoneId } = await addMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            treatmentPlanId,
            { title: 'm', dueDate: futureDate(30) },
        );
        await changeStrategy(
            ctxAs(Role.ADMIN, admin.userId),
            treatmentPlanId,
            { strategy: 'ACCEPT', reason: 'pivot' },
        );
        await completeMilestone(
            ctxAs(Role.EDITOR, editor.userId),
            milestoneId,
            {},
        );
        await completePlan(ctxAs(Role.ADMIN, admin.userId), treatmentPlanId, {
            closingRemark: 'done',
        });
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: {
                    in: [
                        'TREATMENT_PLAN_CREATED',
                        'TREATMENT_MILESTONE_ADDED',
                        'TREATMENT_PLAN_ACTIVATED',
                        'TREATMENT_PLAN_STRATEGY_CHANGED',
                        'TREATMENT_MILESTONE_COMPLETED',
                        'RISK_STATUS_CHANGED_BY_TREATMENT_PLAN',
                        'TREATMENT_PLAN_COMPLETED',
                    ],
                },
            },
            orderBy: { createdAt: 'asc' },
            select: { action: true },
        });
        expect(audit.map((a) => a.action)).toEqual([
            'TREATMENT_PLAN_CREATED',
            'TREATMENT_MILESTONE_ADDED',
            'TREATMENT_PLAN_ACTIVATED',
            'TREATMENT_PLAN_STRATEGY_CHANGED',
            'TREATMENT_MILESTONE_COMPLETED',
            'RISK_STATUS_CHANGED_BY_TREATMENT_PLAN',
            'TREATMENT_PLAN_COMPLETED',
        ]);
    });
});
