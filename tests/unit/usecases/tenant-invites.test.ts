/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/tenant-invites.ts
 *
 * Wave 5 of GAP-02. Epic 1's invite flow is the ONLY way new
 * TenantMembership rows land — everything else (OAuth sign-in,
 * SCIM, even credentials self-signup) eventually goes through
 * `redeemInvite`. The security contract is dense:
 *
 *   1. Token is a 256-bit base64url random string with 7-day TTL.
 *   2. Email binding is strict, case-insensitive — a leaked
 *      token used by anyone other than the invitee is BURNT on
 *      first claim, not just rejected.
 *   3. The atomic claim is an `updateMany` predicate (the
 *      acceptedAt+revokedAt+expiresAt liveness gates), not a
 *      separate read-then-write — concurrent claims see
 *      count=0 and get a 410 Gone.
 *   4. OWNER role invites require admin.owner_management on top
 *      of admin.members — separation of duty.
 *   5. Audit emit is post-commit so the chain entry never points
 *      at a transaction that rolled back.
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantInvite: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        tenant: {
            findUnique: jest.fn(),
        },
        tenantMembership: {
            upsert: jest.fn(),
            findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createInviteToken,
    revokeInvite,
    listPendingInvites,
    previewInviteByToken,
    redeemInvite,
    inviteSignInOutcome,
} from '@/app-layer/usecases/tenant-invites';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockInviteFindUnique = prisma.tenantInvite.findUnique as jest.MockedFunction<typeof prisma.tenantInvite.findUnique>;
const mockInviteUpdateMany = prisma.tenantInvite.updateMany as jest.MockedFunction<typeof prisma.tenantInvite.updateMany>;
const mockTransaction = prisma.$transaction as jest.MockedFunction<any>;
const mockMembershipFindFirst = prisma.tenantMembership.findFirst as jest.MockedFunction<typeof prisma.tenantMembership.findFirst>;
const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockAppendAudit = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createInviteToken — RBAC + OWNER guard', () => {
    function txDb(opts: {
        existingUser?: { id: string } | null;
        existingMembershipStatus?: string;
        upsertResult?: object;
    } = {}) {
        return {
            user: { findUnique: jest.fn().mockResolvedValue(opts.existingUser ?? null) },
            tenantMembership: {
                findUnique: jest.fn().mockResolvedValue(
                    opts.existingMembershipStatus
                        ? { status: opts.existingMembershipStatus }
                        : null,
                ),
            },
            tenantInvite: {
                upsert: jest.fn().mockResolvedValue(
                    opts.upsertResult ?? {
                        id: 'invite-1',
                        token: 'tok',
                        email: 'a@b.com',
                        role: 'EDITOR',
                    },
                ),
            },
        };
    }

    it('rejects EDITOR (canManageMembers gate)', async () => {
        await expect(
            createInviteToken(makeRequestContext('EDITOR'), {
                email: 'a@b.com',
                role: 'EDITOR',
            }),
        ).rejects.toThrow();
    });

    it('rejects OWNER role invite when caller lacks admin.owner_management', async () => {
        const ctx = makeRequestContext('ADMIN');
        // ADMIN's resolved permissions DENY owner_management — the
        // resolver should produce false. Verify here too in case a
        // future schema change widens ADMIN.
        ctx.appPermissions.admin.owner_management = false;

        await expect(
            createInviteToken(ctx, { email: 'a@b.com', role: 'OWNER' }),
        ).rejects.toThrow(/Only OWNERs can invite other OWNERs/);
        // Regression: a refactor that collapsed both gates into
        // canManageMembers alone would let any ADMIN promote
        // themselves to OWNER by inviting their own alt account.
    });

    it('allows OWNER role invite when caller is OWNER (has owner_management)', async () => {
        const ctx = makeRequestContext('OWNER');
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(txDb() as never));

        await expect(
            createInviteToken(ctx, { email: 'a@b.com', role: 'OWNER' }),
        ).resolves.toBeDefined();
    });

    it('rejects when the email already has an ACTIVE membership', async () => {
        const fakeDb = txDb({
            existingUser: { id: 'user-1' },
            existingMembershipStatus: 'ACTIVE',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            createInviteToken(makeRequestContext('ADMIN'), {
                email: 'existing@b.com',
                role: 'EDITOR',
            }),
        ).rejects.toThrow(/already a member/);
        // Regression: skipping this guard would let an admin
        // re-invite an active member, refresh the token, and
        // overwrite the role on redemption — privilege escalation.
        expect(fakeDb.tenantInvite.upsert).not.toHaveBeenCalled();
    });

    it('normalises email (trim + lowercase) before persistence', async () => {
        const fakeDb = txDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createInviteToken(makeRequestContext('ADMIN'), {
            email: '   Mixed.Case@EXAMPLE.com  ',
            role: 'EDITOR',
        });

        const upsertArgs = (fakeDb.tenantInvite.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertArgs.where.tenantId_email.email).toBe('mixed.case@example.com');
        expect(upsertArgs.create.email).toBe('mixed.case@example.com');
    });

    it('emits MEMBER_INVITED audit', async () => {
        const fakeDb = txDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createInviteToken(makeRequestContext('ADMIN'), {
            email: 'a@b.com',
            role: 'EDITOR',
        });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'MEMBER_INVITED' }),
        );
    });

    it('returns the relative URL `/invite/<token>` for emailing', async () => {
        const fakeDb = txDb({
            upsertResult: {
                id: 'invite-1',
                token: 'random-tok-xyz',
                email: 'a@b.com',
                role: 'EDITOR',
            },
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        const result = await createInviteToken(makeRequestContext('ADMIN'), {
            email: 'a@b.com',
            role: 'EDITOR',
        });

        expect(result.url).toBe('/invite/random-tok-xyz');
    });
});

describe('revokeInvite', () => {
    it('rejects EDITOR (canManageMembers gate)', async () => {
        await expect(
            revokeInvite(makeRequestContext('EDITOR'), { inviteId: 'i1' }),
        ).rejects.toThrow();
    });

    it('throws notFound on cross-tenant invite id', async () => {
        const fakeDb = {
            tenantInvite: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            revokeInvite(makeRequestContext('ADMIN'), { inviteId: 'tenant-B-invite' }),
        ).rejects.toThrow(/already accepted\/revoked/);
        // Regression: a refactor that revoked by id without the
        // tenantId filter would let admin in A invalidate B's invites.
        expect(fakeDb.tenantInvite.update).not.toHaveBeenCalled();
    });
});

describe('listPendingInvites', () => {
    it('rejects when caller cannot view admin settings', async () => {
        // canViewAdminSettings is satisfied by ADMIN; READER cannot.
        await expect(
            listPendingInvites(makeRequestContext('READER')),
        ).rejects.toThrow();
    });
});

describe('previewInviteByToken — null on every failure mode', () => {
    it('returns null when the token does not exist', async () => {
        mockInviteFindUnique.mockResolvedValueOnce(null);
        const result = await previewInviteByToken('nope', null);
        expect(result).toBeNull();
    });

    it('returns null for revoked invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            role: 'EDITOR',
            revokedAt: new Date(),
            acceptedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
        // Regression: surfacing tenant name + role for revoked
        // invites would let an attacker probe valid token strings
        // for tenant metadata.
    });

    it('returns null for accepted invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            acceptedAt: new Date(),
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('returns null for expired invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() - 1000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('matchesSession is case-insensitive', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'Mixed.Case@Example.COM',
            role: 'EDITOR',
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        const result = await previewInviteByToken('tok', 'mixed.case@example.com');
        expect(result?.matchesSession).toBe(true);
        // Regression: a strict-equal compare would force the
        // signed-in user to use the exact case of the invite
        // email — most OAuth providers normalise email to
        // lowercase, so the user would be locked out of valid
        // invites sent to "John.Doe@..." style addresses.
    });
});

describe('redeemInvite — atomic claim + email binding', () => {
    it('throws notFound when the token does not exist', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce(null);

        await expect(
            redeemInvite({
                token: 'nope',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/Invite not found/);
    });

    it('throws gone when the invite was revoked', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: null,
            revokedAt: new Date(),
            expiresAt: new Date(Date.now() + 100000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/revoked/);
    });

    it('throws gone when the invite has expired', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() - 1000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/expired/);
    });

    it('throws gone when the invite was already redeemed (race lost)', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: new Date(),
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/already been redeemed/);
        // Regression: a refactor that returned the existing membership
        // instead of throwing would let two concurrent redemptions of
        // the same token both "succeed" — the second sees an active
        // membership and silently no-ops, masking a possible token
        // leak from the security team.
    });

    it('email mismatch: invite IS BURNT — the throw must NOT roll back the claim', async () => {
        // The claim is committed (count=1). Then the email check fails.
        // The thrown error must come from the standalone post-claim path,
        // NOT from inside a transaction that would roll back the claim.
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 1 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            id: 'invite-1',
            tenantId: 't1',
            email: 'real-invitee@b.com',
            role: 'EDITOR',
            invitedById: 'admin-1',
        } as never);

        await expect(
            redeemInvite({
                token: 'leaked-tok',
                userId: 'attacker-id',
                userEmail: 'attacker@b.com',
            }),
        ).rejects.toThrow(/Invite email does not match/);
        // Regression: putting the email-binding inside a $transaction
        // would have Prisma roll back the acceptedAt write on throw.
        // A leaked token could then be tried again by the legitimate
        // invitee — but worse, an attacker could keep retrying with
        // different userEmail values until they found one that
        // matched.  We check that the $transaction was NOT entered
        // (the post-claim email check is sequenced before the tx).
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('happy path: $transaction upserts membership, post-commit audit fires', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 1 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            id: 'invite-1',
            tenantId: 't1',
            email: 'me@b.com',
            role: 'EDITOR',
            invitedById: 'admin-1',
        } as never);

        const upsertSpy = jest.fn().mockResolvedValue({ id: 'membership-1' });
        mockTransaction.mockImplementationOnce(async (fn: any) =>
            fn({
                // The redemption reads the membership's custom role (2026-10-30); here there is none.
                tenantMembership: { upsert: upsertSpy, findUnique: jest.fn().mockResolvedValue(null) },
                tenant: {
                    findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }),
                },
            }),
        );

        const result = await redeemInvite({
            token: 'tok',
            userId: 'user-1',
            userEmail: 'me@b.com',
        });

        expect(result).toEqual({
            tenantId: 't1',
            slug: 'acme',
            role: 'EDITOR',
        });
        expect(upsertSpy).toHaveBeenCalled();
        // Regression: appendAuditEntry is INTENTIONALLY post-tx
        // because it opens its own advisory-locked transaction.
        // Calling it inside the tx would deadlock; calling it
        // pre-tx would emit chain entries pointing at writes that
        // could still roll back.
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'MEMBER_INVITE_ACCEPTED',
                entity: 'TenantMembership',
            }),
        );
    });
});

describe('redeemInvite — each refusal names its reason (#4689)', () => {
    const input = { token: 'tok', userId: 'u-1', userEmail: 'a@example.com' };
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);

    async function reasonOf(): Promise<unknown> {
        try {
            await redeemInvite(input);
        } catch (e) {
            return (e as { details?: { reason?: unknown } }).details?.reason;
        }
        throw new Error('expected a refusal');
    }

    it.each([
        ['INVITE_NOT_FOUND', null],
        ['INVITE_REVOKED', { acceptedAt: null, revokedAt: new Date(), expiresAt: future }],
        ['INVITE_EXPIRED', { acceptedAt: null, revokedAt: null, expiresAt: past }],
        ['INVITE_ALREADY_REDEEMED', { acceptedAt: new Date(), revokedAt: null, expiresAt: future }],
    ])('%s', async (reason, row) => {
        mockInviteUpdateMany.mockResolvedValue({ count: 0 });
        mockInviteFindUnique.mockResolvedValue(row as never);
        await expect(reasonOf()).resolves.toBe(reason);
    });

    it('INVITE_EMAIL_MISMATCH', async () => {
        mockInviteUpdateMany.mockResolvedValue({ count: 1 });
        mockInviteFindUnique.mockResolvedValue({
            id: 'inv-1', tenantId: 't-1', email: 'other@example.com', role: 'EDITOR',
            invitedById: 'u-0', createdAt: new Date(),
        } as never);
        await expect(reasonOf()).resolves.toBe('INVITE_EMAIL_MISMATCH');
    });
});

describe('inviteSignInOutcome — what became of an invite redeemed at sign-in (#4689)', () => {
    const input = { token: 'tok', userId: 'u-1', userEmail: 'Invitee@Example.com' };
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const row = (over: Record<string, unknown>) => ({
        tenantId: 't-1',
        email: 'invitee@example.com',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: future,
        tenant: { name: 'Acme', slug: 'acme' },
        ...over,
    });

    it('ACCEPTED when the invite is spent and the user is an active member', async () => {
        mockInviteFindUnique.mockResolvedValue(row({ acceptedAt: new Date() }) as never);
        mockMembershipFindFirst.mockResolvedValue({ id: 'm-1' } as never);
        await expect(inviteSignInOutcome(input)).resolves.toEqual({ kind: 'ACCEPTED', slug: 'acme' });
        expect(mockMembershipFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 't-1', userId: 'u-1', status: 'ACTIVE' } }),
        );
    });

    it('EMAIL_MISMATCH when it was spent by a sign-in under another address', async () => {
        mockInviteFindUnique.mockResolvedValue(row({ acceptedAt: new Date(), email: 'other@example.com' }) as never);
        mockMembershipFindFirst.mockResolvedValue(null);
        await expect(inviteSignInOutcome(input)).resolves.toEqual({
            kind: 'REFUSED', reason: 'INVITE_EMAIL_MISMATCH', tenantName: 'Acme',
        });
    });

    it('NOT_COMPLETED when it was spent under the right address but no membership exists', async () => {
        mockInviteFindUnique.mockResolvedValue(row({ acceptedAt: new Date() }) as never);
        mockMembershipFindFirst.mockResolvedValue(null);
        await expect(inviteSignInOutcome(input)).resolves.toMatchObject({ reason: 'INVITE_NOT_COMPLETED' });
    });

    it('REVOKED, EXPIRED and NOT_FOUND', async () => {
        mockInviteFindUnique.mockResolvedValue(row({ revokedAt: new Date() }) as never);
        await expect(inviteSignInOutcome(input)).resolves.toMatchObject({ reason: 'INVITE_REVOKED' });
        mockInviteFindUnique.mockResolvedValue(row({ expiresAt: past }) as never);
        await expect(inviteSignInOutcome(input)).resolves.toMatchObject({ reason: 'INVITE_EXPIRED' });
        mockInviteFindUnique.mockResolvedValue(null);
        await expect(inviteSignInOutcome(input)).resolves.toEqual({
            kind: 'REFUSED', reason: 'INVITE_NOT_FOUND', tenantName: null,
        });
    });

    it('PENDING when the invite is still live', async () => {
        mockInviteFindUnique.mockResolvedValue(row({}) as never);
        await expect(inviteSignInOutcome(input)).resolves.toEqual({ kind: 'PENDING' });
        expect(mockMembershipFindFirst).not.toHaveBeenCalled();
    });
});
