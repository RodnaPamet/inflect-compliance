/**
 * Roadmap-10 PR-8 — column-visibility gear coverage ratchet.
 *
 * The gear is the user's lever for tailoring a dense list to the
 * columns they actually care about. After R10-PR6 introduced
 * `useColumnsDropdown` and R10-PR7 mounted it on the four pages
 * that lacked it, every entity list page in the product carries
 * the gear. This ratchet locks the coverage so a new entity list
 * page can't ship without one (or without an explicit exemption).
 *
 * Same EXEMPTIONS shape as the sibling ratchets
 * (`filter-toolbar-coverage`, `list-page-shell-coverage`,
 * `no-raw-tables-in-app-pages`). Three legitimate exemption shapes:
 *
 *   (a) Sub-component embedded inside a parent page — the parent
 *       owns the toolbar surface; the sub-component is the table
 *       only (e.g. `MembersTable.tsx` inside `admin/rbac/page.tsx`).
 *   (b) Multi-table dashboard — multiple stacked DataTables; a
 *       per-table gear would be more chrome than the data deserves
 *       (e.g. `admin/members`, `admin/api-keys`).
 *   (c) Findings / pages still without a toolbar — designing the
 *       toolbar is its own change; the gear lands when the toolbar
 *       does.
 *
 * The direction of travel: this list shrinks. New entity list pages
 * should reach for `useColumnsDropdown` from `@/components/ui/table`
 * and mount its `dropdown` into the toolbar's `actions` slot.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/app/t/[tenantSlug]/(app)';

/**
 * Files mounting `<DataTable>` without `<ColumnsDropdown>` /
 * `useColumnsDropdown`. Each entry carries a category prefix and a
 * one-line reason. PRs that add a new entry must justify the
 * absence of a gear; PRs that mount a gear should REMOVE the entry.
 */
const EXEMPTIONS: Record<string, string> = {
    'admin/vendor-assessment-reviews/VendorAssessmentReviewsQueueClient.tsx':
        '(b) results view — cross-vendor review queue with a fixed derived column set (vendor, status, score, risk, submitted); per-column hide/show not meaningful.',
    'security-testing/SecurityTestingClient.tsx':
        '(b) multi-table — the primary findings table is an EntityListPage; the secondary scan-history (ScannerRun) table is a read-only fixed-column log (outcome, source, repo, ran, via, findings); per-column hide/show not meaningful.',
    'audits/nis2-gap/Nis2GapLifecycleClient.tsx':
        '(b) results view — run-history + prioritized-gap sub-tables with fixed derived columns; per-column hide/show not meaningful.',
    'frameworks/[frameworkKey]/readiness/Nis2ReadinessClient.tsx':
        '(b) results view — fixed derived columns (domain breakdown + prioritized gaps); per-column hide/show not meaningful.',
    // ─── (a) Sub-components — parent owns the toolbar ──────────────
    // R13-PR10 — `admin/AdminClient.tsx` was deleted; audit log
    // moved to `admin/audit-log/AuditLogClient.tsx`. The new sub-
    // component is still a chronological log (no per-column
    // hide/show needed), so the exemption follows the move.
    'admin/audit-log/AuditLogClient.tsx':
        '(a) sub-component — chronological audit log; parent page owns chrome.',
    'admin/dsar-requests/DsarRegisterClient.tsx':
        '(c) admin register still without a toolbar — small rights-request queue (GDPR Art.15/17); the gear lands when a toolbar does.',
    'admin/billing/BillingEventLog.tsx':
        '(a) sub-component — billing-page event log; parent decides chrome.',
    'admin/integrations/ConnectionHealthPanel.tsx':
        '(a) sub-component — GAP-3 freshness panel inside the integrations page; parent owns chrome.',
    'admin/rbac/MembersTable.tsx':
        '(a) sub-component — RBAC members sub-table; parent dashboard owns chrome.',
    'access-reviews/[reviewId]/AccessReviewDetailClient.tsx':
        '(a) sub-component — detail-page roster sub-table; EntityDetailLayout owns chrome.',
    'vendors/[vendorId]/page.tsx':
        '(a) sub-component — vendor-detail documents sub-table (R11-PR7); EntityDetailLayout owns chrome.',
    'controls/[controlId]/page.tsx':
        '(a) sub-component — control-detail tasks sub-table (R11-PR6); EntityDetailLayout owns chrome.',
    'assets/[id]/page.tsx':
        '(a) sub-component — asset-detail Vulnerabilities sub-table (360° view); EntityDetailLayout owns chrome.',
    'controls/[controlId]/_tabs/ControlMappingsTab.tsx':
        '(a) sub-component — control-detail mappings sub-table (R10-PR3 follow-up); EntityDetailLayout owns chrome.',
    'controls/[controlId]/_tabs/ControlChecksTab.tsx':
        '(a) sub-component — control-detail automated-checks history sub-table (PR-1); EntityDetailLayout owns chrome.',
    'tasks/[taskId]/page.tsx':
        '(a) sub-component — task-detail links sub-table (R11-PR8); EntityDetailLayout owns chrome.',

    // ─── (b) Multi-table / multi-section pages ─────────────────────
    'admin/api-keys/page.tsx':
        '(b) multi-table page — active + revoked stacked tables; a per-table gear would noise the chrome.',
    'admin/members/page.tsx':
        '(b) multi-table page — members + pending invites stacked; per-table gear unnecessary at this scale.',
    'admin/notifications/page.tsx':
        '(b) tabbed admin settings page — small fixed table + a form tab; column visibility isn\'t the user need.',
    'admin/integrations/page.tsx':
        '(b) multi-section admin page — small fixed catalogue with inline controls.',
    'admin/integrations/[connectionId]/page.tsx':
        '(b) admin sub-page — one connection’s check-run history; fixed columns, no need for a column gear.',
    'admin/integrations/identity-accounts/page.tsx':
        '(b) admin sub-page — synced-identity roster; fixed columns, no need for a column gear.',
    'admin/roles/page.tsx':
        '(b) custom roles admin — small fixed list with inline create + permission controls.',
    'coverage/CoverageClient.tsx':
        '(b) multi-card coverage dashboard — KPIs + two gap tables; per-table gear would compete with the page composition.',
    'access-reviews/AccessReviewsClient.tsx':
        '(b) multi-section dashboard — review cycle list inside a tabbed composition.',
    'reports/ReportsClient.tsx':
        '(b) reports landing — composite of discrete report tiles, not a single entity list.',
    'controls/templates/page.tsx':
        '(b) control-template catalogue — small fixed catalogue browsed by section.',
    'risks/import/page.tsx':
        '(b) risk import wizard — staged workflow, each step has its own controls.',
    'assets/import/page.tsx':
        '(b) asset import wizard — staged workflow, each step has its own controls.',

    // ─── (c) Toolbar pending ────────────────────────────────────────
    // (none today — Findings got the gear in R10-PR11 mounted
    // standalone above the table, like Frameworks.)
};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

// Match the two gear-mount idioms: the new useColumnsDropdown hook
// AND the legacy direct ColumnsDropdown component mount (some
// callers wire the dropdown manually for one-off layouts).
const GEAR_USE_RE = /\buseColumnsDropdown\b/;
const GEAR_COMPONENT_RE = /<ColumnsDropdown\b/;

describe('columns-dropdown gear coverage (R10-PR8)', () => {
    const APP_ROOT = path.resolve(ROOT, SCAN_DIR);

    test('every file mounting <DataTable> mounts the gear or is in EXEMPTIONS', () => {
        const violators: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (!/<DataTable\b/.test(content)) continue;
            if (GEAR_USE_RE.test(content)) continue;
            if (GEAR_COMPONENT_RE.test(content)) continue;
            const rel = path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/');
            if (EXEMPTIONS[rel]) continue;
            violators.push(rel);
        }
        if (violators.length > 0) {
            throw new Error(
                `${violators.length} app page(s) mount <DataTable> without a column-visibility gear:\n  ` +
                    violators.join('\n  ') +
                    '\n\nFix options:\n' +
                    '  • Import `useColumnsDropdown` from `@/components/ui/table`, declare a\n' +
                    '    column list, and mount the returned `dropdown` into your FilterToolbar\n' +
                    '    `actions` slot (see R10-PR7 for the canonical pattern).\n' +
                    '  • OR add the file path to EXEMPTIONS in this test with a category\n' +
                    '    prefix ((a) sub-component, (b) multi-table, (c) toolbar pending)\n' +
                    '    and a one-line reason.\n',
            );
        }
    });

    test('no exempt entry has a stale path (file moved / deleted / migrated)', () => {
        const stale: string[] = [];
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const abs = path.join(APP_ROOT, exemptPath);
            if (!fs.existsSync(abs)) {
                stale.push(`${exemptPath} (file missing)`);
                continue;
            }
            const content = fs.readFileSync(abs, 'utf-8');
            if (
                /<DataTable\b/.test(content) &&
                (GEAR_USE_RE.test(content) || GEAR_COMPONENT_RE.test(content))
            ) {
                stale.push(
                    `${exemptPath} (gear has been mounted — remove from EXEMPTIONS)`,
                );
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `EXEMPTIONS contains ${stale.length} stale entry/entries:\n  ` +
                    stale.join('\n  ') +
                    '\n\nRemove these entries from the EXEMPTIONS object.',
            );
        }
    });

    test('EXEMPTIONS entries are uniquely-prefixed by category', () => {
        for (const [file, reason] of Object.entries(EXEMPTIONS)) {
            expect(reason).toMatch(/^\((a|b|c)\)\s+\S/);
            expect(file).not.toMatch(/^\//);
        }
    });
});

// R-filter-gear (2026-06-07) — the two toolbar gears (Edit filter cards +
// Toggle columns) are differentiated by icon (Settings vs Columns3) but
// share ONE primitive: <ChecklistGearButton>. This locks that delegation
// so a future PR can't fork the checklist UI back into two copies.
describe('R-filter-gear — both gears mount the shared ChecklistGearButton', () => {
    const read = (rel: string) =>
        fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it('columns gear delegates to ChecklistGearButton (Columns3, toggle-columns-button)', () => {
        const src = read('src/components/ui/table/columns-dropdown.tsx');
        expect(src).toMatch(/ChecklistGearButton/);
        expect(src).toMatch(/\bColumns3\b/);
        expect(src).toMatch(/data-testid="toggle-columns-button"/);
        // i18n: title now flows through the catalog. Assert the wiring +
        // that the key still resolves to the canonical English label.
        expect(src).toMatch(/title=\{t\("table\.toggleColumns"\)\}/);
        const en = JSON.parse(read('messages/en.json'));
        expect(en.common.table.toggleColumns).toBe('Toggle columns');
    });

    it('filter gear delegates to ChecklistGearButton (Settings, edit-filters-button)', () => {
        const src = read('src/components/ui/filter/edit-filters-button.tsx');
        expect(src).toMatch(/ChecklistGearButton/);
        expect(src).toMatch(/\bSettings\b/);
        expect(src).toMatch(/data-testid="edit-filters-button"/);
        // i18n: the title flows through the catalogue, mirroring the columns
        // gear asserted just above. The literal it used to pin was also the
        // WRONG NAME — the gear edits the KPI strip, not the Filter dropdown's
        // categories, on all eight list pages.
        expect(src).toMatch(/title=\{t\('table\.editKpiCards'\)\}/);
        const enCat = JSON.parse(read('messages/en.json'));
        expect(enCat.common.table.editKpiCards).toBe('Edit KPI cards');
    });
});
