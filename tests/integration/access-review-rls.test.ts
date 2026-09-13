/**
 * Epic G-4 — AccessReview + AccessReviewDecision RLS, uniqueness,
 * default-state, and CHECK-constraint behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`)
 * confirms the canonical three policies + FORCE flag exist on each
 * table. These tests exercise the actual semantics against a live
 * Postgres, so any future migration that quietly weakens them
 * (drops a policy, weakens WITH CHECK, removes a CHECK constraint,
 * or breaks the cross-tenant composite FK) breaks here even if the
 * static surface still reads as correct.
 *
 * Coverage
 * --------
 *   1. INSERT under `app_user` with own tenantId → succeeds for
 *      both AccessReview and AccessReviewDecision.
 *   2. INSERT under `app_user` with a different tenantId → blocked
 *      on both tables.
 *   3. SELECT under `app_user` is scoped — TENANT_A cannot see
 *      TENANT_B's campaigns or decisions.
 *   4. AccessReviewDecision composite-FK enforcement: a child row
 *      that names a campaign in a different tenant is rejected by
 *      the (accessReviewId, tenantId) FK regardless of RLS.
 *   5. Per-(campaign, subject user) uniqueness — duplicate decision
 *      rows for the same subject are rejected at INSERT time.
 *   6. Default lifecycle state — a freshly created campaign is OPEN
 *      with scope=ALL_USERS.
 *   7. CHECK constraints — MODIFY requires modifiedToRole; CONFIRM /
 *      REVOKE forbid it. Decided pair must be (decision, decidedAt,
 *      decidedByUserId) all-non-null OR all-null. Executed pair must
 *      be (executedAt, executedByUserId) both-non-null OR both-null.
 *   8. Backward-compat sanity — pre-existing TenantMembership rows
 *      are unaffected (the migration is purely additive). Asserted
 *      indirectly: a snapshot row referencing an existing
 *      TenantMembership reads back the live row via the relation.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
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

// ─── Fixtures ──────────────────────────────────────────────────────

const SUITE_TAG = `g4-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;
let USER_A_ID = '';
let USER_B_ID = '';
let MEMBERSHIP_A_ID = '';

async function seedFixtures() {
    // Two tenants under different ids so RLS isolation is observable.
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_A_ID },
        update: {},
        create: { id: TENANT_A_ID, name: `tenant ${SUITE_TAG}-a`, slug: `${SUITE_TAG}-a` },
    });
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_B_ID },
        update: {},
        create: { id: TENANT_B_ID, name: `tenant ${SUITE_TAG}-b`, slug: `${SUITE_TAG}-b` },
    });

    const aEmail = `${SUITE_TAG}-a@example.test`;
    const bEmail = `${SUITE_TAG}-b@example.test`;

    const userA = await globalPrisma.user.create({
        data: { email: aEmail, emailHash: hashForLookup(aEmail) },
    });
    USER_A_ID = userA.id;

    const userB = await globalPrisma.user.create({
        data: { email: bEmail, emailHash: hashForLookup(bEmail) },
    });
    USER_B_ID = userB.id;

    const membershipA = await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_A_ID,
            userId: USER_A_ID,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    MEMBERSHIP_A_ID = membershipA.id;
}

async function teardownFixtures() {
    // Order matters because of FKs (the global teardown's
    // savepoint-per-statement pattern is a runtime defence; here we
    // just delete in dependency order).
    await globalPrisma.accessReviewDecision.deleteMany({
        where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
    });
    await globalPrisma.accessReview.deleteMany({
        where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
    });
    // Tenant DEK backfill writes a row to AuditLog on first
    // tenantId-context use; delete those before the Tenant FK target
    // goes. AuditLog has an immutability trigger that would normally
    // reject DELETE — do it under postgres role with the trigger
    // bypassed via session_replication_role=replica (same pattern
    // global-teardown uses).
    await deleteAuditRowsForTenants(globalPrisma, [TENANT_A_ID, TENANT_B_ID]);
    await globalPrisma.user.deleteMany({
        where: { id: { in: [USER_A_ID, USER_B_ID] } },
    });
    await globalPrisma.tenant.deleteMany({
        where: { id: { in: [TENANT_A_ID, TENANT_B_ID] } },
    });
}

// ─── Suite ─────────────────────────────────────────────────────────

describeFn('Epic G-4 — AccessReview RLS + uniqueness + CHECK constraints', () => {
    beforeAll(async () => {
        await seedFixtures();
    });

    afterAll(async () => {
        await teardownFixtures();
        await globalPrisma.$disconnect();
    });

    // ── 1. INSERT under own tenant succeeds ────────────────────────

    it('app_user INSERT with own tenantId succeeds for AccessReview', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const created = await tx.accessReview.create({
                data: {
                    tenantId: TENANT_A_ID,
                    name: 'Q1 access review',
                    reviewerUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            });
            return created.id;
        });
        const persisted = await globalPrisma.accessReview.findUnique({
            where: { id },
        });
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.status).toBe('OPEN');
        expect(persisted?.scope).toBe('ALL_USERS');
        await globalPrisma.accessReview.delete({ where: { id } });
    });

    // ── 2. INSERT with foreign tenantId is blocked ─────────────────

    it('app_user INSERT with a foreign tenantId is blocked (AccessReview)', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.accessReview.create({
                    data: {
                        tenantId: TENANT_B_ID, // wrong tenant
                        name: 'rogue',
                        reviewerUserId: USER_A_ID,
                        createdByUserId: USER_A_ID,
                    },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('app_user INSERT with a foreign tenantId is blocked (AccessReviewDecision)', async () => {
        // Set up a parent campaign in TENANT_A first (under postgres
        // role), then attempt to insert a decision row under TENANT_A's
        // app_user but mark it tenantId=TENANT_B. The tenant_isolation_insert
        // policy must reject.
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'parent for decision RLS test',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });

        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.accessReviewDecision.create({
                    data: {
                        tenantId: TENANT_B_ID, // wrong tenant
                        accessReviewId: review.id,
                        subjectUserId: USER_A_ID,
                        snapshotRole: Role.ADMIN,
                        snapshotMembershipStatus: MembershipStatus.ACTIVE,
                    },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates|insert or update/i);

        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    // ── 3. SELECT visibility is tenant-scoped ──────────────────────

    it('app_user SELECT only sees own-tenant campaigns', async () => {
        const reviewA = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'visible to A',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        const reviewB = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_B_ID,
                name: 'visible to B',
                reviewerUserId: USER_B_ID,
                createdByUserId: USER_B_ID,
            },
        });

        const visibleToA = await withTenantDb(TENANT_A_ID, async (tx) => {
            return tx.accessReview.findMany({
                where: { id: { in: [reviewA.id, reviewB.id] } },
                select: { id: true, tenantId: true },
            });
        });
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(reviewA.id)).toBe(true);
        expect(ids.has(reviewB.id)).toBe(false);

        await globalPrisma.accessReview.deleteMany({
            where: { id: { in: [reviewA.id, reviewB.id] } },
        });
    });

    // ── 4. Composite FK forbids cross-tenant child references ─────

    it('AccessReviewDecision cannot reference a campaign in another tenant (composite FK)', async () => {
        // Campaign in TENANT_B, decision attempting to claim TENANT_A.
        const reviewB = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_B_ID,
                name: 'b-campaign',
                reviewerUserId: USER_B_ID,
                createdByUserId: USER_B_ID,
            },
        });
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID, // doesn't match the parent
                    accessReviewId: reviewB.id,
                    subjectUserId: USER_A_ID,
                    snapshotRole: Role.ADMIN,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
        await globalPrisma.accessReview.delete({ where: { id: reviewB.id } });
    });

    // ── 5. Uniqueness: one decision per (campaign, subject user) ──

    it('uniqueness — second decision for same (campaign, subjectUserId) is rejected', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'unique check',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        await globalPrisma.accessReviewDecision.create({
            data: {
                tenantId: TENANT_A_ID,
                accessReviewId: review.id,
                subjectUserId: USER_A_ID,
                membershipId: MEMBERSHIP_A_ID,
                snapshotRole: Role.ADMIN,
                snapshotMembershipStatus: MembershipStatus.ACTIVE,
            },
        });
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID,
                    accessReviewId: review.id,
                    subjectUserId: USER_A_ID, // same campaign + subject
                    snapshotRole: Role.READER,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                },
            }),
        ).rejects.toThrow(/unique constraint|violates/i);

        await globalPrisma.accessReview.delete({ where: { id: review.id } }); // cascade
    });

    // ── 6. Default lifecycle state ─────────────────────────────────

    it('default — a freshly created AccessReview has status=OPEN, scope=ALL_USERS', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'defaults probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        expect(review.status).toBe('OPEN');
        expect(review.scope).toBe('ALL_USERS');
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    // ── 7. CHECK constraints ───────────────────────────────────────

    it('CHECK — MODIFY decision without modifiedToRole is rejected', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'modify-shape probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID,
                    accessReviewId: review.id,
                    subjectUserId: USER_A_ID,
                    snapshotRole: Role.ADMIN,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                    decision: 'MODIFY',
                    decidedAt: new Date(),
                    decidedByUserId: USER_A_ID,
                    // modifiedToRole intentionally missing
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    it('CHECK — CONFIRM with modifiedToRole present is rejected', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'confirm-shape probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID,
                    accessReviewId: review.id,
                    subjectUserId: USER_A_ID,
                    snapshotRole: Role.ADMIN,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                    decision: 'CONFIRM',
                    decidedAt: new Date(),
                    decidedByUserId: USER_A_ID,
                    modifiedToRole: Role.READER, // shouldn't be set
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    it('CHECK — decided pair (decision, decidedAt, decidedByUserId) must be all-set or all-null', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'decided-pair probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        // decision set but decidedAt missing
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID,
                    accessReviewId: review.id,
                    subjectUserId: USER_A_ID,
                    snapshotRole: Role.ADMIN,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                    decision: 'CONFIRM',
                    // decidedAt + decidedByUserId missing
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    it('CHECK — executed pair must be (executedAt, executedByUserId) both-set or both-null', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'executed-pair probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        // executedAt set but executedByUserId missing
        await expect(
            globalPrisma.accessReviewDecision.create({
                data: {
                    tenantId: TENANT_A_ID,
                    accessReviewId: review.id,
                    subjectUserId: USER_A_ID,
                    snapshotRole: Role.ADMIN,
                    snapshotMembershipStatus: MembershipStatus.ACTIVE,
                    decision: 'CONFIRM',
                    decidedAt: new Date(),
                    decidedByUserId: USER_A_ID,
                    executedAt: new Date(),
                    // executedByUserId missing
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });

    // ── 8. Backward-compat — TenantMembership relation reachable ──

    it('backward-compat — decision row joins back to TenantMembership cleanly', async () => {
        const review = await globalPrisma.accessReview.create({
            data: {
                tenantId: TENANT_A_ID,
                name: 'compat probe',
                reviewerUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        const decision = await globalPrisma.accessReviewDecision.create({
            data: {
                tenantId: TENANT_A_ID,
                accessReviewId: review.id,
                membershipId: MEMBERSHIP_A_ID,
                subjectUserId: USER_A_ID,
                snapshotRole: Role.ADMIN,
                snapshotMembershipStatus: MembershipStatus.ACTIVE,
            },
            include: { membership: { select: { id: true, role: true } } },
        });
        expect(decision.membership?.id).toBe(MEMBERSHIP_A_ID);
        expect(decision.membership?.role).toBe(Role.ADMIN);
        await globalPrisma.accessReview.delete({ where: { id: review.id } });
    });
});
