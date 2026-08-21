/**
 * RQ4-1 — Page/subpage segregation source of truth.
 *
 * Every tenant-scoped route is classified as either:
 *
 *   - MAIN     — a top-level sidebar destination. NO back affordance.
 *   - SUBPAGE  — every other route. MUST mount a back affordance.
 *
 * This file is the single structural fact every later RQ4 ratchet reads
 * from. When a new route lands under `src/app/t/[tenantSlug]/(app)/`, it
 * MUST be added here — RQ4-1's ratchet (`tests/guards/rq4-1-page-segregation.test.ts`)
 * walks the filesystem and fails CI if a `page.tsx` exists that this file
 * does not classify.
 *
 * Routes are stored without the `/t/[tenantSlug]` prefix — they're written
 * as the user sees them in the address bar (e.g. `/risks`, `/risks/[riskId]`).
 * Dynamic segments use the Next.js `[param]` form verbatim so the file is
 * grep-able against the route tree.
 */

export type RouteClass = 'main' | 'subpage' | 'unknown';

/**
 * Subpages that intentionally DO NOT render `<BackAffordance>`.
 *
 *   - **Redirect shims** (`/controls/new`, `/risks/new`, `/issues/*`) —
 *     these files only call `redirect()`; there's no UI to attach the
 *     affordance to.
 *   - **Auth + onboarding flow pages** (`/auth/mfa`, `/onboarding`) —
 *     a back affordance would let the user bypass a required gating
 *     step. Wrong affordance for the page's job.
 *   - **Print views** (`/reports/soa/print`) — print CSS hides nav chrome
 *     anyway, and the print page has its own minimal frame.
 *
 * The RQ4-10 cohort-sweep ratchet reads this list and exempts every
 * entry from the positive-coverage assertion. Add an entry HERE with a
 * comment naming the reason; never silently strip a BackAffordance
 * import from a page.
 */
/**
 * MAIN pages on which `<BackAffordance noFallback />` is intentionally
 * mounted. The OB-H invariant "no MAIN page renders an IA-canonical
 * back fallback" still holds — these pages mount the affordance in
 * `noFallback` mode, which returns null when there's no in-tab
 * referrer. The user only ever sees a back link when they actually
 * arrived from somewhere in the app.
 *
 * Use this for top-level destinations that are routinely deep-linked
 * from other sections (e.g. `/clauses` and `/findings` reached from
 * `/audits`). The cohort sweep ratchet checks for `noFallback` on
 * every entry here.
 */
export const REFERRER_ONLY_BACK_MAIN_PAGES: readonly string[] = [
    '/clauses',   // deep-linked from /audits (Internal Audit)
    '/findings',  // deep-linked from /audits (Internal Audit)
] as const;

export const BACK_AFFORDANCE_EXEMPT_SUBPAGES: readonly string[] = [
    '/assets/new',            // redirect shim → /assets?create=1
    '/audits/new',            // redirect shim → /audits?create=1
    '/audits/readiness',      // redirect shim → /audits/cycles (unified list)
    '/auth/mfa',              // auth flow — back would bypass MFA challenge
    '/controls/new',          // redirect shim → /controls?create=1
    '/issues/[issueId]',      // legacy redirect → /tasks/[taskId]
    '/issues/dashboard',      // legacy redirect → /tasks (dashboard retired, TP-7)
    '/issues/new',            // legacy redirect → /tasks/new
    '/onboarding',            // forced flow — back would skip a required step
    '/policies/new',          // redirect shim → /policies?create=1
    '/policies/templates',    // redirect shim → /policies?create=1&template=1
    '/reports/soa/print',     // print view, chrome-less by design
    '/risks/new',             // redirect shim → /risks?create=1
    '/tasks/dashboard',       // redirect shim → /tasks (dashboard merged into list, TP-7)
    '/tasks/new',             // redirect shim → /tasks?create=1
    // R3-P3 — parent navigation is PageBreadcrumbs (Dashboard › Tests › …)
    // plus the shared TestsSubNav spine, the richer form PageHeader itself
    // prefers over a one-tap back affordance.
    '/tests/due',
    '/tests/dashboard',
    '/vendors/new',           // redirect shim → /vendors?create=1
] as const;

/**
 * Subpages that still need `<BackAffordance>` mounted in their page tree.
 *
 * These pages don't use `<EntityDetailLayout>` (so RQ4-5/6/7/8's
 * one-line `back={{ smart: true }}` doesn't apply) and don't yet use
 * `<PageHeader>` (so the foundations PR's seam doesn't reach them).
 * Each one needs a manual edit: add the BackAffordance import + mount
 * the component above the page title.
 *
 * The RQ4-10 cohort sweep ratchet treats this list as a temporary
 * waiver — entries here pass the positive-coverage assertion, but the
 * ratchet enforces that the list NEVER GROWS. The list is expected to
 * shrink to `[]` over follow-up PRs; the structural invariant
 * (mount on every subpage) is the long-term shape.
 *
 * To migrate a page off this list:
 *   1. Add `import { BackAffordance } from '@/components/nav/BackAffordance';`
 *   2. Render `<BackAffordance />` as the first child of the page's
 *      outermost wrapper, above the title.
 *   3. Remove the entry from this list — CI confirms the mount.
 */
export const BACK_AFFORDANCE_COHORT_TODO: readonly string[] = [
] as const;

/**
 * Top-level sidebar destinations. These pages are reached from the primary
 * navigation; they have no parent within the tenant scope. The back
 * affordance is forbidden here.
 */
export const MAIN_PAGES: readonly string[] = [
    '/access-reviews',
    '/admin',
    '/assets',
    '/audits',
    '/calendar',
    '/clauses',
    '/controls',
    '/coverage',
    '/dashboard',
    '/evidence',
    '/findings',
    '/framework-updates',
    '/issues',
    '/mapping',
    '/notifications',
    '/policies',
    '/processes',
    '/reports',
    '/risks',
    '/tasks',
    '/tests',
    '/vendors',
] as const;

/**
 * Every other tenant-scoped route. The back affordance is required here
 * (unless listed in `BACK_AFFORDANCE_EXEMPT_SUBPAGES`).
 *
 * Dynamic segments are written as `[param]` and matched literally — the
 * `classifyRoute` helper normalises a runtime pathname to the same form
 * before lookup.
 */
export const SUBPAGES: readonly string[] = [
    // Access reviews
    '/access-reviews/[reviewId]',

    // Admin subpages
    '/admin/api-keys',
    '/admin/audit-log',
    '/admin/billing',
    '/admin/devices',
    '/admin/dsar-requests',
    '/admin/entra',
    '/admin/identity-leaver-passes',
    '/admin/integrations',
    '/admin/integrations/sharepoint-health',
    '/admin/integrations/[connectionId]',
    '/admin/integrations/identity-accounts',
    '/admin/mcp',
    '/admin/mcp/agent-receipts',
    '/admin/members',
    '/admin/notifications',
    '/admin/personnel',
    '/admin/rbac',
    '/admin/privacy',
    '/admin/risk-appetite',
    '/admin/risk-matrix',
    '/admin/roles',
    '/admin/scim',
    '/admin/security',
    '/admin/sso',
    '/admin/training',
    '/admin/trust-center',
    '/admin/vendor-assessment-reviews',
    '/admin/vendor-assessment-reviews/[assessmentId]',
    '/admin/vendor-templates',
    '/admin/vendor-templates/[templateId]',

    // Agent (MCP) — reached from the /admin/mcp hub, not the sidebar.
    '/agent-proposals',
    '/agent-runs',

    // Assets
    '/assets/[id]',
    '/assets/import',
    '/assets/new',

    // Audits
    '/audits/auditors',
    '/audits/business-continuity',
    '/audits/business-continuity/[id]',
    '/audits/cycles',
    '/audits/cycles/[cycleId]',
    '/audits/cycles/[cycleId]/readiness',
    '/audits/nis2-gap',
    '/audits/nis2-gap/respond/[assignmentId]',

    '/audits/new',
    '/audits/packs/[packId]',
    '/audits/readiness',

    // Auth (in-app)
    '/auth/mfa',

    // Controls
    '/controls/[controlId]',
    '/controls/[controlId]/tests/[planId]',
    '/controls/dashboard',
    '/controls/new',
    '/controls/sankey',
    '/controls/templates',

    // Incidents (NIS2 Article 23) — subpage of Internal Audit
    '/incidents',
    '/incidents/[incidentId]',

    // Frameworks — subpages of Internal Audit
    '/frameworks',
    '/frameworks/[frameworkKey]',
    '/frameworks/[frameworkKey]/diff',
    '/frameworks/[frameworkKey]/readiness',
    '/frameworks/[frameworkKey]/self-assessment',
    '/frameworks/[frameworkKey]/install',
    '/frameworks/[frameworkKey]/templates',

    // Issues
    '/issues/[issueId]',
    '/issues/dashboard',
    '/issues/new',

    // Onboarding
    '/onboarding',

    // Policies
    '/policies/[policyId]',
    '/policies/new',
    '/policies/templates',

    // Processes
    '/processes/governance',

    // Reports
    '/reports/soa',
    '/reports/soa/print',

    // Risks
    '/risks/[riskId]',
    '/risks/ai',
    '/risks/ai-systems',
    '/risks/ai-systems/[systemId]',
    '/risks/board',
    '/risks/correlations',
    '/risks/dashboard',
    '/risks/hierarchy',
    '/risks/information-registry',
    '/risks/import',
    '/risks/kri',
    '/risks/loss-events',
    '/risks/new',
    '/risks/reports',
    '/risks/scenarios',

    // Security (self-service)
    '/security/mfa',

    // Security posture — reached from Risks (vulnerabilities) / the
    // Internal Audit "Scans" link (security-testing) + entity detail
    // surfaces, not the sidebar.
    '/security-testing',
    '/vulnerabilities',

    // Tasks
    '/tasks/[taskId]',
    '/tasks/dashboard',
    '/tasks/new',

    // Tests
    '/tests/dashboard',
    '/tests/due',
    '/tests/plans/[planId]',
    '/tests/runs/[runId]',

    // Vendors
    '/vendors/[vendorId]',
    '/vendors/dashboard',
    '/vendors/new',
] as const;

/**
 * Normalise a runtime pathname (with the tenant prefix and concrete dynamic
 * segment values) to the canonical form used in `MAIN_PAGES` / `SUBPAGES`.
 *
 *   /t/acme/risks/abc-123  →  /risks/[riskId]
 *   /t/acme/dashboard      →  /dashboard
 *
 * Returns the stripped path on a match, `null` if it doesn't fit the
 * tenant-scoped shape.
 */
export function normalizePathname(pathname: string): string | null {
    const stripped = pathname.replace(/^\/t\/[^/]+/, '');
    if (!stripped.startsWith('/')) return null;

    const sorted = [...MAIN_PAGES, ...SUBPAGES].sort(
        (a, b) => b.split('/').length - a.split('/').length,
    );

    for (const pattern of sorted) {
        if (matchesPattern(stripped, pattern)) return pattern;
    }
    return null;
}

function matchesPattern(pathname: string, pattern: string): boolean {
    const pathSegs = pathname.split('/').filter(Boolean);
    const patternSegs = pattern.split('/').filter(Boolean);
    if (pathSegs.length !== patternSegs.length) return false;
    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i];
        if (p.startsWith('[') && p.endsWith(']')) continue;
        if (p !== pathSegs[i]) return false;
    }
    return true;
}

/**
 * Classify a runtime pathname. Returns:
 *   - 'main'     — the route is in `MAIN_PAGES` (no back affordance)
 *   - 'subpage'  — the route is in `SUBPAGES` (back affordance required)
 *   - 'unknown'  — the route is outside the tenant scope or not classified
 */
export function classifyRoute(pathname: string): RouteClass {
    const normalized = normalizePathname(pathname);
    if (!normalized) return 'unknown';
    if ((MAIN_PAGES as readonly string[]).includes(normalized)) return 'main';
    if ((SUBPAGES as readonly string[]).includes(normalized)) return 'subpage';
    return 'unknown';
}
