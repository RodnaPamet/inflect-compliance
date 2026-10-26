import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { OidcConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    discoverOidc,
    decodeState,
    exchangeCodeForTokens,
    IdTokenRefusedError,
    verifyIdToken,
} from '@/lib/security/oidc-client';
import { linkExternalIdentity } from '@/app-layer/usecases/sso';
import { ssoLog, generateSsoRequestId, emailDomainForLog } from '@/lib/security/sso-logging';
import { issueSsoHandoff, ssoHandoffResponse } from '@/lib/auth/sso-handoff';
import { clearSsoFlow, readBoundSsoFlow } from '@/lib/auth/sso-flow';
import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { publicBaseUrl } from '@/lib/http/public-base-url';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/callback?code=<code>&state=<state>
 *
 * Handles the OIDC callback after IdP authentication:
 * 1. Validates state (tenant + provider + PKCE verifier)
 * 2. Exchanges authorization code for tokens
 * 3. Verifies the ID token: signature, issuer, audience, expiry, nonce
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
    // `state` is the flow's id; the flow itself is in the cookie /start set
    // (src/lib/auth/sso-flow.ts). A callback URL opened in any other browser
    // — the login-CSRF shape — has no matching cookie and stops here.
    const boundState = readBoundSsoFlow(req, 'oidc', stateParam);
    const state = boundState ? decodeState(boundState) : null;
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

    // ── Verify the ID token ──
    // Signature against the IdP's published keys, then issuer, audience,
    // expiry and this flow's nonce (`verifyIdToken`). The person sees one
    // generic message; the reason is logged for their administrator.
    let claims;
    try {
        claims = await verifyIdToken(tokens.id_token, {
            discovery,
            clientId: oidcConfig.clientId,
            nonce: state.nonce,
        });
    } catch (err) {
        const reason = err instanceof IdTokenRefusedError ? err.reason : 'unknown';
        ssoLog('error', 'ID token refused', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'id_token_verification',
            meta: { reason, error: (err as Error).message },
        });
        return redirectToLogin(req, reason === 'nonce' ? 'nonce_mismatch' : 'id_token_invalid');
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
            meta: { reason: linkResult.reason, emailDomain: emailDomainForLog(claims.email) },
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
    // `returnTo` originates in the UNAUTHENTICATED /start query string, so
    // whoever wrote that link chose it: it is attacker-controlled even though
    // the flow cookie that carries it here is signed. `new URL(returnTo, baseUrl)` does not constrain it:
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
    const res = ssoHandoffResponse(baseUrl, returnTo, handoff);
    clearSsoFlow(res, 'oidc');
    return res;
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
    // A failed callback spends the flow too.
    const res = NextResponse.redirect(loginUrl);
    clearSsoFlow(res, 'oidc');
    return res;
}
