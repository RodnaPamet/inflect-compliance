import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { OidcConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    discoverOidc,
    generateCodeVerifier,
    generateCodeChallenge,
    generateNonce,
    encodeState,
    buildAuthorizationUrl,
} from '@/lib/security/oidc-client';
import { ssoLog, generateSsoRequestId, redactSsoUrl } from '@/lib/security/sso-logging';
import { isCrossSiteStart, prepareSsoFlow } from '@/lib/auth/sso-flow';
import { withApiErrorHandling } from '@/lib/errors/api';
import { publicBaseUrl } from '@/lib/http/public-base-url';
import {
    badRequest,
    notFound,
    configurationError,
    externalServiceError,
} from '@/lib/errors/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/start?tenant=<tenantSlug>&provider=<providerId>&returnTo=<path>
 *
 * Initiates the OIDC authorization flow for a tenant-scoped IdP.
 *
 * Epic E — Standardized error contract via withApiErrorHandling. Failures
 * (missing params, unknown tenant/provider, broken config, IdP unreachable)
 * surface as ApiErrorResponse JSON, not bespoke `{error: '...'}` bodies.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const requestId = generateSsoRequestId();
    const { searchParams } = req.nextUrl;
    const tenantSlug = searchParams.get('tenant');
    const providerId = searchParams.get('provider');
    // Absent stays absent, so the callback's dashboard fallback applies; a
    // '/' default here made every SSO sign-in land on the root instead.
    const returnTo = searchParams.get('returnTo') || undefined;

    // Only a sign-in this browser asked for: never one another site started
    // (see `isCrossSiteStart` in src/lib/auth/sso-flow.ts).
    if (isCrossSiteStart(req)) {
        ssoLog('warn', 'Cross-site SSO start refused', {
            requestId, stage: 'start', providerType: 'OIDC',
        });
        const loginUrl = new URL('/login', publicBaseUrl(req));
        loginUrl.searchParams.set('error', 'sso_start_refused');
        return NextResponse.redirect(loginUrl, 303);
    }

    // ── Validate params ──
    if (!tenantSlug || !providerId) {
        ssoLog('warn', 'Missing required parameters', {
            requestId, stage: 'start', providerType: 'OIDC',
        });
        throw badRequest('Missing required parameters: tenant and provider');
    }

    const logCtx = { requestId, tenantSlug, providerType: 'OIDC' as const, providerId };

    ssoLog('info', 'OIDC flow started', { ...logCtx, stage: 'start' });

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        ssoLog('warn', 'Tenant not found', { ...logCtx, stage: 'start' });
        // One generic message for both "no such tenant" and "no such
        // provider". Distinct messages here answer, to a FULLY ANONYMOUS
        // caller and before any assertion or code is validated, whether a
        // given tenant slug exists and which SSO providers it has
        // configured. That is a customer list, enumerable by dictionary.
        throw notFound('SSO is not available for this tenant and provider');
    }

    // ── Load provider config ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'OIDC',
        },
    });

    if (!provider) {
        ssoLog('warn', 'Provider not found or disabled', { ...logCtx, stage: 'config_load' });
        throw notFound('SSO is not available for this tenant and provider');
    }

    // ── Parse OIDC config ──
    const configResult = OidcConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid OIDC configuration', {
            ...logCtx, stage: 'config_load',
            meta: { validationError: configResult.error.message },
        });
        throw configurationError('SSO configuration error');
    }
    const oidcConfig = configResult.data;

    // ── OIDC Discovery ──
    let discovery;
    try {
        discovery = await discoverOidc(oidcConfig);
        ssoLog('info', 'OIDC discovery successful', { ...logCtx, stage: 'discovery' });
    } catch (err) {
        ssoLog('error', 'OIDC discovery failed', {
            ...logCtx, stage: 'discovery',
            meta: { error: (err as Error).message },
        });
        throw externalServiceError('Failed to contact identity provider');
    }

    // ── Generate PKCE + state ──
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const nonce = generateNonce();

    // The flow — verifier included — stays in this browser's cookie; the
    // identity provider sees only its id (src/lib/auth/sso-flow.ts).
    const flow = prepareSsoFlow('oidc', encodeState({
        tenantSlug: tenant.slug,
        providerId: provider.id,
        codeVerifier,
        nonce,
        returnTo,
    }));

    // ── Build callback URL ──
    const baseUrl = publicBaseUrl(req);
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/callback`;

    // ── Redirect to IdP ──
    const authUrl = buildAuthorizationUrl(
        discovery,
        oidcConfig,
        callbackUrl,
        flow.id,
        codeChallenge,
        nonce
    );

    ssoLog('info', 'Redirecting to IdP', {
        ...logCtx, stage: 'redirect',
        meta: { authUrl: redactSsoUrl(authUrl) },
    });

    const res = NextResponse.redirect(authUrl);
    flow.bind(res);
    return res;
});
