/**
 * Epic G-4 — usecase-layer integration tests for createAccessReview
 * + submitDecision.
 *
 * Hit a real database (per the project convention — integration tests
 * never mock Prisma) so the snapshot semantics, RLS interaction, and
 * CHECK-constraint backstops are all exercised end-to-end.
 *
 * Coverage
 * --------
 *   1. createAccessReview snapshots ALL active+invited memberships
 *      under scope=ALL_USERS and seeds null-decision rows.
 *   2. ADMIN_ONLY scope filters to OWNER + ADMIN.
 *   3. CUSTOM scope honours the supplied membership ids; rejects
 *      ineligible ids (deactivated / wrong tenant) with a 400.
 *   4. Empty population (e.g. ADMIN_ONLY with no admins) is rejected.
 *   5. createAccessReview requires admin permission.
 *   6. submitDecision CONFIRM transitions OPEN → IN_REVIEW + records
 *      decidedAt + decidedByUserId; second submit on the same row
 *      is rejected.
 *   7. submitDecision REVOKE captures notes + leaves modifiedToRole null.
 *   8. submitDecision MODIFY requires modifiedToRole; CONFIRM/REVOKE
 *      forbid it (validator + DB CHECK).
 *   9. submitDecision rejects non-reviewer non-admin actors.
 *  10. submitDecision rejects writes against a CLOSED campaign.
 *  11. Live TenantMembership stays untouched — REVOKE/MODIFY in this
 *      phase capture intent only.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createAccessReview,
    submitDecision,
    getAccessReview,
} from '@/app-layer/usecases/access-review';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g4u-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

interface UserFixture {
    userId: string;
    membershipId: string;
}

let admin: UserFixture;
let reviewer: UserFixture;
let editor: UserFixture;
let reader: UserFixture;
/** A second tenant fixture used to assert tenant-isolation invariants. */
const FOREIGN_TENANT_ID = `t-${SUITE_TAG}-other`;
let foreignAdmin: UserFixture;

async function makeUserAndMembership(
    label: string,
    role: Role,
    tenantId: string = TENANT_ID,
    status: MembershipStatus = MembershipStatus.ACTIVE,
): Promise<UserFixture> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    const m = await globalPrisma.tenantMembership.create({
        data: { tenantId, userId: u.id, role, status },
    });
    return { userId: u.id, membershipId: m.id };
}

async function seedFixtures() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    await globalPrisma.tenant.upsert({
        where: { id: FOREIGN_TENANT_ID },
        update: {},
        create: {
            id: FOREIGN_TENANT_ID,
            name: `t ${SUITE_TAG} other`,
            slug: `${SUITE_TAG}-other`,
        },
    });
    admin = await makeUserAndMembership('admin', Role.ADMIN);
    reviewer = await makeUserAndMembership('reviewer', Role.AUDITOR);
    editor = await makeUserAndMembership('editor', Role.EDITOR);
    reader = await makeUserAndMembership('reader', Role.READER);
    foreignAdmin = await makeUserAndMembership(
        'foreign-admin',
        Role.ADMIN,
        FOREIGN_TENANT_ID,
    );
}

async function teardownFixtures() {
    const tenantIds = [TENANT_ID, FOREIGN_TENANT_ID];
    await globalPrisma.accessReviewDecision.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.accessReview.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    // Tenant DEK backfill writes audit rows on first context use;
    // strip them before the FK target goes (immutability trigger
    // bypassed under postgres role + session_replication_role=replica).
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    const userIds = [
        admin?.userId,
        reviewer?.userId,
        editor?.userId,
        reader?.userId,
        foreignAdmin?.userId,
    ].filter(Boolean) as string[];
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

describeFn('Epic G-4 — createAccessReview + submitDecision usecases', () => {
    beforeAll(async () => {
        await seedFixtures();
    });

    afterAll(async () => {
        await teardownFixtures();
        await globalPrisma.$disconnect();
    });

    afterEach(async () => {
        // Each test creates one or more campaigns. Wipe between cases
        // so suite-internal counts stay deterministic.
        await globalPrisma.accessReviewDecision.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.accessReview.deleteMany({
            where: { tenantId: TENANT_ID },
        });
    });

    // ── 1. ALL_USERS snapshot ──────────────────────────────────────

    it('createAccessReview ALL_USERS snapshots every active/invited membership', async () => {
        const { accessReviewId, snapshotCount } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Q1 review',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        // 4 fixtures live in TENANT_ID (admin/reviewer/editor/reader),
        // foreignAdmin is in FOREIGN_TENANT_ID and must not appear.
        expect(snapshotCount).toBe(4);
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const subjectIds = review.decisions.map((d) => d.subjectUserId).sort();
        expect(subjectIds).toEqual(
            [
                admin.userId,
                reviewer.userId,
                editor.userId,
                reader.userId,
            ].sort(),
        );
        // Every snapshot row starts pending.
        expect(review.decisions.every((d) => d.decision === null)).toBe(true);
        expect(review.decisions.every((d) => d.snapshotMembershipStatus === 'ACTIVE')).toBe(true);
    });

    // ── 2. ADMIN_ONLY scope ────────────────────────────────────────

    it('createAccessReview ADMIN_ONLY snapshots only OWNER + ADMIN', async () => {
        const { accessReviewId, snapshotCount } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Admins-only review',
                scope: 'ADMIN_ONLY',
                reviewerUserId: reviewer.userId,
            },
        );
        expect(snapshotCount).toBe(1); // only admin fixture has ADMIN role
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        expect(review.decisions[0].subjectUserId).toBe(admin.userId);
        expect(review.decisions[0].snapshotRole).toBe('ADMIN');
    });

    // ── 3. CUSTOM scope ────────────────────────────────────────────

    it('createAccessReview CUSTOM honours the supplied membership ids', async () => {
        const { snapshotCount } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Curated review',
                scope: 'CUSTOM',
                reviewerUserId: reviewer.userId,
                customMembershipIds: [editor.membershipId, reader.membershipId],
            },
        );
        expect(snapshotCount).toBe(2);
    });

    it('createAccessReview CUSTOM rejects ineligible membership ids (foreign tenant / unknown)', async () => {
        // foreignAdmin's membership is in FOREIGN_TENANT_ID — passing
        // it to a TENANT_ID campaign must be rejected, not silently
        // dropped.
        await expect(
            createAccessReview(ctxAs(Role.ADMIN, admin.userId), {
                name: 'Bad CUSTOM',
                scope: 'CUSTOM',
                reviewerUserId: reviewer.userId,
                customMembershipIds: [foreignAdmin.membershipId, 'definitely-not-an-id'],
            }),
        ).rejects.toThrow(/eligible|not in this tenant/i);
    });

    // ── 4. Empty population ────────────────────────────────────────

    it('createAccessReview rejects a scope that resolves to zero subjects', async () => {
        // Wipe ADMIN-class memberships in this tenant so ADMIN_ONLY
        // resolves to zero rows.
        const before = await globalPrisma.tenantMembership.findMany({
            where: { tenantId: TENANT_ID, role: { in: ['ADMIN', 'OWNER'] } },
        });
        await globalPrisma.tenantMembership.updateMany({
            where: { tenantId: TENANT_ID, role: { in: ['ADMIN', 'OWNER'] } },
            data: { status: 'DEACTIVATED' },
        });
        try {
            await expect(
                createAccessReview(ctxAs(Role.ADMIN, admin.userId), {
                    name: 'Empty scope',
                    scope: 'ADMIN_ONLY',
                    reviewerUserId: reviewer.userId,
                }),
            ).rejects.toThrow(/zero subjects|no memberships matched/i);
        } finally {
            // Restore status so subsequent tests in the same process
            // see the seeded state.
            for (const m of before) {
                await globalPrisma.tenantMembership.update({
                    where: { id: m.id },
                    data: { status: m.status },
                });
            }
        }
    });

    // ── 5. Permission gate ─────────────────────────────────────────

    it('createAccessReview rejects non-admin actors', async () => {
        await expect(
            createAccessReview(ctxAs(Role.EDITOR, editor.userId), {
                name: 'should-fail',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            }),
        ).rejects.toThrow(/permission/i);
    });

    // ── 6. submitDecision CONFIRM + state transition ──────────────

    it('submitDecision CONFIRM transitions OPEN → IN_REVIEW + freezes decided fields', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Transition test',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        expect(review.status).toBe('OPEN');
        const target = review.decisions.find((d) => d.subjectUserId === editor.userId)!;
        expect(target).toBeDefined();

        const r = await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            target.id,
            { decision: 'CONFIRM', notes: 'still active and valid' },
        );
        expect(r.transitionedToInReview).toBe(true);

        const after = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        expect(after.status).toBe('IN_REVIEW');
        const updated = after.decisions.find((d) => d.id === target.id)!;
        expect(updated.decision).toBe('CONFIRM');
        expect(updated.decidedByUserId).toBe(reviewer.userId);
        expect(updated.decidedAt).toBeInstanceOf(Date);

        // Re-submitting same decision is rejected.
        await expect(
            submitDecision(
                ctxAs(Role.AUDITOR, reviewer.userId),
                target.id,
                { decision: 'CONFIRM' },
            ),
        ).rejects.toThrow(/already been recorded/i);
    });

    // ── 7. REVOKE captures notes + leaves modifiedToRole null ─────

    it('submitDecision REVOKE captures notes + leaves modifiedToRole null', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'REVOKE test',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const target = review.decisions.find((d) => d.subjectUserId === reader.userId)!;

        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            target.id,
            { decision: 'REVOKE', notes: 'left the company' },
        );
        // Read via the usecase so the encryption extension decrypts
        // `notes` cleanly. A raw `globalPrisma.findUnique` here would
        // return the v2: ciphertext because this test file constructs
        // a non-extended PrismaClient.
        const after = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            target.accessReviewId,
        );
        const persisted = after.decisions.find((d) => d.id === target.id);
        expect(persisted?.decision).toBe('REVOKE');
        expect(persisted?.notes).toBe('left the company');
        expect(persisted?.modifiedToRole).toBeNull();
    });

    // ── 8. MODIFY requires modifiedToRole ─────────────────────────

    it('submitDecision MODIFY requires modifiedToRole — Zod rejects missing field', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'MODIFY validator',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const target = review.decisions.find((d) => d.subjectUserId === editor.userId)!;
        await expect(
            submitDecision(
                ctxAs(Role.AUDITOR, reviewer.userId),
                target.id,
                // modifiedToRole intentionally missing
                { decision: 'MODIFY', notes: 'should fail' } as unknown,
            ),
        ).rejects.toThrow(/modifiedToRole|invalid_type|required/i);
    });

    it('submitDecision MODIFY records modifiedToRole on success', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'MODIFY happy path',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const target = review.decisions.find((d) => d.subjectUserId === editor.userId)!;
        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            target.id,
            { decision: 'MODIFY', modifiedToRole: 'READER', notes: 'over-privileged' },
        );
        const after = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            target.accessReviewId,
        );
        const persisted = after.decisions.find((d) => d.id === target.id);
        expect(persisted?.decision).toBe('MODIFY');
        expect(persisted?.modifiedToRole).toBe('READER');
    });

    // ── 9. Reviewer permission gate ───────────────────────────────

    it('submitDecision rejects non-reviewer non-admin actors', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Reviewer-gate test',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const target = review.decisions.find((d) => d.subjectUserId === editor.userId)!;
        // Reader is neither the assigned reviewer nor an admin.
        await expect(
            submitDecision(ctxAs(Role.READER, reader.userId), target.id, {
                decision: 'CONFIRM',
            }),
        ).rejects.toThrow(/assigned reviewer|admin/i);
        // Admin acts as backup — succeeds.
        const r = await submitDecision(
            ctxAs(Role.ADMIN, admin.userId),
            target.id,
            { decision: 'CONFIRM' },
        );
        expect(r.decision).toBe('CONFIRM');
    });

    // ── 10. CLOSED campaign is immutable ───────────────────────────

    it('submitDecision rejects writes against a CLOSED campaign', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Closed-immutability test',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        // Force CLOSED via the global client (bypasses RLS — the
        // closeout usecase will land in the next prompt).
        await globalPrisma.accessReview.update({
            where: { id: accessReviewId },
            data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: admin.userId },
        });
        const review = await globalPrisma.accessReview.findUniqueOrThrow({
            where: { id: accessReviewId },
            include: { decisions: { take: 1 } },
        });
        await expect(
            submitDecision(
                ctxAs(Role.AUDITOR, reviewer.userId),
                review.decisions[0].id,
                { decision: 'CONFIRM' },
            ),
        ).rejects.toThrow(/closed|immutable/i);
    });

    // ── 11. Live TenantMembership untouched by capture phase ──────

    it('submitDecision REVOKE/MODIFY do NOT mutate the live TenantMembership', async () => {
        const { accessReviewId } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'Live-row preservation test',
                scope: 'ALL_USERS',
                reviewerUserId: reviewer.userId,
            },
        );
        const review = await getAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const target = review.decisions.find((d) => d.subjectUserId === editor.userId)!;
        const before = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });

        await submitDecision(ctxAs(Role.AUDITOR, reviewer.userId), target.id, {
            decision: 'REVOKE',
            notes: 'capture phase only',
        });

        const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });
        // The live row's role + status are unchanged — closeout
        // (next prompt) is the phase that mutates TenantMembership.
        expect(after.role).toBe(before.role);
        expect(after.status).toBe(before.status);
    });
});
