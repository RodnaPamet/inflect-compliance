/**
 * The hand-off from an SSO callback to a NextAuth session.
 *
 * The OIDC and SAML callbacks prove who the identity provider vouched for, but
 * they do not mint the session. They used to, by signing a cookie with
 * `jsonwebtoken` under a name NextAuth v4 never reads
 * (`authjs.session-token`), so every SSO sign-in ended with no session at all.
 * Minting a NextAuth cookie by hand would also have skipped everything the
 * `jwt` callback does at sign-in: the membership claims the edge gate reads,
 * the workspace MFA policy, and the `UserSession` row that revocation needs.
 *
 * So a callback issues a hand-off instead: a random token, stored hashed, good
 * once for 60 seconds, delivered in an HttpOnly cookie scoped to the one
 * NextAuth callback that redeems it. The completion page asks NextAuth to sign
 * in with the `sso-handoff` provider; that provider redeems the cookie, and
 * NextAuth runs its normal sign-in from there.
 *
 * The cookie, not the URL, carries the token so that a hand-off cannot be
 * completed in a browser other than the one that went through the identity
 * provider: a link with a hand-off in it would otherwise sign whoever opened it
 * in to someone else's account.
 *
 * Rows live in `VerificationToken`, beside the email-verification tokens. The
 * identifier prefix keeps the two apart, and the hash is taken over the prefix
 * too, so an email-verification token can never redeem as a hand-off.
 */
import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { env } from '@/env';
import {
    SSO_COMPLETE_PATH,
    SSO_HANDOFF_COOKIE,
    SSO_HANDOFF_COOKIE_PATH,
} from '@/lib/auth/sso-session';

export const SSO_HANDOFF_TTL_SECONDS = 60;

const IDENTIFIER_PREFIX = 'sso-handoff:';

function hashHandoff(raw: string): string {
    return createHash('sha256').update(`${IDENTIFIER_PREFIX}${raw}`).digest('hex');
}

export interface SsoHandoff {
    userId: string;
    tenantId: string;
}

/** Store a hand-off for this person in this tenant; returns the raw token. */
export async function issueSsoHandoff(handoff: SsoHandoff): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();
    await prisma.$transaction([
        // Opportunistic cleanup of hand-offs nobody redeemed.
        prisma.verificationToken.deleteMany({
            where: { identifier: { startsWith: IDENTIFIER_PREFIX }, expires: { lt: now } },
        }),
        prisma.verificationToken.create({
            data: {
                identifier: `${IDENTIFIER_PREFIX}${handoff.tenantId}:${handoff.userId}`,
                token: hashHandoff(raw),
                expires: new Date(now.getTime() + SSO_HANDOFF_TTL_SECONDS * 1000),
            },
        }),
    ]);
    return raw;
}

/**
 * Redeem a hand-off. Resolves `null` for a missing, unknown, expired or
 * already-redeemed token. Single use: of two concurrent redemptions, only the
 * one whose delete removes the row gets the hand-off.
 */
export async function redeemSsoHandoff(
    raw: string | null | undefined,
): Promise<SsoHandoff | null> {
    if (!raw) return null;
    const token = hashHandoff(raw);
    const row = await prisma.verificationToken.findUnique({ where: { token } });
    if (!row || !row.identifier.startsWith(IDENTIFIER_PREFIX)) return null;

    const claimed = await prisma.verificationToken.deleteMany({
        where: { token, identifier: row.identifier, expires: { gt: new Date() } },
    });
    if (claimed.count !== 1) return null;

    const [tenantId, userId, ...rest] = row.identifier.slice(IDENTIFIER_PREFIX.length).split(':');
    if (!tenantId || !userId || rest.length > 0) return null;
    return { tenantId, userId };
}

/**
 * The SSO callback's response: send the browser to the completion page with
 * the hand-off in its cookie. `returnTo` must already be a sanitised path.
 *
 * 303, not the default 307: the SAML callback receives a POST, and a 307 would
 * have the browser POST the identity provider's form to the completion page.
 */
export function ssoHandoffResponse(
    baseUrl: string,
    returnTo: string,
    rawHandoff: string,
): NextResponse {
    const completeUrl = new URL(SSO_COMPLETE_PATH, baseUrl);
    completeUrl.searchParams.set('next', returnTo);
    const res = NextResponse.redirect(completeUrl, 303);
    res.cookies.set(SSO_HANDOFF_COOKIE, rawHandoff, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: SSO_HANDOFF_COOKIE_PATH,
        maxAge: SSO_HANDOFF_TTL_SECONDS,
    });
    return res;
}
