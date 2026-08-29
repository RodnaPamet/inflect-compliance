/**
 * Epic 52 — DataTable migration ratchet.
 *
 * Tracks the count of raw `<table>` elements in app pages and ensures it
 * only goes down as we migrate surfaces to `<DataTable>`.
 *
 * Exclusions:
 *   - SoA print view (`reports/soa/print/`) — semantic HTML required for print CSS
 *   - RBAC page (`admin/rbac/`) — server component; DataTable is client-only
 *   - SoA report table (`reports/soa/SoAClient.tsx`) — bespoke master/detail
 *     with (a) per-row conditional gap highlighting (`hasGap → bg-bg-error`, a
 *     load-bearing compliance-scan signal) which `<DataTable>`'s public API
 *     exposes no per-row `className`/`rowProps` hook for, and (b) single-row
 *     click-to-expand semantics (`<DataTable>` offers only uncontrolled
 *     multi-expand). `<DataTable>` can host the expandable sub-row, but not the
 *     row-styling contract this SoA view depends on. Also pre-exempted in
 *     `no-raw-tables-in-app-pages.test.ts` as "bespoke SoA reading order".
 *
 * After migrating a surface, decrease the baseline.
 */
import * as fs from 'fs';
import * as path from 'path';

import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

const APP_PAGES = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

/** Paths that are intentionally excluded from the ratchet. */
const EXCLUDED_PATHS = [
    'reports/soa/print/',  // Print view — raw table is correct for print CSS
    'admin/rbac/',          // Server component — DataTable requires client
    // Bespoke SoA master/detail: per-row gap highlighting + single-row
    // click-to-expand that <DataTable>'s public API can't express (see the
    // header comment). Already exempt in no-raw-tables-in-app-pages.test.ts.
    'reports/soa/SoAClient.tsx',
];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function countRawTables(): { count: number; files: string[] } {
    const allFiles = walk(APP_PAGES);
    const files: string[] = [];
    let count = 0;

    for (const file of allFiles) {
        const rel = path.relative(APP_PAGES, file);
        if (EXCLUDED_PATHS.some(p => rel.startsWith(p))) continue;

        const content = fs.readFileSync(file, 'utf-8');
        const matches = content.match(/<table[\s>]/g);
        if (matches) {
            count += matches.length;
            files.push(`${rel} (${matches.length})`);
        }
    }
    return { count, files };
}

function countDataTableUsages(): number {
    const allFiles = walk(APP_PAGES);
    let count = 0;
    for (const file of allFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const matches = content.match(/<DataTable[\s/]/g);
        if (matches) count += matches.length;
    }
    return count;
}

describe('Epic 52 — DataTable migration ratchet', () => {
    /**
     * Baseline: Raw <table> count in app pages (excluding print/server-only).
     * Started at 22 tables across 16 files.
     * Lower this number whenever you migrate a surface — and note that
     * lowering it is enforced, not merely encouraged: the drift sentinel
     * below fails when the baseline sits more than DRIFT_ALLOWANCE above
     * the live count, because that gap is headroom a regression can spend
     * with a green build.
     *
     * History
     *   12 → 9  (2026-08-29) re-seated to the live count. The trailing
     *           comment enumerated a tree three migrations out of date —
     *           controls/[controlId] (3) and access-reviews/[reviewId]/
     *           AccessReviewDetailClient (1) no longer match, admin/members
     *           dropped 2 → 1, vendors/[vendorId] 3 → 1 — while
     *           risks/correlations, risks/scenarios, ControlsClient and
     *           EvidenceClient joined.
     *
     * Live hits (2026-08-29). The scan is a text match, so a `<table`
     * inside a COMMENT counts like markup; four of the nine are prose.
     *   admin/roles/page.tsx        (2)  1 markup + 1 in the header comment
     *   admin/members/page.tsx      (1)  comment only — migrated to DataTable
     *   controls/ControlsClient.tsx (1)  comment only
     *   evidence/EvidenceClient.tsx (1)  comment only
     *   risks/correlations/page.tsx (1)  markup — correlation matrix
     *   risks/scenarios/page.tsx    (1)  markup — scenario grid
     *   tasks/[taskId]/page.tsx     (1)  comment only
     *   vendors/[vendorId]/page.tsx (1)  comment only
     */
    const RAW_TABLE_BASELINE = 9;

    /**
     * Tolerance before the drift sentinel fires.
     *
     * Two, and the number is chosen against a concrete test rather than
     * taste: an allowance must be STRICTLY SMALLER than the drift it is
     * being introduced to correct, or the sentinel is calibrated to sleep
     * through a repeat of the exact failure that motivated it. The drift
     * corrected on 2026-08-29 was three (12 against a live 9), so three
     * would have stayed green on it — the first draft of this constant
     * did, and re-running the old baseline through the sentinel is what
     * caught it.
     *
     * Two still absorbs an ordinary doc pass: four of the nine live hits
     * are `<table` inside comments, and rewording two of them costs
     * nothing here.
     */
    const DRIFT_ALLOWANCE = 2;

    it('raw <table> count does not exceed the baseline', () => {
        const { count, files } = countRawTables();
        if (count > RAW_TABLE_BASELINE) {
            fail(
                `Raw <table> count (${count}) exceeds baseline (${RAW_TABLE_BASELINE}).\n` +
                `Files with raw tables:\n  ${files.join('\n  ')}\n\n` +
                `Migrate to <DataTable> or lower the baseline if this is an excluded surface.`
            );
        }
    });

    it('baseline has not drifted above the live count (drift sentinel)', () => {
        const { count } = countRawTables();

        // Positive control against the real counter: prove the sentinel
        // can fail before reading its silence as good news.
        expect(
            ratchetSlackFailure({
                constantName: 'RAW_TABLE_BASELINE',
                baseline: count + DRIFT_ALLOWANCE + 1,
                count,
                allowance: DRIFT_ALLOWANCE,
            }),
        ).not.toBeNull();

        assertRatchetSlack({
            constantName: 'RAW_TABLE_BASELINE',
            baseline: RAW_TABLE_BASELINE,
            count,
            allowance: DRIFT_ALLOWANCE,
            what: 'raw `<table` occurrences in tenant app pages, excluding print/server-only surfaces',
        });
    });

    it('DataTable adoption is growing', () => {
        const count = countDataTableUsages();
        // After migration batch: should be at least 20 DataTable usages
        expect(count).toBeGreaterThanOrEqual(15);
    });

    it('excluded paths still use semantic tables', () => {
        // Verify the print view and RBAC page still have their expected tables
        const soaPrint = path.join(APP_PAGES, 'reports/soa/print/SoAPrintView.tsx');
        if (fs.existsSync(soaPrint)) {
            expect(fs.readFileSync(soaPrint, 'utf-8')).toContain('<table');
        }
        const rbac = path.join(APP_PAGES, 'admin/rbac/page.tsx');
        if (fs.existsSync(rbac)) {
            expect(fs.readFileSync(rbac, 'utf-8')).toContain('<table');
        }
    });
});
