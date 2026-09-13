/**
 * Epic G-7 — RiskTreatmentPlan + TreatmentMilestone schema, RLS,
 * FK, and CHECK-constraint behavioural tests.
 *
 * Static guardrail (`tests/guardrails/rls-coverage.test.ts`) confirms
 * the policies + FORCE flag exist on each table. These tests
 * exercise the actual semantics so a future migration that quietly
 * weakens them breaks here even if the static surface still reads
 * as correct.
 *
 * Coverage
 * --------
 *   1. INSERT under app_user with own tenantId → succeeds, default
 *      status is DRAFT.
 *   2. INSERT under app_user with foreign tenantId → blocked.
 *   3. SELECT under app_user is tenant-scoped.
 *   4. Composite FK forbids cross-tenant risk reference.
 *   5. Milestone composite FK rejects cross-tenant parent reference.
 *   6. Cascade delete — deleting the plan cascades to milestones.
 *   7. CHECK — COMPLETED plan must carry completedAt + completedByUserId.
 *   8. CHECK — non-COMPLETED plan must NOT carry completion fields.
 *   9. CHECK — milestone completion pair (completedAt + completedByUserId).
 *  10. Milestone sortOrder + ordering integrity.
 *  11. Encrypted fields decrypt cleanly across the full client path.
 */

import {
    PrismaClient,
    Role,
    MembershipStatus,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g7-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let USER_A_ID = '';
let USER_B_ID = '';
let RISK_A_ID = '';
let RISK_B_ID = '';

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
    const ua = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-a@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-a@example.test`),
        },
    });
    USER_A_ID = ua.id;
    const ub = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-b@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-b@example.test`),
        },
    });
    USER_B_ID = ub.id;
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_A_ID, userId: USER_A_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_B_ID, userId: USER_B_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
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
    await globalPrisma.risk.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    if (USER_A_ID) await globalPrisma.user.delete({ where: { id: USER_A_ID } });
    if (USER_B_ID) await globalPrisma.user.delete({ where: { id: USER_B_ID } });
    await globalPrisma.tenant.deleteMany({
        where: { id: { in: tenantIds } },
    });
}

const futureDate = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describeFn('Epic G-7 — RiskTreatmentPlan + TreatmentMilestone schema', () => {
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

    // ── 1. Default state + own-tenant insert ───────────────────────

    it('app_user INSERT with own tenantId succeeds and defaults status=DRAFT', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const plan = await tx.riskTreatmentPlan.create({
                data: {
                    tenantId: TENANT_A_ID,
                    riskId: RISK_A_ID,
                    strategy: 'MITIGATE',
                    ownerUserId: USER_A_ID,
                    targetDate: futureDate(90),
                    createdByUserId: USER_A_ID,
                },
            });
            return plan.id;
        });
        const persisted = await globalPrisma.riskTreatmentPlan.findUnique({
            where: { id },
        });
        expect(persisted?.status).toBe('DRAFT');
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.completedAt).toBeNull();
        expect(persisted?.strategy).toBe('MITIGATE');
    });

    // ── 2. Foreign-tenant insert blocked ───────────────────────────

    it('app_user INSERT with a foreign tenantId is blocked', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.riskTreatmentPlan.create({
                    data: {
                        tenantId: TENANT_B_ID, // wrong tenant
                        riskId: RISK_B_ID,
                        strategy: 'ACCEPT',
                        ownerUserId: USER_A_ID,
                        targetDate: futureDate(60),
                        createdByUserId: USER_A_ID,
                    },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    // ── 3. SELECT visibility tenant-scoped ─────────────────────────

    it('app_user SELECT only sees own-tenant plans', async () => {
        const a = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        const b = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_B_ID,
                riskId: RISK_B_ID,
                strategy: 'AVOID',
                ownerUserId: USER_B_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_B_ID,
            },
        });
        const visibleToA = await withTenantDb(TENANT_A_ID, async (tx) => {
            return tx.riskTreatmentPlan.findMany({
                where: { id: { in: [a.id, b.id] } },
                select: { id: true },
            });
        });
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(a.id)).toBe(true);
        expect(ids.has(b.id)).toBe(false);
    });

    // ── 4. Composite FK — risk must be in the same tenant ────────

    it('composite FK rejects a plan that names a risk in another tenant', async () => {
        await expect(
            globalPrisma.riskTreatmentPlan.create({
                data: {
                    tenantId: TENANT_A_ID,
                    riskId: RISK_B_ID, // wrong tenant
                    strategy: 'TRANSFER',
                    ownerUserId: USER_A_ID,
                    targetDate: futureDate(90),
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ── 5. Milestone composite FK ──────────────────────────────────

    it('milestone composite FK rejects cross-tenant parent', async () => {
        const planA = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        await expect(
            globalPrisma.treatmentMilestone.create({
                data: {
                    tenantId: TENANT_B_ID, // wrong tenant for plan A
                    treatmentPlanId: planA.id,
                    title: 'rogue',
                    dueDate: futureDate(30),
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ── 6. Cascade delete on plan ──────────────────────────────────

    it('deleting a plan cascades to its milestones', async () => {
        const plan = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        await globalPrisma.treatmentMilestone.createMany({
            data: [
                { tenantId: TENANT_A_ID, treatmentPlanId: plan.id, title: 'm1', dueDate: futureDate(30), sortOrder: 0 },
                { tenantId: TENANT_A_ID, treatmentPlanId: plan.id, title: 'm2', dueDate: futureDate(60), sortOrder: 1 },
            ],
        });
        await globalPrisma.riskTreatmentPlan.delete({ where: { id: plan.id } });
        const orphans = await globalPrisma.treatmentMilestone.count({
            where: { treatmentPlanId: plan.id },
        });
        expect(orphans).toBe(0);
    });

    // ── 7. CHECK — COMPLETED requires completion fields ───────────

    it('CHECK — COMPLETED plan without completedAt/completedByUserId is rejected', async () => {
        await expect(
            globalPrisma.riskTreatmentPlan.create({
                data: {
                    tenantId: TENANT_A_ID,
                    riskId: RISK_A_ID,
                    strategy: 'MITIGATE',
                    ownerUserId: USER_A_ID,
                    targetDate: futureDate(90),
                    createdByUserId: USER_A_ID,
                    status: 'COMPLETED',
                    // completedAt + completedByUserId missing
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    it('CHECK — COMPLETED plan with full triple succeeds', async () => {
        const p = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
                status: 'COMPLETED',
                completedAt: new Date(),
                completedByUserId: USER_A_ID,
                closingRemark: 'all milestones met',
            },
        });
        expect(p.status).toBe('COMPLETED');
        // closingRemark is encrypted at rest; verify decrypted read
        // returns the plaintext (decryption goes through the manifest).
        expect(p.closingRemark).toBe('all milestones met');
    });

    // ── 8. CHECK — non-COMPLETED forbids completion fields ────────

    it('CHECK — closingRemark on a non-COMPLETED plan is rejected', async () => {
        await expect(
            globalPrisma.riskTreatmentPlan.create({
                data: {
                    tenantId: TENANT_A_ID,
                    riskId: RISK_A_ID,
                    strategy: 'MITIGATE',
                    ownerUserId: USER_A_ID,
                    targetDate: futureDate(90),
                    createdByUserId: USER_A_ID,
                    closingRemark: 'should not be allowed', // status is DRAFT
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    // ── 9. CHECK — milestone completion pair ──────────────────────

    it('CHECK — milestone with completedAt missing completedByUserId is rejected', async () => {
        const plan = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        await expect(
            globalPrisma.treatmentMilestone.create({
                data: {
                    tenantId: TENANT_A_ID,
                    treatmentPlanId: plan.id,
                    title: 'm',
                    dueDate: futureDate(30),
                    completedAt: new Date(),
                    // completedByUserId missing
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    // ── 10. Milestone sortOrder ordering ─────────────────────────

    it('milestone ordering by sortOrder is stable', async () => {
        const plan = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        await globalPrisma.treatmentMilestone.createMany({
            data: [
                { tenantId: TENANT_A_ID, treatmentPlanId: plan.id, title: 'third', dueDate: futureDate(90), sortOrder: 2 },
                { tenantId: TENANT_A_ID, treatmentPlanId: plan.id, title: 'first', dueDate: futureDate(30), sortOrder: 0 },
                { tenantId: TENANT_A_ID, treatmentPlanId: plan.id, title: 'second', dueDate: futureDate(60), sortOrder: 1 },
            ],
        });
        const ordered = await globalPrisma.treatmentMilestone.findMany({
            where: { treatmentPlanId: plan.id },
            orderBy: { sortOrder: 'asc' },
            select: { title: true, sortOrder: true },
        });
        expect(ordered.map((m) => m.title)).toEqual(['first', 'second', 'third']);
        expect(ordered.map((m) => m.sortOrder)).toEqual([0, 1, 2]);
    });

    // ── 11. Encrypted fields round-trip ────────────────────────────

    it('milestone description (encrypted) decrypts cleanly through the relation read', async () => {
        const plan = await globalPrisma.riskTreatmentPlan.create({
            data: {
                tenantId: TENANT_A_ID,
                riskId: RISK_A_ID,
                strategy: 'MITIGATE',
                ownerUserId: USER_A_ID,
                targetDate: futureDate(90),
                createdByUserId: USER_A_ID,
            },
        });
        await globalPrisma.treatmentMilestone.create({
            data: {
                tenantId: TENANT_A_ID,
                treatmentPlanId: plan.id,
                title: 'm',
                description: 'procure SIEM licences from vendor X',
                dueDate: futureDate(30),
            },
        });
        const fresh = await globalPrisma.riskTreatmentPlan.findUniqueOrThrow({
            where: { id: plan.id },
            include: { milestones: true },
        });
        expect(fresh.milestones[0].description).toBe(
            'procure SIEM licences from vendor X',
        );
    });
});
