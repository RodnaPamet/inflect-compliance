/**
 * Which OAuth sign-ins may stand for an email address, and what happens to an
 * account whose address nobody ever proved.
 *
 * ── When a provider's email is trusted ─────────────────────────────────
 *
 * The `signIn` callback links an OAuth sign-in to the existing account that
 * holds the same email, and redeems pending invites addressed to it. Both are
 * only as good as the provider's claim that the person owns the address.
 *
 *   - Google: `email_verified === true`. Google sets it for every account
 *     whose address it has confirmed.
 *   - Microsoft (multi-tenant endpoint): the `email` claim is whatever the
 *     user's directory says, and the administrator of ANY directory can set
 *     it. Microsoft's answer is the optional `xms_edov` claim ("email domain
 *     owner verified"), which is true only when that directory has verified it
 *     owns the address's domain. It is trusted when the app registration emits
 *     `xms_edov` and the claim is true (owner decision 2026-11-12). Without the
 *     claim, a Microsoft sign-in links nothing and redeems no invite by email;
 *     the emailed invite link, which proves possession of the token, still
 *     works.
 *   - Any other provider: not trusted. Fail closed.
 *
 * ── Claiming an account whose email was never verified ────────────────
 *
 * Email verification at registration is off by default, so a password
 * account can be registered under somebody else's address. When the owner of
 * that address later signs in with a trusted provider, the sign-in claims the
 * account (owner decision 2026-11-12): the password is removed, every other
 * provider link is removed, every session is revoked, outstanding password
 * reset links are spent, and the address is marked verified. The person who
 * proved the address is the only one left holding a way in.
 *
 * A claim runs only when the account shows a competing credential (a password,
 * or a link to another provider). An account with neither is just stamped
 * verified: OAuth-created accounts are stored with no `emailVerified`, and
 * revoking every one of their sessions on the first sign-in after this change
 * would sign out people nobody contested. MFA enrolments are kept: removing
 * them would weaken a legitimate owner's account, and a squatter left with no
 * password and no provider link cannot use one.
 */
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { recordUnverifiedAccountClaimed } from '@/lib/auth/security-events';

type Profile = Record<string, unknown> | null | undefined;

function claimIsTrue(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

/** Whether `provider` vouches that the person signing in owns `profile`'s email. */
export function oauthEmailIsVerified(provider: string, profile: Profile): boolean {
    if (!profile) return false;
    if (provider === 'google') return profile.email_verified === true;
    if (provider === 'microsoft-entra-id') return claimIsTrue(profile.xms_edov);
    return false;
}

export interface ClaimInput {
    userId: string;
    email: string;
    /** The provider link this sign-in is using, which the claim keeps. */
    keep: { provider: string; providerAccountId: string };
    method: 'google' | 'microsoft-entra-id';
}

export type ClaimOutcome =
    | { kind: 'already-verified' }
    | { kind: 'stamped' }
    | { kind: 'claimed'; removedPassword: boolean; removedProviderLinks: number };

/**
 * Mark `userId`'s email verified on a trusted sign-in, claiming the account
 * first when it carries a credential somebody else could hold. Idempotent:
 * once `emailVerified` is set, nothing more happens.
 */
export async function claimAccountForVerifiedEmail(input: ClaimInput): Promise<ClaimOutcome> {
    const outcome = await runWithoutRls({ reason: 'auth-credentials' }, async (db) => {
        const user = await db.user.findUnique({
            where: { id: input.userId },
            select: { emailVerified: true, passwordHash: true },
        });
        if (!user || user.emailVerified) return { kind: 'already-verified' } as const;

        const otherLinks = await db.account.count({
            where: {
                userId: input.userId,
                NOT: { provider: input.keep.provider, providerAccountId: input.keep.providerAccountId },
            },
        });
        const now = new Date();

        if (!user.passwordHash && otherLinks === 0) {
            await db.user.updateMany({
                where: { id: input.userId, emailVerified: null },
                data: { emailVerified: now },
            });
            return { kind: 'stamped' } as const;
        }

        await db.$transaction([
            db.user.update({
                where: { id: input.userId },
                data: { passwordHash: null, emailVerified: now, sessionVersion: { increment: 1 } },
            }),
            db.account.deleteMany({
                where: {
                    userId: input.userId,
                    NOT: { provider: input.keep.provider, providerAccountId: input.keep.providerAccountId },
                },
            }),
            db.userSession.updateMany({
                where: { userId: input.userId, revokedAt: null },
                data: { revokedAt: now, revokedReason: 'auth:unverified-account-claimed' },
            }),
            db.passwordResetToken.updateMany({
                where: { userId: input.userId, usedAt: null },
                data: { usedAt: now },
            }),
        ]);
        return {
            kind: 'claimed',
            removedPassword: Boolean(user.passwordHash),
            removedProviderLinks: otherLinks,
        } as const;
    });

    if (outcome.kind === 'claimed') {
        await recordUnverifiedAccountClaimed({
            userId: input.userId,
            email: input.email,
            method: input.method,
            removedPassword: outcome.removedPassword,
            removedProviderLinks: outcome.removedProviderLinks,
        });
    }
    return outcome;
}
