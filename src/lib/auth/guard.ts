/**
 * Edge-compatible auth guard helpers.
 * Pure functions — no Node.js or Prisma imports.
 * Used by middleware.ts for path classification and redirect building.
 */
import { NextResponse } from 'next/server';

// ─── Public path allowlist ───

const PUBLIC_PATH_PREFIXES = [
    '/login',
    '/register',
    '/forgot-password',  // Password-reset request page — unauthenticated users must reach it
    '/reset-password',   // Password-reset confirm page — reached from an emailed token link
    '/no-tenant',        // Landing page for uninvited users — must not gate-loop
    '/tenants',          // R-1: tenant picker — must be reachable before active-tenant is set
    '/invite/',          // Invite preview page (tenant + org) — public so unauthenticated users can see invite details
    '/api/auth',         // Auth.js callbacks, session, csrf, providers
    '/api/invites/',     // Tenant invite redemption API (public) + start-signin cookie setter
    '/api/org/invite/',  // Org invite API (public) — start-signin cookie setter + accept-redirect, mirrors /api/invites/
    '/api/health',       // Health check (no auth) — deprecated alias
    '/api/livez',        // Liveness probe (no auth)
    '/api/readyz',       // Readiness probe (no auth)
    '/api/staging/seed', // Staging seed endpoint (token-gated internally)
    '/audit/shared',     // Shared audit pack read-only view (token-gated, no login)
    '/api/audit/shared', // Shared audit pack API endpoint (token-gated)
    '/vendor-assessment/',     // Epic G-3 — external respondent page (token-gated)
    '/api/vendor-assessment/', // Epic G-3 — external respondent API (token-gated)
    // Trust Center — INTENTIONALLY public, unauthenticated compliance page at
    // /trust/<slug>. The page reads ONLY the curated TrustCenter row (enabled
    // ones), never tenant data. Middleware edge-rate-limits /trust/ BEFORE
    // this allow (see src/middleware.ts) to protect against scraping/DoS.
    '/trust/',
    '/_next',            // Next.js internals
];

const PUBLIC_PATH_EXACT = new Set([
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
]);

const STATIC_EXTENSIONS = /\.(ico|png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf|eot|map|json)$/;

/**
 * Public API routes that the prefix allowlist cannot express — they carry a
 * dynamic tenant slug or resource id in the MIDDLE of the path, so a prefix
 * would over-expose the whole tenant API. These are anonymous, token- or
 * slug-authed endpoints whose real authentication runs INSIDE the handler
 * (device-token verify; trust-center slug/token checks). The middleware
 * matcher only stops the blanket 401 so the request reaches that handler.
 *
 *   - `POST /api/t/<slug>/devices/report`            — device-agent token auth
 *   - `POST /api/trust/<slug>/access-request`        — anonymous gated-doc request
 *   - `GET  /api/trust/download/<token>`             — single-use download token
 */
export const PUBLIC_API_REGEXES: readonly RegExp[] = [
    /^\/api\/t\/[^/]+\/devices\/report$/,
    /^\/api\/trust\/(?:[^/]+\/access-request|download\/[^/]+)$/,
];

/**
 * Endpoints whose caller is a MACHINE, not a browser session.
 *
 * These were all unreachable. The edge gate runs
 * `isPublicPath(pathname)` and then, on a missing JWT,
 * `if (isApiRoute(pathname)) return unauthorizedJson()` — so a caller with
 * no NextAuth cookie is refused BEFORE the handler that would have
 * authenticated it. Stripe, Microsoft Graph, the AV scanner, a SCIM IdP and
 * an MCP client all send exactly that request, and all got 401.
 *
 * Nothing about the routes looked wrong, which is why this survived: every
 * one of them verifies its own caller, correctly, in code that never ran.
 * The gap was that "authenticates itself" was never expressed to the edge.
 *
 * Each entry below MUST authenticate inside the handler. That is not a
 * convention — `tests/guards/machine-caller-paths-self-authenticate.test.ts`
 * fails if an entry here has no in-handler gate, because an allowlist entry
 * without one is a hole, and this list is the only thing standing between a
 * public prefix and the tenant API.
 *
 * And "the handler" means EVERY handler the file exports. Matching here is
 * path-scoped, not method-scoped: an entry added for one credential-less
 * method opens the others too. That is how `GET /api/security/csp-report`
 * came to serve the cross-tenant CSP violation buffer to the internet
 * (#2103) while its own comment said the middleware protected it. If a
 * route needs one method open and another closed, the closed one gates
 * itself in code — there is no way to say so here.
 */
export const MACHINE_CALLER_PREFIXES = [
    // Bearer SCIM token, tenant-scoped — `authenticateScimRequest`
    // (src/lib/scim/auth.ts). The IdP has no cookie by construction.
    '/api/scim',
    // `stripe-signature` header verified against the raw body by
    // `constructWebhookEvent`. The route's own docblock already said
    // "Public (no auth), but verifies signature".
    '/api/stripe/webhook',
    // HMAC over the raw body, compared with `crypto.timingSafeEqual`.
    '/api/storage/av-webhook',
    // Graph validation-token handshake plus a `clientState` anti-spoof
    // check against the stored subscription id. Its header comment reads
    // "Unauthenticated by design (Graph is the caller)" — which was true
    // of the handler and false of the deployment.
    '/api/webhooks/sharepoint',
    // Per-provider raw-body signature verification; the tenant is resolved
    // from the IntegrationConnection and never from the caller.
    '/api/integrations/webhooks',
    // `Bearer <TenantApiKey>` → `authenticateMcpRequest` → verifyApiKey with
    // an `mcp:read` capability scope.
    '/api/mcp',
    // Browser-sent CSP violation reports. Credential-less by spec — the
    // browser will not attach cookies, so requiring one guarantees zero
    // reports. Protected by a per-IP report limiter and a 16 KB body cap.
    // POST only, in intent: the GET on the same path returns the
    // process-wide violation buffer and gates itself on
    // PLATFORM_ADMIN_API_KEY, because this list cannot express a method.
    '/api/security/csp-report',
    '/api/csp-report',
    // Web-vitals beacon, same reasoning: `navigator.sendBeacon` from a page
    // that may not yet have a session.
    '/api/telemetry/vitals',
];

/**
 * Check if a pathname is public (should bypass auth).
 */
export function isPublicPath(pathname: string): boolean {
    // Exact matches
    if (PUBLIC_PATH_EXACT.has(pathname)) return true;

    // Prefix matches
    if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return true;

    // Regex matches — public API routes with a dynamic segment mid-path.
    if (PUBLIC_API_REGEXES.some((re) => re.test(pathname))) return true;
    // Exact match OR a `<prefix>/…` sub-path. Deliberately NOT a bare
    // `startsWith`: that would make `/api/mcp` also open `/api/mcp-admin`,
    // and an allowlist whose entries quietly cover their own siblings is
    // the shape that turns one intended hole into several.
    if (MACHINE_CALLER_PREFIXES.some(
        (p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`),
    )) return true;

    // Static file extensions
    if (STATIC_EXTENSIONS.test(pathname)) return true;

    return false;
}

/**
 * The `iflk_` API-key prefix, duplicated for the Edge runtime.
 *
 * The canonical definition is `API_KEY_PREFIX` in
 * `src/lib/auth/api-key-auth.ts`, which cannot be imported here: that
 * module pulls in Prisma and `node:crypto`, and this file is bundled into
 * the Edge middleware. The duplication is checked, not trusted —
 * `tests/unit/edge-api-key-request.test.ts` imports both and fails if they
 * diverge, and it also pins `matchTenantApiKeyRequest` to accept exactly the
 * header shapes `extractBearerToken` + `isApiKeyToken` accept. A rename on
 * either side therefore turns CI red rather than silently re-closing the
 * partner surface.
 */
export const EDGE_API_KEY_PREFIX = 'iflk_';

/**
 * FNV-1a (32-bit) over the presented API key, hex-encoded.
 *
 * Used ONLY to derive a per-key rate-limit bucket. Deliberately NOT a
 * truncation of the key the way the device-agent block truncates its device
 * token: `checkApiReadRateLimit` logs its `tenantSlug` argument at WARN level
 * on every 429 (`apiReadRateLimit.ts` — "API read rate limit exceeded"), so a
 * truncated key would write live key material into structured logs exactly
 * when a caller is being abusive. A 32-bit digest of a 192-bit-entropy secret
 * is not invertible, and a bucket collision between two keys costs at most a
 * shared 120/min budget.
 */
function fnv1a32(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Recognise a tenant-API request that carries an `iflk_` API key instead of a
 * session cookie, and return the rate-limit scope to meter it under.
 * Returns null for anything else.
 *
 * #2224 — `getToken()` reads `Authorization: Bearer`, tries to JWE-decode
 * whatever it finds, and returns null on an `iflk_` key. The edge then 401s a
 * key-only caller before `tryApiKeyAuth` (wired into BOTH `getTenantCtx` and
 * `getLegacyCtx`) ever runs, so the partner flow documented in
 * `docs/api-consumer-guide.md` could not work on any of the 305 tenant routes.
 *
 * This is deliberately a RECOGNITION, not a verification. Nothing here decides
 * whether the key is real, unexpired, unrevoked or scoped — Prisma is not
 * reachable from the Edge runtime, and the handler is and remains the sole
 * authority (`verifyApiKey` → `tryApiKeyAuth`, which THROWS 401 on an invalid
 * key rather than falling back to the cookie). The edge only decides "this is
 * not a browser session, let the handler judge it".
 *
 * Narrow by construction, because the fall-through skips the JWT-derived edge
 * gates (admin role, MFA, tenant-access):
 *   - `/api/t/**` only — the surface the credential is documented for.
 *   - `Bearer <token>` parsed exactly as `extractBearerToken` parses it.
 *   - `iflk_` prefix required.
 * The tenant-access gate this bypasses is replaced in the handler:
 * `getTenantCtx` rejects a key whose tenant is not the slug in the URL.
 */
export function matchTenantApiKeyRequest(
    pathname: string,
    authorization: string | null | undefined,
): string | null {
    if (!pathname.startsWith('/api/t/')) return null;
    if (!authorization) return null;
    // Mirror of `extractBearerToken`: exactly two space-separated parts, the
    // first case-insensitively "bearer".
    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    const token = parts[1];
    if (!token.startsWith(EDGE_API_KEY_PREFIX)) return null;
    return `apikey:${fnv1a32(token)}`;
}

/**
 * Check if a pathname is an API route.
 */
export function isApiRoute(pathname: string): boolean {
    return pathname.startsWith('/api/');
}

/**
 * Check if a pathname requires admin role.
 * Recognizes both flat and tenant-scoped admin paths.
 */
export function isAdminPath(pathname: string): boolean {
    // Flat: /admin, /api/admin
    if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) return true;
    // Tenant-scoped: /t/:slug/admin, /api/t/:slug/admin
    if (/^\/t\/[^/]+\/admin/.test(pathname)) return true;
    if (/^\/api\/t\/[^/]+\/admin/.test(pathname)) return true;
    return false;
}

/**
 * Check if a pathname is a tenant-scoped route.
 */
export function isTenantPath(pathname: string): boolean {
    return pathname.startsWith('/t/') || pathname.startsWith('/api/t/');
}

/**
 * Check if a pathname is an org-scoped route.
 *
 * Mirror of `isTenantPath` for the hub-and-spoke organization layer.
 * Used by the middleware-level org-access gate (GAP O4-1) to decide
 * whether to apply the JWT-bound org membership check on top of the
 * existing layout/page/API guards.
 */
export function isOrgPath(pathname: string): boolean {
    return pathname.startsWith('/org/') || pathname.startsWith('/api/org/');
}

/**
 * Paths that stay reachable while `mfaPending` is true.
 *
 * This is an ALLOWLIST, and since #2223 it is the ONLY thing that softens
 * MFA enforcement. The middleware used to gate MFA on
 * `isTenantPath(pathname) && !isMfaAllowedPath(pathname)`, which enforced by
 * URL SHAPE while authorization is enforced per route — so a session that had
 * presented a password and not a second factor was refused on `/api/t/**` and
 * admitted on all 93 flat API routes, 19 of which build a full tenant context
 * through `getLegacyCtx` (`/api/audit-log`, `/api/evidence`, `/api/findings`,
 * …), plus `/api/org/**` and `/api/admin`. The check is now "every
 * authenticated request except these".
 *
 * Public and machine-caller paths are NOT listed here and do not need to be:
 * `isPublicPath` returns them at step 1 of the middleware, before the JWT is
 * ever read, so `/api/auth/`, the health probes, `/api/scim`, `/api/mcp`, the
 * webhooks and the CSP-report beacon never reach the MFA branch at all. A
 * server-to-server caller also carries no `mfaPending` claim, so the check
 * would be a no-op for it even if it did.
 *
 * What IS here is the enrolment + challenge surface, because a user cannot
 * clear `mfaPending` without it:
 *
 *   - `/t/<slug>/auth/mfa`        — the challenge page.
 *   - `/t/<slug>/security/mfa`    — the ENROLMENT page. Under a REQUIRED
 *     policy an unenrolled user is `mfaPending` from first sign-in, and the
 *     challenge page's own "Set up MFA" button points here; without this
 *     entry that click bounced straight back to the challenge, so a
 *     REQUIRED-policy tenant could not onboard anyone. The docstring above
 *     claimed enrolment worked long before it did.
 *   - `/api/t/<slug>/security/mfa/**` — the APIs both of those pages call.
 *   - `/api/auth/` — sign-out, session, csrf. Redundant with `isPublicPath`
 *     and kept because this predicate is also read on its own.
 *
 * Adding an entry here creates a surface a half-authenticated session can
 * reach. Add only what is needed to COMPLETE the challenge.
 */
export function isMfaAllowedPath(pathname: string): boolean {
    // MFA challenge page, enrolment page, and their API routes
    if (/^\/t\/[^/]+\/auth\/mfa/.test(pathname)) return true;
    if (/^\/t\/[^/]+\/security\/mfa(?:\/|$)/.test(pathname)) return true;
    if (/^\/api\/t\/[^/]+\/security\/mfa/.test(pathname)) return true;
    // Auth callbacks (sign-out, etc.)
    if (pathname.startsWith('/api/auth/')) return true;
    return false;
}

/**
 * Sanitize a redirect path to prevent open-redirect attacks.
 * Only allows relative paths starting with '/'.
 * Strips protocol, host, and any absolute URL to return '/'.
 */
export function sanitizeRedirectPath(next: string | null | undefined): string {
    if (!next) return '/';

    // Decode if URL-encoded
    let decoded: string;
    try {
        decoded = decodeURIComponent(next);
    } catch {
        return '/';
    }

    // Strip any protocol + host (prevents https://evil.com)
    // Reject anything that looks like an absolute URL
    if (
        decoded.startsWith('//') ||
        decoded.includes('://') ||
        decoded.startsWith('\\')
    ) {
        return '/';
    }

    // Must start with /
    if (!decoded.startsWith('/')) {
        return '/';
    }

    // Drop any authority component (//evil.com/path)
    const cleaned = decoded.replace(/^\/\/+/, '/');

    return cleaned;
}

/**
 * Build a login redirect URL with a safe 'next' parameter.
 */
export function buildLoginRedirect(
    baseUrl: string,
    pathname: string
): URL {
    const loginUrl = new URL('/login', baseUrl);
    const safeNext = sanitizeRedirectPath(pathname);
    if (safeNext !== '/') {
        loginUrl.searchParams.set('next', safeNext);
    }
    return loginUrl;
}

/**
 * Return a 401 Unauthorized JSON response for API routes.
 */
export function unauthorizedJson(): NextResponse {
    return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
    );
}

/**
 * Return a 403 Forbidden JSON response.
 */
export function forbiddenJson(reason?: string): NextResponse {
    return NextResponse.json(
        { error: reason || 'Forbidden' },
        { status: 403 }
    );
}

/**
 * Extract the tenant slug from a tenant-scoped URL path.
 *
 * Handles both:
 *   /t/:slug/...           → slug
 *   /api/t/:slug/...       → slug
 *
 * Returns null for any path that is not tenant-scoped.
 */
export function extractTenantSlugFromPath(pathname: string): string | null {
    // /t/:slug/...  or  /t/:slug (trailing-slash-less)
    const webMatch = pathname.match(/^\/t\/([^/]+)(?:\/|$)/);
    if (webMatch) return webMatch[1];

    // /api/t/:slug/...
    const apiMatch = pathname.match(/^\/api\/t\/([^/]+)(?:\/|$)/);
    if (apiMatch) return apiMatch[1];

    return null;
}

/**
 * Pure gate function: check whether a user's memberships array allows access
 * to the given path. Extracted as a pure function so it can be unit-tested
 * without Next.js framework machinery.
 *
 * R-1: `memberships` replaces the old single-slug `jwtTenantSlug` parameter.
 * A user is allowed through to `/t/:slug/...` if ANY of their memberships
 * contains a matching slug.
 *
 * Returns:
 *   'allow'             — pass through
 *   'no_tenant_access'  — authed user has no tenant memberships at all
 *   'cross_tenant'      — the URL slug is not in any of the user's memberships
 *
 * `membershipsTruncated` — set when the JWT carries only a capped subset
 * of the user's memberships (see `MAX_JWT_MEMBERSHIPS` in `auth.ts`). A
 * slug-miss is then NOT definitive — the slug may be a membership that
 * did not fit — so the gate returns 'allow' and lets the authoritative,
 * DB-backed server-side check (`TenantLayout` / `getTenantCtx`) decide.
 * This is safe because the middleware gate is the early-rejection layer,
 * never the sole authority.
 */
export type TenantGateResult = 'allow' | 'no_tenant_access' | 'cross_tenant';

export function checkTenantAccess(
    pathname: string,
    memberships: ReadonlyArray<{ slug: string }> | null | undefined,
    membershipsTruncated = false,
): TenantGateResult {
    // Only gate tenant-scoped routes.
    const urlSlug = extractTenantSlugFromPath(pathname);
    if (!urlSlug) return 'allow';

    // Public paths that should always pass (e.g. MFA challenge within a tenant URL).
    // Already checked upstream in isPublicPath, but be defensive.
    if (isPublicPath(pathname)) return 'allow';

    // An empty list is unambiguous — a truncated list is never empty, so
    // this genuinely means the user holds no memberships.
    if (!memberships || memberships.length === 0) return 'no_tenant_access';

    if (!memberships.some((m) => m.slug === urlSlug)) {
        // Slug not in the (possibly capped) list. If capped, defer to
        // the server-side gate rather than redirect a legitimate member.
        return membershipsTruncated ? 'allow' : 'cross_tenant';
    }
    return 'allow';
}

// ── Org-route gate (mirror of the tenant gate) ───────────────────────

/**
 * Extract the org slug from `/org/:slug/...` or `/api/org/:slug/...`.
 * Returns null for any path that is not org-scoped.
 */
export function extractOrgSlugFromPath(pathname: string): string | null {
    const webMatch = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
    if (webMatch) return webMatch[1];

    const apiMatch = pathname.match(/^\/api\/org\/([^/]+)(?:\/|$)/);
    if (apiMatch) return apiMatch[1];

    return null;
}

/**
 * Pure gate: check whether a user's `orgMemberships` allows access to
 * an `/org/:slug/...` or `/api/org/:slug/...` path. Same shape as
 * `checkTenantAccess` so the middleware can route both gates through
 * a parallel branch.
 *
 * Returns:
 *   'allow'           — pass through
 *   'no_org_access'   — authed user has no org memberships at all
 *   'cross_org'       — the URL slug is not in any of the user's org memberships
 *
 * Anti-enumeration: middleware MUST collapse both `no_org_access` and
 * `cross_org` to the SAME external response (404 / no-tenant). The
 * distinction exists for log/metric tagging, not for the user.
 *
 * `orgMembershipsTruncated` — same contract as `checkTenantAccess`'s
 * `membershipsTruncated`: a slug-miss against a capped list defers to
 * the authoritative server-side org gate instead of denying.
 */
export type OrgGateResult = 'allow' | 'no_org_access' | 'cross_org';

export function checkOrgAccess(
    pathname: string,
    orgMemberships: ReadonlyArray<{ slug: string }> | null | undefined,
    orgMembershipsTruncated = false,
): OrgGateResult {
    const urlSlug = extractOrgSlugFromPath(pathname);
    if (!urlSlug) return 'allow';

    if (isPublicPath(pathname)) return 'allow';

    if (!orgMemberships || orgMemberships.length === 0) return 'no_org_access';

    if (!orgMemberships.some((m) => m.slug === urlSlug)) {
        return orgMembershipsTruncated ? 'allow' : 'cross_org';
    }
    return 'allow';
}
