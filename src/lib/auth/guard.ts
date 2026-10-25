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
    // The inbound A2A endpoint (#3679): another organisation's agent, which has
    // no cookie by construction. Its OWN entry rather than a widening of the
    // `iflk_` carve-out on `/api/t/**`, which also skips the admin-role and MFA
    // gates (`matchTenantApiKeyRequest`). The edge decides nothing here: the
    // handler checks the peer's `iflp_` credential, its Ed25519 signature over
    // the exact body, its card pin and its kill before it reads the body
    // (`handleInboundA2a`).
    '/api/a2a',
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
    /*
        Platform-operator routes, gated on PLATFORM_ADMIN_API_KEY (#3132).

        The same defect this list was created for, missed when it was written:
        all four routes verify the platform key correctly, in code that never
        ran, because an operator's `curl` carries no NextAuth cookie and the
        edge refused it at `middleware.ts`'s `!token` branch. A correct key and
        a wrong key returned byte-identical 401s, which is what kept it hidden.

        The kill switch is the reason this matters rather than being tidy:
        `/api/admin/agent-kill-switch` exists to stop every agent at once, and
        its only remote control was unreachable.

        SAFE ONLY BECAUSE EVERY METHOD GATES ITSELF, and that is checked rather
        than assumed — matching here is path-scoped, so this entry opens all
        four files and any added later. `machine-caller-paths-self-authenticate`
        derives the population from the directory and asserts a gate inside
        EVERY exported handler, which is the lesson `/api/security/csp-report`
        taught at the cost of serving a cross-tenant buffer to the internet
        (#2103).

        A sibling stem like `/api/administrators` is NOT opened: the matcher
        above is exact-or-subpath, never a bare `startsWith`.
    */
    '/api/admin',
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
    // MFA challenge page, enrolment page, and the APIs those two pages call.
    //
    // Every pattern is ANCHORED on a segment boundary. An unanchored
    // `/security/mfa` prefix also matches `/security/mfa/policy` and
    // `/security/mfa-policy`, and `PUT` on the policy route is gated on
    // `admin.manage` and nothing else — `updateTenantMfaPolicy` has an
    // anti-lockout check for switching TO required and none for switching
    // AWAY. So an mfaPending ADMIN holding only a password could have sent
    // `{"mfaPolicy":"DISABLED"}`, signed out and back in fully authenticated,
    // and turned MFA off for every user in the tenant. The allowlist must
    // admit only what COMPLETES a challenge, never what redefines whether one
    // is required.
    if (/^\/t\/[^/]+\/auth\/mfa(?:\/|$)/.test(pathname)) return true;
    if (/^\/t\/[^/]+\/security\/mfa(?:\/|$)/.test(pathname)) return true;
    // Enumerated, not prefixed: `enroll` and `challenge` are the two the
    // challenge and enrolment pages call. A future sibling under this path is
    // NOT admitted by default, which is the failure mode above.
    if (/^\/api\/t\/[^/]+\/security\/mfa\/(?:enroll|challenge)(?:\/|$)/.test(pathname)) return true;
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
 * The workspace whose MFA challenge this request must pass first, if any, for
 * the session's NON-primary workspaces (`mfaPendingTenantIds`; the primary one
 * is `mfaPending`, handled before this):
 *   - a path inside a pending workspace answers that workspace;
 *   - an org path answers the first pending workspace, because an org route
 *     exposes a portfolio that includes it;
 *   - any other path answers nothing.
 * Paths that must stay reachable mid-challenge are the caller's to exempt
 * (`isMfaAllowedPath`). See `src/lib/auth/workspace-mfa.ts`.
 */
export function pendingMfaWorkspaceSlug(
    pathname: string,
    token: {
        memberships?: ReadonlyArray<{ slug: string; tenantId: string }> | null;
        mfaPendingTenantIds?: readonly string[] | null;
    },
): string | null {
    const pending = new Set(token.mfaPendingTenantIds ?? []);
    if (pending.size === 0) return null;
    const memberships = token.memberships ?? [];
    const slug = extractTenantSlugFromPath(pathname);
    if (slug) {
        const membership = memberships.find((m) => m.slug === slug);
        return membership && pending.has(membership.tenantId) ? slug : null;
    }
    if (isOrgPath(pathname)) {
        return memberships.find((m) => pending.has(m.tenantId))?.slug ?? null;
    }
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

// ── Admin-path gate ──────────────────────────────────────────────────

/** The built-in roles the edge admits to an admin path. OWNER is strictly superior to ADMIN. */
export const EDGE_ADMIN_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'OWNER']);

/**
 * The ONLY admin paths the edge admits an `AI_ADMIN` to (#3699) — tenant
 * templates, `[slug]` standing for the URL's tenant slug, each matched as the
 * path itself or a sub-path on a SEGMENT boundary.
 *
 * `AI_ADMIN` runs the agent register and holds the agent keys and no
 * tenant-wide admin key, so it reaches exactly the admin surface those keys
 * gate:
 *
 *   - `/api/t/[slug]/admin/agents`          every agent admin API — the
 *     register, policy cards, tool grants, the kill switch, harness scans and
 *     scanner keys, parameter sets, reports, skills, and the two-step
 *     ownership transfer (`admin.agent_ownership`);
 *   - `/api/t/[slug]/admin/mcp/quarantine`  the quarantine triage read, gated
 *     `admin.agent_registry` — the one agent-key API outside `/admin/agents`,
 *     and the only data path of `/agents/quarantine`;
 *   - `/t/[slug]/admin/agents`, `/t/[slug]/admin/mcp/agent-receipts`,
 *     `/t/[slug]/admin/mcp/quarantine`  the agent PAGES still under `/admin`,
 *     all compatibility redirects to `/t/[slug]/agents/**`, which is not an
 *     admin path at all.
 *
 * NOT `/admin/mcp` itself (agent CREDENTIALS, `admin.view`), not
 * `/admin/security-settings/agent-enforcement` (`admin.manage`), not
 * `/admin/agent-driver` (`admin.tenant_lifecycle`): those keys are tenant-wide
 * and the role holds none of them. Every other `/admin/**` path refuses it.
 *
 * The edge only PRE-FILTERS. The handler's literal `requirePermission` stays
 * the authority on every one of these routes, and is what writes
 * `AUTHZ_DENIED`. `tests/unit/ai-admin-edge-allowlist.test.ts` pins this list
 * by exact set equality and runs the real middleware for an AI_ADMIN against a
 * sample of every other admin root, derived from the filesystem.
 */
export const AI_ADMIN_ADMIN_PATH_PREFIXES: readonly string[] = [
    '/api/t/[slug]/admin/agents',
    // A2A host consumers (#3861). NOT an expansion of what an AI_ADMIN can
    // already do, which is the reason this is a one-line addition rather than
    // a decision to escalate:
    //
    //   · the routes are gated on `admin.agent_registry` and
    //     `admin.agent_kill_switch`, both of which an AI_ADMIN already HOLDS;
    //   · `/api/t/[slug]/admin/agents` is already listed above, and the PEER
    //     A2A routes live under it — so an AI_ADMIN can already issue a
    //     credential that admits ANOTHER ORGANISATION'S agent. Admitting a
    //     host consumer is the same authority over the same keys.
    //
    // `tests/unit/ai-admin-handler-authz.test.ts` is what forced the choice,
    // and it leaves no third option: a route OUTSIDE this list may not name a
    // key an AI_ADMIN holds. The alternative was to move the routes under
    // `admin/agents/host-consumers`, which was rejected — a catch-all
    // `admin/agents(/.*)?` rule and the `[agentId]` segment both match it, so
    // the word "host-consumers" would become an agent id nobody could ever
    // use. A separate `admin/a2a` subtree keeps the paths unambiguous.
    '/api/t/[slug]/admin/a2a',
    '/api/t/[slug]/admin/mcp/quarantine',
    '/t/[slug]/admin/agents',
    '/t/[slug]/admin/mcp/agent-receipts',
    '/t/[slug]/admin/mcp/quarantine',
];

/**
 * Whether `pathname` is inside `AI_ADMIN_ADMIN_PATH_PREFIXES`.
 *
 * Fails closed on anything not in canonical form, because an allowlist that
 * reasons about segments must be shown segments: a percent-encoding (`%2F`
 * would make `agents%2F..%2Fmembers` one segment to this function and a
 * different route to a decoder downstream), a backslash, an empty segment
 * (`//`), or a `.`/`..` segment. The URL parser normalises dot segments before
 * the middleware sees the path; refusing them here costs nothing and does not
 * depend on it. A prefix is matched as itself or `<prefix>/…`, never by bare
 * `startsWith`, so `/admin/agents-evil` and `/admin/agentsX` are not inside
 * `/admin/agents`.
 */
export function isAiAdminAdminPath(pathname: string): boolean {
    const template = tenantPathTemplate(pathname);
    if (template === null) return false;
    return AI_ADMIN_ADMIN_PATH_PREFIXES.some(
        (prefix) => template === prefix || template.startsWith(`${prefix}/`),
    );
}

/**
 * `pathname` as a tenant TEMPLATE — `/api/t/acme/admin/agents` →
 * `/api/t/[slug]/admin/agents` — or `null` when it is not a tenant path in
 * canonical form (see `isAiAdminAdminPath` for what canonical means and why
 * anything else fails closed). A single trailing slash is the path itself and
 * is dropped.
 */
function tenantPathTemplate(pathname: string): string | null {
    if (/[%\\]/.test(pathname)) return null;
    const match = pathname.match(/^(\/api)?\/t\/([^/]+)(\/.*)?$/);
    if (!match) return null;
    const rest = match[3] ?? '';
    const segments = rest.split('/').slice(1);
    // A single trailing slash is the path itself; any other empty segment is not canonical.
    const inner = segments.length > 0 && segments[segments.length - 1] === '' ? segments.slice(0, -1) : segments;
    if ([match[2], ...inner].some((s) => s === '' || s === '.' || s === '..')) return null;
    return `${match[1] ?? ''}/t/[slug]${rest}`;
}

/**
 * The static directories beside `[agentId]` under
 * `src/app/api/t/[tenantSlug]/admin/agents/`. A single segment after
 * `/admin/agents/` is an AGENT ID only when it is none of these.
 *
 * A name this list does not know is read as an agent id, so the edge would
 * admit an AUDITOR's GET of it and leave the refusal to that route's handler.
 * That is safe — the handler is the authority and audits the denial — but it is
 * a pre-filter wider than the view key, so the list is pinned against the
 * filesystem by `tests/unit/agent-registry-view-key.test.ts` and a new static
 * route under the agent subtree fails CI until it is listed here.
 */
export const AGENT_ADMIN_API_STATIC_SEGMENTS: readonly string[] = [
    'a2a-signing-key',
    'audit-pilot',
    'budget',
    'concurrency',
    'external-tools',
    'harness-acceptances',
    'harness-estates',
    'harness-scanner-keys',
    'harness-scans',
    'intake',
    'kill-switch',
    'owner-orphan-pass',
    'parameter-sets',
    'peers',
    'reports',
    'review-quality',
    'skills',
    'tool-manifests',
];

/**
 * The admin API READS the edge admits an AUDITOR to (#3710, #3678) — the agent
 * inventory, which the read-only `admin.agent_registry_view` gates and AUDITOR
 * holds. Exact templates, `[agentId]` standing for one segment that is not in
 * `AGENT_ADMIN_API_STATIC_SEGMENTS`, and GET or HEAD only:
 *
 *   - `/api/t/[slug]/admin/agents`                the register list
 *   - `/api/t/[slug]/admin/agents/[agentId]`      one agent's register row —
 *     the detail page's Overview tab reads it from the browser, which is why the
 *     edge must admit it at all
 *   - `/api/t/[slug]/admin/agents/harness-scans`  the scan list
 *   - `/api/t/[slug]/admin/agents/harness-estates` the client estates and their
 *     schedule health, built from the scans (owner decision, 2026-10-19). The
 *     exact list template only: one estate's path is PATCH and DELETE
 *   - `/api/t/[slug]/admin/agents/reports`        the governance pack
 *
 * Nothing under those paths, no other method, and no other admin path: AUDITOR
 * holds no key that writes, and the only other admin key it holds
 * (`compliance_dsar_view`) is not widened here. The handler's literal
 * `requirePermission` stays the authority, as for every role.
 */
export const AUDITOR_ADMIN_READ_PATHS: readonly string[] = [
    '/api/t/[slug]/admin/agents',
    '/api/t/[slug]/admin/agents/[agentId]',
    '/api/t/[slug]/admin/agents/harness-scans',
    '/api/t/[slug]/admin/agents/harness-estates',
    '/api/t/[slug]/admin/agents/reports',
];

const AGENT_DETAIL_TEMPLATE = '/api/t/[slug]/admin/agents/[agentId]';
const AGENT_SUBTREE = '/api/t/[slug]/admin/agents/';

/** Whether an AUDITOR's request is one of `AUDITOR_ADMIN_READ_PATHS`. */
export function isAuditorAdminReadPath(pathname: string, method: string | null | undefined): boolean {
    const verb = (method ?? '').toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') return false;
    const raw = tenantPathTemplate(pathname);
    if (raw === null) return false;
    const template = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    for (const allowed of AUDITOR_ADMIN_READ_PATHS) {
        if (allowed === AGENT_DETAIL_TEMPLATE) {
            if (!template.startsWith(AGENT_SUBTREE)) continue;
            const segment = template.slice(AGENT_SUBTREE.length);
            if (segment !== '' && !segment.includes('/') && !AGENT_ADMIN_API_STATIC_SEGMENTS.includes(segment)) {
                return true;
            }
        } else if (template === allowed) {
            return true;
        }
    }
    return false;
}

/**
 * Pure gate function: may this session reach an admin path, judged by the
 * role it holds IN THE TENANT THE PATH NAMES (#3701)?
 *
 * The gate used to read `token.role`, which is the role on the session's
 * primary (oldest) membership. A user who was a READER in their first tenant
 * and an OWNER in a second was refused every admin route in the second, and a
 * user who was an OWNER in their first tenant passed this gate in any tenant
 * they held at all. It failed closed in the first case and was caught by the
 * handler's own `requirePermission` in the second, but the edge was answering
 * a question about the wrong tenant.
 *
 * Returns:
 *   'allow' — the role here is an admin role, or is AI_ADMIN and the path is
 *             one of the agent admin paths (`AI_ADMIN_ADMIN_PATH_PREFIXES`,
 *             #3699), or is AUDITOR and the request is a GET of the agent
 *             inventory (`AUDITOR_ADMIN_READ_PATHS`, #3710)
 *   'deny'  — the role here is not
 *   'defer' — the URL's tenant is not in the claim. This gate does not own
 *             that answer: the tenant-access gate does, and it refuses
 *             `cross_tenant` when the claim is complete, or defers to the
 *             DB-backed server gate when it was capped at sign-in. Refusing
 *             here instead would deny a legitimate member whose membership did
 *             not fit in the cookie.
 *
 * A flat admin path names no tenant, so it is judged by the primary role, as
 * before. (`/api/admin` is a machine-caller prefix and never reaches this
 * gate; the `/admin` page is what remains.)
 */
export type AdminGateResult = 'allow' | 'deny' | 'defer';

export function checkAdminAccess(
    pathname: string,
    primaryRole: string | null | undefined,
    memberships: ReadonlyArray<{ slug: string; role: string }> | null | undefined,
    /**
     * The request method — read only for the AUDITOR branch (#3710), which is
     * GET/HEAD-only. Absent, that branch admits nothing.
     */
    method?: string | null,
): AdminGateResult {
    const urlSlug = extractTenantSlugFromPath(pathname);
    if (!urlSlug) {
        return primaryRole && EDGE_ADMIN_ROLES.has(primaryRole) ? 'allow' : 'deny';
    }
    const here = memberships?.find((m) => m.slug === urlSlug);
    if (!here) return 'defer';
    if (EDGE_ADMIN_ROLES.has(here.role)) return 'allow';
    // #3699 — AI_ADMIN in THIS tenant, on an agent admin path only. A flat
    // path (above) never admits it: it names no tenant, so no agent register.
    if (here.role === 'AI_ADMIN' && isAiAdminAdminPath(pathname)) return 'allow';
    // #3710 — AUDITOR in THIS tenant, reading the agent inventory only.
    if (here.role === 'AUDITOR' && isAuditorAdminReadPath(pathname, method)) return 'allow';
    return 'deny';
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
