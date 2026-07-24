/**
 * Route → permission map for the API surface (Epic C.1).
 *
 * The map is the single declarative source of truth for "which
 * `PermissionKey` does this URL require?" — it lets us:
 *
 *   1. Roll the `requirePermission(...)` middleware across handlers
 *      without duplicating the policy in twelve different files.
 *   2. Guard against a new sensitive route shipping unprotected: the
 *      coverage test in `tests/guards/route-permission-coverage.test.ts`
 *      walks `src/app/api/**\/route.ts` and verifies every in-scope
 *      route has a matching rule AND uses `requirePermission(...)` in
 *      its handler.
 *   3. Surface the policy in code review: a PR that touches an admin
 *      route is forced to update this map, which a reviewer can read
 *      in isolation without context-switching across handler files.
 *
 * Adding or moving an admin/privileged route:
 *   - Add a rule below covering the path + methods.
 *   - Wire `requirePermission(<key>, …)` into the route handler.
 *   - Run `npm test -- tests/guards/route-permission-coverage.test.ts`
 *     to verify the rollout is complete.
 *
 * This file is intentionally narrow in scope. It only enumerates
 * privileged routes (admin, key rotation, member management, etc.).
 * Read-mostly tenant routes (controls, evidence, risks, reports,
 * etc.) continue to authorise via the existing usecase-layer policy
 * helpers (`assertCanRead/Write/Admin/Audit`) — Epic C.2 will widen
 * the route-map to those once the granular policy keys settle.
 */

import type { PermissionKey, PermissionMode } from './permission-middleware';

// ─── Rule shape ─────────────────────────────────────────────────────

/**
 * Closed set of HTTP methods a rule may gate. Template-literal union
 * enforces at compile time that every rule uses the canonical
 * uppercase form — the hot path at line ~210 does a direct
 * `includes` with no per-call normalisation.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePermissionRule {
    /**
     * Regex matched against `req.nextUrl.pathname`. Use `\/[^/]+\/` for
     * a single dynamic segment (so trailing slashes / query strings
     * don't accidentally match).
     */
    path: RegExp;
    /**
     * HTTP methods this rule covers. Omit to apply to every method.
     * MUST be uppercase — the compile-time `HttpMethod` union enforces.
     */
    methods?: readonly HttpMethod[];
    /**
     * Permission key(s) required to call the route.
     */
    permission: PermissionKey | readonly PermissionKey[];
    /**
     * All-of vs any-of when multiple keys. Defaults to `'all'`.
     */
    mode?: PermissionMode;
    /**
     * Short human-readable rationale. Required so a reviewer can sanity-
     * check the policy at a glance — `'admin.scim'` on the SCIM route is
     * obvious; rules that combine keys or carve exceptions are not.
     */
    note: string;
}

// ─── Tenant route prefix ────────────────────────────────────────────

/**
 * Shared prefix for every tenant-scoped API path. Centralised so a
 * future rename (`/api/t/` → `/api/tenants/`) updates one place.
 */
const T = String.raw`\/api\/t\/[^/]+`;

// ─── The map ────────────────────────────────────────────────────────

export const ROUTE_PERMISSIONS: readonly RoutePermissionRule[] = [
    // ── DSAR register (manual-fulfilment queue) ─────────────────────
    // Split view/manage: AUDITOR holds _view because reading the
    // rights-request log IS the auditor's job, but must never advance a
    // request. Two rules rather than one so the GET stays readable to a
    // role that cannot mutate.
    {
        path: new RegExp(`^${T}\\/admin\\/dsar-requests(\\/.*)?$`),
        methods: ['GET'],
        permission: 'admin.compliance_dsar_view',
        note:
            'Reading the GDPR Art.15/17 rights-request register — includes ' +
            'the identity of data subjects who exercised a right.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/dsar-requests(\\/.*)?$`),
        methods: ['POST', 'PATCH'],
        permission: 'admin.compliance_dsar_manage',
        note:
            'Recording and advancing rights requests — a staff action with ' +
            'legal consequence, so AUDITOR observes but never transitions.',
    },
    // ── Member management ───────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/members(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing members, inviting, editing role, deactivating — ' +
            'changes who can access the tenant and at what level.',
    },

    // ── Session management (Epic C.3) ────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/sessions(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing + revoking active user sessions for the tenant. ' +
            'Treated as a member-management action since it controls ' +
            'who currently has live access.',
    },

    // ── SCIM token management ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/scim$`),
        permission: 'admin.scim',
        note:
            'Generating, listing and revoking SCIM bearer tokens — ' +
            'controls automated provisioning from the IdP.',
    },

    // ── Custom RBAC roles ───────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/roles(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Creating / editing / deleting custom roles. Falls under ' +
            "admin.manage — there's no separate `admin.roles` key.",
    },

    // ── Tenant-wide settings ────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/settings(\\/.*)?$`),
        permission: 'admin.manage',
        note: 'Tenant settings (display name, branding, defaults).',
    },

    // ── Outbound integrations ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/integrations(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'CRUD on outbound integrations (Slack, webhooks, ticketing). ' +
            'Mis-configuration leaks data outside the tenant.',
    },

    // ── Risk matrix configuration (Epic 44) ──────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/risk-matrix-config(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Tenant-scoped likelihood × impact matrix shape, axis ' +
            'labels, severity bands, and per-level vocabulary. ' +
            'Read-only sibling at /risk-matrix-config (risks.view).',
    },

    // ── M2M API keys ────────────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/api-keys(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'API key issuance + revocation — every key is a long-lived ' +
            'credential against the tenant; treat as admin-only.',
    },

    // ── Device-agent tokens (PR-5) ──────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/device-tokens(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Device-agent token issuance + revocation — a long-lived ' +
            'per-tenant credential authenticating /devices/report; admin-only.',
    },

    // ── Master-KEK rotation (Epic B.3) ──────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/key-rotation(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Re-wraps the tenant DEK + re-encrypts v1 ciphertexts ' +
            'after the operator stages a new DATA_ENCRYPTION_KEY. ' +
            'Operator-driven fleet operation; ADMIN tier suffices.',
    },

    // ── NIS2 gap-assessment delegation (Prompt 2) ───────────────────
    {
        // Dispatch (POST) + owner list (GET) + finalize — assessment-admin
        // actions. The assignee self-service routes at
        // `/gap-assessments/<id>/assignments/my/**` are intentionally NOT
        // matched here (excluded below): they are ctx-scoped in the usecase to
        // the assignee, mirroring own-MFA / own-session self-service.
        path: new RegExp(`^${T}\\/gap-assessments\\/[^/]+\\/assignments(\\/finalize)?$`),
        permission: 'admin.manage',
        note:
            'Delegating a NIS2 gap re-assessment to respondents + finalising it ' +
            'is an assessment-admin action; per-respondent answering is ' +
            'self-service (ctx-scoped in the usecase).',
    },

    // ── Admin plan change (business-KPI plan-change boundary) ───────
    {
        path: new RegExp(`^${T}\\/admin\\/billing\\/plan(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Mutates BillingAccount.plan — direct billing + entitlement ' +
            'consequences. No Stripe webhook in this deployment, so this ' +
            'is the only first-party plan-change path; OWNER-only.',
    },

    // ── Per-tenant DEK rotation (Epic F.2 follow-up) ────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/tenant-dek-rotation(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Generates a fresh per-tenant DEK + sweeps every v2 ' +
            'ciphertext under the new key. Response to a per-tenant ' +
            'compromise — destructive on the timeline that matters ' +
            'and OWNER-only per the role model in CLAUDE.md.',
    },
    // ── Per-tenant DEK rotation — GAP-22 alias path ─────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/rotate-dek(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Same handler as /admin/tenant-dek-rotation; aliased here ' +
            'so the GAP-22-prescribed short URL is gated identically ' +
            'rather than relying on path-equivalence at the runtime ' +
            'permission middleware (the regex matcher is path-string ' +
            'based, not handler-identity based).',
    },

    // ── Billing (Epic D.3 — was legacy requireAdminCtx) ─────────────
    {
        path: new RegExp(`^${T}\\/billing\\/(checkout|portal|events)(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Stripe checkout + customer portal + billing-event listing — ' +
            'commercial actions; treat as admin-only.',
    },

    // ── Security session-management bulk routes (Epic D.3) ──────────
    {
        path: new RegExp(`^${T}\\/security\\/sessions\\/(revoke-all|revoke-user)$`),
        permission: 'admin.members',
        note:
            'Admin-driven session revocation for the whole tenant or a ' +
            'specific colleague — same surface as /admin/sessions; ' +
            'gated under admin.members for consistency.',
    },

    // ── Tenant MFA policy (Epic D.3 — PUT only; GET is open) ────────
    // Only the PUT method is mapped here. The GET handler in the same
    // file is intentionally unprotected by `requirePermission` — any
    // tenant member can read the current MFA posture from the security
    // settings page. The methods array enforces the asymmetry.
    {
        path: new RegExp(`^${T}\\/security\\/mfa\\/policy$`),
        methods: ['PUT'],
        permission: 'admin.manage',
        note:
            'Mutating the tenant MFA policy is admin-only; the GET ' +
            'sibling stays open so the settings UI can render for ' +
            'every tenant member.',
    },

    // ── Tenant SSO configuration (Epic D.3) ─────────────────────────
    {
        path: new RegExp(`^${T}\\/sso(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'SSO provider configuration — provider list, upsert, ' +
            'enable/enforce toggles, deletion. All ADMIN-only.',
    },

    // ── Tenant invite management (Epic 1, PR 3) ──────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/invites(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Creating, listing, and revoking pending tenant invites. ' +
            'Changes who can join the tenant — gated under admin.members.',
    },

    // ── Trust Center — publish toggle (OWNER) ───────────────────────
    // MUST precede the compose rule below — first-match wins and this is the
    // more specific path. Publishing exposes company data on the PUBLIC
    // internet, so it is OWNER-only (admin.tenant_lifecycle), audited.
    {
        path: new RegExp(`^${T}\\/admin\\/trust-center\\/enable(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Enable/disable the PUBLIC /trust/<slug> page — exposes or ' +
            'withdraws company data on the open internet. OWNER-only; ' +
            'audited (TRUST_CENTER_PUBLISHED/UNPUBLISHED).',
    },

    // ── Trust Center — compose content (ADMIN) ──────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/trust-center(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Compose the curated trust-center projection (display name, ' +
            'frameworks-to-show, posture prose, documents). ADMIN-tier; ' +
            'publishing it to the internet is the separate OWNER-gated ' +
            '/enable route above.',
    },

    // ── NIS2 Article 23 incident response ────────────────────────────
    // Mutations (create, advance phase, mark reportable, file a
    // regulatory notification, link controls, append timeline) are a
    // privileged security-team action — gated under `incidents.manage`.
    {
        path: new RegExp(`^${T}\\/incidents(\\/.*)?$`),
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        permission: 'incidents.manage',
        note:
            'Create / advance / mark-reportable / submit-notification / ' +
            'link-controls / timeline writes — a privileged security-team ' +
            'action, not a general editor action. ADMIN/OWNER only.',
    },
    // Reads (list + detail + deadlines + timeline) are visible to every
    // member for compliance visibility — gated under `incidents.view`.
    {
        path: new RegExp(`^${T}\\/incidents(\\/.*)?$`),
        methods: ['GET'],
        permission: 'incidents.view',
        note: 'List / detail incident reads — compliance visibility for every member.',
    },

    // ── Report export surface (reports.export) ──────────────────────
    // The UI gates these three export actions with
    // <RequirePermission resource="reports" action="export"> — the API
    // must enforce the same or the gate is UI-only. READER has
    // reports.export=false; EDITOR/AUDITOR/ADMIN/OWNER have it true.
    {
        path: new RegExp(`^${T}\\/reports\\/pdf\\/generate$`),
        methods: ['POST'],
        permission: 'reports.export',
        note:
            'Generates a branded PDF report (audit-readiness / risk-register / ' +
            'gap-analysis) and streams or persists it — an export action.',
    },
    {
        path: new RegExp(`^${T}\\/reports\\/soa\\/export\\.csv$`),
        methods: ['GET'],
        permission: 'reports.export',
        note:
            'Exports the Statement of Applicability / coverage CSV — an export ' +
            'action carrying aggregated compliance posture out of the app.',
    },
    {
        path: new RegExp(`^${T}\\/risks\\/reports$`),
        methods: ['POST'],
        permission: 'reports.export',
        note:
            'Generates a risk report run (PDF/CSV/PPTX) — an export action. The ' +
            'GET on the same path (list templates + recent runs) stays open.',
    },
] as const;

// ─── Resolver ───────────────────────────────────────────────────────

export interface ResolvedRoutePermission {
    rule: RoutePermissionRule;
    permission: PermissionKey | readonly PermissionKey[];
    mode: PermissionMode;
}

/**
 * Look up the permission rule that applies to a request path + method.
 * Returns `null` for routes the map doesn't cover — callers decide
 * whether to fall back to legacy guards (Epic C.1 scope) or to fail
 * closed (a future Epic C.3 enforcement-by-default mode).
 */
export function resolveRoutePermission(
    pathname: string,
    method: string,
): ResolvedRoutePermission | null {
    const upperMethod = method.toUpperCase() as HttpMethod;
    for (const rule of ROUTE_PERMISSIONS) {
        if (!rule.path.test(pathname)) continue;
        if (rule.methods && !rule.methods.includes(upperMethod)) {
            continue;
        }
        return {
            rule,
            permission: rule.permission,
            mode: rule.mode ?? 'all',
        };
    }
    return null;
}

/**
 * Quick membership test for guard / coverage tests. True iff the path
 * matches at least one rule (regardless of method).
 */
export function isRouteCovered(pathname: string): boolean {
    return ROUTE_PERMISSIONS.some((r) => r.path.test(pathname));
}
