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
        // Tenant-wide calendar consent. `admin.manage`, not a calendar key:
        // Microsoft's tenant-wide grant admits EVERY user in the tenant to a
        // third-party calendar API, which is an admin authority rather than a
        // calendar one. A weaker key here would be an UNLOGGED gate — the
        // request would pass the middleware and be refused deeper, where
        // nothing writes AUTHZ_DENIED.
        path: new RegExp(`^${T}\\/admin\\/calendar\\/consent$`),
        permission: 'admin.manage',
        note: 'Grant, read or withdraw tenant-wide calendar consent (audited).',
    },
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

    // ── JML identity-write authority (per direction) ────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/identity-write-policy(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Decides whether this product may DISABLE or CREATE accounts ' +
            'in the customer\'s own identity directory. Same OWNER-only key ' +
            'as tenant deletion and DEK rotation because it is authority of ' +
            'the same class — and ADMIN explicitly does not hold it. Every ' +
            'other integration reads; this is the one that writes to a ' +
            'system we do not own.',
    },

    // ── JML break-glass protection (never-offboard, per account) ────
    {
        path: new RegExp(`^${T}\\/admin\\/identity-account-protection(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Marks one directory account as never-offboard, or releases it. ' +
            'Same OWNER-only key as the write policy it overrides: deciding ' +
            'the product may NOT disable an account is authority of the same ' +
            'class as deciding that it may, and releasing one hands back ' +
            'standing power to disable it. A SIBLING path rather than nested ' +
            'under admin/integrations/identity-accounts, where the roster GET ' +
            'lives — matching is first-match-wins and that rule resolves to ' +
            'admin.manage.',
    },

    // ── JML leaver pass reports (the seven-day observation record) ──
    {
        path: new RegExp(`^${T}\\/admin\\/identity-leaver-passes(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Reads the per-candidate record of what a dry-run leaver pass ' +
            'WOULD have disabled. Same OWNER-only key as the write policy ' +
            'those passes run under, because naming which of a customer\'s ' +
            'people the product would disable is authority of the same class ' +
            'as granting the disable. A SIBLING path rather than nested under ' +
            'admin/integrations on purpose: matching is first-match-wins and ' +
            'that rule resolves to admin.manage, so nesting would document a ' +
            'weaker gate here than the handler enforces.',
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
    // ── The quarantine list (the read side of the reversal) ─────────
    //
    // Order against the reversal rule below does not matter: the two
    // paths are disjoint (`quarantined` carries no second segment), so
    // first-match-wins cannot confuse them. They sit adjacent because
    // they are one decision — a reviewer changing the tier of either
    // needs the other on the same screen.
    {
        path: new RegExp(`^${T}\\/admin\\/files\\/quarantined$`),
        permission: 'admin.tenant_lifecycle',
        methods: ['GET'],
        note:
            'Enumerates the files ClamAV condemned. Same OWNER-only key ' +
            'as the reversal it feeds, deliberately: it is the ONLY ' +
            'source of the fileId that write consumes, so a weaker tier ' +
            'here would be disclosure with no matching capability — and ' +
            'the rows are a map of the malware in a customer library ' +
            '(name, size, uploader, engine signature). An ADMIN mid- ' +
            'incident still reads every FILE_QUARANTINED audit row at ' +
            'the far lower audit.view bar.',
    },
    // ── False-positive quarantine reversal ──────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/files\\/[^/]+\\/clear-quarantine$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Returns a file ClamAV condemned to circulation — the only ' +
            'way back from a terminal INFECTED verdict. Serving suspected ' +
            'malware again is OWNER-grade authority, the same class as ' +
            'tenant deletion and DEK rotation; ADMIN is explicitly denied ' +
            'this key. Audited as FILE_QUARANTINE_CLEARED before the write.',
    },
    // ── Bounded AV catch-up rescan ──────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/av-rescan$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Enqueues the bounded per-tenant `av-rescan` job, which turns ' +
            'evidence stuck at scanStatus PENDING into CLEAN or INFECTED. ' +
            'Same OWNER-only key as clear-quarantine directly above, because ' +
            'it is the same authority — deciding what the download gate will ' +
            'serve — applied in BULK rather than one file at a time. A ' +
            'SIBLING of admin/files rather than nested under it: matching is ' +
            'first-match-wins, and an exact-anchored path here means a future ' +
            'sub-route cannot silently inherit this gate. Audited as ' +
            'AV_RESCAN_INITIATED at enqueue time.',
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

    // ── Asset bulk mutations + purge (Epic C.1 audit consistency) ────
    {
        path: new RegExp(`^${T}\\/assets\\/bulk\\/(status|assign)$`),
        methods: ['POST'],
        permission: 'assets.edit',
        note:
            'Bulk asset status change / owner assign — recoverable asset ' +
            'mutations; gated so denials audit at the permission layer.',
    },
    {
        // Split out of the (status|assign|delete) rule above, which declared
        // assets.edit for all three while the handler had always declared
        // admin.manage. Nothing enforced off this map, so the mismatch cost no
        // access — but the map is what a reviewer and the SDK read, and it
        // described the delete as one tier weaker than it is.
        path: new RegExp(`^${T}\\/assets\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk soft-delete of the asset register — bulkDeleteAsset asserts ' +
            'canAdmin, so the route gate matches at admin.manage rather than ' +
            'the assets.edit its recoverable bulk siblings use.',
    },
    {
        path: new RegExp(`^${T}\\/assets\\/bulk\\/import$`),
        methods: ['POST'],
        permission: 'assets.create',
        note: 'Bulk asset CSV import — creates assets, so gated on assets.create.',
    },
    {
        path: new RegExp(`^${T}\\/assets\\/[^/]+\\/purge$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'IRREVERSIBLE hard delete of a soft-deleted asset — the usecase ' +
            'asserts canAdmin, so the route gate matches at admin.manage ' +
            '(OWNER/ADMIN), not the assets.edit an EDITOR holds.',
    },

    // ── Tenant security settings ────────────────────────────────────
    // Admin-only on BOTH verbs, unlike the sibling MFA-policy route whose
    // GET is member-visible: this payload carries the session cap and
    // reveals whether an outbound audit-stream endpoint is configured.
    {
        path: new RegExp(`^${T}\\/admin\\/security-settings$`),
        permission: 'admin.manage',
        note:
            'Reading and writing the tenant security configuration — session ' +
            'cap, audit-stream endpoint + HMAC secret, AI guard mode and AI ' +
            'residency. Every field here was previously unreachable: the ' +
            'consumers existed, the writer did not.',
    },

    // ── Vendor sub-processor register (4th-party graph) ─────────────
    // Split read/write so AUDITOR and READER keep visibility of the
    // nth-party chain — reading who a vendor sub-processes to IS a
    // compliance-review action — while only vendors.edit can rewire it.
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/subprocessors(\\/chain)?$`),
        methods: ['GET'],
        permission: 'vendors.view',
        note:
            'Reading the sub-processor register and the recursive nth-party ' +
            'chain. Matches the usecase assert; the /chain leaf discloses the ' +
            'whole graph in one call, so it is gated identically rather than ' +
            'left to inherit.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/subprocessors$`),
        methods: ['POST', 'DELETE'],
        permission: 'vendors.edit',
        note:
            'Adding or removing a sub-processor relationship — edits the ' +
            'GDPR Art.28 sub-processor record, so it sits at the vendor ' +
            'management tier, not the read tier.',
    },
    // ── Evidence bundles (the surviving `/issues` routes) ────────────
    // The rest of `/issues` was a parallel write API over the same `Task`
    // rows with strictly weaker gates, and was deleted. These three carry
    // behaviour with no `/tasks` twin, so they keep the path and gain the
    // gate they never had: without `requirePermission` the granular
    // custom-role `tasks.*` flags were unreachable — the coarse
    // `ctx.permissions` set is derived from the BASE role and never reads
    // `permissionsJson` — and a denial wrote no AUTHZ_DENIED row.
    {
        path: new RegExp(`^${T}\\/issues\\/[^/]+\\/bundles(\\/.*)?$`),
        methods: ['GET'],
        permission: 'tasks.view',
        note:
            'Reading a task\'s evidence bundles. Same key as the `/tasks` ' +
            'read tier, since a bundle is a view onto that task\'s evidence.',
    },
    {
        path: new RegExp(`^${T}\\/issues\\/[^/]+\\/bundles(\\/.*)?$`),
        methods: ['POST'],
        permission: 'tasks.edit',
        note:
            'Creating a bundle, adding an item, or FREEZING one. Freeze ' +
            'makes the bundle immutable, so it is an edit rather than a ' +
            'read even though it takes no body.',
    },

    // ── Destructive register verbs (#2117) ──────────────────────────
    // Bulk delete / archive / purge / restore across the evidence,
    // policy, vendor, test-plan and task registers. Every one of these
    // authorized correctly BEFORE this map entry existed — via the
    // usecase `assertCan*` — and every one of them recorded nothing when
    // it refused, because `AUTHZ_DENIED` is written by `requirePermission`
    // and by nothing else. The usecase asserts stay (they are what
    // protects jobs and scripts); these rules describe the route gate
    // that now sits in front of them.
    //
    // Each key is chosen to MIRROR the assert behind it, never to be
    // derived from the path. A key weaker than the assert is not a
    // lenient gate, it is an unlogged one; a key stricter than the
    // assert locks out a caller the usecase would admit.
    {
        path: new RegExp(`^${T}\\/evidence\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk soft-delete of the evidence register — `bulkDeleteEvidence` ' +
            'asserts canAdmin, so the route gate matches at admin.manage ' +
            'rather than the evidence.edit an EDITOR holds.',
    },
    {
        path: new RegExp(`^${T}\\/evidence\\/[^/]+\\/(purge|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'IRREVERSIBLE hard delete of a soft-deleted evidence record, and ' +
            'its restore counterpart. Both reach assertCanAdmin through ' +
            'purgeEntity / restoreEntity in soft-delete-operations.',
    },
    {
        path: new RegExp(`^${T}\\/policies\\/bulk\\/(delete|archive)$`),
        methods: ['POST'],
        permission: ['admin.manage', 'policies.edit'],
        mode: 'all',
        note:
            'Bulk delete / archive of the policy library. TWO keys because ' +
            'assertCanAdminPolicies is itself a conjunction — the coarse ADMIN ' +
            'tier AND the granular policies.edit flag — and the route must ' +
            'mirror the assert to catch every denial it exists to log.',
    },
    {
        path: new RegExp(`^${T}\\/policies\\/[^/]+\\/(purge|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Hard delete / restore of one policy. admin.manage ALONE, unlike ' +
            'the bulk siblings: purgePolicy and restorePolicy delegate to ' +
            'purgeEntity / restoreEntity, which assert only the coarse ' +
            'canAdmin and never reach assertCanAdminPolicies. Adding ' +
            'policies.edit here would out-strict the usecase.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete of the vendor register — raised to assertCanAdmin so ' +
            'it matches every peer register, unlike its bulk/status and ' +
            'bulk/assign siblings which stay at the vendors.edit tier.',
    },
    {
        path: new RegExp(`^${T}\\/tests\\/plans\\/bulk\\/(delete|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete / restore of the control test programme. ' +
            'assertCanBulkManageTestPlans reads appPermissions.admin.manage ' +
            'directly, so route gate and usecase gate are the same predicate.',
    },
    {
        path: new RegExp(`^${T}\\/tasks\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete of the task register. Previously declared tasks.edit ' +
            'while bulkDeleteTask asserted canAdmin — a gate weaker than its ' +
            'assert, so an EDITOR passed the middleware and was refused deeper ' +
            'where nothing writes an audit row. Not an access change.',
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
