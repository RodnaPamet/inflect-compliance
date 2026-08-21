/**
 * Roadmap-7 PR-4 — FilterToolbar coverage ratchet.
 *
 * Heavy entity-level list pages — Risks, Vendors, Audits, Frameworks
 * (templates), Tasks, Evidence, Controls — wear `<FilterToolbar>` so
 * search, faceted filters, view-toggle, and primary action sit in
 * the same order, with the same spacing, on every page. New pages
 * mounting `<DataTable>` should reach for `<FilterToolbar>` before
 * inventing their own toolbar chrome.
 *
 * The ratchet enforces that any file mounting `<DataTable>` either
 * also mounts `<FilterToolbar>` OR appears in EXEMPTIONS with a
 * written reason describing why the page legitimately doesn't need
 * faceted filters. Today's exemption list captures the empirical
 * pattern after surveying production: cross-tenant read-only
 * aggregation tables, admin sub-pages with one fixed entity-type
 * and inline controls, wizards, dashboard composites, and detail-
 * tab sub-tables.
 *
 * The direction of travel: this list shrinks as pages organically
 * gain faceted filtering. New pages added to the codebase should
 * either mount FilterToolbar or land in this list with reasoning —
 * never bypass silently.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

const EXEMPT_DIR_NAMES = new Set<string>([
    "node_modules",
    "__tests__",
    "__mocks__",
]);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

/**
 * Files mounting `<DataTable>` without `<FilterToolbar>`. Each entry
 * documents the structural reason the page doesn't need (or doesn't
 * yet have) faceted filters. PRs that ADD a new entry must carry a
 * non-trivial reason in this map; the ratchet validates the reason
 * length to stop hand-waved exemptions.
 */
const EXEMPTIONS: Record<string, string> = {
    "src/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/VendorAssessmentReviewsQueueClient.tsx":
        "Cross-vendor review queue — an admin aggregation of submitted/reviewed/closed assessments across all vendors, ordered by review priority; inline status is the only facet and the set is bounded, so it uses sort + row click-through rather than the faceted FilterToolbar.",
    "src/app/org/[orgSlug]/(app)/initiatives/InitiativesClient.tsx":
        "Org-level portfolio programme list — cross-tenant initiative records with sort + row click-through, no per-tenant faceted filters at the portfolio tier.",
    "src/app/org/[orgSlug]/(app)/initiatives/[initiativeId]/InitiativeDetailClient.tsx":
        "Detail-page linked-work sub-table — not a filterable list surface; the parent detail owns the chrome.",
    "src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/readiness/Nis2ReadinessClient.tsx":
        "NIS2 readiness results view — derived score + prioritized gap tables (sorted by priority); not a faceted-filter list surface.",
    "src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx":
        "Detail-page Vulnerabilities sub-table (asset 360° view) — the CVE list for one asset; EntityDetailLayout owns the chrome, not a faceted-filter list surface.",
    "src/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient.tsx":
        "NIS2 gap-lifecycle surface — run-history + prioritized-gap sub-tables on a multi-section detail view (KPIs + trend + radar + propose-not-commit review); not a faceted-filter list.",
    "src/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/LeaverPassesClient.tsx":
        "Dry-run leaver-pass report — a master/detail pair (the passes a tenant has run, capped at 100 by the read, plus the selected pass's decisions). The whole point is reading every pass in the seven-day window, so a facet that hides one is a facet that hides evidence; the list is already bounded and ordered most-recent-first.",
    // ── Cross-tenant read-only aggregation views (org-level) ──
    // These render a portfolio of tenant-scoped data without the
    // per-tenant filtering surface that FilterToolbar provides.
    // Sort + cursor pagination is the entire interaction surface.
    "src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx":
        "Org-level cross-tenant audit log — chronological view with sort + load-more, no faceted filters appropriate at the portfolio aggregation tier.",
    "src/app/org/[orgSlug]/(app)/controls/ControlsTable.tsx":
        "Org-level non-performing controls digest — fixed scope (status != IMPLEMENTED) + sort, no per-tenant facets.",
    "src/app/org/[orgSlug]/(app)/evidence/EvidenceTable.tsx":
        "Org-level overdue-evidence digest — fixed scope (review past due) + sort, no per-tenant facets.",
    "src/app/org/[orgSlug]/(app)/members/MembersTable.tsx":
        "Org-level membership list — small aggregate with sort, faceted filtering not yet a need at this scale.",
    "src/app/org/[orgSlug]/(app)/risks/RisksTable.tsx":
        "Org-level critical-risk digest — fixed scope (severity >= HIGH) + sort.",
    "src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx":
        "Org-level tenant health roll-up — fixed scope, no faceted filtering at portfolio tier.",

    // ── Admin sub-pages with one fixed entity-type ──
    // Each surface owns a small fixed entity list with inline
    // controls (toggle / revoke / archive) baked into the page chrome.
    // FilterToolbar is overkill — the entity volume sits in the
    // dozens, not the thousands.
    // R13-PR10 — audit log moved out of the admin landing into
    // its own `/admin/audit-log` page; AdminClient.tsx was
    // deleted. The exemption follows the audit log to the new
    // sub-component.
    "src/app/t/[tenantSlug]/(app)/admin/audit-log/AuditLogClient.tsx":
        "Chronological audit log bound to one tenant — not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/admin/dsar-requests/DsarRegisterClient.tsx":
        "DSAR manual register — admin queue of rights requests (GDPR Art.15/17): small fixed-scope, status-driven list with inline transition controls, not a faceted-filter surface (same shape as the sibling admin sub-pages above).",
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx":
        "API keys admin — small fixed list (typical: <20) with inline create + revoke controls.",
    "src/app/t/[tenantSlug]/(app)/admin/billing/BillingEventLog.tsx":
        "Detail-tab sub-table inside the billing page — chronological event log with fixed scope.",
    "src/app/t/[tenantSlug]/(app)/admin/integrations/ConnectionHealthPanel.tsx":
        "GAP-3 freshness sub-panel inside the (exempt) integrations page — read-only per-connection health table, no faceting.",
    "src/app/t/[tenantSlug]/(app)/admin/rbac/MembersTable.tsx":
        "Members sub-table on the RBAC admin dashboard — fixed list of tenant memberships with no faceting (members admin owns the writes; RBAC is read-only matrix).",
    "src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx":
        "Detail-page roster sub-table — fixed scope (decisions in this campaign) with inline per-row decision controls; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx":
        "Detail-page documents sub-table (R11-PR7) — fixed scope (documents attached to this one vendor); not a faceted-filter surface.",
    // B4 (2026-06-07): the controls DETAIL page no longer has a DataTable —
    // the legacy 'Control tasks' sub-table was removed when the Tasks tab
    // was aligned to Asset/Risk (a single LinkedTasksPanel). It's no longer
    // a DataTable surface, so it drops out of this exemption list.
    "src/components/controls-shared/EvidenceSubTable.tsx":
        "Detail-page evidence sub-table (R10-PR3 follow-up) — fixed scope (evidence links + direct evidence for this one control) with per-row unlink action; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlMappingsTab.tsx":
        "Detail-page mappings sub-table (R10-PR3 follow-up) — fixed scope (framework mappings for this one control) with per-row unmap action; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlChecksTab.tsx":
        "Detail-page automated-checks history sub-table (PR-1) — fixed scope (IntegrationExecution rows for this one control); not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx":
        "Detail-page links sub-table (R11-PR8) — fixed scope (cross-links from this one task); not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx":
        "Integrations admin — small fixed catalogue with inline toggle controls.",
    "src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/page.tsx":
        "Integrations admin sub-page — one connection's check-run history with an inline Sync-now control; not a faceted surface.",
    "src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page.tsx":
        "Integrations admin sub-page — synced-identity roster (bounded per-tenant); no faceting needed.",
    "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx":
        "Members admin — single tenant's roster with inline role + invite controls; faceting belongs to the org-level view.",
    "src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx":
        "Notifications admin — small fixed channel list with inline rule controls.",
    "src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx":
        "Custom roles admin — small fixed list with inline create + permission controls.",

    // ── Section dashboards / composite pages ──
    // Pages composed of multiple cards + sub-tables, where the page
    // body is itself the navigation/filter surface. FilterToolbar
    // would compete with the page's existing composition.
    "src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx":
        "Multi-section dashboard — review cycle list lives inside a tabbed dashboard composition with per-tab filtering.",
    "src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx":
        "Multi-section coverage dashboard — already in the Epic 52 EXEMPTIONS list for ListPageShell; same shape applies here.",
    "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx":
        "Findings list — currently uses inline filter controls; planned for FilterToolbar migration in a follow-up.",
    "src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx":
        "Framework picker — small fixed catalogue of installable frameworks; tile + status surface, not a filter-driven list.",
    // ── Wizards / multi-step flows ──
    "src/app/t/[tenantSlug]/(app)/risks/import/page.tsx":
        "Risk import wizard — staged workflow, each step has its own controls; not an ongoing browse surface.",
    "src/app/t/[tenantSlug]/(app)/assets/import/page.tsx":
        "Asset import wizard — staged workflow, each step has its own controls; not an ongoing browse surface.",

    // ── Templates / sub-resource lists ──
    "src/app/t/[tenantSlug]/(app)/controls/templates/page.tsx":
        "Control template catalogue — small fixed catalogue browsed by section; faceting not yet a need.",

    // ── Tests / planning surfaces ──
    // tests/page.tsx now carries a real FilterToolbar (Status / Last
    // Result / Frequency / Due + search), so it is no longer exempt.
};

function isExempt(rel: string): boolean {
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) return true;
    if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) return true;
    return false;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (isExempt(rel)) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
}

interface Violation {
    file: string;
}

describe("FilterToolbar coverage", () => {
    it("every file mounting <DataTable> either mounts <FilterToolbar> or is in EXEMPTIONS", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (!/<DataTable\b/.test(content)) continue;
            if (/FilterToolbar/.test(content)) continue;
            const rel = path.relative(ROOT, file);
            if (rel in EXEMPTIONS) continue;
            violations.push({ file: rel });
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map((v) => `  ${v.file}`)
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) mounting <DataTable> without <FilterToolbar>. Either wire the page through <FilterToolbar> + <FilterProvider> for a consistent toolbar shape, OR add the file to EXEMPTIONS with a written structural reason (cross-tenant aggregation, admin sub-page with inline controls, dashboard composite, wizard, sub-table — see existing entries for the vocabulary).\n\nFirst ${Math.min(15, violations.length)} offender(s):\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("EXEMPTIONS entries point at real files", () => {
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const full = path.join(ROOT, exemptPath);
            if (!fs.existsSync(full)) {
                throw new Error(
                    `EXEMPTIONS contains a path that no longer exists: ${exemptPath}. Drop the entry — the ratchet only enforces real files.`,
                );
            }
            // The file must still mount DataTable, otherwise the
            // exemption is stale (the file was refactored, etc.).
            const content = fs.readFileSync(full, "utf8");
            expect(content).toMatch(/<DataTable\b/);
        }
    });

    it("EXEMPTIONS entries each have a non-trivial reason", () => {
        for (const [, reason] of Object.entries(EXEMPTIONS)) {
            // 40+ chars rules out hand-waves; force a real
            // sentence about the structural shape.
            expect(reason.length).toBeGreaterThan(40);
        }
    });
});
