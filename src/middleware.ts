import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkAuthRateLimit } from '@/lib/rate-limit/authRateLimit';
import {
    checkApiReadRateLimit,
    extractTenantSlug,
    isApiReadRateLimited,
} from '@/lib/rate-limit/apiReadRateLimit';
import { env } from '@/env';
import {
    isPublicPath,
    isApiRoute,
    isAdminPath,
    isTenantPath,
    isOrgPath,
    isMfaAllowedPath,
    extractTenantSlugFromPath,
    matchTenantApiKeyRequest,
    buildLoginRedirect,
    unauthorizedJson,
    forbiddenJson,
    checkTenantAccess,
    checkOrgAccess,
} from '@/lib/auth/guard';
import { generateNonce, buildCspHeader, CSP_NONCE_HEADER, CSP_REPORT_PATH, LEGACY_CSP_REPORT_PATH, CSP_REPORT_GROUP, getCspHeaderName, isCspReportOnly } from '@/lib/security/csp';
import { applySecurityHeaders } from '@/lib/security/headers';
import { resolveCorsConfig, isOriginAllowed, applyCorsHeaders, CORS_PREFLIGHT_HEADERS } from '@/lib/security/cors';
import { shouldBlockAdminRequest } from '@/lib/security/admin-session-guard';

/**
 * GAP-04 — Edge middleware: centralized auth guard + CSP for ALL routes.
 *
 * v4 migration: switched from the v5 `auth(async (req) => …)` async
 * wrapper (which bundled the full NextAuth config into the Edge
 * runtime) to the v4 `getToken()` direct JWT verification path. This
 * has three benefits:
 *
 *   1. The Edge bundle no longer needs the `auth.config.ts`
 *      edge/node split — middleware just verifies the JWT cookie,
 *      same as in v5 but without the wrapper indirection.
 *   2. Token fields are typed via the `next-auth/jwt` module
 *      augmentation in `src/auth.ts`. The 4 `as`-casts that v5's
 *      loose `req.auth` typing required are now typed accesses.
 *   3. `getToken()` is sync-callable from Edge functions and avoids
 *      v5-beta-specific runtime issues with the `auth()` wrapper.
 *
 * CSP flow:
 *   1. Generate cryptographic nonce per request
 *   2. Pass nonce to server components via x-csp-nonce request header
 *   3. Set Content-Security-Policy response header with nonce
 *
 * Auth behavior:
 *   ┌──────────────────┬───────────────┬──────────────────────────┐
 *   │ Route type       │ Unauthed      │ Authed but wrong role    │
 *   ├──────────────────┼───────────────┼──────────────────────────┤
 *   │ /api/*           │ 401 JSON      │ 403 JSON                 │
 *   │ App pages        │ redirect →    │ 403 redirect to /login   │
 *   │                  │  /login?next= │                          │
 *   │ Public paths     │ allowed       │ allowed                  │
 *   └──────────────────┴───────────────┴──────────────────────────┘
 */

async function authMiddleware(req: NextRequest): Promise<NextResponse> {
    const { pathname } = req.nextUrl;

    // ── 0. Public Trust Center — rate-limit at the edge, THEN allow. ──
    // /trust/<slug> is intentionally public + unauthenticated + indexable.
    // Because it's public it's a scraping/DoS target, so it is edge-rate-
    // limited (keyed per-IP + per-slug) BEFORE the public-path allow below.
    // The page itself reads ONLY the curated TrustCenter row — never tenant
    // data (enforced by tests/guardrails/trust-center-coverage.test.ts).
    if (pathname.startsWith('/trust/')) {
        const slug = pathname.split('/')[2] ?? '';
        const rl = await checkApiReadRateLimit(req, null, `trust:${slug}`);
        if (!rl.ok && rl.response) {
            return rl.response;
        }
        return NextResponse.next();
    }

    // ── 0b. Public Trust Center API — rate-limit (per-IP + per-slug), THEN
    // allow. These anonymous endpoints (`/api/trust/<slug>/access-request`,
    // `/api/trust/download/<token>`) authenticate in-handler (slug/enabled +
    // single-use token); the edge limit protects the allowlist-probing +
    // token-guessing surface before the handler runs.
    if (pathname.startsWith('/api/trust/')) {
        // /api/trust/<slug>/access-request → slug at [3]; /api/trust/download/<token> → 'download'.
        const key = pathname.startsWith('/api/trust/download/')
            ? 'apitrust:download'
            : `apitrust:${pathname.split('/')[3] ?? ''}`;
        const rl = await checkApiReadRateLimit(req, null, key);
        if (!rl.ok && rl.response) {
            return rl.response;
        }
        return NextResponse.next();
    }

    // ── 0c. Device-agent posture report — rate-limit (per-IP + per-token),
    // THEN allow. A device agent authenticates with a Bearer device token and
    // no session cookie; the token verify runs in-handler. Key by a truncated
    // token so many devices behind one NAT get independent buckets.
    if (/^\/api\/t\/[^/]+\/devices\/report$/.test(pathname)) {
        const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const rl = await checkApiReadRateLimit(req, null, `devreport:${bearer.slice(0, 16)}`);
        if (!rl.ok && rl.response) {
            return rl.response;
        }
        return NextResponse.next();
    }

    // ── 0d. External vendor-assessment respondent surface — rate-limit
    // (per-IP + per-assessment), THEN allow. The page
    // (`/vendor-assessment/<id>?t=…`) and its API
    // (`/api/vendor-assessment/<id>`, `…/<id>/submit`) are anonymous and
    // token-gated in-handler, exactly like the Trust Center pair above.
    // Without a limit here the token brute-force, assessment-id enumeration
    // and repeated bulk-answer submit surfaces are all unthrottled — the
    // token check is constant-time but not free, and one submit carries up
    // to 500 answers. Keyed by assessment id so a noisy respondent cannot
    // starve another tenant's.
    if (
        pathname.startsWith('/vendor-assessment/') ||
        pathname.startsWith('/api/vendor-assessment/')
    ) {
        const isApi = pathname.startsWith('/api/');
        // /vendor-assessment/<id> → id at [2]; /api/vendor-assessment/<id> → [3].
        const assessmentId = pathname.split('/')[isApi ? 3 : 2] ?? '';
        const rl = await checkApiReadRateLimit(
            req,
            null,
            `vendorassess:${assessmentId}`,
        );
        if (!rl.ok && rl.response) {
            return rl.response;
        }
        return NextResponse.next();
    }

    // ── 0e. CSP violation report — meter the operator GET, leave the
    // browser POST alone. Same shape as 0–0d: an anonymous-at-the-edge path
    // whose credential is verified in the handler, rate-limited BEFORE the
    // allowlist below waves it through.
    //
    // `/api/security/csp-report` sits in MACHINE_CALLER_PREFIXES so a browser
    // can POST a report with no cookie, and that allowlist matches a PATH —
    // so the operator GET, which returns the process-wide violation buffer
    // behind PLATFORM_ADMIN_API_KEY (#2103), was reachable from the internet
    // at any rate at all. Measured before this block: 500 consecutive
    // wrong-key GETs, 500 × 401, zero 429. The key is 32+ characters and
    // compared in constant time, so guessing it is not the threat being
    // answered here; the threat is that each of those attempts is free to the
    // caller and is not free to us — the same reason 0d gives for the
    // assessment-token check.
    //
    // GET (and the HEAD that Next.js auto-derives from it, which runs the
    // same handler) — deliberately not POST. The POST is a credential-less
    // browser beacon, and a limiter it shares with an attacker silently drops
    // real reports, which is the exact failure this path exists to avoid. It
    // keeps its own per-IP limiter (30/min) and 16 KB body cap inside the
    // handler and is not touched here: it falls through to the allowlist
    // exactly as before.
    //
    // Keyed by IP alone — `checkApiReadRateLimit` folds the client IP into
    // the bucket and userId is null because no JWT has been read at this
    // point. Deliberately NOT keyed by the presented credential the way 0c
    // keys by the device bearer token: a device token is ISSUED, so keying by
    // it gives each device a fair bucket behind one NAT, whereas here the
    // credential is the thing an attacker varies — keying by it would hand
    // every guess a fresh budget.
    //
    // Budget: API_READ_LIMIT (120/min), the same preset 0–0d use. Operator
    // use of this endpoint is a human refreshing a debug view — single digits
    // per minute — so 120 leaves it untouched while bounding a caller to 120
    // constant-time compares plus summary serialisations per IP per minute
    // instead of unbounded.
    if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (pathname === CSP_REPORT_PATH || pathname === LEGACY_CSP_REPORT_PATH)
    ) {
        const rl = await checkApiReadRateLimit(req, null, 'cspreport');
        if (!rl.ok && rl.response) {
            return rl.response;
        }
        // Falls THROUGH to the allowlist rather than returning
        // `NextResponse.next()` the way 0–0d do — the one place this block
        // departs from them, and only on the allow side. Behaviour today is
        // identical, because `isPublicPath` matches this path on the next
        // line. What it buys is that MACHINE_CALLER_PREFIXES stays the only
        // thing making this path public at the edge, which is what
        // `guard.ts` claims of it. A `next()` here would be a second,
        // silent authority: removing the allowlist entry would then close
        // the POST and leave the GET open, which is the inverse of what
        // anyone editing that list would intend.
    }

    // ── 0f. Tenant API called with an `iflk_` API key — rate-limit
    // (per-IP + per-key), THEN allow. Same shape as 0c: a caller that
    // authenticates with a Bearer credential and no session cookie, whose
    // credential is verified in-handler.
    //
    // #2224 — this surface was 401 for its entire life. `getToken()` reads
    // `Authorization: Bearer`, JWE-decodes whatever it finds, and returns
    // null on an `iflk_` key; section 2 below then 401s any `/api/*` with a
    // null token. `tryApiKeyAuth` is wired into BOTH context builders
    // (`getTenantCtx`, 305 routes; `getLegacyCtx`, 19) and never ran for a
    // cookieless caller — so the canonical partner flow in
    // `docs/api-consumer-guide.md` returned 401 before any handler executed.
    //
    // Why this cannot be a `MACHINE_CALLER_PREFIXES` entry: that list matches
    // a PATH, and the surface here is the whole tenant API. The credential,
    // not the path, is what says "not a browser session" — so the match is on
    // the header, and it is deliberately narrow (`/api/t/**` + a `Bearer
    // iflk_` header; see `matchTenantApiKeyRequest`).
    //
    // What the fall-through costs, and where it is paid back: returning
    // `next()` here skips the JWT-derived gates below (admin role, MFA,
    // tenant-access), all of which read a session token this caller does not
    // have. The one that was doing real work for a cookie+key request is the
    // tenant-access gate, and it is replaced in the handler — `getTenantCtx`
    // rejects a key whose tenant is not the slug in the URL, which is also
    // what `docs/api-consumer-guide.md` has always claimed happens.
    //
    // The handler stays the sole authority on whether the key is real:
    // `tryApiKeyAuth` THROWS 401 on an invalid key rather than falling back
    // to the cookie, so presenting `Bearer iflk_garbage` buys nothing.
    //
    // Rate limit keyed per-key (hashed — see `matchTenantApiKeyRequest`) so
    // many partner keys behind one NAT get independent buckets, exactly as
    // 0c gives each device its own.
    const apiKeyScope = matchTenantApiKeyRequest(
        pathname,
        req.headers.get('authorization'),
    );
    if (apiKeyScope) {
        // TWO buckets, and the second is the load-bearing one.
        //
        // Keying by the key digest gives partner keys behind one NAT
        // independent budgets, which is the point of 0f. But the credential is
        // the thing an ATTACKER varies: a random `iflk_` per request yields a
        // fresh bucket every time, so that meter alone bounds nothing for an
        // unauthenticated flood — and each such request now reaches the App
        // Router and burns a `tenantApiKey.findUnique` before its 401, where
        // pre-#2224 it was a free edge refusal. Block 0e sixty lines above
        // writes down exactly this reasoning; 0f must not contradict it.
        //
        // So the per-key bucket is checked for fairness, and an IP-only bucket
        // is checked for containment. Order matters only for which 429 is
        // returned; both must pass.
        const perKey = await checkApiReadRateLimit(req, null, apiKeyScope);
        if (!perKey.ok && perKey.response) {
            return perKey.response;
        }
        const perIp = await checkApiReadRateLimit(req, null, 'apikey-ip');
        if (!perIp.ok && perIp.response) {
            return perIp.response;
        }
        return NextResponse.next();
    }

    // ── 1. Allow public paths (login, auth callbacks, static, etc.) ──
    if (isPublicPath(pathname)) {
        return NextResponse.next();
    }

    // ── 2. Verify JWT cookie ──
    // v4 — `getToken()` reads + verifies the JWT cookie set by NextAuth.
    // Returns null if no cookie / bad signature / expired.
    const token = await getToken({
        req,
        secret: env.AUTH_SECRET,
    });

    if (!token) {
        if (isApiRoute(pathname)) {
            return unauthorizedJson();
        }
        const proto = req.headers.get('x-forwarded-proto') || 'http';
        const host = req.headers.get('host') || req.nextUrl.host;
        const origin = `${proto}://${host}`;
        return NextResponse.redirect(
            buildLoginRedirect(origin, pathname),
        );
    }

    // ── 3. Admin-only paths ──
    if (isAdminPath(pathname)) {
        const role = token.role;
        // OWNER is strictly superior to ADMIN (see CLAUDE.md RBAC section).
        const ADMIN_ROLES = new Set(['ADMIN', 'OWNER']);
        if (!role || !ADMIN_ROLES.has(role)) {
            if (isApiRoute(pathname)) {
                return forbiddenJson('Admin access required');
            }

            // Allow the request to proceed to the App Router.
            // The Server Component guard in `admin/layout.tsx` will
            // safely capture this and render the `<ForbiddenPage>`.
            // (Avoiding NextResponse.redirect(dashboardUrl) here prevents a known Next.js 14 dev server crash
            // where 307-redirecting an HTML request back to the browser's currently active URL causes an Edge Runtime panic).
            return NextResponse.next();
        }

        // Admin role confirmed — enforce stricter session posture.
        // Block cross-site requests to admin API routes (Sec-Fetch-Site check).
        // This provides equivalent protection to SameSite=strict cookies
        // without breaking OAuth redirect flows that require SameSite=lax.
        if (isApiRoute(pathname)) {
            const secFetchSite = req.headers.get('sec-fetch-site');
            const method = req.method || 'GET';
            if (shouldBlockAdminRequest(secFetchSite, method)) {
                return forbiddenJson('Cross-site admin requests are not allowed');
            }
        }
    }

    // ── 4. MFA enforcement ──
    // EVERY authenticated request, minus an explicit allowlist. Execution
    // reaches this line only past the `!token` return above, so "authenticated"
    // is already established.
    //
    // #2223 — this used to read `isTenantPath(pathname) && !isMfaAllowedPath(…)`,
    // which enforced MFA by URL SHAPE while authorization is enforced per
    // route. The two disagreed on 93 paths: an `mfaPending` session was refused
    // on `/api/t/**` and admitted on every flat API route, including the 19
    // that build a full tenant context through `getLegacyCtx`
    // (`GET /api/audit-log` — the hash-chained trail; `GET /api/evidence` —
    // the encrypted-at-rest business content Epic B exists to protect;
    // `/api/findings`, `/api/audits`, `/api/dashboard`), plus `/api/org/**`
    // and `/api/admin`. Inverting the condition is the fix: the predicate,
    // not its call sites, was the wrong question.
    //
    // Public + machine-caller paths do not regress, and not because they are
    // listed: `isPublicPath` returned them at step 1, before `getToken` ran.
    // `/api/auth/`, `/api/health`, `/api/livez`, `/api/readyz`,
    // `/api/csp-report`, `/api/scim`, `/api/mcp` and the webhooks never arrive
    // here. `/api/docs` is NOT public, so it is now MFA-gated — correct, and
    // moot in production where it 404s regardless.
    //
    // `/api/org/**` is gated the same as tenant routes. That is a decision,
    // not an inference: nothing in the code answers whether an ORG_ADMIN
    // mid-challenge may read org data, so the conservative reading applies —
    // `mfaPending` is a property of the PRINCIPAL (it is set on the token from
    // the active tenant's `mfaPolicy`, not derived from the path), and an org
    // route exposes a portfolio spanning every tenant under the org, which is
    // a superset of the one tenant whose policy demanded the second factor.
    // Admitting it would mean the broader surface is the unguarded one.
    if (!isMfaAllowedPath(pathname) && token.mfaPending === true) {
        if (isApiRoute(pathname)) {
            return forbiddenJson('MFA verification required');
        }

        // The challenge lives at a tenant URL, so a page redirect needs a
        // slug. Prefer the one in the URL; fall back to the token's primary
        // membership, which is what non-tenant pages (`/`, `/org/<slug>/…`,
        // `/admin`) now need. The fallback is always populated when it is
        // needed: `mfaPending` is only ever set when `token.tenantId` is
        // non-null (`src/auth.ts` — the MFA block is inside `if
        // (activeTenantId)`), and `tenantId`/`tenantSlug` are assigned
        // together from the primary membership.
        const tenantSlug =
            extractTenantSlugFromPath(pathname) ?? token.tenantSlug ?? null;

        if (tenantSlug) {
            const mfaUrl = new URL(`/t/${tenantSlug}/auth/mfa`, req.nextUrl.origin);
            mfaUrl.searchParams.set('next', pathname);
            return NextResponse.redirect(mfaUrl);
        }

        // No slug anywhere — a state the paragraph above says is unreachable.
        // Send them somewhere terminal and public rather than falling through,
        // because falling through is how a page path used to skip this gate
        // entirely.
        return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
    }

    // ── 5. Tenant-access gate ──
    // R-1: check whether the URL slug appears in the user's memberships
    // array. No DB hit — the JWT claim is the early-rejection layer. If
    // the membership list was capped at sign-in (membershipsTruncated),
    // a slug-miss defers to the authoritative server-side gate
    // (TenantLayout / getTenantCtx) instead of a definitive denial.
    if (isTenantPath(pathname)) {
        const memberships = token.memberships;
        const gateResult = checkTenantAccess(
            pathname,
            memberships,
            token.membershipsTruncated === true,
        );

        if (gateResult === 'no_tenant_access') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'no_tenant_access' },
                    { status: 403 },
                );
            }
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }

        if (gateResult === 'cross_tenant') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'cross_tenant_access_denied' },
                    { status: 403 },
                );
            }
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }
    }

    // ── 5b. Org-access gate (GAP O4-1) ──
    // Mirror of the tenant gate, keyed on `token.orgMemberships`.
    // Same anti-enumeration posture as `getOrgCtx` / `getOrgServerContext`:
    // both `no_org_access` and `cross_org` collapse to a single
    // external response (notFound for pages, 404 JSON for API). The
    // gate-result string distinguishes them for ops via the standard
    // request-id correlation; nothing leaks to the caller.
    //
    // No DB hit — the JWT claim is the authority. The `orgMemberships`
    // array is populated by the JWT callback in `src/auth.ts` at
    // sign-in time. Page-level (`getOrgServerContext`) and API-level
    // (`getOrgCtx`) checks remain in place as defense-in-depth — this
    // is the early-rejection layer, not a replacement.
    if (isOrgPath(pathname)) {
        const gateResult = checkOrgAccess(
            pathname,
            token.orgMemberships,
            token.orgMembershipsTruncated === true,
        );
        if (gateResult !== 'allow') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'not_found' },
                    { status: 404 },
                );
            }
            // 404 surface — route to the same landing page non-members
            // see today via the layout's `notFound()` collapse, so a
            // probing user can't tell whether the slug exists.
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }
    }

    // ── 5c. API read rate limit (GAP-17) ──
    // Tenant-scoped GETs go through a dedicated read-tier limiter
    // before reaching the route handler. Sits AFTER the tenant-access
    // gate so unauthorized cross-tenant reads still 403 (cheaper) and
    // BEFORE the route runs (so we don't burn a DB query when the
    // budget is exhausted). Health probes (`/api/health`, `/api/livez`,
    // `/api/readyz`) and `/api/docs` are excluded by
    // `isApiReadRateLimited`. Mutations + non-tenant routes are
    // unaffected — they have their own tiers.
    if (isApiReadRateLimited(req.method, pathname)) {
        const tenantSlug = extractTenantSlug(pathname);
        const userId = (token.sub as string | undefined) ?? null;
        const rl = await checkApiReadRateLimit(req, userId, tenantSlug);
        if (!rl.ok && rl.response) {
            return rl.response;
        }
    }

    // ── 6. Authenticated and authorized → proceed ──
    return NextResponse.next();
}

export default async function middleware(
    req: NextRequest,
    // Optional 2nd arg kept for back-compat with the v5 wrapper signature
    // and existing test fixtures that call `middleware(req, {})`. Unused
    // by the v4 implementation — the JWT is read via `getToken({ req })`.
    _ctx?: unknown,
): Promise<NextResponse> {
    void _ctx;
    const { pathname } = req.nextUrl;

    // ── CSP Nonce — generated once per request ──
    const nonce = generateNonce();
    const isDev = env.NODE_ENV === 'development';
    const cspHeader = buildCspHeader(nonce, isDev);
    const cspReportOnly = isCspReportOnly(process.env.CSP_REPORT_ONLY);
    const cspHeaderName = getCspHeaderName(cspReportOnly);

    // ── Request ID (reuse from upstream or generate) ──
    const requestId = req.headers.get('x-request-id') || crypto.randomUUID();

    // ── Pass nonce to server components via request header ──
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(CSP_NONCE_HEADER, nonce);
    requestHeaders.set('x-request-id', requestId);
    // 2026-05-14 — Next.js 15 reads the FULL CSP policy from the
    // request headers (NOT just our `x-csp-nonce` request header)
    // to drive its internal auto-nonce-application. Specifically,
    // Next's chunk-preload `<link>` tags and the webpack runtime's
    // chunk-loader `<script>` tags get stamped with the nonce only
    // when the framework can extract it from a `Content-Security-
    // Policy` request header at SSR time.
    //
    // Without this, `strict-dynamic` blocks every chunk that
    // wasn't statically server-rendered with the matching nonce
    // — the failure mode that R16's visx + motion dynamic imports
    // surfaced.
    //
    // The canonical Next.js CSP-middleware pattern in the official
    // docs sets the policy as a request header for exactly this
    // reason; our middleware was setting it only on the response.
    // Add both — response for browser enforcement, request for
    // Next's auto-nonce machinery.
    requestHeaders.set(cspHeaderName, cspHeader);

    const origin = req.headers.get('origin') ?? '';

    // ── CORS Policy — environment-aware, fail-closed in production ──
    const corsConfig = resolveCorsConfig(env.CORS_ALLOWED_ORIGINS, env.NODE_ENV);
    const isAllowedOrigin = isOriginAllowed(origin, corsConfig);
    const isProduction = env.NODE_ENV === 'production';

    // ── CORS Preflight for APIs ──
    if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
        const preflightHeaders = new Headers();
        if (isAllowedOrigin && origin) {
            applyCorsHeaders(preflightHeaders, origin);
        }
        for (const [key, value] of Object.entries(CORS_PREFLIGHT_HEADERS)) {
            preflightHeaders.set(key, value);
        }
        preflightHeaders.set('x-request-id', requestId);
        preflightHeaders.set(cspHeaderName, cspHeader);
        applySecurityHeaders(preflightHeaders, isProduction);
        return new NextResponse(null, { status: 204, headers: preflightHeaders });
    }

    // ── Rate Limit Auth Endpoints ──
    if (pathname.startsWith('/api/auth/')) {
        const rlResult = await checkAuthRateLimit(req);
        if (!rlResult.ok && rlResult.response) {
            return rlResult.response;
        }
    }

    // ── Auth API routes bypass ──
    // /api/auth/* routes are public and self-authenticating (they manage their
    // own session/CSRF handling). Skip the JWT-checking middleware path
    // entirely so the request body stream isn't disturbed.
    let authRes: NextResponse | undefined;
    if (pathname.startsWith('/api/auth/')) {
        authRes = NextResponse.next();
    } else {
        authRes = await authMiddleware(req);
    }

    // If auth returned a redirect (3xx) or error (4xx/5xx), use it directly.
    // Otherwise create a NextResponse.next() that forwards the modified request
    // headers — critically including x-csp-nonce, which Next.js reads to stamp
    // its <script> tags with the matching nonce.
    //
    // For /api/auth/ routes we must NOT pass { request: { headers } } because
    // Next.js re-creates the Request to apply header overrides, which can
    // interfere with NextAuth's body-parsing path. API routes don't need the
    // x-csp-nonce request header anyway.
    const isAuthApi = pathname.startsWith('/api/auth/');
    const isPassThrough = !authRes
        || (authRes.status === 200 && !authRes.headers.get('location'));

    let res: NextResponse;
    if (!isPassThrough && authRes) {
        res = authRes;
    } else if (isAuthApi) {
        res = NextResponse.next();
    } else {
        res = NextResponse.next({ request: { headers: requestHeaders } });
    }

    // ── Security Headers — applied to ALL responses ──
    applySecurityHeaders(res.headers, isProduction);

    // ── Inject CSP + Report-To + request ID on every response ──
    res.headers.set(cspHeaderName, cspHeader);
    res.headers.set('x-request-id', requestId);

    // Report-To header for the modern Reporting API (report-to CSP directive)
    res.headers.set('Report-To', JSON.stringify({
        group: CSP_REPORT_GROUP,
        max_age: 86400,
        endpoints: [{ url: CSP_REPORT_PATH }],
    }));

    // Reporting-Endpoints header (newer alternative, Chrome 96+)
    res.headers.set('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);

    // ── Apply CORS Headers to API responses (environment-locked) ──
    if (pathname.startsWith('/api/') && isAllowedOrigin && origin) {
        applyCorsHeaders(res.headers, origin);
    }

    return res;
}

/**
 * Matcher: run middleware on all routes EXCEPT static assets.
 * The public path check inside the middleware handles /login, /api/auth, etc.
 */
export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)',
    ],
};
