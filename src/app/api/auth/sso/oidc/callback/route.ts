import { NextRequest, NextResponse } from 'next/server';
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
import { issueSsoHandoff, ssoHandoffResponse } from '@/lib/auth/sso-handoff';
import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { publicBaseUrl } from '@/lib/http/public-base-url';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/callback?code=<code>&state=<state>
 *
 * Handles the OIDC callback after IdP authentication:
 * 1. Validates state (tenant + provider + PKCE verifier)
 * 2. Exchanges authorization code for tokens
 * 3. Extracts and validates ID token claims
 * 4. Links external identity to local user (via usecase)
 * 5. Hands off to NextAuth, which opens the session (`src/lib/auth/sso-handoff.ts`)
 * 6. Redirects through the completion page to the app
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
    const baseUrl = publicBaseUrl(req);
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

    // ── Membership must be live ──
    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId: linkedUserId,
            },
        },
        select: { status: true },
    });

    if (!membership || membership.status !== 'ACTIVE') {
        return redirectToLogin(req, 'no_membership');
    }

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
    const handoff = await issueSsoHandoff({ userId: linkedUserId, tenantId: tenant.id });
    return ssoHandoffResponse(baseUrl, returnTo, handoff);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function redirectToLogin(
    req: NextRequest,
    errorCode: string,
    errorMessage?: string
): NextResponse {
    // publicBaseUrl, not req.nextUrl.origin: this becomes a Location
        // header, and behind the proxy the request origin is the app's
        // internal bind address — the browser cannot follow it.
        const loginUrl = new URL('/login', publicBaseUrl(req));
    loginUrl.searchParams.set('error', errorCode);
    if (errorMessage) {
        loginUrl.searchParams.set('error_description', errorMessage);
    }
    return NextResponse.redirect(loginUrl);
}
