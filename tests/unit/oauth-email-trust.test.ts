/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and
 * NextAuth callback call shapes. */
/**
 * An OAuth sign-in stands for an email address only when its provider vouches
 * for it (src/lib/auth/oauth-email-trust.ts), and a vouched sign-in claims an
 * account whose address nobody ever verified.
 *
 * Two halves:
 *   - the rule itself, and the claim's writes, against a Prisma double;
 *   - the real `signIn` callback: an unvouched Microsoft email links nothing
 *     and redeems no invite by address; a vouched one links and claims.
 */
const state = {
    user: null as null | { id: string; emailVerified: Date | null; passwordHash: string | null },
    otherLinks: 0,
    ops: [] as string[],
};

const db: any = {
    user: {
        findUnique: jest.fn(async () => state.user),
        updateMany: jest.fn(async () => {
            state.ops.push('user.stampVerified');
            return { count: 1 };
        }),
        update: jest.fn((args: any) => {
            state.ops.push(`user.update:${JSON.stringify(args.data)}`);
            return 'user.update';
        }),
    },
    account: {
        count: jest.fn(async () => state.otherLinks),
        deleteMany: jest.fn(() => {
            state.ops.push('account.deleteOthers');
            return 'account.deleteMany';
        }),
    },
    userSession: {
        updateMany: jest.fn(() => {
            state.ops.push('userSession.revoke');
            return 'userSession.updateMany';
        }),
    },
    passwordResetToken: {
        updateMany: jest.fn(() => {
            state.ops.push('passwordResetToken.spend');
            return 'passwordResetToken.updateMany';
        }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
};

jest.mock('@/lib/db/rls-middleware', () => ({
    runWithoutRls: jest.fn(async (_opts: unknown, cb: (d: unknown) => unknown) => cb(db)),
}));
jest.mock('@/lib/auth/security-events', () => ({
    recordUnverifiedAccountClaimed: jest.fn(async () => undefined),
}));

import {
    claimAccountForVerifiedEmail,
    oauthEmailIsVerified,
} from '@/lib/auth/oauth-email-trust';
import { recordUnverifiedAccountClaimed } from '@/lib/auth/security-events';

const KEEP = { provider: 'google', providerAccountId: 'g-1' };

beforeEach(() => {
    jest.clearAllMocks();
    state.user = null;
    state.otherLinks = 0;
    state.ops = [];
});

describe('which provider emails are vouched for', () => {
    it.each([
        ['google', { email_verified: true }, true],
        ['google', { email_verified: 'true' }, false],
        ['google', { email_verified: false }, false],
        ['google', {}, false],
        ['microsoft-entra-id', { xms_edov: true }, true],
        ['microsoft-entra-id', { xms_edov: '1' }, true],
        ['microsoft-entra-id', { xms_edov: false }, false],
        ['microsoft-entra-id', { email: 'victim@example.com' }, false],
        ['microsoft-entra-id', { email_verified: true }, false],
        ['github', { email_verified: true }, false],
        ['credentials', { email_verified: true }, false],
    ])('%s with %j → %s', (provider, profile, expected) => {
        expect(oauthEmailIsVerified(provider, profile)).toBe(expected);
    });

    it('no profile is not vouched', () => {
        expect(oauthEmailIsVerified('google', undefined)).toBe(false);
    });
});

describe('claiming an account whose email nobody verified', () => {
    const claim = () =>
        claimAccountForVerifiedEmail({ userId: 'u1', email: 'owner@example.com', keep: KEEP, method: 'google' });

    it('does nothing to an account already verified', async () => {
        state.user = { id: 'u1', emailVerified: new Date(), passwordHash: 'hash' };
        await expect(claim()).resolves.toEqual({ kind: 'already-verified' });
        expect(state.ops).toEqual([]);
        expect(recordUnverifiedAccountClaimed).not.toHaveBeenCalled();
    });

    it('only stamps an account with no competing credential, and revokes nothing', async () => {
        state.user = { id: 'u1', emailVerified: null, passwordHash: null };
        await expect(claim()).resolves.toEqual({ kind: 'stamped' });
        expect(state.ops).toEqual(['user.stampVerified']);
        expect(recordUnverifiedAccountClaimed).not.toHaveBeenCalled();
    });

    it('removes a password, revokes every session and spends reset links', async () => {
        state.user = { id: 'u1', emailVerified: null, passwordHash: 'squatter-hash' };
        await expect(claim()).resolves.toEqual({ kind: 'claimed', removedPassword: true, removedProviderLinks: 0 });
        expect(state.ops[0]).toContain('"passwordHash":null');
        expect(state.ops[0]).toContain('"sessionVersion":{"increment":1}');
        expect(state.ops[0]).toContain('"emailVerified"');
        expect(state.ops).toEqual(
            expect.arrayContaining(['account.deleteOthers', 'userSession.revoke', 'passwordResetToken.spend']),
        );
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(recordUnverifiedAccountClaimed).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', removedPassword: true, removedProviderLinks: 0 }),
        );
    });

    it('removes another provider link but keeps the one signing in', async () => {
        state.user = { id: 'u1', emailVerified: null, passwordHash: null };
        state.otherLinks = 1;
        await expect(claim()).resolves.toMatchObject({ kind: 'claimed', removedProviderLinks: 1 });
        const where = db.account.deleteMany.mock.calls[0][0].where;
        expect(where).toEqual({ userId: 'u1', NOT: KEEP });
    });

    it('a missing user is a no-op', async () => {
        await expect(claim()).resolves.toEqual({ kind: 'already-verified' });
        expect(state.ops).toEqual([]);
    });
});
