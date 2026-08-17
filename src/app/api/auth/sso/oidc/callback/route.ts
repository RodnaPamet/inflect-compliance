import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { OidcConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    discoverOidc,
    decodeState,
    exchangeCodeForTokens,
    extractIdTokenClaims,
    validateIdTokenNonce,
} from '@/lib/security/oidc-client';
import { linkExternalIdentity } from '@/app-layer/usecases/sso';
import { ssoLog, generateSsoRequestId } from '@/lib/security/sso-logging';
import { env } from '@/env';
import jwt from 'jsonwebtoken';
import { sanitizeRedirectPath } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/callback?code=<code>&state=<state>
 *
 * Handles the OIDC callback after IdP authentication:
 * 1. Validates state (tenant + provider + PKCE verifier)
 * 2. Exchanges authorization code for tokens
 * 3. Extracts and validates ID token claims
 * 4. Links external identity to local user (via usecase)
 * 5. Creates JWT session compatible with existing auth model
 * 6. Redirects to app
 */
export async function GET(req: NextRequest) {
    const requestId = generateSsoRequestId();
    const { searchParams } = req.nextUrl;
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    // ── Handle IdP errors ──
    if (error) {
        ssoLog('warn', 'IdP returned error', {
            requestId, providerType: 'OIDC', stage: 'callback_received',
            meta: { error, errorDescription: errorDescription || '' },
        });
        return redirectToLogin(req, 'sso_error', 'Identity provider returned an error');
    }

    if (!code || !stateParam) {
        return redirectToLogin(req, 'missing_params', 'Missing code or state');
    }

    // ── Decode and validate state ──
    const state = decodeState(stateParam);
    if (!state) {
        return redirectToLogin(req, 'invalid_state', 'Invalid SSO state');
    }

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: state.tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        return redirectToLogin(req, 'tenant_not_found');
    }

    // ── Load provider config (verify it's still enabled) ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: state.providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'OIDC',
        },
    });

    if (!provider) {
        return redirectToLogin(req, 'provider_disabled', 'SSO provider is no longer active');
    }

    // ── Parse OIDC config ──
    const configResult = OidcConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid OIDC config on callback', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: provider.id, stage: 'config_load',
        });
        return redirectToLogin(req, 'config_error');
    }
    const oidcConfig = configResult.data;

    // ── OIDC Discovery ──
    let discovery;
    try {
        discovery = await discoverOidc(oidcConfig);
    } catch (err) {
        ssoLog('error', 'OIDC discovery failed on callback', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'discovery',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'discovery_error');
    }

    // ── Exchange code for tokens ──
    const baseUrl = env.APP_URL || req.nextUrl.origin;
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/callback`;

    let tokens;
    try {
        tokens = await exchangeCodeForTokens(
            discovery,
            oidcConfig,
            code,
            callbackUrl,
            state.codeVerifier
        );
    } catch (err) {
        ssoLog('error', 'OIDC token exchange failed', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'token_exchange',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'token_error', 'Failed to exchange authorization code');
    }

    // ── Validate nonce ──
    if (!validateIdTokenNonce(tokens.id_token, state.nonce)) {
        ssoLog('error', 'Nonce mismatch — possible replay attack', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'nonce_validation',
        });
        return redirectToLogin(req, 'nonce_mismatch');
    }

    // ── Extract claims ──
    let claims;
    try {
        claims = extractIdTokenClaims(tokens.id_token);
    } catch (err) {
        ssoLog('error', 'Failed to extract ID token claims', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'claims_extraction',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'claims_error');
    }

    if (!claims.email) {
        return redirectToLogin(req, 'no_email', 'Identity provider did not return an email');
    }

    // ── Link external identity to local user ──
    const linkResult = await linkExternalIdentity(
        tenant.id,
        provider.id,
        claims.sub,
        claims.email
    );

    if (linkResult.status === 'rejected') {
        const reasonMessages: Record<string, string> = {
            cross_tenant: 'Cross-tenant login attempt blocked',
            domain_mismatch: 'Email domain not allowed for this SSO provider',
            no_user: 'No matching account found. Contact your administrator.',
            no_membership: 'No matching account found. Contact your administrator.',
            subject_conflict: 'Identity conflict detected. Contact your administrator.',
            jit_disabled: 'No matching account found. Contact your administrator.',
            no_email: 'Identity provider did not return an email',
        };
        ssoLog('warn', 'Identity linking rejected', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: provider.id, stage: 'identity_linking',
            meta: { reason: linkResult.reason, email: claims.email },
        });
        return redirectToLogin(
            req,
            linkResult.reason,
            reasonMessages[linkResult.reason] || 'Login failed'
        );
    }

    const linkedUserId = linkResult.userId;

    // ── Load user and membership for session ──
    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId: linkedUserId,
            },
        },
    });

    if (!membership) {
        return redirectToLogin(req, 'no_membership');
    }

    const user = await prisma.user.findUnique({
        where: { id: linkedUserId },
        select: { id: true, email: true, name: true },
    });

    if (!user) {
        return redirectToLogin(req, 'user_not_found');
    }

    // ── Create JWT session (compatible with Auth.js JWT strategy) ──
    const authSecret = env.AUTH_SECRET;
    if (!authSecret) {
        ssoLog('error', 'AUTH_SECRET not set', {
            requestId, tenantSlug: tenant.slug, providerType: 'OIDC', stage: 'session_creation',
        });
        return redirectToLogin(req, 'config_error');
    }

    const sessionToken = jwt.sign(
        {
            userId: user.id,
            email: user.email,
            name: user.name,
            tenantId: tenant.id,
            role: membership.role,
            provider: `sso-oidc-${provider.id}`,
            sub: user.id,
            iat: Math.floor(Date.now() / 1000),
        },
        authSecret,
        { expiresIn: '7d' }
    );

    // ── Set session cookie (matching Auth.js cookie name) ──
    const isProduction = env.NODE_ENV === 'production';
    const cookieName = isProduction
        ? '__Secure-authjs.session-token'
        : 'authjs.session-token';

    const cookieStore = await cookies();
    cookieStore.set(cookieName, sessionToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    // ── Redirect to app ──
    // `returnTo` originates in the UNAUTHENTICATED /start query string and
    // rides here inside an UNSIGNED state blob, so it is attacker-controlled
    // end to end. `new URL(returnTo, baseUrl)` does not constrain it:
    // `new URL('https://evil.com', base)` and `new URL('//evil.com', base)`
    // both resolve to the attacker's origin, which is a phishing link served
    // from our own domain.
    //
    // Sanitised HERE, on the way out, rather than only at /start: a value
    // smuggled past the entry point — or reached by any future path that
    // writes state — still cannot escape. sanitizeRedirectPath was already
    // in the tree, unused by this flow.
    // Ternary, not `sanitize(x) || fallback`: sanitizeRedirectPath
    // returns '/' for anything it rejects, and '/' is truthy — so the
    // `||` form would silently retire the dashboard fallback and land
    // every SSO sign-in with no returnTo on the root instead.
    const returnTo = state.returnTo
        ? sanitizeRedirectPath(state.returnTo)
        : `/t/${tenant.slug}/dashboard`;
    return NextResponse.redirect(new URL(returnTo, baseUrl));
}

// ─── Helpers ─────────────────────────────────────────────────────────

function redirectToLogin(
    req: NextRequest,
    errorCode: string,
    errorMessage?: string
): NextResponse {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    loginUrl.searchParams.set('error', errorCode);
    if (errorMessage) {
        loginUrl.searchParams.set('error_description', errorMessage);
    }
    return NextResponse.redirect(loginUrl);
}
