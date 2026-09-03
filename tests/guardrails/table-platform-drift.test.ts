/**
 * Guardrail: DataTable platform anti-drift.
 *
 * Prevents ad-hoc table implementations from creeping back into
 * list-page components that have been migrated to the shared DataTable
 * architecture (Epic 52).
 *
 * Three enforcement layers:
 * 1. Import hygiene — no SkeletonTableRow, no deep-path imports
 * 2. Structural compliance — migrated pages use DataTable, not <table>
 * 3. Convention compliance — useMemo columns, barrel imports, test IDs
 */
import * as fs from 'fs';
import * as path from 'path';

import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

const TABLE_MODULE_DIR = path.resolve(__dirname, '../../src/components/ui/table');
const UI_DIR = path.resolve(__dirname, '../../src/components/ui');
const CLIENT_DIR = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

/**
 * Pages intentionally excluded from DataTable migration.
 * Each must have a documented reason.
 */
const EXCLUDED_PAGES: Record<string, string> = {
    'SoAClient.tsx': 'Expandable row sub-components, not a flat list',
    'AuditsClient.tsx': 'Master/detail panel UX, not a list page',
    // Epic G-4 — list-of-decisions inside a campaign detail page.
    // Per-row inline dropdown + decision dialog sit on the row;
    // same architectural shape as AuditsClient.
    'AccessReviewDetailClient.tsx':
        'Master/detail with inline decision controls — list inside a parent record, not a list page.',
};

/**
 * Client pages that have been migrated and must NOT regress.
 */
const MIGRATED_PAGES = [
    'controls/ControlsClient.tsx',
    'evidence/EvidenceClient.tsx',
    'risks/RisksClient.tsx',
    'policies/PoliciesClient.tsx',
    'tasks/TasksClient.tsx',
    'vendors/VendorsClient.tsx',
    'assets/AssetsClient.tsx',
    'findings/FindingsClient.tsx',
    // PR-G — reports/ReportsClient.tsx is no longer a DataTable list page; it
    // was rebuilt as a framework-scoped report catalog (cards), so it is no
    // longer tracked here as a DataTable-migrated page.
    // R13-PR10 — `admin/AdminClient.tsx` was deleted (audit log
    // moved to `/admin/audit-log` with a dedicated client island).
    // The new sub-component takes its place in the registry.
    'admin/audit-log/AuditLogClient.tsx',
];

function readClientFile(rel: string): string {
    return fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf-8');
}

function findFilesRecursive(dir: string, filter: (name: string) => boolean): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findFilesRecursive(full, filter));
        else if (filter(entry.name)) results.push(full);
    }
    return results;
}

// ─── Layer 1: Import Hygiene ─────────────────────────────────────────

describe('Import hygiene — no legacy table imports in migrated pages', () => {
    it.each(MIGRATED_PAGES)('%s does not import SkeletonTableRow', (rel) => {
        const src = readClientFile(rel);
        expect(src).not.toContain('SkeletonTableRow');
    });

    it.each(MIGRATED_PAGES)('%s does not import SkeletonDataTable', (rel) => {
        const src = readClientFile(rel);
        expect(src).not.toContain('SkeletonDataTable');
    });

    it.each(MIGRATED_PAGES)('%s imports from barrel, not deep module paths', (rel) => {
        const src = readClientFile(rel);
        if (!src.includes('DataTable')) return; // skip non-table pages

        // Should use barrel: from '@/components/ui/table'
        expect(src).toContain("from '@/components/ui/table'");

        // Should NOT import from sub-modules like '@/components/ui/table/data-table'
        const deepImports = src.match(/from\s+['"]@\/components\/ui\/table\/[^'"]+['"]/g);
        expect(deepImports ?? []).toEqual([]);
    });
});

// ─── Layer 2: Structural Compliance ──────────────────────────────────

describe('Structural compliance — migrated pages use DataTable', () => {
    it.each(MIGRATED_PAGES)('%s uses <DataTable>, not raw <table>', (rel) => {
        const src = readClientFile(rel);
        // `EntityListPage` is the composition shell that internally
        // mounts `<DataTable>` (see `src/components/layout/EntityListPage.tsx`).
        // A page that uses the shell satisfies this guardrail without
        // importing DataTable directly. Either signal counts.
        const hasDataTable = src.includes('DataTable');
        const hasEntityListPage = src.includes('EntityListPage');
        const hasRawTable = /<table[\s>]/.test(src);

        // Must use DataTable directly OR via the EntityListPage shell.
        expect(hasDataTable || hasEntityListPage).toBe(true);
        // Should NOT have raw <table> (unless also using DataTable)
        if (hasRawTable) {
            // Transitional: allow raw <table> only if DataTable is also present
            expect(hasDataTable).toBe(true);
        }
    });

    it.each(MIGRATED_PAGES)('%s exists and is not accidentally deleted', (rel) => {
        const fullPath = path.join(CLIENT_DIR, rel);
        expect(fs.existsSync(fullPath)).toBe(true);
    });
});

// ─── Layer 3: Convention Compliance ──────────────────────────────────

describe('Convention compliance — column patterns', () => {
    it.each(MIGRATED_PAGES)('%s uses createColumns<T> for type-safe column definitions', (rel) => {
        const src = readClientFile(rel);
        if (!src.includes('DataTable')) return;
        expect(src).toContain('createColumns');
    });

    it.each(MIGRATED_PAGES)('%s wraps columns in useMemo (not inline)', (rel) => {
        const src = readClientFile(rel);
        if (!src.includes('DataTable')) return;

        // React rules-of-hooks violation: columns must be memoized
        expect(src).toContain('useMemo');

        // Negative check: no standalone IIFE around column definitions.
        // Anti-pattern: const columns = (() => createColumns([...]))();
        // Good pattern: const columns = useMemo(() => createColumns([...]), []);
        // We check that every `createColumns` call is inside a `useMemo` on the same line
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('createColumns') && !line.includes('import') && !line.includes('//')) {
                // This line defines columns — it should be inside useMemo, not a bare IIFE
                const isBareIIFE = /=\s*\(\(\)\s*=>/.test(line) && !line.includes('useMemo');
                if (isBareIIFE) {
                    throw new Error(`Line ${i + 1}: createColumns in bare IIFE — wrap in useMemo instead`);
                }
            }
        }
    });

    it.each(MIGRATED_PAGES)('%s has a data-testid for E2E targeting', (rel) => {
        const src = readClientFile(rel);
        if (!src.includes('DataTable')) return;
        expect(src).toContain('data-testid');
    });
});

// ─── Module Integrity ────────────────────────────────────────────────

describe('Table module integrity', () => {
    it('barrel index.ts re-exports all modules', () => {
        const barrel = fs.readFileSync(path.join(TABLE_MODULE_DIR, 'index.ts'), 'utf-8');
        const tsFiles = fs.readdirSync(TABLE_MODULE_DIR)
            .filter(f => /\.(ts|tsx)$/.test(f) && f !== 'index.ts');

        for (const file of tsFiles) {
            const mod = file.replace(/\.(ts|tsx)$/, '');
            expect(barrel).toContain(mod);
        }
    });

    it('no duplicate PaginationControls outside table module', () => {
        expect(fs.existsSync(path.join(UI_DIR, 'pagination-controls.tsx'))).toBe(false);
    });

    it('GUIDE.md exists and is non-trivial', () => {
        const guidePath = path.join(TABLE_MODULE_DIR, 'GUIDE.md');
        expect(fs.existsSync(guidePath)).toBe(true);
        const content = fs.readFileSync(guidePath, 'utf-8');
        expect(content.length).toBeGreaterThan(500);
        // Assert the canonical import LINE, not bare mentions. `createColumns`
        // occurs 5x and `DataTable` 17x in this guide, so either bare needle is
        // satisfied by any surviving prose — the guide could lose its usage
        // example entirely and stay green. This line appears exactly once.
        expect(content).toContain(
            "import { DataTable, createColumns } from '@/components/ui/table';",
        );
    });

    it('no new *Client.tsx pages bypass DataTable without being in EXCLUDED_PAGES', () => {
        const allClientFiles = findFilesRecursive(CLIENT_DIR, name => name.endsWith('Client.tsx'));
        const migratedSet = new Set(MIGRATED_PAGES.map(r => path.basename(r)));
        const excludedSet = new Set(Object.keys(EXCLUDED_PAGES));

        const unknownPages: string[] = [];
        for (const file of allClientFiles) {
            const basename = path.basename(file);
            if (migratedSet.has(basename) || excludedSet.has(basename)) continue;

            // Check if this unknown page has a raw <table> without DataTable
            const src = fs.readFileSync(file, 'utf-8');
            const hasRawTable = /<table[\s>]/.test(src);
            const hasDataTable = src.includes('DataTable');

            if (hasRawTable && !hasDataTable) {
                unknownPages.push(basename);
            }
        }

        // If this fails, add the page to MIGRATED_PAGES or EXCLUDED_PAGES
        expect(unknownPages).toEqual([]);
    });
});

// ─── Exclusion Registry ──────────────────────────────────────────────

describe('Excluded page registry', () => {
    for (const [page, reason] of Object.entries(EXCLUDED_PAGES)) {
        it(`${page} exists and has a documented reason: "${reason}"`, () => {
            const allFiles = findFilesRecursive(CLIENT_DIR, name => name === page);
            expect(allFiles.length).toBeGreaterThanOrEqual(1);
            expect(reason.length).toBeGreaterThan(10);
        });
    }

    it('excluded page count is bounded (should not grow unbounded)', () => {
        expect(Object.keys(EXCLUDED_PAGES).length).toBeLessThanOrEqual(5);
    });
});

// ─── Migration Progress Tracking ─────────────────────────────────────

describe('Migration progress', () => {
    it('at least 9 pages are fully migrated', () => {
        // PR-G — reports/ReportsClient.tsx was intentionally rebuilt from a
        // DataTable list into a framework-scoped report catalog (cards), so it
        // left this list; the floor drops from 10 → 9 to match. This is an
        // architectural transition, not a DataTable regression.
        const existing = MIGRATED_PAGES.filter(rel => {
            try { readClientFile(rel); return true; } catch { return false; }
        });
        expect(existing.length).toBeGreaterThanOrEqual(9);
    });

    it('migrated pages collectively cover all entity types', () => {
        const entityNames = ['control', 'evidence', 'risk', 'polic', 'task', 'vendor', 'asset', 'finding'];
        for (const entity of entityNames) {
            const covered = MIGRATED_PAGES.some(p => p.toLowerCase().includes(entity));
            expect(covered).toBe(true);
        }
    });
});

// ─── Ad-hoc <table> ratchet (Epic 52 finishing guide) ───────────────
//
// The MIGRATED_PAGES list above only knows about `*Client.tsx` files.
// The Epic 52 finishing guide also targets detail pages and admin
// routes that aren't named `*Client.tsx` — `admin/api-keys/page.tsx`,
// `admin/roles/page.tsx`, `controls/[controlId]/page.tsx`, etc. This
// ratchet caps the total count of `<table>` occurrences across the
// whole tenant surface so those pages can only migrate in one
// direction.

const RATCHET_ALLOWLIST = new Set<string>([
    // Print-only views — the static PDF generator uses plain <table>
    // so it can render identically across browsers / serverless print
    // pipelines. DataTable's interactive chrome is the wrong fit.
    'reports/soa/print/SoAPrintView.tsx',
]);

// Baseline recorded at Epic 52 finishing-guide close-out. Counts
// `<table>` occurrences (a page with 3 sub-tables contributes 3 to
// the total). Lower only.
//
// History
//   15 → 11  (2026-08-29) re-seated to the live count. The enumeration
//            that used to sit here described a tree that had since
//            migrated — controls/[controlId] (3) and
//            access-reviews/[reviewId]/AccessReviewDetailClient (1)
//            no longer match at all, and vendors/[vendorId] dropped
//            from 3 to 1 — leaving four units of headroom nothing
//            reported.
//
// Live hits (2026-08-29). Note what this regex actually counts: the
// pattern is a text scan, so a `<table` written in a COMMENT counts
// exactly like markup. Six of the eleven are prose, which is why the
// list below marks each one.
//   2  admin/roles/page.tsx          1 markup (role/permission grid)
//                                    + 1 in the header comment
//   1  admin/members/page.tsx        comment only — migrated to DataTable
//   1  admin/rbac/page.tsx           markup (server component)
//   1  controls/ControlsClient.tsx   comment only
//   1  evidence/EvidenceClient.tsx   comment only
//   1  reports/soa/SoAClient.tsx     markup — cross-cutting SoA grid
//                                    (also in EXCLUDED_PAGES: expandable-row UX)
//   1  risks/correlations/page.tsx   markup (correlation matrix)
//   1  risks/scenarios/page.tsx      markup (scenario grid)
//   1  tasks/[taskId]/page.tsx       comment only
//   1  vendors/[vendorId]/page.tsx   comment only
//
// So the real ad-hoc-markup residue is 5, and a PR that only reworded
// a comment would move this number. That coupling is why
// DRIFT_ALLOWANCE below is not zero.
const RAW_TABLE_BASELINE = 11;

// See `tests/helpers/ratchet-slack.ts`. Three, because the count is
// small and partly comment-coupled: a doc pass should not have to edit
// this guard, but the four units of drift that accumulated before
// 2026-08-29 must not be able to accumulate again.
const RAW_TABLE_DRIFT_ALLOWANCE = 3;
const RAW_TABLE_RE = /<table\b/g;

function countAdHocTables(): { total: number; byFile: Record<string, number> } {
    const byFile: Record<string, number> = {};
    let total = 0;
    const files = findFilesRecursive(CLIENT_DIR, (name) => /\.tsx$/.test(name));
    for (const full of files) {
        const rel = path.relative(CLIENT_DIR, full);
        if (RATCHET_ALLOWLIST.has(rel)) continue;
        const src = fs.readFileSync(full, 'utf-8');
        const matches = src.match(RAW_TABLE_RE);
        if (matches && matches.length > 0) {
            byFile[rel] = matches.length;
            total += matches.length;
        }
    }
    return { total, byFile };
}

describe('Ad-hoc <table> ratchet', () => {
    it(`<table> occurrences under (app) excluding print views ≤ ${RAW_TABLE_BASELINE}`, () => {
        const { total, byFile } = countAdHocTables();
        if (total > RAW_TABLE_BASELINE) {
            const listed = Object.entries(byFile)
                .sort(([, a], [, b]) => b - a)
                .map(([f, n]) => `  ${n}\t${f}`)
                .join('\n');
            throw new Error(
                `Epic 52 ratchet: ad-hoc <table> count grew from baseline ${RAW_TABLE_BASELINE} to ${total}.\n` +
                    `Migrate the new page to <DataTable> (see src/components/ui/table/GUIDE.md) or, for print-only views, add it to RATCHET_ALLOWLIST in this test.\n` +
                    `Current hits:\n${listed}`,
            );
        }
        expect(total).toBeLessThanOrEqual(RAW_TABLE_BASELINE);
    });

    it('every allowlist entry points at a real file', () => {
        for (const rel of RATCHET_ALLOWLIST) {
            expect(fs.existsSync(path.join(CLIENT_DIR, rel))).toBe(true);
        }
    });

    it('baseline has not drifted above the live count (drift sentinel)', () => {
        const { total } = countAdHocTables();

        // Positive control against the real counter — proves the sentinel
        // can still fail, so a pass below means something.
        expect(
            ratchetSlackFailure({
                constantName: 'RAW_TABLE_BASELINE',
                baseline: total + RAW_TABLE_DRIFT_ALLOWANCE + 1,
                count: total,
                allowance: RAW_TABLE_DRIFT_ALLOWANCE,
            }),
        ).not.toBeNull();

        assertRatchetSlack({
            constantName: 'RAW_TABLE_BASELINE',
            baseline: RAW_TABLE_BASELINE,
            count: total,
            allowance: RAW_TABLE_DRIFT_ALLOWANCE,
            what: '`<table` occurrences under the tenant (app) tree, excluding print views',
        });
    });
});
