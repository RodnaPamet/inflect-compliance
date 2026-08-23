/**
 * Guardrail (LAYER 2): every API route handler has SOME authorization.
 *
 * ─── WHAT THIS LAYER CLAIMS, AND WHAT IT DOES NOT ──────────────────────
 *
 * This walks ALL of `src/app/api/**\/route.ts` — 582 files, 771 exported
 * handlers at the time of writing — and asks one deliberately weak
 * question per handler:
 *
 *     Is there ANY authorization on this path at all?
 *
 * A handler passes if it does one of:
 *
 *   (a) calls `requirePermission` / `requireAnyPermission` itself, or
 *   (b) reaches a permission decision through the call graph (the usecase
 *       layer's `assertCan*`, or an equivalent inline check on the request
 *       context), or
 *   (c) carries a declared exemption below, tagged with the CLASS of
 *       credential that authorises it instead.
 *
 * **It makes no claim that the authorization is correct, sufficient, or
 * correctly ordered.** Specifically, and these are not hypotheticals — each
 * one passes here today if you write it:
 *
 *   - **Ordering is not checked.** A handler that runs
 *     `prisma.risk.deleteMany(...)` and *then* calls a permission check
 *     reads as "has authorization". So does a check inside a `.map()`
 *     callback that runs after the destructive write.
 *   - **Sufficiency is not checked.** A DELETE handler gated on
 *     `risks.view` passes.
 *   - **Liveness is not checked.** A real gate sitting behind a feature
 *     flag that is permanently false passes.
 *
 * If any of those matter for a route — and for a privileged route they all
 * do — layer 1 is where it should be covered.
 *
 * But be precise about what that buys, because the sentence above used to
 * read as though layer 1 checked them: IT DOES NOT. Layer 1 asserts a literal
 * `requirePermission` in the file plus a path-matched rule. It does not check
 * ordering, sufficiency, or liveness either — a `risks.view` key on a DELETE
 * satisfies it. What layer 1 gives is a stronger and much more legible
 * REQUIREMENT (the gate is at the route boundary, where a denial is audited)
 * on a population someone curated deliberately. Neither layer verifies that
 * the gate governs the work; nothing here does.
 *
 * ─── THE RELATIONSHIP TO LAYER 1 ───────────────────────────────────────
 *
 * `tests/guardrails/api-permission-coverage.test.ts` is LAYER 1 and it is
 * the stronger claim: for its curated `PRIVILEGED_ROOTS` population it
 * demands a LITERAL `requirePermission(...)` in the route file plus a
 * matching `ROUTE_PERMISSIONS` entry. A usecase-layer `assertCan*` does
 * NOT satisfy layer 1 and must never be allowed to — the two mechanisms
 * are not equivalent:
 *
 *     `requirePermission` denial → hash-chained AUTHZ_DENIED audit row
 *     `assertCanAdmin`   denial → a 403 and nothing written
 *
 * That is the same defect Epic D.3 fixed for seven tenant routes. So a
 * route covered by layer 1 keeps ALL of layer 1's obligations; nothing
 * here relaxes them. This file is purely ADDITIVE: it exists because 489
 * of the 582 route files sit outside layer 1's population entirely
 * (issue #2099), where a missing gate was not failing — it was simply
 * never in the denominator.
 *
 * Some routes therefore appear in both files' carve-out lists, phrased
 * differently, because the two lists answer different questions:
 * layer 1 asks "why no route-level permission key?", this asks
 * "what authorises the caller at all?".
 *
 * ─── FAIL DIRECTION OF EVERY KNOWN BLIND SPOT ──────────────────────────
 *
 * "Fail closed" here means: the detector reports LESS authorization than
 * exists, so something fine gets flagged and costs a triage. "Fail open"
 * means the reverse, and is the dangerous direction. Enumerated honestly
 * rather than claimed away — this rule is NOT fail-closed as an unqualified
 * property:
 *
 * Fail CLOSED (safe; costs a triage):
 *   - Chains deeper than `MAX_MODULE_HOPS` (3) module boundaries.
 *   - A context bound to an identifier outside `CONTEXT_ROOTS`.
 *   - `const { role } = ctx` — destructuring loses the root.
 *   - Decisions written as a ternary, `&&` short-circuit, or `switch`
 *     rather than an `if`.
 *   - Handlers produced by a higher-order factory imported from beyond
 *     the hop budget, or from `node_modules`.
 *
 * Fail OPEN (dangerous; recorded because pretending otherwise is worse):
 *   - Ordering / sufficiency / liveness, as above. This is the big one.
 *   - `branchDenies` counts ANY `throw` in the branch, so a defensive
 *     `if (!ctx.permissions) throw new Error('bad ctx')` sanity assert
 *     reads as a permission decision.
 *   - Its 401/403 fallback is a text match on the branch, so a branch that
 *     merely *mentions* `status: 403` counts as denying.
 *   - A decision reached on SOME path through the call graph counts for the
 *     whole handler, even if the destructive path skips it.
 *   - `CONTEXT_ROOTS` is a NAME check with no type behind it, so anything
 *     bound to one of those names reads as a context. `const ctx = await
 *     req.json(); if (ctx.role !== 'OWNER') throw ...` passes — caller-
 *     supplied data deciding its own authorization. This is the exact mirror
 *     of the fail-CLOSED entry above (a real context under an unrecognised
 *     name), and only that safe direction was written down until adversarial
 *     review found the other one. Both directions of a name check have to be
 *     stated or the list flatters itself.
 *
 * The fail-open set is the price of asking a reachability question. It is
 * why this layer is named for reachability and why layer 1 was left alone.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    createAnalyzer,
    CONTEXT_ROOTS,
    type HandlerVerdict,
    type HttpMethod,
} from '../helpers/route-authorization-graph';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const API_ROOT = path.join(REPO_ROOT, 'src/app/api');
const APP_ROOT = path.join(REPO_ROOT, 'src/app');

// ─── Exempt classes ──────────────────────────────────────────────────

/**
 * Each class names a CREDENTIAL that authorises the caller instead of a
 * tenant role, and — where one exists — a `mechanism` pattern that the
 * route source must still match. The pattern is what stops this from
 * being a bare list of trusted paths: the class asserts a property, and
 * CI checks the property is still there. A route that quietly stops
 * verifying its webhook signature fails this file even though its
 * exemption entry is untouched.
 *
 * `requiresNote: true` marks the classes that carry NO mechanism — there
 * is nothing to corroborate because the route really is open — so every
 * member must justify itself individually instead.
 */
interface ExemptClassDef {
    why: string;
    mechanism?: RegExp;
    requiresNote?: true;
}

type ExemptClass =
    | 'PUBLIC_UNAUTHENTICATED'
    | 'PRE_TENANT_AUTH'
    | 'SESSION_SELF_SERVICE'
    | 'CAPABILITY_TOKEN'
    | 'PROTOCOL_CREDENTIAL'
    | 'SIGNED_WEBHOOK'
    | 'MEMBERSHIP_SCOPED'
    | 'NO_AUTHORIZATION';

const EXEMPT_CLASSES: Record<ExemptClass, ExemptClassDef> = {
    PUBLIC_UNAUTHENTICATED: {
        why:
            'Genuinely open by design — liveness probes, the OpenAPI document, ' +
            'browser-originated report sinks, and pre-login UI configuration. ' +
            'There is no caller identity to authorise. Each member states its ' +
            'own case; nothing can be corroborated because there is no ' +
            'credential to look for.',
        requiresNote: true,
    },
    PRE_TENANT_AUTH: {
        why:
            'The authentication surface itself: sign-in/out, registration, ' +
            'password reset, SSO handshake, email verification. The caller is ' +
            'establishing or proving an identity, so there is no role yet for ' +
            'an authorization decision to read. Corroborated structurally — ' +
            'membership is confined to /api/auth/.',
    },
    SESSION_SELF_SERVICE: {
        why:
            'Acts on the SESSION\'s own user and takes no subject identifier ' +
            'from the request, so the session IS the authorization. Corroborated ' +
            'by the presence of a session/context resolver: a route that stops ' +
            'authenticating altogether fails here.',
        mechanism:
            /getServerSession|getSessionOrThrow|getLegacyCtx|getTenantCtx|getOrgCtx|\bauth\(\)/,
    },
    CAPABILITY_TOKEN: {
        why:
            'A single-use or bearer token carried in the URL IS the credential — ' +
            'invite redemption, an audit-pack share link, a gated trust-centre ' +
            'download, an external vendor-assessment response. The token is ' +
            'unguessable, scoped and (mostly) single-use; there is no session ' +
            'to resolve a role from. Corroboration here is WEAK: it only checks ' +
            'the route still mentions a token at all.',
        mechanism: /token/i,
    },
    PROTOCOL_CREDENTIAL: {
        why:
            'A non-session credential authenticates the whole surface — a SCIM ' +
            'bearer token, an MCP tenant API key, a device-agent token, the ' +
            'platform admin key, the staging seed token. Each member names the ' +
            'verifier it must keep calling.',
    },
    SIGNED_WEBHOOK: {
        why:
            'An inbound callback from an external system, authenticated by a ' +
            'payload signature or an OAuth state nonce rather than by a user. ' +
            'Corroborated by the signature/state check still being present.',
        mechanism: /signature|hmac|clientState|_state\b|constructWebhookEvent/i,
    },
    MEMBERSHIP_SCOPED: {
        why:
            'Resolves a tenant or org context — which authenticates the session ' +
            'AND checks membership — then reads only rows inside that scope, ' +
            'with no finer-grained permission on top. Weaker than a permission ' +
            'gate and recorded as such: membership is a boundary, not a role ' +
            'check. Corroborated by the context resolver still being called.',
        mechanism: /getTenantCtx|getOrgCtx|getSessionOrThrow/,
    },
    NO_AUTHORIZATION: {
        why:
            'The honest residual: no authorization on any path, and no ' +
            'credential class that explains it. This is the OUTPUT of this ' +
            'guardrail, not a carve-out. Every member must reference the issue ' +
            'tracking its fix. Keep this list at zero if you can and never add ' +
            'to it to make CI green.',
        requiresNote: true,
    },
};

// ─── The declared exemptions ─────────────────────────────────────────

interface ExemptEntry {
    /** `<path from src/app>#<METHOD>`, e.g. `api/health/route.ts#GET`. */
    handler: string;
    klass: ExemptClass;
    /** Required for classes with no mechanism; optional elsewhere. */
    note?: string;
    /** Overrides the class mechanism for this one handler. */
    mechanism?: RegExp;
}

const EXEMPT_HANDLERS: readonly ExemptEntry[] = [
    // ── PRE_TENANT_AUTH ──────────────────────────────────────────────
    { handler: 'api/auth/[...nextauth]/route.ts#GET', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/[...nextauth]/route.ts#POST', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/change-password/route.ts#POST', klass: 'PRE_TENANT_AUTH',
      note: 'Verifies the CURRENT password before setting the new one — the old credential is the authorization.' },
    { handler: 'api/auth/forgot-password/route.ts#POST', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/logout/route.ts#POST', klass: 'PRE_TENANT_AUTH',
      note: 'Clears a cookie. Reads nothing, so there is nothing to authorise.' },
    { handler: 'api/auth/register/route.ts#POST', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/reset-password/route.ts#POST', klass: 'PRE_TENANT_AUTH',
      note: 'Consumes a single-use, hashed-at-rest reset token; the token is the credential.' },
    { handler: 'api/auth/sso/oidc/callback/route.ts#GET', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/sso/oidc/start/route.ts#GET', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/sso/saml/callback/route.ts#POST', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/sso/saml/start/route.ts#GET', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/verify-email/resend/route.ts#POST', klass: 'PRE_TENANT_AUTH' },
    { handler: 'api/auth/verify-email/route.ts#GET', klass: 'PRE_TENANT_AUTH' },

    // ── PUBLIC_UNAUTHENTICATED ───────────────────────────────────────
    { handler: 'api/health/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Liveness/health probe. Operators must keep monitoring access during an attack — see docs/rate-limiting.md.' },
    { handler: 'api/livez/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Kubernetes liveness probe. Same reason as /api/health.' },
    { handler: 'api/readyz/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Kubernetes readiness probe. Same reason as /api/health.' },
    { handler: 'api/docs/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Serves the generated OpenAPI document, which describes the public API shape and contains no tenant data.' },
    { handler: 'api/csp-report/route.ts#POST', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Edge forwarder for the legacy report-uri path; browsers post CSP reports without credentials by specification.' },
    { handler: 'api/security/csp-report/route.ts#POST', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'The current CSP violation sink. Browsers post reports without credentials by specification; the handler rate-limits, caps the payload and always answers 204.' },
    { handler: 'api/telemetry/vitals/route.ts#POST', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Web-vitals beacon posted by the browser without credentials; accepts timing numbers only.' },
    { handler: 'api/auth/ui-config/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Which sign-in providers to render on the login page. Read before any identity exists, by definition.' },
    { handler: 'api/risk-templates/route.ts#GET', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'Global risk-template library — product catalogue content with no tenant dimension. Declared public in the handler doc comment.' },
    { handler: 'api/trust/[slug]/access-request/route.ts#POST', klass: 'PUBLIC_UNAUTHENTICATED',
      note: 'A prospect asking a tenant for access to gated trust-centre documents. The caller is by construction an outsider; approval happens later, inside the tenant.' },

    // ── SESSION_SELF_SERVICE ─────────────────────────────────────────
    { handler: 'api/account/avatar/route.ts#POST', klass: 'SESSION_SELF_SERVICE',
      note: 'Upload MY avatar — storage key derives from session.user.id.' },
    { handler: 'api/account/avatar/route.ts#DELETE', klass: 'SESSION_SELF_SERVICE',
      note: 'Delete MY avatar — same keying.' },
    { handler: 'api/account/profile/route.ts#PATCH', klass: 'SESSION_SELF_SERVICE',
      note: 'Patch MY profile — writes to session.user.id, takes no user identifier from the request.' },
    { handler: 'api/auth/me/route.ts#GET', klass: 'SESSION_SELF_SERVICE',
      note: 'Read MY session user + first membership. 401s without a session.' },
    { handler: 'api/notifications/stream/route.ts#GET', klass: 'SESSION_SELF_SERVICE',
      note: 'SSE feed of MY notifications, subscribed under getLegacyCtx.' },
    { handler: 'api/org/route.ts#GET', klass: 'SESSION_SELF_SERVICE',
      note: 'List the orgs I am a member of — queried by session.userId.' },
    { handler: 'api/org/route.ts#POST', klass: 'SESSION_SELF_SERVICE',
      note: 'Self-service org creation: the caller becomes ORG_ADMIN of a brand-new empty org and gains authority over nobody else. Rate-limited by the mutation tier.' },
    { handler: 'api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts#POST', klass: 'SESSION_SELF_SERVICE',
      note: 'Complete MY MFA challenge during sign-in (Epic D.3 self-service carve-out).' },
    { handler: 'api/t/[tenantSlug]/security/mfa/enroll/route.ts#GET', klass: 'SESSION_SELF_SERVICE',
      note: 'Read MY MFA enrolment state. The sibling DELETE reaches a usecase assert on its own.' },
    { handler: 'api/t/[tenantSlug]/security/mfa/enroll/start/route.ts#POST', klass: 'SESSION_SELF_SERVICE',
      note: 'Start MY MFA enrolment (Epic D.3 self-service carve-out).' },
    { handler: 'api/t/[tenantSlug]/security/mfa/enroll/verify/route.ts#POST', klass: 'SESSION_SELF_SERVICE',
      note: 'Verify MY MFA enrolment (Epic D.3 self-service carve-out).' },

    // ── CAPABILITY_TOKEN ─────────────────────────────────────────────
    { handler: 'api/audit/shared/[token]/route.ts#GET', klass: 'CAPABILITY_TOKEN',
      note: 'Auditor share link. Explicitly rate-limited on (IP, token) because the token is the only credential.' },
    { handler: 'api/audit/shared/[token]/route.ts#POST', klass: 'CAPABILITY_TOKEN',
      note: 'Comment on a shared audit pack through the same share token.' },
    { handler: 'api/invites/[token]/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/invites/[token]/route.ts#POST', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/invites/[token]/accept-redirect/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/invites/[token]/start-signin/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/org/invite/[token]/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/org/invite/[token]/route.ts#POST', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/org/invite/[token]/accept-redirect/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/org/invite/[token]/accept-redirect/route.ts#POST', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/org/invite/[token]/start-signin/route.ts#GET', klass: 'CAPABILITY_TOKEN' },
    { handler: 'api/trust/download/[token]/route.ts#GET', klass: 'CAPABILITY_TOKEN',
      note: 'Single-use, expiring download token minted after an approved trust-centre access request.' },
    { handler: 'api/vendor-assessment/[assessmentId]/route.ts#GET', klass: 'CAPABILITY_TOKEN',
      note: 'External vendor respondent. The token arrives ONLY as ?t=… and is never read from a header or body.' },
    { handler: 'api/vendor-assessment/[assessmentId]/submit/route.ts#POST', klass: 'CAPABILITY_TOKEN',
      note: 'External vendor submits their answers under the same ?t=… token.' },

    // ── PROTOCOL_CREDENTIAL ──────────────────────────────────────────
    { handler: 'api/admin/diagnostics/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /verifyPlatformApiKey/ },
    { handler: 'api/admin/tenants/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /verifyPlatformApiKey/ },
    { handler: 'api/admin/tenants/[slug]/transfer-ownership/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /verifyPlatformApiKey/ },
    { handler: 'api/scim/v2/Users/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Users/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Users/[id]/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Users/[id]/route.ts#PUT', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Users/[id]/route.ts#PATCH', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Users/[id]/route.ts#DELETE', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/[id]/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/[id]/route.ts#PUT', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/[id]/route.ts#PATCH', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/Groups/[id]/route.ts#DELETE', klass: 'PROTOCOL_CREDENTIAL', mechanism: /authenticateScimRequest/ },
    { handler: 'api/scim/v2/ServiceProviderConfig/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL',
      // The one SCIM route with no authenticator, deliberately: RFC 7644 §4
      // makes /ServiceProviderConfig a discovery document an IdP fetches
      // BEFORE it has been given a token. It returns static capability flags.
      mechanism: /ServiceProviderConfig/,
      note: 'RFC 7644 §4 discovery document — fetched before the IdP holds a token, returns static capability flags only.' },
    { handler: 'api/mcp/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /authenticateMcpRequest/,
      note: 'Bearer TenantApiKey. The per-tool enforceApiKeyScope + usecase assertCanRead sit deeper than the hop budget, so only the key check is visible from here.' },
    { handler: 'api/staging/seed/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /STAGING_SEED_TOKEN/,
      note: 'Refuses outright when NODE_ENV === production, then requires the x-seed-token header to equal STAGING_SEED_TOKEN.' },
    { handler: 'api/t/[tenantSlug]/devices/report/route.ts#POST', klass: 'PROTOCOL_CREDENTIAL',
      mechanism: /authorizeDeviceReport/,
      note: 'Per-tenant device-agent token (Bearer icdt_…). An endpoint agent has no login; the verifier also binds the token tenant to the URL slug.' },

    // ── SIGNED_WEBHOOK ───────────────────────────────────────────────
    { handler: 'api/stripe/webhook/route.ts#POST', klass: 'SIGNED_WEBHOOK',
      note: 'Stripe signature over the RAW body — the route must not JSON-parse first.' },
    { handler: 'api/storage/av-webhook/route.ts#POST', klass: 'SIGNED_WEBHOOK',
      note: 'HMAC-SHA256 in X-AV-Signature, timing-safe compared.' },
    { handler: 'api/webhooks/sharepoint/route.ts#POST', klass: 'SIGNED_WEBHOOK',
      note: 'Microsoft Graph notification; clientState (<tenantId>:<policyId>) is compared against the stored subscription.' },
    { handler: 'api/security/csp-report/route.ts#GET', klass: 'PROTOCOL_CREDENTIAL',
      // Was NO_AUTHORIZATION until #2109. The GET is reachable at the edge
      // because the path is in PUBLIC_PATH_EXACT for the browser POST — the
      // allowlist is path-scoped and cannot express a method — so it gates
      // itself in-handler with the platform admin key, and is metered by
      // middleware section 0e.
      mechanism: /verifyPlatformApiKey/,
      note: 'Deployment-wide CSP violation summary, so a tenant role would be the wrong axis: the buffer is one ring buffer per process, shared by every tenant. Gated by the platform admin key, the same credential /api/admin/diagnostics uses.' },
    { handler: 'api/integrations/webhooks/[provider]/route.ts#POST', klass: 'SIGNED_WEBHOOK',
      // The verification is ONE HOP AWAY, so this entry corroborates on the
      // delegation rather than on the check. The route reads the raw body,
      // hands it to `processIncomingWebhook`, and turns `auth_failed` into a
      // 401; `usecases/webhook-processor.ts` is what calls `extractSignature`
      // / `verifyHmacSha256` / `verifyGitHubSignature` against the connection's
      // stored secret.
      //
      // The class default (/signature|hmac|clientState|…/) matched this file
      // only via its DOCBLOCK, which is why it survived until the corroboration
      // started ignoring comments. Corroborating on something the route's own
      // code actually contains is the honest version — and it is weaker: it
      // asserts that the route still delegates, not that the delegate still
      // verifies.
      mechanism: /processIncomingWebhook|auth_failed/,
      note: 'Provider signature verified in webhook-processor against the connection\'s stored webhook secret before any processing; the route delegates and maps auth_failed to 401.' },
    { handler: 'api/integrations/calendar/callback/route.ts#GET', klass: 'SIGNED_WEBHOOK',
      note: 'OAuth redirect. The cal_oauth_state cookie nonce is the CSRF defence; the cookie is deleted on use.' },
    { handler: 'api/integrations/calendar/admin-callback/route.ts#GET', klass: 'SIGNED_WEBHOOK',
      note: 'Admin-consent OAuth redirect. cal_admin_state nonce, single-use — it grants tenant-wide access, so a lingering cookie would be replayable.' },

    // ── MEMBERSHIP_SCOPED ────────────────────────────────────────────
    { handler: 'api/org/[orgSlug]/route.ts#GET', klass: 'MEMBERSHIP_SCOPED',
      note: 'Org metadata + counts. getOrgCtx requires membership of ANY org role.' },
    { handler: 'api/org/[orgSlug]/tenants/route.ts#GET', klass: 'MEMBERSHIP_SCOPED',
      note: 'Tenants inside my org. The sibling POST reaches a usecase assert on its own.' },
    { handler: 'api/t/[tenantSlug]/onboarding/state/route.ts#GET', klass: 'MEMBERSHIP_SCOPED',
      note: 'Onboarding checklist progress for the current tenant — visible to every member by design.' },
    { handler: 'api/account/avatar/[userId]/route.ts#GET', klass: 'MEMBERSHIP_SCOPED',
      // Was NO_AUTHORIZATION until #2108. Not under /api/t/, so there is no
      // tenant in the path and no role to check against; the audience is
      // "any tenant we both belong to", which is a membership question.
      // `canViewAvatar` requires an ACTIVE membership shared with the subject
      // and answers everyone else with the same 404 an absent avatar returns,
      // so it does not double as an account-existence oracle.
      mechanism: /canViewAvatar/,
      note: 'Reads ANOTHER user, so neither self-service nor unguarded. Behaviour asserted in tests/unit/account-avatar-serve-authz.test.ts.' },
    { handler: 'api/t/[tenantSlug]/security/mfa/policy/route.ts#GET', klass: 'MEMBERSHIP_SCOPED',
      note: 'Reading whether the tenant requires MFA is open to every member; the PUT next to it is gated on admin.manage by layer 1.' },

    // ── NO_AUTHORIZATION — the residual, and the finding ─────────────
    //
    // EMPTY, as of 2026-08-23. Both original members were fixed rather than
    // reclassified to make CI quiet, and each moved to the class naming the
    // mechanism that now guards it — see PROTOCOL_CREDENTIAL (csp-report,
    // #2109) and MEMBERSHIP_SCOPED (avatar, #2108).
    //
    // Read this before adding one. The class doc says to keep the list at zero
    // and never add to it to make CI green; that is not aspirational. A route
    // reaching this bucket means the guard found real unauthorized access, and
    // both times it did, the answer was a fix with a behavioural test, not an
    // entry with a ticket number attached.
    //
    // Note what the analyser still cannot see, because it bears on the next
    // one: `verifyPlatformApiKey(request)` and `canViewAvatar(...)` are both
    // real gates, and BOTH still classify as NONE. The detector looks for
    // `if (<ctx.role|ctx.permissions|ctx.appPermissions>) throw`, so a gate
    // shaped as a credential verifier or a membership query is invisible to
    // it. That is why these two need an entry at all now that they are fixed —
    // the exemption records a gate the tier system cannot detect, which is a
    // different thing from recording a gap.
];

/**
 * Handlers whose ONLY authorization is a role-PRESENCE test —
 * `if (!ctx.role) throw forbidden(...)`. That condition is never false for
 * a real authenticated request, because `getTenantCtx` has already refused
 * a non-member, so it authenticates without authorising.
 *
 * Pinned by EXACT equality in both directions: a new one fails CI, and a
 * fixed one must be deleted from this list in the same diff. It is its own
 * tier rather than an exemption because these routes are not exempt from
 * anything — they are a known-weak shape we are choosing not to grow.
 */
const ROLE_PRESENCE_ONLY_HANDLERS: readonly string[] = [
    // Six entries came OFF this list on 2026-08-23, all from ONE change.
    // `assertCanViewFrameworks` was the shared root cause — its whole body was
    // the never-false check — so the routes above it inherited the shape
    // rather than each having their own. Fixing the policy to read
    // `appPermissions.frameworks.view` cleared:
    //
    //   api/mcp/route.ts#POST
    //   api/t/[tenantSlug]/frameworks/route.ts#GET
    //   api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts#GET
    //   api/t/[tenantSlug]/frameworks/[frameworkKey]/tree/route.ts#GET
    //   api/t/[tenantSlug]/onboarding/frameworks/route.ts#GET
    //   api/t/[tenantSlug]/reports/readiness/route.ts#GET
    //
    // `reports/readiness` is worth a word: it cleared WITHOUT a route-level
    // `reports.view` gate, because `generateReadinessReport` opens with the
    // policy call. Gating the route instead would have left the Reports page
    // — which calls that usecase directly — reading the same payload
    // ungated. Fixing the shared policy covers both callers by construction.
    //
    // The two below are NOT this shape's dependents: each carries its own
    // inline `if (!ctx.role)` in its own usecase, so neither was touched.
    'api/t/[tenantSlug]/search/route.ts#GET',
    'api/t/[tenantSlug]/traceability/graph/route.ts#GET',
];

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * The population comes from git, not an `fs` walk with a skip list — see
 * `tests/helpers/repo-files.ts`. Here it also buys correctness rather than
 * just hygiene: a `.claude/worktrees/<id>/` checkout contains a complete
 * second copy of `src/app/api`, and a naive walk from the repo root would
 * classify every route twice.
 */
const ROUTE_FILES = repoRelativeFiles()
    .filter(
        (rel) =>
            rel.startsWith('src/app/api/') &&
            (rel.endsWith('/route.ts') || rel.endsWith('/route.tsx')),
    )
    .map((rel) => path.join(REPO_ROOT, rel))
    .sort();
const analyzer = createAnalyzer(REPO_ROOT);

interface ClassifiedHandler {
    /** `<path from src/app>#<METHOD>`. */
    key: string;
    relFromApp: string;
    file: string;
    method: HttpMethod;
    verdict: HandlerVerdict;
}

const ALL_HANDLERS: ClassifiedHandler[] = ROUTE_FILES.flatMap((file) => {
    const relFromApp = path.relative(APP_ROOT, file);
    return analyzer.classify(file).map((verdict) => ({
        key: `${relFromApp}#${verdict.method}`,
        relFromApp,
        file,
        method: verdict.method,
        verdict,
    }));
});

const EXEMPT_BY_KEY = new Map(EXEMPT_HANDLERS.map((e) => [e.handler, e]));

function readSource(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

/**
 * Source with comments removed.
 *
 * The mechanism corroboration below must not be satisfiable by the route's own
 * prose. Testing `/verifyWebhookSignature/` against raw source passes for a file
 * whose only mention is `// we no longer verifyWebhookSignature here` — which is
 * the exact state the check exists to catch, reading as a pass.
 *
 * Deliberately crude: block comments, line comments, and the contents of string
 * literals are all out of scope for a credential-check regex, so removing a
 * little too much is safe here. Erring the other way is not.
 */
function readCodeOnly(file: string): string {
    return readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('every API route handler has SOME authorization (layer 2)', () => {
    it('walks the whole API tree, not a curated subset', () => {
        // The positive companion to every "no offenders" assertion below:
        // an empty or collapsed population would make them all vacuous.
        // Issue #2099 measured 582 files / 771 handlers; the floors sit
        // just under that so a genuine deletion spree still trips them.
        expect(ROUTE_FILES.length).toBeGreaterThan(500);
        expect(ALL_HANDLERS.length).toBeGreaterThan(700);
        // And the walk really did reach past layer 1's 15 curated roots.
        expect(
            ROUTE_FILES.filter((f) => !f.includes(`${path.sep}admin${path.sep}`)).length,
        ).toBeGreaterThan(500);
    });

    it('classifies a meaningful share of handlers as actually gated', () => {
        // Guards against a detector that silently stops resolving anything
        // and pushes the whole tree into the exempt/None buckets — every
        // offender list would then be "explained" by the allowlist.
        const gated = ALL_HANDLERS.filter(
            (h) =>
                h.verdict.tier === 'ROUTE_PERMISSION' ||
                h.verdict.tier === 'USECASE_ASSERT',
        );
        expect(gated.length).toBeGreaterThan(600);
        expect(
            ALL_HANDLERS.filter((h) => h.verdict.tier === 'ROUTE_PERMISSION').length,
        ).toBeGreaterThan(100);
    });

    it('no handler is left with no authorization and no declared class', () => {
        const offenders = ALL_HANDLERS.filter(
            (h) => h.verdict.tier === 'NONE' && !EXEMPT_BY_KEY.has(h.key),
        );

        if (offenders.length > 0) {
            throw new Error(
                [
                    'API handlers with no authorization reachable on any path:',
                    ...offenders.map((o) => `  - ${o.key}`),
                    '',
                    'Fix, in order of preference:',
                    "  1. Wrap the handler with requirePermission('<key>', …) from",
                    '     @/lib/security/permission-middleware — the only mechanism',
                    '     whose denials write an AUTHZ_DENIED audit row.',
                    '  2. Route the work through a usecase that calls an assertCan*',
                    '     guard within 3 module hops of the handler.',
                    '  3. If a NON-role credential authorises the caller (webhook',
                    '     signature, capability token, platform key, …), add an',
                    '     EXEMPT_HANDLERS entry naming the class — and make sure the',
                    '     class mechanism actually matches the route source.',
                    '',
                    'Do NOT add a NO_AUTHORIZATION entry to make this green. That',
                    'class is the finding this guardrail exists to surface.',
                ].join('\n'),
            );
        }
    });

    it('every exemption still points at a route file that exists', () => {
        const resolved = EXEMPT_HANDLERS.filter((e) =>
            fs.existsSync(path.join(APP_ROOT, e.handler.split('#')[0])),
        );
        // Positive companion: the emptiness asserted next means "nothing
        // dangles", not "the list is empty" or "APP_ROOT was wrong".
        expect(resolved.length).toBe(EXEMPT_HANDLERS.length);
        expect(EXEMPT_HANDLERS.length).toBeGreaterThan(50);

        const dangling = EXEMPT_HANDLERS.filter(
            (e) => !fs.existsSync(path.join(APP_ROOT, e.handler.split('#')[0])),
        );
        expect(dangling.map((e) => e.handler)).toEqual([]);
    });

    it('every exemption is still needed — none has been silently outgrown', () => {
        // The mirror of the offenders test, and the half that rots. An
        // exemption for a handler that has since GAINED a gate, or that no
        // longer exists as an export, is dead text that reads like a
        // considered carve-out. Exact equality in both directions.
        const noneKeys = new Set(
            ALL_HANDLERS.filter((h) => h.verdict.tier === 'NONE').map((h) => h.key),
        );
        // Positive companion: an analyser that resolved nothing would put the
        // whole tree in NONE and this test would pass vacuously; one that
        // resolved everything would empty the set and fail loudly instead of
        // quietly. Pin both sides of the band.
        expect(noneKeys.size).toBeGreaterThan(50);
        expect(noneKeys.size).toBeLessThan(150);

        const stale = EXEMPT_HANDLERS.filter((e) => !noneKeys.has(e.handler));

        if (stale.length > 0) {
            throw new Error(
                [
                    'EXEMPT_HANDLERS entries that no longer exempt anything:',
                    ...stale.map((e) => `  - ${e.handler} (${e.klass})`),
                    '',
                    'Either the handler gained real authorization — delete the entry',
                    'in the same diff — or it was renamed/removed, in which case the',
                    'exemption does not follow it and must be deleted too.',
                ].join('\n'),
            );
        }
    });

    it('every exemption names a class that carries a written rationale', () => {
        const offenders = EXEMPT_HANDLERS.filter((e) => {
            const def = EXEMPT_CLASSES[e.klass];
            return !def || def.why.trim().length < 60;
        });
        expect(offenders.map((e) => e.handler)).toEqual([]);
    });

    it('classes with nothing to corroborate require a per-handler note', () => {
        // PUBLIC_UNAUTHENTICATED and NO_AUTHORIZATION have no credential to
        // look for, so the class rationale alone would let a route join them
        // by assertion. Each member states its own case instead.
        const inScope = EXEMPT_HANDLERS.filter(
            (e) => EXEMPT_CLASSES[e.klass].requiresNote === true,
        );
        // Positive companion: the classes that need notes have members, so an
        // empty offender list is evidence rather than an empty scan.
        expect(inScope.length).toBeGreaterThan(5);

        const offenders = inScope.filter((e) => (e.note ?? '').trim().length < 40);

        if (offenders.length > 0) {
            throw new Error(
                [
                    'Exemptions in a no-corroboration class without a real note:',
                    ...offenders.map((e) => `  - ${e.handler} (${e.klass})`),
                    '',
                    'These classes assert nothing checkable, so the justification is',
                    'the only evidence a reviewer gets. Write one (>=40 chars).',
                ].join('\n'),
            );
        }
    });

    it('every corroborated exemption still matches its mechanism in the route source', () => {
        // This is what makes the allowlist more than a list of trusted
        // paths. A webhook route that stops verifying its signature, or a
        // self-service route that stops resolving a session, fails HERE —
        // its exemption entry is untouched but the property it claimed is
        // gone.
        //
        // Matched against CODE ONLY, and that is load-bearing. Run against raw
        // source, `/verifyWebhookSignature/` also matches
        // `// we no longer verifyWebhookSignature here`, so a route that had
        // deleted the check would pass on the strength of the comment saying
        // so. Adversarial review found one exemption in exactly that state.
        //
        // What this still CANNOT see, so it is not claimed above: that the
        // named call is REACHED. A verifier behind `if (false)`, or after the
        // work it should gate, satisfies the regex. Presence, not liveness.
        const offenders: string[] = [];
        let checked = 0;
        for (const e of EXEMPT_HANDLERS) {
            const mechanism = e.mechanism ?? EXEMPT_CLASSES[e.klass].mechanism;
            if (!mechanism) continue;
            const file = path.join(APP_ROOT, e.handler.split('#')[0]);
            if (!fs.existsSync(file)) continue; // reported by the dangling test
            checked += 1;
            if (!mechanism.test(readCodeOnly(file))) {
                offenders.push(`${e.handler} (${e.klass}) expected ${mechanism}`);
            }
        }

        // Positive companion: most of the allowlist really is corroborated.
        // Without this, dropping every `mechanism` would read as a clean pass.
        expect(checked).toBeGreaterThan(45);

        if (offenders.length > 0) {
            throw new Error(
                [
                    'Exempt routes that no longer show the credential check their',
                    'class claims authorises them:',
                    ...offenders.map((o) => `  - ${o}`),
                    '',
                    'Either the check moved (update the mechanism in the same diff,',
                    'and say where it went) or it is gone, in which case the route',
                    'is now unauthorized and the exemption is a lie.',
                ].join('\n'),
            );
        }
    });

    it('PRE_TENANT_AUTH membership stays confined to /api/auth/', () => {
        // The one class whose corroboration is structural rather than
        // textual: "the caller has no identity yet" is only credible on the
        // authentication surface itself.
        const members = EXEMPT_HANDLERS.filter((e) => e.klass === 'PRE_TENANT_AUTH');
        expect(members.length).toBeGreaterThan(5); // the class is populated

        const strays = members.filter((e) => !e.handler.startsWith('api/auth/'));
        expect(strays.map((e) => e.handler)).toEqual([]);
    });

    it('the role-PRESENCE-only tier has not grown', () => {
        const actual = ALL_HANDLERS.filter(
            (h) => h.verdict.tier === 'ROLE_PRESENCE_ONLY',
        )
            .map((h) => h.key)
            .sort();
        const pinned = [...ROLE_PRESENCE_ONLY_HANDLERS].sort();

        // Exact equality both directions. A new `if (!ctx.role)` route fails
        // because it is missing from the pin; a route that gains a real
        // permission check fails because its pin entry is now stale.
        expect(actual).toEqual(pinned);
    });

    it('the NO_AUTHORIZATION residual is empty', () => {
        // Calibration against an independent six-agent classification of all
        // 582 routes (2026-08-22): exactly 6 routes had no authorization
        // anywhere, of which 3 were refuted as membership-scoped reads,
        // leaving 2 tracked fixes (#2103, #2104) and 1 benign tenant read.
        // Matching that number was the evidence this rule is calibrated; a
        // rule producing 40 would have been measuring something else.
        //
        // Both tracked fixes landed on 2026-08-23 (#2109, #2108) and their
        // entries moved to the class naming the mechanism that now guards
        // them, so the residual is ZERO.
        //
        // A DOWNWARD ratchet, deliberately expressed as equality rather than
        // `<= 0`. The looser form reads identically today and stops meaning
        // anything the moment someone needs a number above zero — at which
        // point the honest change is to write that number here, in a diff,
        // with the issue that tracks it. Making CI green by widening a bound
        // is how this list would fill up.
        const residual = EXEMPT_HANDLERS.filter((e) => e.klass === 'NO_AUTHORIZATION');
        expect(residual.map((e) => e.handler)).toEqual([]);

        // Positive companion: the class still EXISTS and is still reachable.
        // Without this, deleting `NO_AUTHORIZATION` from `EXEMPT_CLASSES`
        // entirely would satisfy the assertion above while removing the guard's
        // whole output channel.
        expect(Object.keys(EXEMPT_CLASSES)).toContain('NO_AUTHORIZATION');
        expect(EXEMPT_CLASSES.NO_AUTHORIZATION.requiresNote).toBe(true);
    });
});

// ─── Detector regression proofs ──────────────────────────────────────
//
// Every assertion above is "no offenders", which a broken detector could
// satisfy by finding nothing anywhere. These prove the detector still
// discriminates, in both directions, on real files.

describe('the authorization detector still discriminates', () => {
    const probe = path.join(API_ROOT, 'health/route.ts');
    const tierOf = (src: string): string => {
        const verdicts = analyzer.classifyWithSource(probe, src);
        expect(verdicts).toHaveLength(1);
        return verdicts[0].tier;
    };

    it('does not mistake request-body validation for an authorization decision', () => {
        // The exact false positive that sank an earlier draft: it matched
        // `.role` on ANY object, so validating an inbound role field read as
        // an authz check. In this tree `.role` is read off `input`/
        // `membership`/`body` at least as often as off `ctx`.
        expect(
            tierOf(`
                export async function GET(req) {
                    const body = await req.json();
                    if (body.role === 'OWNER') { throw new Error('cannot invite an owner'); }
                    return null;
                }
            `),
        ).toBe('NONE');

        // Positive companion — the same SHAPE rooted at the request context
        // is a decision, proving the detector reached the point of decision
        // and rejected it on the root, not on the shape.
        expect(
            tierOf(`
                export async function GET(req, ctx) {
                    if (ctx.role !== 'OWNER') { throw new Error('forbidden'); }
                    return null;
                }
            `),
        ).toBe('USECASE_ASSERT');
    });

    it('separates a role-PRESENCE test from a real comparison', () => {
        expect(
            tierOf(`
                export async function GET(req, ctx) {
                    if (!ctx.role) { throw new Error('Authentication required'); }
                    return null;
                }
            `),
        ).toBe('ROLE_PRESENCE_ONLY');

        expect(
            tierOf(`
                export async function GET(req, ctx) {
                    if (!ctx.permissions.canAdmin) { throw new Error('forbidden'); }
                    return null;
                }
            `),
        ).toBe('USECASE_ASSERT');
    });

    it('notices when a real route loses the usecase call that authorised it', () => {
        // `POST /evidence/[id]/purge` is the deepest chain in the tree and
        // still the right probe, but since #2117 it carries BOTH layers: a
        // route-level `requirePermission` AND, three module hops away,
        // purgeEvidence → purgeEntity → assertCanAdmin. So the probe is run
        // in three states rather than two — otherwise the route gate alone
        // would answer every question and the graph walk would never be
        // exercised at all, which is the thing this test exists to prove.
        const purge = path.join(
            API_ROOT,
            't/[tenantSlug]/evidence/[id]/purge/route.ts',
        );
        const original = readSource(purge);

        // 1. As it ships — the strongest tier wins.
        expect(analyzer.classify(purge).map((v) => v.tier)).toEqual([
            'ROUTE_PERMISSION',
        ]);

        // 2. Route gate removed. The usecase assert is three hops away and
        //    invisible in this file; only the graph walk can find it.
        const noRouteGate = original.replace(/requirePermission/g, 'passthroughWrapper');
        expect(noRouteGate).not.toEqual(original);
        expect(
            analyzer.classifyWithSource(purge, noRouteGate).map((v) => v.tier),
        ).toEqual(['USECASE_ASSERT']);

        // 3. Usecase call removed too — nothing left to reach, so NONE.
        //    Without step 2 above, this step would pass on a walker that had
        //    stopped following imports entirely.
        const noneLeft = noRouteGate.replace(/purgeEvidence/g, 'noopEvidence');
        expect(noneLeft).not.toEqual(noRouteGate);
        expect(
            analyzer.classifyWithSource(purge, noneLeft).map((v) => v.tier),
        ).toEqual(['NONE']);
    });

    it('notices when a real route loses its route-level requirePermission', () => {
        const scim = path.join(API_ROOT, 't/[tenantSlug]/admin/scim/route.ts');
        const original = readSource(scim);
        expect(analyzer.classify(scim).every((v) => v.tier === 'ROUTE_PERMISSION')).toBe(
            true,
        );

        const mutated = original.replace(/requirePermission/g, 'passthroughWrapper');
        expect(mutated).not.toEqual(original);
        expect(
            analyzer
                .classifyWithSource(scim, mutated)
                .every((v) => v.tier === 'ROUTE_PERMISSION'),
        ).toBe(false);
    });

    it('pins the context roots the identity matcher trusts', () => {
        // Widening this set widens what counts as an authorization decision,
        // which is the fail-OPEN direction. It should be a deliberate diff
        // with a measurement behind it, not a drive-by addition.
        expect([...CONTEXT_ROOTS].sort()).toEqual([
            'ctx',
            'orgCtx',
            'requestContext',
            'serverCtx',
            'tenantCtx',
        ]);
    });
});
