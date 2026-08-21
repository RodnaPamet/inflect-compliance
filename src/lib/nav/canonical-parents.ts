/**
 * RQ4-4 — Canonical parent resolver.
 *
 * Maps each route in `SUBPAGES` (RQ4-1) to the page the back affordance
 * should fall back to when no in-tab referrer is available (cold load,
 * fresh tab, deep link, history-cleared session).
 *
 * Convention: the canonical parent is the route one structural step up
 * from the subpage in the IA — NOT necessarily the URL parent. A nested
 * subpage like `/vendors/[vendorId]/assessment/[assessmentId]` falls
 * back to `/vendors/[vendorId]` (its parent entity), not `/vendors`,
 * because the user-mental-model parent is the vendor detail page.
 *
 * Patterns are written in the `[param]` form. The resolver normalises a
 * runtime pathname via `normalizePathname` (RQ4-1) before lookup.
 *
 * Labels are CONTEXTUAL — they name the destination ("Back to Risks",
 * "Back to Vendor"). Labels are static i18n-default English; localisation
 * threading is a follow-up — the strings are short and consistent so the
 * upgrade is mechanical.
 */
import { normalizePathname } from './page-segregation';

export interface CanonicalParent {
    /** Pattern relative to `/t/[tenantSlug]` — joined at render time. */
    href: string;
    /** Trailing portion of the affordance label: "Back to <label>". */
    label: string;
}

const PARENT_MAP: Record<string, CanonicalParent> = {
    '/frameworks/[frameworkKey]/readiness': { href: '/frameworks/[frameworkKey]', label: 'NIS2' },
    '/frameworks/[frameworkKey]/self-assessment': { href: '/frameworks/[frameworkKey]', label: 'NIS2' },
    // Access reviews
    '/access-reviews/[reviewId]': { href: '/access-reviews', label: 'Access reviews' },

    // Agent (MCP) — both hang off the /admin/mcp hub.
    '/agent-proposals': { href: '/admin/mcp', label: 'MCP' },
    '/agent-runs': { href: '/admin/mcp', label: 'MCP' },
    '/admin/mcp/agent-receipts': { href: '/admin/mcp', label: 'MCP' },

    // Admin subpages
    '/admin/api-keys': { href: '/admin', label: 'Admin' },
    '/admin/audit-log': { href: '/admin', label: 'Admin' },
    '/admin/billing': { href: '/admin', label: 'Admin' },
    '/admin/devices': { href: '/admin', label: 'Admin' },
    '/admin/dsar-requests': { href: '/admin', label: 'Admin' },
    '/admin/entra': { href: '/admin', label: 'Admin' },
    // Reached from the Integrations hub, where the identity connectors these
    // passes act on are configured — same structural parent as the synced
    // identity roster.
    '/admin/identity-leaver-passes': { href: '/admin/integrations', label: 'Integrations' },
    '/admin/integrations': { href: '/admin', label: 'Admin' },
    '/admin/integrations/sharepoint-health': { href: '/admin/integrations', label: 'Integrations' },
    '/admin/integrations/[connectionId]': { href: '/admin/integrations', label: 'Integrations' },
    '/admin/integrations/identity-accounts': { href: '/admin/integrations', label: 'Integrations' },
    '/admin/mcp': { href: '/admin', label: 'Admin' },
    '/admin/members': { href: '/admin', label: 'Admin' },
    '/admin/notifications': { href: '/admin', label: 'Admin' },
    '/admin/personnel': { href: '/admin', label: 'Admin' },
    '/admin/privacy': { href: '/admin', label: 'Admin' },
    '/admin/rbac': { href: '/admin', label: 'Admin' },
    '/admin/risk-appetite': { href: '/admin', label: 'Admin' },
    '/admin/risk-matrix': { href: '/admin', label: 'Admin' },
    '/admin/roles': { href: '/admin', label: 'Admin' },
    '/admin/scim': { href: '/admin', label: 'Admin' },
    '/admin/security': { href: '/admin', label: 'Admin' },
    '/admin/sso': { href: '/admin', label: 'Admin' },
    '/admin/training': { href: '/admin', label: 'Admin' },
    '/admin/trust-center': { href: '/admin', label: 'Admin' },
    '/admin/vendor-assessment-reviews': { href: '/admin', label: 'Admin' },
    '/admin/vendor-assessment-reviews/[assessmentId]': { href: '/admin', label: 'Admin' },
    '/admin/vendor-templates': { href: '/admin', label: 'Admin' },
    '/admin/vendor-templates/[templateId]': { href: '/admin/vendor-templates', label: 'Vendor templates' },

    // Assets
    '/assets/[id]': { href: '/assets', label: 'Assets' },
    '/assets/import': { href: '/assets', label: 'Assets' },
    '/assets/new': { href: '/assets', label: 'Assets' },

    // Audits
    '/audits/auditors': { href: '/audits', label: 'Audits' },
    '/audits/business-continuity': { href: '/audits', label: 'Internal Audit' },
    '/audits/business-continuity/[id]': { href: '/audits/business-continuity', label: 'Business Continuity' },
    '/audits/cycles': { href: '/audits', label: 'Audits' },
    '/audits/cycles/[cycleId]': { href: '/audits/cycles', label: 'Audit cycles' },
    '/audits/cycles/[cycleId]/readiness': {
        href: '/audits/cycles/[cycleId]',
        label: 'Audit cycle',
    },
    '/audits/nis2-gap': { href: '/audits', label: 'Internal Audit' },
    '/audits/nis2-gap/respond/[assignmentId]': { href: '/audits/nis2-gap', label: 'NIS2 Gap Assessment' },
    '/audits/new': { href: '/audits', label: 'Audits' },
    '/audits/packs/[packId]': { href: '/audits', label: 'Audits' },
    '/audits/readiness': { href: '/audits', label: 'Audits' },

    // Auth
    '/auth/mfa': { href: '/dashboard', label: 'Dashboard' },

    // Controls
    '/controls/[controlId]': { href: '/controls', label: 'Controls' },
    // Incidents (NIS2 Article 23) — subpage of Internal Audit
    '/incidents': { href: '/audits', label: 'Internal Audit' },
    '/incidents/[incidentId]': { href: '/incidents', label: 'Incidents' },
    // Test-plan detail lives URL-wise under a control, but the user's
    // mental model is "I'm working on a test"; the canonical parent is
    // the Tests list. The in-tab referrer still wins — drilling in from
    // a control detail shows "Back to Control" via the smart referrer.
    '/controls/[controlId]/tests/[planId]': {
        href: '/tests',
        label: 'Tests',
    },
    '/controls/dashboard': { href: '/controls', label: 'Controls' },
    '/controls/new': { href: '/controls', label: 'Controls' },
    '/controls/sankey': { href: '/controls', label: 'Controls' },
    '/controls/templates': { href: '/controls', label: 'Controls' },

    // Frameworks — a subpage of Internal Audit (frameworks are the
    // standards an audit is conducted against; not a top-level section).
    '/frameworks': { href: '/audits', label: 'Internal Audit' },
    '/frameworks/[frameworkKey]': { href: '/frameworks', label: 'Frameworks' },
    '/frameworks/[frameworkKey]/diff': {
        href: '/frameworks/[frameworkKey]',
        label: 'Framework',
    },
    '/frameworks/[frameworkKey]/install': {
        href: '/frameworks/[frameworkKey]',
        label: 'Framework',
    },
    '/frameworks/[frameworkKey]/templates': {
        href: '/frameworks/[frameworkKey]',
        label: 'Framework',
    },

    // Issues
    '/issues/[issueId]': { href: '/issues', label: 'Issues' },
    '/issues/dashboard': { href: '/issues', label: 'Issues' },
    '/issues/new': { href: '/issues', label: 'Issues' },

    // Onboarding
    '/onboarding': { href: '/dashboard', label: 'Dashboard' },

    // Policies
    '/policies/[policyId]': { href: '/policies', label: 'Policies' },
    '/policies/new': { href: '/policies', label: 'Policies' },
    '/policies/templates': { href: '/policies', label: 'Policies' },

    // Processes
    '/processes/governance': { href: '/processes', label: 'Processes' },

    // Reports
    '/reports/soa': { href: '/reports', label: 'Reports' },
    '/reports/soa/print': { href: '/reports/soa', label: 'SoA' },

    // Risks
    '/risks/[riskId]': { href: '/risks', label: 'Risks' },
    '/risks/ai': { href: '/risks', label: 'Risks' },
    '/risks/ai-systems': { href: '/risks', label: 'Risks' },
    '/risks/ai-systems/[systemId]': { href: '/risks/ai-systems', label: 'AI Systems' },
    '/risks/board': { href: '/risks', label: 'Risks' },
    '/risks/correlations': { href: '/risks', label: 'Risks' },
    '/risks/dashboard': { href: '/risks', label: 'Risks' },
    '/risks/hierarchy': { href: '/risks', label: 'Risks' },
    '/risks/information-registry': { href: '/risks', label: 'Risks' },
    '/risks/import': { href: '/risks', label: 'Risks' },
    '/risks/kri': { href: '/risks', label: 'Risks' },
    '/risks/loss-events': { href: '/risks', label: 'Risks' },
    '/risks/new': { href: '/risks', label: 'Risks' },
    '/risks/reports': { href: '/risks', label: 'Risks' },
    '/risks/scenarios': { href: '/risks', label: 'Risks' },

    // Security (self-service)
    '/security/mfa': { href: '/dashboard', label: 'Dashboard' },
    '/security-testing': { href: '/audits', label: 'Internal Audit' },
    '/vulnerabilities': { href: '/risks', label: 'Risk Register' },

    // Tasks
    '/tasks/[taskId]': { href: '/tasks', label: 'Tasks' },
    '/tasks/dashboard': { href: '/tasks', label: 'Tasks' },
    '/tasks/new': { href: '/tasks', label: 'Tasks' },

    // Tests
    '/tests/dashboard': { href: '/tests', label: 'Tests' },
    '/tests/due': { href: '/tests', label: 'Tests' },
    '/tests/plans/[planId]': { href: '/tests', label: 'Tests' },
    '/tests/runs/[runId]': { href: '/tests', label: 'Tests' },

    // Vendors
    '/vendors/[vendorId]': { href: '/vendors', label: 'Vendors' },
    '/vendors/dashboard': { href: '/vendors', label: 'Vendors' },
    '/vendors/new': { href: '/vendors', label: 'Vendors' },
};

/**
 * Resolve the canonical parent for a runtime pathname. Returns `null` for
 * a route that is not a known subpage (i.e. main pages and unknown routes).
 *
 * `tenantSlug` is used to expand `/t/[tenantSlug]` into the returned href.
 * Dynamic-segment values in the SUBPAGE's pattern (`[riskId]`,
 * `[vendorId]`, etc.) are inherited from the input pathname when the
 * parent references the SAME segment — so
 * `/t/acme/vendors/v1/assessment/a1` → `/t/acme/vendors/v1`, NOT
 * `/t/acme/vendors/[vendorId]`.
 */
export function resolveCanonicalParent(
    pathname: string,
    tenantSlug: string,
): CanonicalParent | null {
    const pattern = normalizePathname(pathname);
    if (!pattern) return null;
    const parent = PARENT_MAP[pattern];
    if (!parent) return null;

    const expandedHref = expandDynamicSegments(parent.href, pattern, pathname);
    return {
        href: `/t/${tenantSlug}${expandedHref}`,
        label: parent.label,
    };
}

/**
 * Substitute `[param]` placeholders in the parent's href with the concrete
 * values from the child's pathname. Only segments that appear in BOTH the
 * child pattern and the parent href are substituted.
 */
function expandDynamicSegments(
    parentHref: string,
    childPattern: string,
    childPathname: string,
): string {
    const childPath = childPathname.replace(/^\/t\/[^/]+/, '');
    const childPatSegs = childPattern.split('/').filter(Boolean);
    const childPathSegs = childPath.split('/').filter(Boolean);
    const dynamicValues = new Map<string, string>();
    for (let i = 0; i < childPatSegs.length; i++) {
        const seg = childPatSegs[i];
        if (seg.startsWith('[') && seg.endsWith(']') && childPathSegs[i]) {
            dynamicValues.set(seg, childPathSegs[i]);
        }
    }
    return parentHref
        .split('/')
        .map((seg) => dynamicValues.get(seg) ?? seg)
        .join('/');
}

export const CANONICAL_PARENT_MAP_INTERNAL = PARENT_MAP;
