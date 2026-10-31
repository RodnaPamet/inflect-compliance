/**
 * GET /api/invites/:token/start-signin
 *
 * Sets a short-lived HttpOnly cookie carrying the invite token, then
 * redirects the user to /login. After the user signs in, the signIn
 * callback reads the cookie and calls redeemInvite to create their
 * TenantMembership, and the sign-in lands on /invite/result, which says
 * what became of the invite: the callback can only log a refusal (#4689).
 *
 * This is the entry point for the "Sign in to accept" flow on the
 * /invite/:token page. The invite preview page links here instead of
 * directly to /login so the token is never exposed in the URL or
 * referrer header after the OAuth round-trip.
 *
 * Cookie spec:
 *   - HttpOnly — JS cannot read it; prevents XSS exfiltration
 *   - SameSite=Lax — survives the OAuth top-level cross-origin redirect
 *   - Secure in production — HTTPS only
 *   - Max-Age=600 (10 min) — the user has time to complete OAuth
 *   - Path=/ — must be visible to the signIn callback at /api/auth/*
 *
 * The cookie is single-use in effect (redeemInvite burns the token on
 * the first call) so a leaked cookie cannot be exploited after the
 * invite is consumed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';

// Epic E — wrapped for x-request-id + standardized error contract.
// The redirect itself is the success contract (any AppError thrown
// inside would surface as a normal JSON 4xx/5xx, not the redirect).
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
    const { token } = await ctx.params;

    // The destination names no token: /invite/result reads it back from the
    // cookie set below, so the token stays out of the URL after sign-in.
    const loginUrl = new URL('/login', resolvePublicOrigin(req));
    loginUrl.searchParams.set('callbackUrl', '/invite/result');
    const response = NextResponse.redirect(loginUrl);

    response.cookies.set('inflect_invite_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: '/',
        maxAge: 600, // 10 min — user has time to complete OAuth
    });

    return response;
});
