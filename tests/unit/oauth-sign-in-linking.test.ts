/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and
 * NextAuth callback call shapes. */
/**
 * The real `signIn` callback links an OAuth sign-in to an existing account,
 * and redeems invites by address, only when the provider vouches for the
 * email (src/lib/auth/oauth-email-trust.ts).
 *
 *   - Microsoft without `xms_edov`: an existing account with that email is
 *     not linked (the person is told to sign in the way they did before), and
 *     no pending invite is redeemed by address.
 *   - Microsoft with `xms_edov`, or Google with `email_verified`: the link is
 *     made, and the account is claimed if its email was never verified.
 */
const existing = { id: 'existing-user', email: 'owner@example.com', emailVerified: null };

jest.mock('@/lib/prisma', () => {
    const prisma: any = {
        user: { findUnique: jest.fn(async () => existing) },
        account: {
            findUnique: jest.fn(async () => null),
            create: jest.fn(async () => ({})),
        },
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/auth/oauth-email-trust', () => ({
    ...jest.requireActual('@/lib/auth/oauth-email-trust'),
    claimAccountForVerifiedEmail: jest.fn(async () => ({ kind: 'stamped' })),
}));
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    redeemInvite: jest.fn(async () => undefined),
    redeemPendingInvitesByEmail: jest.fn(async () => undefined),
}));
jest.mock('@/lib/auth/sso-enforcement', () => ({
    ...jest.requireActual('@/lib/auth/sso-enforcement'),
    workspaceRequiringSso: jest.fn(async () => null),
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({ get: () => undefined, getAll: () => [] }),
    headers: async () => new Headers(),
}));

import { authOptions } from '@/auth';
import prisma from '@/lib/prisma';
import { claimAccountForVerifiedEmail } from '@/lib/auth/oauth-email-trust';
import { redeemPendingInvitesByEmail } from '@/app-layer/usecases/tenant-invites';

const signIn = authOptions.callbacks!.signIn! as any;
const p = prisma as any;

function oauth(provider: string, profile: Record<string, unknown>, userId = 'new-oauth-user') {
    return signIn({
        user: { id: userId, email: 'owner@example.com' },
        account: { provider, type: 'oauth', providerAccountId: `${provider}-sub-1` },
        profile: { email: 'owner@example.com', ...profile },
    });
}

beforeEach(() => jest.clearAllMocks());

describe('linking an OAuth sign-in to an existing account', () => {
    it('refuses a Microsoft sign-in whose email the directory did not verify', async () => {
        await expect(oauth('microsoft-entra-id', {})).resolves.toBe('/login?error=OAuthAccountNotLinked');
        expect(p.account.create).not.toHaveBeenCalled();
        expect(claimAccountForVerifiedEmail).not.toHaveBeenCalled();
        expect(redeemPendingInvitesByEmail).not.toHaveBeenCalled();
    });

    it('links a Microsoft sign-in that carries xms_edov, claiming the account first', async () => {
        await expect(oauth('microsoft-entra-id', { xms_edov: true })).resolves.toBe(true);
        expect(claimAccountForVerifiedEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'existing-user',
                keep: { provider: 'microsoft-entra-id', providerAccountId: 'microsoft-entra-id-sub-1' },
            }),
        );
        expect(p.account.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ userId: 'existing-user' }) }),
        );
        const claimOrder = (claimAccountForVerifiedEmail as jest.Mock).mock.invocationCallOrder[0];
        const linkOrder = p.account.create.mock.invocationCallOrder[0];
        expect(claimOrder).toBeLessThan(linkOrder);
    });

    it('links a Google sign-in whose email Google verified', async () => {
        await expect(oauth('google', { email_verified: true })).resolves.toBe(true);
        expect(p.account.create).toHaveBeenCalled();
        expect(redeemPendingInvitesByEmail).toHaveBeenCalled();
    });

    it('refuses a Google sign-in that does not say the email is verified', async () => {
        await expect(oauth('google', {})).resolves.toBe('/login?error=OAuthAccountNotLinked');
        expect(p.account.create).not.toHaveBeenCalled();
    });
});

describe('redeeming invites by address', () => {
    beforeEach(() => p.user.findUnique.mockResolvedValueOnce(null));

    it('a new Microsoft user without xms_edov redeems nothing by address', async () => {
        await expect(oauth('microsoft-entra-id', {})).resolves.toBe(true);
        expect(redeemPendingInvitesByEmail).not.toHaveBeenCalled();
    });

    it('a new Microsoft user with xms_edov redeems by address', async () => {
        await expect(oauth('microsoft-entra-id', { xms_edov: true })).resolves.toBe(true);
        expect(redeemPendingInvitesByEmail).toHaveBeenCalled();
    });
});

describe('a returning sign-in', () => {
    it('claims the account when the provider vouches for its email', async () => {
        await expect(oauth('google', { email_verified: true }, 'existing-user')).resolves.toBe(true);
        expect(p.account.create).not.toHaveBeenCalled();
        expect(claimAccountForVerifiedEmail).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'existing-user', keep: { provider: 'google', providerAccountId: 'google-sub-1' } }),
        );
    });

    it('claims nothing when the provider does not vouch', async () => {
        await expect(oauth('microsoft-entra-id', {}, 'existing-user')).resolves.toBe(true);
        expect(claimAccountForVerifiedEmail).not.toHaveBeenCalled();
    });
});
