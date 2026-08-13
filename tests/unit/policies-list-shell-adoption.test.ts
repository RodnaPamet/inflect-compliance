/**
 * Structural ratchet — Epic 45.1 policy list migration.
 *
 * Locks the policy list page to:
 *   1. The unified <EntityListPage> shell (Epic 91).
 *   2. The new column set (status / owner / version / next review).
 *   3. The corrected `POLICY_STATUS_LABELS` (filter-defs aligned to
 *      the prisma `PolicyStatus` enum — pre-Epic-45 the filter map
 *      listed `RETIRED` but the schema enum is `ARCHIVED`, so
 *      filtering by "Retired" matched zero rows).
 *
 * Mirrors the controls / risks shell-adoption ratchets — one
 * canonical pattern, one place to update when the contract changes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const POLICIES_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
);
const FILTER_DEFS = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/policies/filter-defs.ts',
);

const clientSrc = readFileSync(POLICIES_CLIENT, 'utf8');
const filterDefsSrc = readFileSync(FILTER_DEFS, 'utf8');
// Search placeholder + column headers migrated to next-intl; resolve keys
// against the en catalog.
const EN_POLICIES = JSON.parse(
    readFileSync(path.resolve(__dirname, '..', '..', 'messages/en.json'), 'utf8'),
).policies as { list: Record<string, string>; colHeaders: Record<string, string> };

describe('Policies list — Epic 45.1 shell + column wiring', () => {
    it('imports <EntityListPage> from the canonical path', () => {
        expect(clientSrc).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"]/,
        );
    });

    it('does NOT hand-roll <ListPageShell> directly (shell owns it)', () => {
        // The unified shell now owns the header / filters / body
        // composition. A future tidy-up that re-introduced inline
        // `<ListPageShell>` would silently regress consistency.
        expect(clientSrc).not.toMatch(
            /import\s*\{[^}]*\bListPageShell\b[^}]*\}\s*from\s*['"]@\/components\/layout\/ListPageShell['"]/,
        );
    });

    it('preserves the Epic 53 filter context (search + status + category)', () => {
        expect(clientSrc).toMatch(
            /import\s*\{[^}]*\buseFilterContext\b[^}]*\}\s*from\s*['"]@\/components\/ui\/filter['"]/,
        );
        expect(clientSrc).toContain('toApiSearchParams');
        expect(clientSrc).toContain('POLICY_FILTER_KEYS');
    });

    it('mounts a typed <EntityListPage<…>> and threads the canonical props', () => {
        // Generic is the page's real row type (PolicyRow) since the any-paydown
        // wave; match the shell mount, not the specific type argument.
        expect(clientSrc).toMatch(/<EntityListPage<\w+>/);
        expect(clientSrc).toMatch(/header=\{\{[\s\S]{0,200}title:/);
        // U1 — the toolbar receives the FULL filter defs, not a gear-filtered
        // subset. This used to require `defs: visibleFilterDefs`, which pinned
        // the defect: that value came from `selectVisibleFilters(...)`, so the
        // gear's checklist governed which FILTERS existed. Hiding a "card"
        // removed a filter from the product, and the KPI strip the gear appears
        // to control never changed.
        //
        // Now the gear registers kind:'kpi' cards and `selectVisibleFilters`
        // returns [] for them — so leaving this wiring in place would render an
        // empty Filter dropdown.
        expect(clientSrc).toMatch(/filters=\{\{[\s\S]{0,200}defs:\s*liveFilters/);
        expect(clientSrc).not.toMatch(/visibleFilterDefs/);
        // Columns are threaded via a MEMOISED array. They used to be
        // `orderColumns(policyColumns)` inline, which minted a new
        // identity every render and rebuilt the table model
        // mid-double-click — see tests/guards/datatable-stable-row-identity.
        expect(clientSrc).toMatch(/table=\{\{[\s\S]{0,260}columns:\s*orderedPolicyColumns/);
        expect(clientSrc).toMatch(
            /const orderedPolicyColumns = useMemo\(\s*\(\) => orderColumns\(policyColumns\)/,
        );
    });

    it('threads searchId + searchPlaceholder for the live filter search box', () => {
        // The FilterToolbar text-search input — retired site-wide by
        // #443 — was restored (2026-05-30) as a LIVE search box on
        // every list page (typing filters the table, no Enter). The
        // policies page wires both props through the EntityListPage
        // `filters` seam.
        expect(clientSrc).toContain("searchId: 'policies-search'");
        expect(clientSrc).toMatch(/searchPlaceholder:\s*tx\('list\.searchPlaceholder'\)/);
        expect(EN_POLICIES.list.searchPlaceholder).toMatch(/^Search policies/);
    });

    it('preserves row navigation to the detail page', () => {
        // The handler is a STABLE useCallback now, not an inline arrow —
        // an inline `onRowClick` is recreated per render and breaks
        // double-click-to-open. Assert the wiring + the destination.
        expect(clientSrc).toMatch(/onRowClick:\s*handleRowClick/);
        expect(clientSrc).toMatch(
            /const handleRowClick = useCallback\([\s\S]{0,200}router\.push\([\s\S]{0,120}\/policies\//,
        );
    });

    it('exposes the new Version column with currentVersion → lifecycleVersion fallback', () => {
        expect(clientSrc).toContain("id: 'version'");
        expect(clientSrc).toContain("header: tx('colHeaders.version')");
        expect(EN_POLICIES.colHeaders.version).toBe('Version');
        expect(clientSrc).toMatch(
            /p\.currentVersion\?\.versionNumber\s*\?\?\s*p\.lifecycleVersion/,
        );
        expect(clientSrc).toContain('data-testid={`policy-version-${row.original.id}`}');
    });

    it('Owner column is a name-only avatar chip (UI-14 capstone — no raw email)', () => {
        expect(clientSrc).toContain('charAt(0).toUpperCase()');
        expect(clientSrc).toContain('data-testid={`policy-owner-${p.id}`}');
        // UI-14 (capstone): name-only via ownerDisplayName (name → email
        // local-part as username), never the full email address.
        expect(clientSrc).toMatch(
            /ownerDisplayName\(p\.owner\?\.name, p\.owner\?\.email\)/,
        );
        expect(clientSrc).not.toMatch(/\{p\.owner\.email\}/);
    });

    it('Status column reads labels from POLICY_STATUS_LABELS (single source of truth)', () => {
        expect(clientSrc).toContain('POLICY_STATUS_LABELS');
        // STATUS_BADGE in the page maps every PolicyStatus enum
        // value — drift here would render an unstyled badge for any
        // missing key.
        for (const k of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED']) {
            expect(clientSrc).toContain(`${k}:`);
        }
    });

    it('column visibility config carries every new column as default-visible', () => {
        // R10-PR6 migrated to `useColumnsDropdown` — defaultVisible is
        // now a per-column flag (omitted = visible). Lock that the
        // three columns are present and none opt out.
        for (const id of ['status', 'owner', 'version']) {
            expect(clientSrc).toMatch(new RegExp(`id:\\s*['"]${id}['"]`));
            const entry = clientSrc.match(
                new RegExp(`\\{\\s*id:\\s*['"]${id}['"][^}]*\\}`),
            )?.[0] ?? '';
            expect(entry).not.toMatch(/defaultVisible:\s*false/);
        }
    });

    it('keeps the overdue-review badge visible when nextReviewAt < now', () => {
        expect(clientSrc).toContain("data-testid={`policy-overdue-${p.id}`}");
        expect(clientSrc).toMatch(/new Date\(p\.nextReviewAt\)\s*<\s*hydratedNow/);
    });
});

describe('Policies filter-defs — POLICY_STATUS_LABELS aligned to enum', () => {
    it('uses ARCHIVED (matching the prisma PolicyStatus enum), not RETIRED', () => {
        expect(filterDefsSrc).toContain('ARCHIVED');
        expect(filterDefsSrc).not.toMatch(/RETIRED:\s*['"]Retired['"]/);
    });

    it('covers every PolicyStatus enum value with a human label', () => {
        // The filter picker offers options derived from
        // POLICY_STATUS_LABELS via `optionsFromEnum(...)`. Missing
        // labels disappear from the picker silently.
        for (const k of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED']) {
            expect(filterDefsSrc).toContain(`${k}:`);
        }
    });
});
