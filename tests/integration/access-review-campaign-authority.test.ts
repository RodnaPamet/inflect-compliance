/**
 * What a member access-review campaign may do to a membership (#3727) —
 * against a real database, two tenants, with an ADMIN and an OWNER closer.
 *
 *   - An ADMIN cannot MODIFY themselves to OWNER through a campaign: refused at
 *     submission by name, audited, and the decision stays pending.
 *   - A campaign decided BEFORE the fix (rows written as the old schema allowed)
 *     is refused at close, never applied: a MODIFY to OWNER, then a MODIFY
 *     carrying a custom role, each by name and each audited.
 *   - An ADMIN closer cannot demote or revoke an OWNER; an OWNER closer can,
 *     and the last-OWNER guard still holds for them. Tenant B is unreachable
 *     from tenant A, and an ADMIN still closes a campaign that lowers no OWNER.
 *   - A MODIFY sets the built-in role and clears a custom role, and its
 *     execution row records the clear.
 *
 * No teardown deletes, as in `ai-admin-assignment.test.ts`: per-run slugs, the
 * last-OWNER trigger refuses a bare membership delete, and `resetDatabase`
 * truncates.
 */
import { randomUUID } from 'crypto';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient, Role } from '@prisma/client';

import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { createCustomRole } from '@/app-layer/usecases/custom-roles';
import { closeAccessReview, createAccessReview, submitDecision } from '@/app-layer/usecases/access-review';
import { MEMBER_DECISION_REFUSAL } from '@/lib/access-review/member-decision-rules';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('access-review campaigns hold the members page’s OWNER-tier rules (real DB, two tenants)', () => {
    let prisma: PrismaClient;
    const stamp = Date.now();

    beforeAll(async () => {
        // The close writes an evidence PDF; give it local storage, as the
        // closeout suite does.
        process.env.STORAGE_PROVIDER = 'local';
        process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/inflect-test-uploads';
        const { resetStorageProvider } = await import('@/lib/storage');
        resetStorageProvider();
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    type Ctx = ReturnType<typeof makeRequestContext>;
    const ctxFor = (role: Role, userId: string, tenantId: string): Ctx =>
        makeRequestContext(role, { userId, tenantId, appPermissions: getPermissionsForRole(role) });

    async function tenant(suffix: string) {
        const result = await createTenantWithOwner({
            name: `AR authority ${suffix}`,
            slug: `ar-authority-${suffix}-${stamp}`,
            ownerEmail: `ar-authority-owner-${suffix}-${stamp}@example.com`,
            requestId: `req-${suffix}`,
        });
        const tenantId = result.tenant.id;
        const ownerRow = await prisma.tenantMembership.findFirstOrThrow({
            where: { tenantId, userId: result.ownerUserId },
            select: { id: true },
        });
        return {
            tenantId,
            owner: { userId: result.ownerUserId, membershipId: ownerRow.id, ctx: ctxFor('OWNER', result.ownerUserId, tenantId) },
        };
    }

    async function member(tenantId: string, suffix: string, role: Role, customRoleId: string | null = null) {
        const u = await prisma.user.create({
            data: { email: `ar-authority-${suffix}-${stamp}@example.com`, name: suffix },
            select: { id: true },
        });
        const m = await prisma.tenantMembership.create({
            data: { tenantId, userId: u.id, role, status: 'ACTIVE', customRoleId },
            select: { id: true },
        });
        return { userId: u.id, membershipId: m.id, ctx: ctxFor(role, u.id, tenantId) };
    }

    /** A CUSTOM campaign over `subjects`, reviewed by `reviewer`; returns its id and each subject's decision id. */
    async function campaign(creator: Ctx, reviewerUserId: string, subjects: Array<{ membershipId: string; userId: string }>) {
        const { accessReviewId } = await createAccessReview(creator, {
            name: `authority-${randomUUID().slice(0, 8)}`,
            scope: 'CUSTOM',
            reviewerUserId,
            customMembershipIds: subjects.map((s) => s.membershipId),
        });
        const rows = await prisma.accessReviewDecision.findMany({
            where: { accessReviewId },
            select: { id: true, subjectUserId: true },
        });
        const decisionOf = (userId: string) => rows.find((r) => r.subjectUserId === userId)!.id;
        return { accessReviewId, decisionOf };
    }

    const membership = (id: string) =>
        prisma.tenantMembership.findUniqueOrThrow({
            where: { id },
            select: { role: true, status: true, customRoleId: true },
        });
    const reviewStatus = async (id: string) =>
        (await prisma.accessReview.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    const refusalRows = (tenantId: string, action: string, entityId: string) =>
        prisma.auditLog.findMany({
            where: { tenantId, action, entityId },
            select: { userId: true, detailsJson: true },
        });

    it('an ADMIN cannot MODIFY themselves to OWNER: refused at submission by name, audited, the decision stays pending', async () => {
        const a = await tenant('self');
        const admin = await member(a.tenantId, 'self-admin', 'ADMIN');
        const { decisionOf } = await campaign(admin.ctx, admin.userId, [admin]);
        const decisionId = decisionOf(admin.userId);

        await expect(
            submitDecision(admin.ctx, decisionId, { decision: 'MODIFY', modifiedToRole: 'OWNER' }),
        ).rejects.toThrow(MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER);

        const rows = await refusalRows(a.tenantId, 'ACCESS_REVIEW_DECISION_REFUSED', decisionId);
        expect(rows).toHaveLength(1);
        expect(rows[0].userId).toBe(admin.userId);
        expect(rows[0].detailsJson).toMatchObject({ after: { reason: MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER } });
        expect(
            await prisma.accessReviewDecision.findUniqueOrThrow({
                where: { id: decisionId },
                select: { decision: true, modifiedToRole: true },
            }),
        ).toEqual({ decision: null, modifiedToRole: null });
        expect(await membership(admin.membershipId)).toMatchObject({ role: 'ADMIN' });
    });

    it('a campaign decided before the fix is refused at close, never applied — a MODIFY to OWNER, then one carrying a custom role', async () => {
        const a = await tenant('stored');
        const editor = await member(a.tenantId, 'stored-editor', 'EDITOR');
        const reader = await member(a.tenantId, 'stored-reader', 'READER');
        const custom = await createCustomRole(a.owner.ctx, {
            name: `Stored ${stamp}`,
            baseRole: 'READER',
            permissionsJson: getPermissionsForRole('READER'),
        });
        const { accessReviewId, decisionOf } = await campaign(a.owner.ctx, a.owner.userId, [editor, reader]);
        await submitDecision(a.owner.ctx, decisionOf(editor.userId), { decision: 'MODIFY', modifiedToRole: 'READER' });
        await submitDecision(a.owner.ctx, decisionOf(reader.userId), { decision: 'MODIFY', modifiedToRole: 'EDITOR' });
        // What the pre-#3727 schema let a reviewer store.
        await prisma.accessReviewDecision.update({
            where: { id: decisionOf(editor.userId) },
            data: { modifiedToRole: 'OWNER' },
        });
        await prisma.accessReviewDecision.update({
            where: { id: decisionOf(reader.userId) },
            data: { modifiedToCustomRoleId: custom.id },
        });

        // Even an OWNER closer: these are rules about what a campaign does.
        await expect(closeAccessReview(a.owner.ctx, accessReviewId)).rejects.toMatchObject({
            status: 409,
            details: { reason: MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER, decisionIds: [decisionOf(editor.userId)] },
        });
        // Re-stored as a legitimate MODIFY, the next refusal is the custom role.
        await prisma.accessReviewDecision.update({
            where: { id: decisionOf(editor.userId) },
            data: { modifiedToRole: 'READER' },
        });
        await expect(closeAccessReview(a.owner.ctx, accessReviewId)).rejects.toMatchObject({
            status: 409,
            details: { reason: MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE, decisionIds: [decisionOf(reader.userId)] },
        });

        // Nothing applied, nothing dropped: the campaign is still open, both
        // memberships as they were, and both refusals are on the record.
        expect(await reviewStatus(accessReviewId)).toBe('IN_REVIEW');
        expect(await membership(editor.membershipId)).toMatchObject({ role: 'EDITOR', customRoleId: null });
        expect(await membership(reader.membershipId)).toMatchObject({ role: 'READER', customRoleId: null });
        const reasons = (await refusalRows(a.tenantId, 'ACCESS_REVIEW_CLOSE_REFUSED', accessReviewId)).map(
            (r) => (r.detailsJson as { after?: { reason?: string } }).after?.reason,
        );
        expect(reasons.sort()).toEqual(
            [MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE, MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER].sort(),
        );
        expect(await prisma.accessReviewDecision.count({ where: { accessReviewId, executedAt: { not: null } } })).toBe(0);
    });

    it('an ADMIN closer cannot demote or revoke an OWNER, an OWNER closer can; tenant B is unreachable, and its last OWNER is guarded', async () => {
        const a = await tenant('lower-a');
        const b = await tenant('lower-b');
        const adminA = await member(a.tenantId, 'lower-admin-a', 'ADMIN');
        const owner2 = await member(a.tenantId, 'lower-owner2', 'OWNER');
        const owner3 = await member(a.tenantId, 'lower-owner3', 'OWNER');
        const editor = await member(a.tenantId, 'lower-editor', 'EDITOR');
        const { accessReviewId, decisionOf } = await campaign(adminA.ctx, adminA.userId, [owner2, owner3, editor]);
        await submitDecision(adminA.ctx, decisionOf(owner2.userId), { decision: 'REVOKE', notes: 'left' });
        await submitDecision(adminA.ctx, decisionOf(owner3.userId), { decision: 'MODIFY', modifiedToRole: 'READER' });
        await submitDecision(adminA.ctx, decisionOf(editor.userId), { decision: 'MODIFY', modifiedToRole: 'READER' });

        // The ADMIN who ran it cannot close it: refused by name, before ANY row
        // executes — the editor's MODIFY is not applied either.
        const err = await closeAccessReview(adminA.ctx, accessReviewId).catch((e) => e);
        expect(err).toMatchObject({
            status: 403,
            details: { reason: MEMBER_DECISION_REFUSAL.OWNER_SUBJECT_NEEDS_OWNER_CLOSER },
        });
        expect([...err.details.decisionIds].sort()).toEqual([decisionOf(owner2.userId), decisionOf(owner3.userId)].sort());
        expect(await membership(owner2.membershipId)).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
        expect(await membership(owner3.membershipId)).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
        expect(await membership(editor.membershipId)).toMatchObject({ role: 'EDITOR' });
        expect(await reviewStatus(accessReviewId)).toBe('IN_REVIEW');
        const refused = await refusalRows(a.tenantId, 'ACCESS_REVIEW_CLOSE_REFUSED', accessReviewId);
        expect(refused.map((r) => r.userId)).toEqual([adminA.userId]);

        // Tenant B's OWNER cannot reach tenant A's campaign at all.
        await expect(closeAccessReview(b.owner.ctx, accessReviewId)).rejects.toThrow(/not found/i);
        expect(await reviewStatus(accessReviewId)).toBe('IN_REVIEW');

        // Tenant A's OWNER closes it, and every decision executes.
        const closed = await closeAccessReview(a.owner.ctx, accessReviewId);
        expect(closed.counts).toMatchObject({ total: 3, executed: 3, skipped: 0 });
        expect(await membership(owner2.membershipId)).toMatchObject({ role: 'OWNER', status: 'DEACTIVATED' });
        expect(await membership(owner3.membershipId)).toMatchObject({ role: 'READER', status: 'ACTIVE' });
        expect(await membership(editor.membershipId)).toMatchObject({ role: 'READER' });
        expect(await reviewStatus(accessReviewId)).toBe('CLOSED');

        // In tenant B: an ADMIN still closes a campaign that lowers no OWNER…
        const adminB = await member(b.tenantId, 'lower-admin-b', 'ADMIN');
        const editorB = await member(b.tenantId, 'lower-editor-b', 'EDITOR');
        const plain = await campaign(adminB.ctx, adminB.userId, [editorB]);
        await submitDecision(adminB.ctx, plain.decisionOf(editorB.userId), { decision: 'REVOKE', notes: 'left' });
        await closeAccessReview(adminB.ctx, plain.accessReviewId);
        expect(await membership(editorB.membershipId)).toMatchObject({ status: 'DEACTIVATED' });

        // …and B's only OWNER, closing a campaign that revokes them, meets the
        // last-OWNER guard: OWNER-tier is necessary, not sufficient.
        // The verdict is recorded by tenant B's ADMIN, as backup: nobody decides
        // their own access (#4130), so the OWNER may not record it themselves.
        const last = await campaign(b.owner.ctx, b.owner.userId, [b.owner]);
        await submitDecision(adminB.ctx, last.decisionOf(b.owner.userId), { decision: 'REVOKE', notes: 'rotation' });
        await expect(closeAccessReview(b.owner.ctx, last.accessReviewId)).rejects.toThrow(/zero ACTIVE OWNERs/);
        expect(await membership(b.owner.membershipId)).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    });

    it('a MODIFY sets the built-in role and clears a custom role, and the execution row records the clear', async () => {
        const a = await tenant('clear');
        const custom = await createCustomRole(a.owner.ctx, {
            name: `Clear ${stamp}`,
            baseRole: 'EDITOR',
            permissionsJson: getPermissionsForRole('EDITOR'),
        });
        const carrier = await member(a.tenantId, 'clear-carrier', 'EDITOR', custom.id);
        const { accessReviewId, decisionOf } = await campaign(a.owner.ctx, a.owner.userId, [carrier]);
        await submitDecision(a.owner.ctx, decisionOf(carrier.userId), { decision: 'MODIFY', modifiedToRole: 'READER' });
        await closeAccessReview(a.owner.ctx, accessReviewId);

        expect(await membership(carrier.membershipId)).toMatchObject({ role: 'READER', customRoleId: null });
        const executed = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: a.tenantId, action: 'ACCESS_REVIEW_DECISION_EXECUTED', entityId: decisionOf(carrier.userId) },
            select: { detailsJson: true },
        });
        expect(executed.detailsJson).toMatchObject({
            after: { fromRole: 'EDITOR', toRole: 'READER', clearedCustomRoleId: custom.id },
        });
    });
});
