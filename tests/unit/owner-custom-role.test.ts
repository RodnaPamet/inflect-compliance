/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * An OWNER membership never carries a custom role (#3720, owner decisions of
 * 2026-10-18) — the rule #3699 deploy 2 made for AI_ADMIN, extended to OWNER.
 *
 * A custom role REPLACES a membership's permissions at resolution, so a
 * READER-based one on an OWNER demoted them in effect while the enum role, and
 * so every last-OWNER check, still read OWNER. An ADMIN could do that to every
 * OWNER at once through `PATCH /admin/members/:id { customRoleId }`.
 *
 *   ASSIGNING one to an OWNER is refused for every caller, OWNER included
 *     (409, `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`).
 *   PROMOTING a member who carries one to OWNER is refused until it is removed —
 *     on the members page, in an ownership transfer, through an invite and
 *     through an access review's MODIFY (409, the same reason).
 *   CLEARING one already on an OWNER (legacy data) is an OWNER's change only
 *     (403, `CLEARING_OWNER_CUSTOM_ROLE_IS_OWNER_TIER`); on any other role,
 *     AI_ADMIN included, it is unchanged.
 *
 * Four halves: the rule itself; each writer that can set `role` or
 * `customRoleId`, driven to its refusal; the paths that cannot reach OWNER at
 * all, verified rather than assumed; and a STRUCTURE census of every file that
 * writes `TenantMembership.customRoleId`. The real-database half — the CHECK
 * and two tenants — is `tests/integration/owner-custom-role.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
const appendAuditEntryMock = jest.fn().mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
// `strictMock`: `@/lib/audit` is a guarded barrel (see partial-mock-of-a-guarded-barrel).
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
        appendAuditEntryOrQueue: jest.fn().mockResolvedValue({ recorded: 'chain', auditId: 'a' }),
    }),
);
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
}));
const prismaMock = {
    user: { findUnique: jest.fn() },
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findMany: jest.fn() },
    tenantInvite: { updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: prismaMock, default: prismaMock }));
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import {
    BUILT_IN_SCOPE_REFUSAL,
    BUILT_IN_SCOPE_ROLES,
    OWNER_TIER_CLEAR_REFUSAL,
    TENANT_ROLES,
    clearingCustomRoleIsOwnerTier,
    mayCarryCustomRole,
} from '@/lib/roles';
import { ConflictError, ForbiddenError } from '@/lib/errors/types';
import { assignCustomRole } from '@/app-layer/usecases/custom-roles';
import { updateTenantMemberRole } from '@/app-layer/usecases/tenant-admin';
import { transferTenantOwnership } from '@/app-layer/usecases/tenant-lifecycle';
import {
    createInviteToken,
    redeemInvite,
    redeemPendingInvitesByEmail,
} from '@/app-layer/usecases/tenant-invites';
import { SubmitDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { closeAccessReview } from '@/app-layer/usecases/access-review';
import {
    SCIM_ASSIGNABLE_ROLES,
    SCIM_GROUP_ASSIGNABLE_ROLES,
    isScimProtectedRole,
    isScimStatusProtectedRole,
} from '@/lib/scim/roles';
import {
    ENTRA_MAPPABLE_ROLES,
    EntraGroupMappingCreateSchema,
} from '@/app-layer/schemas/entra-group-mapping.schemas';
import { NEVER_GROUP_MAPPED_ROLES } from '@/lib/auth/entra-role-mapping';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });

/** A transaction client holding one ACTIVE membership, recording writes. */
function membershipDb(membership: { role: string; customRoleId?: string | null }) {
    const row = {
        id: 'm-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        status: 'ACTIVE',
        customRoleId: null,
        user: { id: 'u-1', name: 'U', email: 'u@example.com' },
        ...membership,
    };
    const db = {
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(row),
            count: jest.fn().mockResolvedValue(2),
            update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
                ...row,
                ...args.data,
                customRole: null,
            })),
        },
        tenantCustomRole: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'cr-1',
                tenantId: 'tenant-1',
                baseRole: 'READER',
                permissionsJson: {},
                isActive: true,
            }),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async () => {
        throw new Error('the database was reached');
    });
});

// ─── THE RULE ──────────────────────────────────────────────────────

describe('the rule — which roles carry no custom role, and whose clear is OWNER-tier', () => {
    it('OWNER and AI_ADMIN carry none; every other role may', () => {
        expect([...BUILT_IN_SCOPE_ROLES].sort()).toEqual(['AI_ADMIN', 'OWNER']);
        expect(TENANT_ROLES.filter((r) => !mayCarryCustomRole(r)).sort()).toEqual(['AI_ADMIN', 'OWNER']);
        for (const r of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER']) expect(mayCarryCustomRole(r)).toBe(true);
    });

    it('clearing is OWNER-tier on an OWNER only — AI_ADMIN keeps what #3699 deploy 2 shipped', () => {
        expect(TENANT_ROLES.filter((r) => clearingCustomRoleIsOwnerTier(r))).toEqual(['OWNER']);
    });
});

// ─── assignCustomRole ──────────────────────────────────────────────

describe('assignCustomRole on an OWNER membership', () => {
    it('an ADMIN assigning a custom role to an OWNER is refused — 409, named reason, nothing read or written', async () => {
        const db = membershipDb({ role: 'OWNER' });
        const err = await assignCustomRole(admin(), 'm-1', 'cr-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(err.message).toMatch(/OWNER role cannot carry a custom role/);
        expect(db.tenantCustomRole.findFirst).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an OWNER assigning a custom role to an OWNER is refused too — the rule is about the membership', async () => {
        const db = membershipDb({ role: 'OWNER' });
        const err = await assignCustomRole(owner(), 'm-1', 'cr-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an ADMIN clearing an OWNER’s (legacy) custom role is refused — 403, named reason', async () => {
        const db = membershipDb({ role: 'OWNER', customRoleId: 'cr-legacy' });
        const err = await assignCustomRole(admin(), 'm-1', null).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.details).toEqual({ reason: OWNER_TIER_CLEAR_REFUSAL });
        expect(err.message).toBe(
            'Only an OWNER can remove a custom role from an OWNER membership: it restores full OWNER authority.',
        );
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an ADMIN is refused the clear even when the OWNER carries nothing — an ADMIN does not modify an OWNER membership', async () => {
        const db = membershipDb({ role: 'OWNER', customRoleId: null });
        await expect(assignCustomRole(admin(), 'm-1', null)).rejects.toMatchObject({
            status: 403,
            details: { reason: OWNER_TIER_CLEAR_REFUSAL },
        });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an OWNER clearing an OWNER’s legacy custom role is allowed, and audited', async () => {
        const db = membershipDb({ role: 'OWNER', customRoleId: 'cr-legacy' });
        await assignCustomRole(owner(), 'm-1', null);
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm-1' }, data: { customRoleId: null } }),
        );
        expect((logEvent as jest.Mock).mock.calls[0][2]).toMatchObject({
            action: 'MEMBER_CUSTOM_ROLE_CHANGED',
            detailsJson: expect.objectContaining({ fromStatus: 'cr-legacy', toStatus: 'none' }),
        });
    });

    it('an ADMIN clearing on an AI_ADMIN membership is unchanged from #3699 deploy 2 — allowed', async () => {
        const db = membershipDb({ role: 'AI_ADMIN', customRoleId: 'cr-legacy' });
        await assignCustomRole(admin(), 'm-1', null);
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { customRoleId: null } }),
        );
    });

    it.each(['ADMIN', 'EDITOR', 'AUDITOR', 'READER'])(
        'an ADMIN still assigns and clears on a %s membership',
        async (role) => {
            const db = membershipDb({ role });
            await assignCustomRole(admin(), 'm-1', 'cr-1');
            await assignCustomRole(admin(), 'm-1', null);
            expect(db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
                { customRoleId: 'cr-1' },
                { customRoleId: null },
            ]);
        },
    );
});

// ─── PROMOTION TO OWNER ────────────────────────────────────────────

describe('promoting a member who carries a custom role to OWNER — refused until it is removed', () => {
    it('the members-page role change: an OWNER promoting such a member gets a 409 with the named reason', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-1' });
        const err = await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'OWNER' }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(err.message).toMatch(/Remove this member's custom role first/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an ADMIN is refused earlier, by the promote-to-OWNER gate', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-1' });
        await expect(updateTenantMemberRole(admin(), { membershipId: 'm-1', role: 'OWNER' })).rejects.toThrow(
            'Only OWNERs can promote to OWNER.',
        );
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('without a custom role the promotion proceeds — the refusal is the custom role, not the promotion', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: null });
        await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'OWNER' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'OWNER' } }));
    });

    it('a legacy OWNER carrying one can be demoted to a role that may carry it (the row becomes valid)', async () => {
        const db = membershipDb({ role: 'OWNER', customRoleId: 'cr-legacy' });
        await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'ADMIN' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'ADMIN' } }));
    });

    describe('transferTenantOwnership', () => {
        const input = { tenantId: 'tenant-1', currentOwnerUserId: 'owner-1', newOwnerEmail: 'new@example.com' };

        it('a new owner who carries a custom role is refused before anything is written', async () => {
            prismaMock.user.findUnique.mockResolvedValue({ id: 'u-new' });
            prismaMock.tenantMembership.findFirst.mockResolvedValueOnce({
                id: 'm-new',
                role: 'EDITOR',
                customRoleId: 'cr-1',
            });
            const err = await transferTenantOwnership(input).catch((e) => e);
            expect(err).toBeInstanceOf(ConflictError);
            expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
            expect(prismaMock.$transaction).not.toHaveBeenCalled();
            expect(appendAuditEntryMock).not.toHaveBeenCalled();
        });

        it('the outgoing owner’s legacy custom role does not block it — they become an ADMIN, which may carry one', async () => {
            prismaMock.user.findUnique.mockResolvedValue({ id: 'u-new' });
            prismaMock.tenantMembership.findFirst
                .mockResolvedValueOnce({ id: 'm-new', role: 'EDITOR', customRoleId: null })
                .mockResolvedValueOnce({ id: 'm-old' });
            const update = jest.fn().mockResolvedValue({});
            prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
                fn({ tenantMembership: { update } }),
            );
            await transferTenantOwnership(input);
            expect(update.mock.calls.map((c: any[]) => c[0])).toEqual([
                { where: { id: 'm-new' }, data: { role: 'OWNER' } },
                { where: { id: 'm-old' }, data: { role: 'ADMIN' } },
            ]);
        });
    });
});

// ─── THE MEMBERS PATCH ROUTE, END TO END ───────────────────────────

describe('PATCH /api/t/:slug/admin/members/:membershipId — neither half slips through the other', () => {
    const patch = (body: unknown) =>
        new NextRequest('http://localhost/api/t/acme/admin/members/m-1', {
            method: 'PATCH',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        });
    const args = { params: Promise.resolve({ tenantSlug: 'acme', membershipId: 'm-1' }) };
    const route = () =>
        import('@/app/api/t/[tenantSlug]/admin/members/[membershipId]/route') as Promise<{
            PATCH: (r: NextRequest, a: unknown) => Promise<Response>;
        }>;

    it('the exploit: an ADMIN sending { customRoleId } for an OWNER gets a 409 with the reason, and nothing is written', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        const db = membershipDb({ role: 'OWNER' });
        const { PATCH } = await route();
        const res = await PATCH(patch({ customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(409);
        expect((await res.json()).error.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an ADMIN sending { customRoleId: null } for an OWNER gets a 403 that names its reason', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        const db = membershipDb({ role: 'OWNER', customRoleId: 'cr-legacy' });
        const { PATCH } = await route();
        const res = await PATCH(patch({ customRoleId: null }), args);
        expect(res.status).toBe(403);
        expect((await res.json()).error.details).toEqual({ reason: OWNER_TIER_CLEAR_REFUSAL });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('OWNER together with a custom role in one body is refused before either write', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'OWNER', customRoleId: 'cr-1' }), args);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(BUILT_IN_SCOPE_REFUSAL);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('promote-and-clear in one body commits nothing for a member who carries a custom role', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-1' });
        const { PATCH } = await route();
        const res = await PATCH(patch({ role: 'OWNER', customRoleId: null }), args);
        expect(res.status).toBe(409);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an empty-string customRoleId is neither an id nor a clear — 400, before the database', async () => {
        getTenantCtxMock.mockResolvedValue(owner());
        const { PATCH } = await route();
        const res = await PATCH(patch({ customRoleId: '' }), args);
        expect(res.status).toBe(400);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });
});

// ─── INVITES ───────────────────────────────────────────────────────

describe('invites redeemed as OWNER onto a membership carrying a custom role', () => {
    function inviteDb(existing: { status: string; customRoleId: string | null } | null) {
        const db = {
            user: { findUnique: jest.fn().mockResolvedValue(existing ? { id: 'u-1' } : null) },
            tenantMembership: { findUnique: jest.fn().mockResolvedValue(existing) },
            tenantInvite: {
                upsert: jest.fn(async (a: any) => ({ id: 'inv-1', token: 't', ...a.create })),
            },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        return db;
    }

    it('createInviteToken refuses an OWNER invite for a deactivated member who carries one — before it is sent', async () => {
        const db = inviteDb({ status: 'DEACTIVATED', customRoleId: 'cr-1' });
        const err = await createInviteToken(owner(), { email: 'x@example.com', role: 'OWNER' }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(db.tenantInvite.upsert).not.toHaveBeenCalled();
    });

    it('the same person invited as EDITOR is not refused — EDITOR may carry a custom role', async () => {
        const db = inviteDb({ status: 'DEACTIVATED', customRoleId: 'cr-1' });
        await createInviteToken(owner(), { email: 'x@example.com', role: 'EDITOR' });
        expect(db.tenantInvite.upsert).toHaveBeenCalledTimes(1);
    });

    function claimed(role: string) {
        prismaMock.tenantInvite.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.tenantInvite.findUnique.mockResolvedValue({
            id: 'inv-1',
            tenantId: 'tenant-1',
            email: 'x@example.com',
            role,
            invitedById: 'owner-1',
            createdAt: new Date(),
        });
    }
    function redemptionTx(existingCustomRoleId: string | null) {
        const tx = {
            tenantMembership: {
                findUnique: jest.fn().mockResolvedValue({ customRoleId: existingCustomRoleId }),
                upsert: jest.fn().mockResolvedValue({ id: 'm-1' }),
            },
            tenant: { findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }) },
        };
        prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
        return tx;
    }

    it('redeemInvite refuses an OWNER invite onto a membership that carries one (the backstop) — no upsert', async () => {
        claimed('OWNER');
        const tx = redemptionTx('cr-1');
        const err = await redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: BUILT_IN_SCOPE_REFUSAL });
        expect(tx.tenantMembership.upsert).not.toHaveBeenCalled();
    });

    it('redeemInvite as OWNER proceeds when the membership carries none', async () => {
        claimed('OWNER');
        const tx = redemptionTx(null);
        await expect(redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' })).resolves.toMatchObject({
            role: 'OWNER',
        });
        expect(tx.tenantMembership.upsert).toHaveBeenCalledTimes(1);
    });

    it('a non-OWNER invite reads no custom role at all', async () => {
        claimed('EDITOR');
        const tx = redemptionTx('cr-1');
        await redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' });
        expect(tx.tenantMembership.findUnique).not.toHaveBeenCalled();
        expect(tx.tenantMembership.upsert).toHaveBeenCalledTimes(1);
    });

    it('redeemPendingInvitesByEmail skips such an OWNER invite WITHOUT claiming it, and still redeems the others', async () => {
        prismaMock.tenantInvite.findMany.mockResolvedValue([
            { id: 'inv-owner', tenantId: 'tenant-1', role: 'OWNER', invitedById: 'o', createdAt: new Date() },
            { id: 'inv-editor', tenantId: 'tenant-2', role: 'EDITOR', invitedById: 'o', createdAt: new Date() },
        ]);
        prismaMock.tenantMembership.findMany.mockResolvedValue([{ tenantId: 'tenant-1' }]);
        prismaMock.tenantInvite.updateMany.mockResolvedValue({ count: 1 });
        redemptionTx(null);
        const redeemed = await redeemPendingInvitesByEmail({ userId: 'u-1', userEmail: 'x@example.com' });
        expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'u-1', tenantId: { in: ['tenant-1'] }, customRoleId: { not: null } },
            }),
        );
        expect(prismaMock.tenantInvite.updateMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.tenantInvite.updateMany.mock.calls[0][0].where.id).toBe('inv-editor');
        expect(redeemed.map((r) => r.role)).toEqual(['EDITOR']);
    });
});

// ─── ACCESS REVIEW MODIFY ──────────────────────────────────────────

describe('an access review MODIFY into OWNER', () => {
    it('submission refuses OWNER with a custom role, and accepts OWNER without one and EDITOR with one', () => {
        const parsed = SubmitDecisionSchema.safeParse({
            decision: 'MODIFY',
            modifiedToRole: 'OWNER',
            modifiedToCustomRoleId: 'cr-1',
        });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain(BUILT_IN_SCOPE_REFUSAL);
        expect(SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'OWNER' }).success).toBe(true);
        expect(
            SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'EDITOR', modifiedToCustomRoleId: 'cr-1' })
                .success,
        ).toBe(true);
    });

    function closeDb(decision: { modifiedToRole: string; modifiedToCustomRoleId: string | null }, live: { role: string; customRoleId: string | null }) {
        const db = {
            accessReview: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'ar-1',
                    tenantId: 'tenant-1',
                    scope: 'ALL_USERS',
                    status: 'IN_REVIEW',
                    deletedAt: null,
                    reviewer: { email: 'r@x' },
                    createdBy: { email: 'c@x' },
                }),
            },
            accessReviewDecision: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        id: 'd-1',
                        membershipId: 'm-1',
                        subjectUserId: 'u-1',
                        snapshotRole: live.role,
                        snapshotMembershipStatus: 'ACTIVE',
                        decision: 'MODIFY',
                        ...decision,
                        executedAt: null,
                        membership: { id: 'm-1', userId: 'u-1', status: 'ACTIVE', ...live },
                        subjectUser: { id: 'u-1', email: 'u@x', name: null },
                    },
                ]),
            },
            tenantMembership: { findMany: jest.fn(), update: jest.fn() },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        return db;
    }

    it('closing a stored MODIFY to OWNER that names a custom role refuses the whole close before any row executes', async () => {
        const db = closeDb({ modifiedToRole: 'OWNER', modifiedToCustomRoleId: 'cr-1' }, { role: 'EDITOR', customRoleId: null });
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toMatchObject({
            status: 409,
            details: { reason: BUILT_IN_SCOPE_REFUSAL },
        });
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('closing a MODIFY to OWNER for a member who still carries a custom role is refused too — never cleared on the closer’s behalf', async () => {
        const db = closeDb({ modifiedToRole: 'OWNER', modifiedToCustomRoleId: null }, { role: 'EDITOR', customRoleId: 'cr-1' });
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toMatchObject({
            status: 409,
            details: { reason: BUILT_IN_SCOPE_REFUSAL },
        });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });
});

// ─── PATHS THAT CANNOT REACH OWNER — VERIFIED, NOT ASSUMED ─────────

describe('SCIM, SSO JIT and Entra never write OWNER, so cannot make the combination', () => {
    it('SCIM: neither ceiling holds OWNER, and an OWNER membership is protected for role and status', () => {
        expect(SCIM_ASSIGNABLE_ROLES as readonly string[]).not.toContain('OWNER');
        expect(SCIM_GROUP_ASSIGNABLE_ROLES as readonly string[]).not.toContain('OWNER');
        expect(isScimProtectedRole('OWNER')).toBe(true);
        expect(isScimStatusProtectedRole('OWNER')).toBe(true);
    });

    it('SSO JIT: the default role cannot be OWNER', () => {
        const parsed = UpsertSsoConfigInput.safeParse({
            name: 'IdP',
            type: 'OIDC',
            config: {},
            allowJitProvisioning: true,
            jitDefaultRole: 'OWNER',
        });
        expect(parsed.success).toBe(false);
    });

    it('Entra: no mapping may target OWNER, and a stored one resolves to nothing', () => {
        expect(ENTRA_MAPPABLE_ROLES as readonly string[]).not.toContain('OWNER');
        expect(NEVER_GROUP_MAPPED_ROLES).toContain('OWNER');
        expect(
            EntraGroupMappingCreateSchema.safeParse({ aadGroupId: '00000000-0000-4000-8000-000000000001', role: 'OWNER' })
                .success,
        ).toBe(false);
    });

    it('Entra: the group sync never writes to an OWNER membership, custom role or not', async () => {
        const update = jest.fn();
        const result = await syncEntraMembershipRole(
            { userId: 'u-1', tenantId: 'tenant-1', aadGroups: ['g-1'] },
            {
                db: {
                    tenantIdentityProvider: { findFirst: jest.fn().mockResolvedValue(null) },
                    tenantEntraGroupMapping: {
                        findMany: jest.fn().mockResolvedValue([{ aadGroupId: 'g-1', role: 'READER', priority: 0 }]),
                    },
                    tenantMembership: {
                        findFirst: jest.fn().mockResolvedValue({ id: 'm-1', role: 'OWNER', customRoleId: 'cr-legacy' }),
                        update,
                    },
                } as never,
            },
        );
        expect(result).toEqual({ effectiveRole: 'OWNER', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
    });
});

// ─── STRUCTURE — WHO WRITES customRoleId ───────────────────────────

/**
 * Every file whose code writes `TenantMembership.customRoleId`, and how each is
 * held. A third writer must hold the rule as well, or appear here with a reason.
 */
const CUSTOM_ROLE_ID_WRITERS: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/custom-roles.ts':
        'assignCustomRole (refuses OWNER/AI_ADMIN; the OWNER clear is OWNER-tier) and deleteCustomRole (clears to NULL only)',
    'src/app-layer/usecases/access-review.ts':
        'closeAccessReview MODIFY: refused at submission and close when the target role carries none',
};

/** A `data:` / `create:` / `update:` object literal naming `customRoleId`. */
const WRITES_CUSTOM_ROLE_ID = /(?:\bdata|\bcreate|\bupdate)\s*:\s*\{[^}]*\bcustomRoleId\b/;

describe('STRUCTURE — the writers of TenantMembership.customRoleId', () => {
    const srcFiles = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
        rel: repoRelative(abs),
        code: codeOf(readFileSync(abs, 'utf8')),
    }));

    it('the population is real', () => {
        expect(srcFiles.length).toBeGreaterThan(1000);
    });

    it('exactly the listed files write it', () => {
        const writers = srcFiles.filter((f) => WRITES_CUSTOM_ROLE_ID.test(f.code)).map((f) => f.rel).sort();
        expect(writers).toEqual(Object.keys(CUSTOM_ROLE_ID_WRITERS).sort());
    });

    it('the detector is not blind (each write shape is caught, a select is not)', () => {
        for (const sample of [
            'data: { customRoleId }',
            'data: { customRoleId: null }',
            'data: {\n role: x,\n ...(c ? { customRoleId: y } : {}) }',
            'create: { tenantId, userId, role, customRoleId: id }',
            'update: { role, customRoleId: id }',
        ]) {
            expect({ sample, caught: WRITES_CUSTOM_ROLE_ID.test(sample) }).toEqual({ sample, caught: true });
        }
        expect(WRITES_CUSTOM_ROLE_ID.test('select: { id: true, customRoleId: true }')).toBe(false);
    });
});
