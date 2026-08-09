/**
 * Roadmap-2 PR-8 — iconography unification (encrustation prevention).
 *
 * The codebase has two icon families: Nucleo (380+ files at
 * `src/components/ui/icons/nucleo/`, the canonical source) and
 * lucide-react (100 import sites today, residual). Visually they
 * are similar enough that no obvious mismatch ships, but every new
 * import that reaches for lucide is a future divergence — the
 * stroke weight, corner radius, and cap geometry differ subtly.
 *
 * Rather than migrating all 100 sites in a single risky PR, this
 * ratchet freezes the residue: the 100 files that import lucide
 * TODAY are allowlisted as the migration TODO list. New PRs that
 * add a `from 'lucide-react'` import outside the allowlist fail
 * CI — they MUST either migrate to Nucleo or extend the allowlist
 * with a written reason in the same diff.
 *
 * Future PRs shrink the allowlist as sites migrate. When the list
 * empties, lucide-react is removed from `package.json` in a
 * follow-up "the migration is complete" PR.
 *
 * What this ratchet detects
 *   Any `import { … } from 'lucide-react'` (single OR double quote)
 *   in `src/**` that is not in the curated `LEGACY_LUCIDE_USERS`
 *   set fails the test. The allowlist is the migration TODO —
 *   shrinking it is the goal.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src');

// Migration TODO — every file currently importing lucide-react.
// Captured at the PR-8 commit. Future migration PRs shrink this.
// Adding a NEW entry requires (a) a written rationale in the PR
// description and (b) confirmation that no Nucleo equivalent
// exists. Default answer: migrate to Nucleo.
const LEGACY_LUCIDE_USERS = new Set<string>([
    'src/app/org/[orgSlug]/(app)/OrgThreatLevelWidget.tsx',
    'src/app/org/[orgSlug]/(app)/OrgMaturityWidget.tsx',
    'src/app/org/[orgSlug]/(app)/OrgInitiativesWidget.tsx',
    'src/app/org/[orgSlug]/(app)/initiatives/[initiativeId]/InitiativeDetailClient.tsx',
    // NIS2 self-assessment surfaces — consistent with the sibling
    // onboarding family (OnboardingWizard) which uses lucide; Nucleo
    // migration tracked for the whole onboarding family.
    'src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/readiness/Nis2ReadinessClient.tsx',
    'src/components/onboarding/Nis2SelfAssessmentStep.tsx',
    'src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx',
    'src/app/org/[orgSlug]/(app)/controls/ControlsTable.tsx',
    'src/app/org/[orgSlug]/(app)/dashboard-sections.tsx',
    'src/app/org/[orgSlug]/(app)/evidence/EvidenceTable.tsx',
    'src/app/org/[orgSlug]/(app)/members/MembersTable.tsx',
    'src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx',
    'src/app/org/[orgSlug]/(app)/risks/RisksTable.tsx',
    'src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx',
    'src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx',
    'src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/billing/BillingActions.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/billing/BillingEventLog.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx',
    // P1 — per-connection outcome page; RefreshCw sync affordance mirrors the
    // parent integrations page (no plain Nucleo refresh/sync equivalent exists).
    'src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/security/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx',
    'src/app/t/[tenantSlug]/(app)/assets/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/tests/filter-defs.ts',
    // Automation Epic 1 — Rules-tab filter defs. `FilterDefInput.icon` is
    // typed `LucideIcon` (the entire filter system is lucide-based), so a
    // new filter-defs file has no Nucleo option until the filter platform
    // migrates. Same precedent as every other *filter-defs.ts entry here.
    'src/app/t/[tenantSlug]/(app)/processes/automation-filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/nis2-gap/respond/[assignmentId]/RespondClient.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/auth/mfa/page.tsx',
    'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx',
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/controls/filter-defs.ts',
    // AI-System Registry (EU AI Act) — filter defs. Same LucideIcon-typed
    // precedent as every other *filter-defs.ts entry here.
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/admin/personnel/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/admin/devices/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/admin/training/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx',
    'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/filter-defs.ts',
    // Security Testing (scanner findings) — filter defs. `FilterDefInput.icon`
    // is typed `LucideIcon`, so a new filter-defs file has no Nucleo option
    // until the filter platform migrates. Same precedent as every other
    // *filter-defs.ts entry here.
    'src/app/t/[tenantSlug]/(app)/security-testing/filter-defs.ts',
    // Business Continuity (BIA register) — filter defs. Same LucideIcon-typed
    // precedent as every other *filter-defs.ts entry here.
    'src/app/t/[tenantSlug]/(app)/audits/business-continuity/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx',
    // NIS2 Article 23 incidents — filter defs. `FilterDefInput.icon` is
    // typed `LucideIcon`, so a new filter-defs file has no Nucleo option
    // until the filter platform migrates. Same precedent as every other
    // *filter-defs.ts entry here.
    'src/app/t/[tenantSlug]/(app)/incidents/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/policies/filter-defs.ts',
    // Roadmap-2 PR-12 — moved a single `Download` icon import
    // from SoAClient to ReportsClient when lifting the SoA
    // export-buttons cluster up into the Reports header. Net
    // change: one new lucide consumer on the allowlist.
    'src/app/t/[tenantSlug]/(app)/reports/ReportsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/reports/soa/SoAClient.tsx',
    'src/app/t/[tenantSlug]/(app)/risks/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx',
    'src/app/t/[tenantSlug]/(app)/tasks/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/filter-defs.ts',
    // FilterDefInput.icon is typed `LucideIcon`; no Nucleo equivalent fits the
    // type contract — same precedent as every other *filter-defs.ts here.
    'src/app/t/[tenantSlug]/(app)/vulnerabilities/filter-defs.ts',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    'src/components/command-palette/command-palette.tsx',
    'src/components/command-palette/use-palette-commands.ts',
    'src/components/ForbiddenPage.tsx',
    'src/components/frameworks/FrameworkExplorer.tsx',
    'src/components/icons/iconMap.ts',
    'src/components/layout/OrgSidebarNav.tsx',
    'src/components/layout/SidebarNav.tsx',
    // Roadmap-14 (top-bar chrome) — the NavBar primitive + its
    // slot family (notifications bell, tenant switcher, user
    // menu) all import lucide icons directly. Same rationale as
    // nav-item.tsx — the top-bar's icon contract is `LucideIcon`,
    // and migrating the top-bar's icon family to Nucleo is a
    // bounded follow-up.
    'src/components/layout/nav-bar.tsx',
    'src/components/layout/notifications-bell.tsx',
    'src/components/layout/tenant-switcher.tsx',
    // PR-2 — `org-workspace-switcher.tsx` mirrors `tenant-switcher`
    // 1:1 for org-page context switching (Check + ChevronsUpDown
    // from lucide). Nucleo has `check` but no `chevrons-up-down`
    // equivalent today; both switchers share the same lucide
    // dependency until that icon lands and both migrate together.
    'src/components/layout/org-workspace-switcher.tsx',
    'src/components/layout/user-menu.tsx',
    // R12-PR1 — `nav-item.tsx` carries the `LucideIcon` type
    // import for the `icon` prop. The sidebar's icon contract
    // is `LucideIcon` (callers pass `LayoutDashboard` /
    // `Building2` / etc directly). Migrating the sidebar's icon
    // family to Nucleo is its own bounded effort — when that
    // lands, this entry removes itself in the same diff.
    'src/components/layout/nav-item.tsx',
    'src/components/onboarding/OnboardingBanner.tsx',
    'src/components/onboarding/OnboardingWizard.tsx',
    'src/components/org-switcher.tsx',
    'src/components/PdfExportButton.tsx',
    'src/components/theme/ThemeToggle.tsx',
    'src/components/ui/accordion.tsx',
    'src/components/ui/ActionCluster.tsx',
    'src/components/ui/ApprovalBanner.tsx',
    'src/components/ui/combobox/index.tsx',
    'src/components/ui/copy-button.tsx',
    'src/components/ui/copy-text.tsx',
    'src/components/ui/dashboard-widgets/types.ts',
    'src/components/ui/date-picker/calendar.tsx',
    'src/components/ui/date-picker/date-picker.tsx',
    'src/components/ui/date-picker/date-range-picker.tsx',
    'src/components/ui/date-picker/trigger.tsx',
    'src/components/ui/empty-state.tsx',
    'src/components/ui/error-state.tsx',
    'src/components/ui/FileDropzone.tsx',
    'src/components/ui/file-icon-resolver.ts',
    'src/components/ui/filter/filter-definitions.ts',
    'src/components/ui/filter/filter-examples.ts',
    'src/components/ui/filter/filter-list.tsx',
    'src/components/ui/filter/filter-range-panel.tsx',
    'src/components/ui/filter/filter-select.tsx',
    'src/components/ui/filter/types.ts',
    'src/components/ui/FrameworkBuilder.tsx',
    'src/components/ui/FreshnessBadge.tsx',
    'src/components/ui/GraphExplorer.tsx',
    // R25/R26 — Processes canvas chrome. The taxonomy module owns
    // the lucide imports (one stroke family for the seven kinds);
    // the palette + typed-node renderer consume icons via the
    // taxonomy meta and no longer carry direct lucide imports.
    // ProcessEdge keeps its lucide ShieldCheck for the
    // control-on-edge overlay (R25-PR-D). Same precedent as
    // GraphExplorer — xyflow-based canvas pages use diagramming-
    // specific icons not yet covered by Nucleo.
    'src/components/processes/ProcessEdge.tsx',
    'src/components/processes/node-taxonomy.ts',
    'src/components/ui/HeroMetric.tsx',
    'src/components/ui/icons/index.tsx',
    'src/components/ui/inline-notice.tsx',
    'src/components/ui/input.tsx',
    'src/components/ui/KpiCard.tsx',
    'src/components/ui/metric.tsx',
    'src/components/ui/modal.tsx',
    'src/components/ui/RichTextEditor.tsx',
    'src/components/risks/RiskMatrix.tsx',
    'src/components/ui/sheet.tsx',
    // R-filter-gear (2026-06-07): the shared gear-popover primitive + the
    // two thin wrappers carry the gear icons (Settings / Columns3 /
    // RotateCcw) — same gear-icon family as columns-dropdown below.
    'src/components/ui/checklist-gear-button.tsx',
    'src/components/ui/filter/edit-filters-button.tsx',
    'src/components/ui/table/columns-dropdown.tsx',
    'src/components/ui/table/edit-columns-button.tsx',
    'src/components/ui/tooltip.tsx',
    'src/components/ui/TreeExpandCollapseToggle.tsx',
    'src/components/ui/TreeViewItem.tsx',
    'src/components/ui/TruncationBanner.tsx',
    'src/components/ui/view-toggle.tsx',
    'src/components/UpgradeGate.tsx',
]);

const LUCIDE_IMPORT_RE = /import[^;]*?from\s+['"]lucide-react['"]/m;

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(ts|tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Iconography unification — no new lucide imports (Roadmap-2 PR-8)', () => {
    it('every lucide-react import sits inside the curated migration list', () => {
        const newOffenders: string[] = [];
        const allUsers: string[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (!LUCIDE_IMPORT_RE.test(content)) continue;
            const rel = path.relative(ROOT, file);
            allUsers.push(rel);
            if (!LEGACY_LUCIDE_USERS.has(rel)) {
                newOffenders.push(rel);
            }
        }
        if (newOffenders.length > 0) {
            throw new Error(
                `Found ${newOffenders.length} NEW lucide-react import site(s) outside the migration allowlist:\n  ${newOffenders.join('\n  ')}\n\nMigrate the icon to Nucleo (\`@/components/ui/icons/nucleo/...\`) — that is the canonical icon family. Adding to LEGACY_LUCIDE_USERS requires a written reason in the PR description AND confirmation that no Nucleo equivalent exists.`,
            );
        }
        expect(newOffenders).toEqual([]);
        // Sanity — the allowlist tracks reality. If this number
        // diverges sharply from the allowlist size, regenerate the
        // allowlist from the current state.
        expect(allUsers.length).toBeGreaterThan(0);
    });

    it('no allowlist entry is stale (every entry actually imports lucide)', () => {
        // Defensive — if a site migrates to Nucleo, it should be
        // REMOVED from the allowlist in the same diff. A stale
        // entry hides regressions: a NEW lucide import on a path
        // that already happens to be in the allowlist would pass
        // silently. Catch them.
        const stale: string[] = [];
        for (const rel of LEGACY_LUCIDE_USERS) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) {
                stale.push(`${rel} (file deleted)`);
                continue;
            }
            const content = fs.readFileSync(abs, 'utf-8');
            if (!LUCIDE_IMPORT_RE.test(content)) {
                stale.push(`${rel} (no lucide import)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `Stale entries in LEGACY_LUCIDE_USERS — remove them in the same diff that migrates the file:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });
});
