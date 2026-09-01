/**
 * Regression cover for the cross-tenant global `User.name` write.
 *
 * HISTORY, because the shape of the bug is the reason these tests look the way
 * they do. `scimPutUser` / `scimPatchUser` write `User.name`, which lives on the
 * GLOBAL user row — it has no `tenantId` and there is no `where` clause that can
 * scope it to a tenant. The first guard placed an authorization check above the
 * write (correct) but asked `isScimProtectedRole(membership.role)`, where
 * `membership` came from `findFirst({ where: { tenantId: ctx.tenantId, userId } })`
 * — the victim's role IN THE CALLER'S OWN TENANT. Correctly placed, wrong
 * subject. A user who is READER in tenant A and OWNER in tenant B was
 * unprotected, so tenant A's SCIM token could rename tenant B's owner.
 *
 * The fix is `isUserProtectedInAnyTenant(userId)`: match the predicate to the
 * BLAST RADIUS of the write. Global write, global predicate.
 *
 * So the load-bearing assertion in this file is not "a protected user is
 * refused" — it is that the query carries NO `tenantId`. A future narrowing of
 * that `where` clause reintroduces the exact defect while every refusal test
 * here keeps passing, because in the tests the victim is protected in the
 * calling tenant too. `pins the predicate as GLOBAL` is the one that sees it.
 */

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
        tenantMembership: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import { scimPatchUser, scimPutUser } from '@/app-layer/usecases/scim-users';
import prismaDefault from '@/lib/prisma';

const db = prismaDefault as unknown as {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    tenantMembership: {
        findFirst: jest.Mock;
        findUnique: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        count: jest.Mock;
    };
};

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** Any tenant that can mint itself a SCIM token. */
const attackerCtx = { tenantId: 'tenant-A', tokenId: 'tok-A', tokenLabel: 'Attacker IdP' };

/**
 * The victim as tenant A sees them: an ordinary READER. Their OWNER role in
 * tenant B is not on this row and is not reachable from it — which is precisely
 * why a predicate reading THIS row cannot protect them.
 */
const victimAsSeenByAttacker = () => ({
    id: 'membership-in-A',
    tenantId: 'tenant-A',
    userId: 'victim-user-id',
    status: 'ACTIVE',
    role: 'READER',
    user: {
        id: 'victim-user-id',
        email: 'owner@victimco.example',
        name: 'Dana Reyes',
        createdAt: NOW,
        updatedAt: NOW,
    },
});

const putInput = { userName: 'owner@victimco.example', displayName: 'PWNED', active: true };

beforeEach(() => {
    jest.clearAllMocks();
    db.tenantMembership.update.mockResolvedValue({});
    db.user.update.mockResolvedValue({});
    db.tenantMembership.findFirst.mockResolvedValue(victimAsSeenByAttacker());
    // Default to 0 EXPLICITLY. `jest.clearAllMocks()` leaves a mock returning
    // `undefined`, and the predicate reads `count > 0` — so an unmocked `count`
    // evaluates `undefined > 0` === false, i.e. "protected nowhere", i.e. the
    // write proceeds. The guard fails OPEN when its query is not stubbed, which
    // is the wrong direction to fail in and is easy to reintroduce in any other
    // suite that mocks prisma and reaches this path.
    db.tenantMembership.count.mockResolvedValue(0);
});

describe('SCIM: the global User.name write is guarded by a GLOBAL predicate', () => {
    it('PUT does not write the global User row when the victim is protected in another tenant', async () => {
        db.tenantMembership.count.mockResolvedValue(1); // OWNER somewhere else

        await scimPutUser(attackerCtx, 'victim-user-id', putInput, 'https://x.example');

        expect(db.user.update).not.toHaveBeenCalled();
    });

    it('PATCH does not write the global User row for the same victim', async () => {
        db.tenantMembership.count.mockResolvedValue(1);

        await scimPatchUser(
            attackerCtx,
            'victim-user-id',
            [{ op: 'replace', path: 'displayName', value: 'PWNED2' }],
            'https://x.example',
        );

        expect(db.user.update).not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL. Without this, both refusals above are satisfied by a
     * guard that blocks the profile write unconditionally, and neither test
     * could tell that apart from a working predicate.
     */
    it('still writes for a user protected nowhere — the refusal is the predicate, not a blanket block', async () => {
        db.tenantMembership.count.mockResolvedValue(0);

        await scimPutUser(attackerCtx, 'victim-user-id', putInput, 'https://x.example');

        expect(db.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'victim-user-id' } }),
        );
    });

    /**
     * THE ONE THAT CATCHES THE ORIGINAL BUG COMING BACK.
     *
     * Every assertion above still passes if someone "scopes" this query by
     * adding `tenantId: ctx.tenantId` — the victim is protected in the calling
     * tenant in those fixtures, so the count is still 1. This asserts the
     * absence of that key, which is the actual invariant: the predicate's
     * reach must match the write's reach, and the write is global.
     */
    it('pins the predicate as GLOBAL — the protection query carries no tenantId', async () => {
        db.tenantMembership.count.mockResolvedValue(1);

        await scimPutUser(attackerCtx, 'victim-user-id', putInput, 'https://x.example');

        expect(db.tenantMembership.count).toHaveBeenCalledTimes(1);
        const where = db.tenantMembership.count.mock.calls[0][0].where;
        expect(where).not.toHaveProperty('tenantId');
        expect(where.userId).toBe('victim-user-id');
        expect(where.status).toBe('ACTIVE');
    });
});
