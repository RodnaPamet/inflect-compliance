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
 * "Back to Vendor"). Each entry stores a MESSAGE KEY under the `common`
 * namespace, never a label: `<BackAffordance>` resolves it with next-intl at
 * render. They used to be English literals dropped into the translated
 * "Back to {label}", so a Bulgarian page read "Обратно към Agents". The key
 * type is the closed `BackLabelKey` union, and
 * `tests/unit/canonical-parent-labels-translated.test.ts` fails if a key has
 * no message in either catalogue.
 */
import { normalizePathname } from './page-segregation';

/**
 * Every message key (relative to `common`) a canonical parent may name. Section
 * names reuse `common.sections.*`, which the referrer-derived label reads too,
 * so "Back to Risks" says the same thing whichever tier produced it.
 */
export const BACK_LABEL_KEYS = [
    'sections.accessReviews',
    'sections.admin',
    'sections.agents',
    'sections.assets',
    'sections.audits',
    'sections.controls',
    'sections.dashboard',
    'sections.frameworks',
    'sections.incidents',
    'sections.issues',
    'sections.policies',
    'sections.processes',
    'sections.reports',
    'sections.risks',
    'sections.tasks',
    'sections.tests',
    'sections.vendors',
    'parentLabels.a2aPeers',
    'parentLabels.agent',
    'parentLabels.agentRuns',
    'parentLabels.aiSystems',
    'parentLabels.auditCycle',
    'parentLabels.auditCycles',
    'parentLabels.businessContinuity',
    'parentLabels.externalTools',
    'parentLabels.framework',
    'parentLabels.integrations',
    'parentLabels.nis2',
    'parentLabels.nis2Gap',
    'parentLabels.riskRegister',
    'parentLabels.soa',
    'parentLabels.vendorTemplates',
] as const;

export type BackLabelKey = (typeof BACK_LABEL_KEYS)[number];

/**
 * Map of in-tenant section paths to their `common.sections.*` message
 * key. `<BackAffordance>` resolves each through next-intl so the
 * referrer-based affordance shows the localised product name (e.g.
 * `/audits` → "Internal Audit" / "Вътрешен одит", not the raw
 * "Audits"). A section missing here reads "previous page", never its raw
 * URL segment.
 */
export const SECTION_LABEL_KEYS: Readonly<Record<string, string>> = {
    '/access-reviews': 'accessReviews',
    '/admin': 'admin',
    '/agents': 'agents',
    '/assets': 'assets',
    '/audits': 'audits',
    '/calendar': 'calendar',
    '/clauses': 'clauses',
    '/controls': 'controls',
    '/coverage': 'coverage',
    '/dashboard': 'dashboard',
    '/evidence': 'evidence',
    '/findings': 'findings',
    '/framework-updates': 'frameworkUpdates',
    '/frameworks': 'frameworks',
    '/incidents': 'incidents',
    '/issues': 'issues',
    '/notifications': 'notifications',
    '/policies': 'policies',
    '/processes': 'processes',
    '/reports': 'reports',
    '/risks': 'risks',
    '/security-testing': 'securityTesting',
    '/tasks': 'tasks',
    '/tests': 'tests',
    '/vendors': 'vendors',
    '/vulnerabilities': 'vulnerabilities',
};

export interface CanonicalParent {
    /** Pattern relative to `/t/[tenantSlug]` — joined at render time. */
    href: string;
    /**
     * Message key, under `common`, for the trailing portion of the affordance
     * label: "Back to <label>".
     */
    labelKey: BackLabelKey;
}

const PARENT_MAP: Record<string, CanonicalParent> = {
    '/frameworks/[frameworkKey]/readiness': { href: '/frameworks/[frameworkKey]', labelKey: 'parentLabels.nis2' },
    '/frameworks/[frameworkKey]/self-assessment': { href: '/frameworks/[frameworkKey]', labelKey: 'parentLabels.nis2' },
    // Access reviews. The LIST hangs off `/tests` (#3252): that in-page button is
    // the only link to it anywhere in the UI, and it has not been a sidebar
    // destination since #1538. The label is what a user sees on the back link, so
    // it names where they came FROM rather than what they are looking at.
    '/access-reviews': { href: '/tests', labelKey: 'sections.tests' },
    '/access-reviews/[reviewId]': { href: '/access-reviews', labelKey: 'sections.accessReviews' },

    // Agent — all five hang off the /agents register (AGENTIC UI 1/4).
    //
    // They used to hang off the /admin/mcp hub, which was the only way in;
    // "MCP" was also the label a user saw on the back link, an acronym naming
    // a wire protocol rather than the thing they came from. The register is
    // the structural parent of every one of them: it is the surface that
    // decides which agents may act, and each of these is a view OF those
    // agents' behaviour.
    // Both added when RQ4-1 stopped accepting a wildcard match and surfaced
    // them as unlisted. A SUBPAGE owes a canonical parent, and both are
    // reached from the register exactly as their siblings are.
    '/agents/decisions': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/external-tools': { href: '/agents', labelKey: 'sections.agents' },
    // #3124 — the parent is the page the inbound link LIVES on, exactly as for
    // the external-write ladder below. An operator reaches saved parameters from
    // the tool catalogue for a specific connection, so that is where Back
    // belongs.
    '/agents/parameter-sets': { href: '/agents/external-tools', labelKey: 'parentLabels.externalTools' },
    '/agents/compose': { href: '/agents', labelKey: 'sections.agents' },
    // #3679 — the peers list hangs off the register like its siblings; one
    // peer's Back goes to the list it was opened from.
    '/agents/peers': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/peers/[peerId]': { href: '/agents/peers', labelKey: 'parentLabels.a2aPeers' },
    // #3807 — the owner-orphan pass hangs off the register like its siblings.
    '/agents/owner-orphan-pass': { href: '/agents', labelKey: 'sections.agents' },
    // #3807 — the pilot auditor's set-up hangs off the register too.
    '/agents/audit-pilot': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/proposals': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/reports': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/runs': { href: '/agents', labelKey: 'sections.agents' },
    // Back from ONE run goes to the run list, not to the register — the
    // list is where the reader came from and what they are working through.
    '/agents/runs/[runId]': { href: '/agents/runs', labelKey: 'parentLabels.agentRuns' },
    '/agents/receipts': { href: '/agents', labelKey: 'sections.agents' },
    '/agents/quarantine': { href: '/agents', labelKey: 'sections.agents' },
    // The ASI09 review-quality report: a view of those agents' review queue,
    // so back goes to them.
    '/agents/review-quality': { href: '/agents', labelKey: 'sections.agents' },
    // An operator who opened one agent is one step from the list of all of
    // them.
    '/agents/[agentId]': { href: '/agents', labelKey: 'sections.agents' },

    // The seven redirect shims keep entries so `resolveCanonicalParent` can
    // answer for a path a stale in-tab referrer still names. They point at the
    // NEW locations — a shim's parent is the surface its target belongs to,
    // not the surface it used to sit under.
    '/agent-proposals': { href: '/agents', labelKey: 'sections.agents' },
    '/agent-runs': { href: '/agents', labelKey: 'sections.agents' },
    '/admin/mcp/agent-receipts': { href: '/agents', labelKey: 'sections.agents' },
    '/admin/mcp/quarantine': { href: '/agents', labelKey: 'sections.agents' },
    // The Step 4b queue's parent is the integrations list rather than the
    // connection it belongs to: these entries are STATIC route forms, and the
    // connection's own href needs the id this map cannot see. The breadcrumb
    // trail on the page carries the connection link, so the specific parent is
    // not lost — it is just not expressible here.
    '/admin/integrations/[connectionId]/reconciliation': {
        href: '/admin/integrations',
        labelKey: 'parentLabels.integrations',
    },
    '/admin/agents': { href: '/agents', labelKey: 'sections.agents' },
    '/admin/agents/[agentId]': { href: '/agents', labelKey: 'sections.agents' },
    '/admin/agents/review-quality': { href: '/agents', labelKey: 'sections.agents' },

    // Admin subpages
    '/admin/api-keys': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/audit-log': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/billing': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/devices': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/dsar-requests': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/entra': { href: '/admin', labelKey: 'sections.admin' },
    // Reached from the Integrations hub, where the identity connectors these
    // passes act on are configured — same structural parent as the synced
    // identity roster.
    '/admin/identity-joiner-passes': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/identity-leaver-passes': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/identity-write-journal': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    // #2861 — the parent is the page the inbound link LIVES on, not
    // /admin/integrations. An operator reaches this from the external-tools
    // surface for a specific connection, so that is where Back belongs; the
    // breadcrumb names the same target, so the two cannot disagree.
    '/admin/external-write-policy/[connectionId]': { href: '/agents/external-tools', labelKey: 'parentLabels.externalTools' },
    '/admin/identity-write-policy': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/ai-features': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/modules': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/integrations': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/integrations/sharepoint-health': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/integrations/[connectionId]': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/integrations/identity-accounts': { href: '/admin/integrations', labelKey: 'parentLabels.integrations' },
    '/admin/mcp': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/members': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/notifications': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/personnel': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/privacy': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/rbac': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/risk-appetite': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/risk-matrix': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/roles': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/sandbox-runtime': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/scim': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/security': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/sso': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/training': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/trust-center': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/vendor-assessment-reviews': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/vendor-assessment-reviews/[assessmentId]': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/vendor-templates': { href: '/admin', labelKey: 'sections.admin' },
    '/admin/vendor-templates/[templateId]': { href: '/admin/vendor-templates', labelKey: 'parentLabels.vendorTemplates' },

    // Assets
    '/assets/[id]': { href: '/assets', labelKey: 'sections.assets' },
    '/assets/import': { href: '/assets', labelKey: 'sections.assets' },
    '/assets/new': { href: '/assets', labelKey: 'sections.assets' },

    // Audits
    '/audits/auditors': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/business-continuity': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/business-continuity/[id]': { href: '/audits/business-continuity', labelKey: 'parentLabels.businessContinuity' },
    '/audits/cycles': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/cycles/[cycleId]': { href: '/audits/cycles', labelKey: 'parentLabels.auditCycles' },
    '/audits/cycles/[cycleId]/readiness': {
        href: '/audits/cycles/[cycleId]',
        labelKey: 'parentLabels.auditCycle',
    },
    '/audits/nis2-gap': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/nis2-gap/respond/[assignmentId]': { href: '/audits/nis2-gap', labelKey: 'parentLabels.nis2Gap' },
    '/audits/new': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/packs/[packId]': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/readiness': { href: '/audits', labelKey: 'sections.audits' },
    '/audits/workpaper-reviews': { href: '/audits', labelKey: 'sections.audits' },

    // Auth
    '/auth/mfa': { href: '/dashboard', labelKey: 'sections.dashboard' },

    // Controls
    '/controls/[controlId]': { href: '/controls', labelKey: 'sections.controls' },
    // Incidents (NIS2 Article 23) — subpage of Internal Audit
    '/incidents': { href: '/audits', labelKey: 'sections.audits' },
    '/incidents/[incidentId]': { href: '/incidents', labelKey: 'sections.incidents' },
    // Test-plan detail lives URL-wise under a control, but the user's
    // mental model is "I'm working on a test"; the canonical parent is
    // the Tests list. The in-tab referrer still wins — drilling in from
    // a control detail shows "Back to Control" via the smart referrer.
    '/controls/[controlId]/tests/[planId]': {
        href: '/tests',
        labelKey: 'sections.tests',
    },
    '/controls/dashboard': { href: '/controls', labelKey: 'sections.controls' },
    '/controls/new': { href: '/controls', labelKey: 'sections.controls' },
    '/controls/sankey': { href: '/controls', labelKey: 'sections.controls' },
    '/controls/templates': { href: '/controls', labelKey: 'sections.controls' },

    // Frameworks — a subpage of Internal Audit (frameworks are the
    // standards an audit is conducted against; not a top-level section).
    '/frameworks': { href: '/audits', labelKey: 'sections.audits' },
    '/frameworks/[frameworkKey]': { href: '/frameworks', labelKey: 'sections.frameworks' },
    '/frameworks/[frameworkKey]/diff': {
        href: '/frameworks/[frameworkKey]',
        labelKey: 'parentLabels.framework',
    },
    '/frameworks/[frameworkKey]/install': {
        href: '/frameworks/[frameworkKey]',
        labelKey: 'parentLabels.framework',
    },
    '/frameworks/[frameworkKey]/templates': {
        href: '/frameworks/[frameworkKey]',
        labelKey: 'parentLabels.framework',
    },

    // Issues
    '/issues/[issueId]': { href: '/issues', labelKey: 'sections.issues' },
    '/issues/dashboard': { href: '/issues', labelKey: 'sections.issues' },
    '/issues/new': { href: '/issues', labelKey: 'sections.issues' },

    // Onboarding
    '/onboarding': { href: '/dashboard', labelKey: 'sections.dashboard' },

    // Policies
    '/policies/[policyId]': { href: '/policies', labelKey: 'sections.policies' },
    '/policies/new': { href: '/policies', labelKey: 'sections.policies' },
    '/policies/templates': { href: '/policies', labelKey: 'sections.policies' },

    // Processes
    '/processes/governance': { href: '/processes', labelKey: 'sections.processes' },
    '/processes/agents/[agentId]': { href: '/agents', labelKey: 'sections.agents' },
    // The flow editor's parent is the agent itself, as its breadcrumbs say.
    '/processes/agents/[agentId]/flow': { href: '/agents/[agentId]', labelKey: 'parentLabels.agent' },

    // Reports
    '/reports/soa': { href: '/reports', labelKey: 'sections.reports' },
    '/reports/soa/print': { href: '/reports/soa', labelKey: 'parentLabels.soa' },

    // Risks
    '/risks/[riskId]': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/ai': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/ai-systems': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/ai-systems/[systemId]': { href: '/risks/ai-systems', labelKey: 'parentLabels.aiSystems' },
    '/risks/board': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/correlations': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/dashboard': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/hierarchy': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/information-registry': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/import': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/kri': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/loss-events': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/new': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/reports': { href: '/risks', labelKey: 'sections.risks' },
    '/risks/scenarios': { href: '/risks', labelKey: 'sections.risks' },

    // Security (self-service)
    '/security/mfa': { href: '/dashboard', labelKey: 'sections.dashboard' },
    '/security-testing': { href: '/audits', labelKey: 'sections.audits' },
    '/vulnerabilities': { href: '/risks', labelKey: 'parentLabels.riskRegister' },

    // Tasks
    '/tasks/[taskId]': { href: '/tasks', labelKey: 'sections.tasks' },
    '/tasks/dashboard': { href: '/tasks', labelKey: 'sections.tasks' },
    '/tasks/new': { href: '/tasks', labelKey: 'sections.tasks' },

    // Tests
    '/tests/dashboard': { href: '/tests', labelKey: 'sections.tests' },
    '/tests/due': { href: '/tests', labelKey: 'sections.tests' },
    '/tests/plans/[planId]': { href: '/tests', labelKey: 'sections.tests' },
    '/tests/runs/[runId]': { href: '/tests', labelKey: 'sections.tests' },

    // Vendors
    '/vendors/[vendorId]': { href: '/vendors', labelKey: 'sections.vendors' },
    '/vendors/dashboard': { href: '/vendors', labelKey: 'sections.vendors' },
    '/vendors/new': { href: '/vendors', labelKey: 'sections.vendors' },
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
/**
 * PARENT_MAP is acyclic today — 112 chains walked, 0 loops of any length,
 * 0 self-edges (measured 2026-09-18). The hop cap keeps this function total
 * if a loop is ever introduced, rather than hanging.
 */
const MAX_PARENT_HOPS = 8;

/**
 * True when `referrer` sits BELOW `pathname` in the IA, so following it would
 * make "back" descend.
 *
 * WHY THIS EXISTS. `BackAffordance` prefers the referrer — the page you came
 * from — over the declared parent. Two guards already reject a referrer that
 * is the current page, or a SIBLING of it. Neither rejects a CHILD, so
 * clicking into a sub-page and pressing back returned you to the sub-page:
 *
 *   on /frameworks/K/install : referrer /frameworks/K          -> ascends, fine
 *   on /frameworks/K         : referrer /frameworks/K/install  -> DESCENDS
 *
 * and because the back click itself writes the referrer (NavigationTracker
 * stores the OUTGOING path), the two pages then bounce off each other.
 *
 * TWO CLAUSES, BOTH LOAD-BEARING — measured over every (page, referrer) pair:
 *   1. URL containment. Catches 23 of the 25 non-sibling pairs.
 *   2. IA containment — walk canonical parents up from the referrer looking
 *      for the current page. Catches the 2 that descend through a cross-link
 *      whose parent is NOT a URL prefix (/admin/identity-* -> /admin/integrations).
 * Dropping clause 2 leaves 9 pairs oscillating; dropping clause 1 leaves the
 * /controls/[controlId] <-> /controls/[controlId]/tests/[planId] pair, which
 * cross-links to /tests so the IA walk never reaches the control.
 */
export function referrerIsDescendant(
    referrer: string,
    pathname: string,
    tenantSlug: string,
): boolean {
    if (referrer === pathname) return false;
    // 1 — URL containment. The trailing slash stops /frameworks/nis2-extended
    // from counting as a child of /frameworks/nis2.
    if (referrer.startsWith(`${pathname}/`)) return true;
    // 2 — IA containment.
    let cursor = referrer;
    for (let hops = 0; hops < MAX_PARENT_HOPS; hops++) {
        const parent = resolveCanonicalParent(cursor, tenantSlug);
        if (!parent) return false;
        if (parent.href === pathname) return true;
        if (parent.href === cursor) return false;
        cursor = parent.href;
    }
    return false;
}

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
        labelKey: parent.labelKey,
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
