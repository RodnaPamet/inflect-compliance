import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SamlConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    buildSamlInstance,
    validateSamlResponse,
    decodeSamlRelayState,
} from '@/lib/security/saml-client';
import { linkExternalIdentity } from '@/app-layer/usecases/sso';
import { ssoLog, generateSsoRequestId } from '@/lib/security/sso-logging';
import { issueSsoHandoff, ssoHandoffResponse } from '@/lib/auth/sso-handoff';
import { clearSsoFlow, readBoundSsoFlow } from '@/lib/auth/sso-flow';
import { spendSsoFlowOnce } from '@/lib/auth/sso-flow-spend';
import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { publicBaseUrl } from '@/lib/http/public-base-url';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sso/saml/callback
 *
 * SAML Assertion Consumer Service (ACS) endpoint.
 * Receives the SAML Response (POST binding) from the IdP:
 * 1. Extracts RelayState to identify tenant + provider
 * 2. Validates the SAML response signature and assertions
 * 3. Extracts NameID/email/name claims
 * 4. Links external identity to local user
 * 5. Hands off to NextAuth, which opens the session (`src/lib/auth/sso-handoff.ts`)
 * 6. Redirects through the completion page to the app
 */
export async function POST(req: NextRequest) {
    const requestId = generateSsoRequestId();
    let formData: FormData;
    try {
        formData = await req.formData();
    } catch {
        return redirectToLogin(req, 'invalid_request', 'Invalid SAML response format');
    }

    const samlResponse = formData.get('SAMLResponse') as string | null;
    const relayStateRaw = formData.get('RelayState') as string | null;

    if (!samlResponse) {
        return redirectToLogin(req, 'missing_response', 'No SAML response received');
    }

    // ── Decode RelayState ──
    if (!relayStateRaw) {
        return redirectToLogin(req, 'missing_relay', 'Missing RelayState parameter');
    }

    // RelayState is the flow's id; the flow itself is in the cookie /start
    // set (src/lib/auth/sso-flow.ts). A SAML response posted into any other
    // browser — the login-CSRF shape — has no matching cookie and stops here.
    const boundRelay = readBoundSsoFlow(req, 'saml', relayStateRaw);
    const relayState = boundRelay ? decodeSamlRelayState(boundRelay) : null;
    if (!relayState) {
        return redirectToLogin(req, 'invalid_relay', 'Invalid RelayState');
    }

    // ── One callback per flow, held on the server (src/lib/auth/sso-flow-spend.ts) ──
    // Spent before the response is read: a replay of the same cookie and
    // response, from any browser, stops here, and so does a second try after a
    // failure. A store that cannot be reached refuses rather than lets through.
    let spent: boolean;
    try {
        spent = await spendSsoFlowOnce(relayStateRaw);
    } catch (err) {
        ssoLog('error', 'SAML flow could not be spent', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: relayState.providerId, stage: 'state_validation',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'sso_error');
    }
    if (!spent) {
        ssoLog('warn', 'SAML flow presented a second time', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: relayState.providerId, stage: 'state_validation',
        });
        return redirectToLogin(req, 'invalid_relay', 'Invalid RelayState');
    }

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: relayState.tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        return redirectToLogin(req, 'tenant_not_found');
    }

    // ── Load provider config (verify still enabled) ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: relayState.providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'SAML',
        },
    });

    if (!provider) {
        return redirectToLogin(req, 'provider_disabled', 'SAML provider is no longer active');
    }

    // ── Parse SAML config ──
    const configResult = SamlConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid SAML config on callback', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'config_load',
        });
        return redirectToLogin(req, 'config_error');
    }
    const samlConfig = configResult.data;

    // ── Build SAML instance for validation ──
    const baseUrl = publicBaseUrl(req);
    const callbackUrl = `${baseUrl}/api/auth/sso/saml/callback`;
    const spIssuer = `${baseUrl}/saml/metadata/${tenant.slug}`;

    const saml = buildSamlInstance(samlConfig, callbackUrl, spIssuer, relayState.request);

    // ── Validate SAML response ──
    // It must answer this flow's request, with a bearer confirmation for this
    // callback (src/lib/security/saml-client.ts).
    let validatedResponse;
    try {
        validatedResponse = await validateSamlResponse(saml, samlResponse, {
            callbackUrl,
            requestId: relayState.request.id,
        });
    } catch (err) {
        ssoLog('error', 'SAML response validation failed', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'response_validation',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'validation_failed', 'SAML response validation failed');
    }

    if (!validatedResponse.email) {
        return redirectToLogin(req, 'no_email', 'Identity provider did not return an email');
    }

    // ── Link external identity to local user ──
    const linkResult = await linkExternalIdentity(
        tenant.id,
        provider.id,
        validatedResponse.nameId,
        validatedResponse.email
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
        ssoLog('warn', 'SAML identity linking rejected', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'identity_linking',
            meta: { reason: linkResult.reason, email: validatedResponse.email },
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
    const returnTo = relayState.returnTo
        ? sanitizeRedirectPath(relayState.returnTo)
        : `/t/${tenant.slug}/dashboard`;
    const handoff = await issueSsoHandoff({ userId: linkedUserId, tenantId: tenant.id });
    const res = ssoHandoffResponse(baseUrl, returnTo, handoff);
    clearSsoFlow(res, 'saml');
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
    // 303: this answers the identity provider's POST, and a 307 would have
    // the browser POST it on to the sign-in page. A failed callback spends
    // the flow too.
    const res = NextResponse.redirect(loginUrl, 303);
    clearSsoFlow(res, 'saml');
    return res;
}
