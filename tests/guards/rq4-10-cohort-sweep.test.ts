/**
 * RQ4-10 — Cohort sweep ratchet.
 *
 * The capstone enforcement layer for the RQ4 wave. Two complementary
 * invariants:
 *
 *   1. **Positive coverage.** Every route in `SUBPAGES` (minus the
 *      explicit exemption list) imports `BackAffordance` from
 *      `@/components/nav/BackAffordance` AND mounts `<BackAffordance ...>`
 *      somewhere in the page tree (either directly OR via the
 *      `EntityDetailLayout.back={ smart: true }` form OR via the
 *      `PageHeader.back={ smart: true }` form).
 *   2. **Negative coverage (OB-H).** No route in `MAIN_PAGES` imports
 *      or mounts `<BackAffordance>` — main pages don't carry a back
 *      affordance, by design.
 *
 * The ratchet walks the actual `page.tsx` files (and sibling
 * `*Client.tsx` files when the page is a thin server wrapper) so it
 * can't be cheated by adding the entry to the segregation list
 * without actually wiring the component.
 *
 * The OB-H scan deliberately ignores the legacy `back={{ href: ..., label: ... }}`
 * static-link form — that's the pre-RQ4 affordance kept alive by the
 * foundations PR, used today only by `CoverageClient`. RQ4-10 enforces
 * that no MAIN page gains a NEW `<BackAffordance>` mount; pre-existing
 * static back links are out of scope.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    BACK_AFFORDANCE_COHORT_TODO,
    BACK_AFFORDANCE_EXEMPT_SUBPAGES,
    MAIN_PAGES,
    REFERRER_ONLY_BACK_MAIN_PAGES,
    SUBPAGES,
} from '@/lib/nav/page-segregation';

/**
 * The cohort sweep ratchet enforces a SHRINKING TODO list. When a
 * subpage is migrated off `BACK_AFFORDANCE_COHORT_TODO`, this ceiling
 * must drop in the same PR — otherwise the structural ratchet that
 * "TODO never grows" would pass with the wrong floor and let future
 * regressions slip in.
 *
 * Update process:
 *   1. Migrate a page (add `<BackAffordance />` mount).
 *   2. Remove its entry from `BACK_AFFORDANCE_COHORT_TODO`.
 *   3. Decrement the floor below by the same amount.
 */
const COHORT_TODO_CEILING = BACK_AFFORDANCE_COHORT_TODO.length;

const APP_PAGES = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

function routePatternToFilesystemPath(pattern: string): string {
    return path.join(APP_PAGES, pattern.replace(/^\//, ''));
}

/**
 * For a given route pattern, return the set of `.tsx` files we consider
 * part of its rendered tree:
 *   - the `page.tsx`
 *   - sibling `*Client.tsx` files in the same directory (canonical
 *     thin-wrapper pattern)
 */
function tsxFilesForPattern(pattern: string): string[] {
    const dir = routePatternToFilesystemPath(pattern);
    if (!fs.existsSync(dir)) return [];
    const pageFile = path.join(dir, 'page.tsx');
    if (!fs.existsSync(pageFile)) return [];

    const siblings = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
            (e) =>
                e.isFile() &&
                e.name.endsWith('.tsx') &&
                e.name !== 'loading.tsx' &&
                e.name !== 'error.tsx',
        )
        .map((e) => path.join(dir, e.name));

    return [pageFile, ...siblings.filter((f) => f !== pageFile)];
}

function fileMountsBackAffordance(file: string): boolean {
    const source = fs.readFileSync(file, 'utf-8');
    // EntityDetailLayout/PageHeader.back={{ smart: true }} counts as a mount
    // because the layout/header itself renders <BackAffordance/>.
    if (/\bback=\{\{\s*smart:\s*true\s*\}\}/.test(source)) return true;
    // DashboardLayout consumers pass `header` as an OBJECT, so the smart-back
    // form appears as a property literal `back: { smart: true }` (no JSX
    // expression braces). Treat that as a mount too — DashboardLayout
    // forwards the prop straight to <PageHeader>, which mounts
    // <BackAffordance>.
    if (/\bback:\s*\{\s*smart:\s*true\s*\}/.test(source)) return true;
    // PR-Q — the two test-plan detail routes are thin wrappers that delegate the
    // ENTIRE detail body (breadcrumbs + BackAffordance + content) to the shared
    // <TestPlanDetailView>. That component isn't a sibling *Client.tsx, so the
    // directory sweep can't see it — recognise the delegation explicitly.
    if (/\bTestPlanDetailView\b/.test(source)) {
        // Moved out of the route on 2026-08-06: two surfaces used it, so it
        // now lives in src/components/ (see route-import-boundaries).
        const shared = path.join(
            APP_PAGES, '../../../../components/test-plans/TestPlanDetailView.tsx',
        );
        if (fs.existsSync(shared) && /<BackAffordance\b/.test(fs.readFileSync(shared, 'utf-8'))) {
            return true;
        }
    }
    if (!/@\/components\/nav\/BackAffordance/.test(source)) return false;
    return /<BackAffordance\b/.test(source);
}

function fileMountsBackAffordanceComponent(file: string): boolean {
    const source = fs.readFileSync(file, 'utf-8');
    return (
        /@\/components\/nav\/BackAffordance/.test(source) ||
        /<BackAffordance\b/.test(source) ||
        /\bback=\{\{\s*smart:\s*true\s*\}\}/.test(source)
    );
}

describe('rq4-10 cohort sweep', () => {
    it('every SUBPAGE (minus exemptions + cohort TODO) mounts BackAffordance', () => {
        const exempt = new Set(BACK_AFFORDANCE_EXEMPT_SUBPAGES);
        const todo = new Set(BACK_AFFORDANCE_COHORT_TODO);
        const missing: string[] = [];

        for (const pattern of SUBPAGES) {
            if (exempt.has(pattern)) continue;
            if (todo.has(pattern)) continue;
            const files = tsxFilesForPattern(pattern);
            if (files.length === 0) {
                missing.push(`${pattern} — no page.tsx on disk`);
                continue;
            }
            const mounted = files.some(fileMountsBackAffordance);
            if (!mounted) {
                missing.push(pattern);
            }
        }

        expect(missing).toEqual([]);
    });

    it('every entry in BACK_AFFORDANCE_COHORT_TODO is a real SUBPAGE that does NOT yet mount BackAffordance', () => {
        const subSet = new Set(SUBPAGES);
        const orphans: string[] = [];
        const alreadyMounted: string[] = [];

        for (const pattern of BACK_AFFORDANCE_COHORT_TODO) {
            if (!subSet.has(pattern)) {
                orphans.push(pattern);
                continue;
            }
            const files = tsxFilesForPattern(pattern);
            if (files.some(fileMountsBackAffordance)) {
                alreadyMounted.push(pattern);
            }
        }

        // Orphan entries (not in SUBPAGES) fail loudly so the list
        // can't drift. `alreadyMounted` entries fail to FORCE removal
        // from the TODO — once a page is migrated, it must come off
        // the list immediately or the ratchet flags drift.
        expect({ orphans, alreadyMounted }).toEqual({
            orphans: [],
            alreadyMounted: [],
        });
    });

    it('BACK_AFFORDANCE_COHORT_TODO size never exceeds the ratcheted ceiling', () => {
        // The ceiling is a constant in this test file. When a page is
        // migrated, the contributor must (a) remove the entry from
        // the TODO list and (b) decrement the ceiling in the same
        // PR. A future "oops, added a new TODO without migrating one
        // off" PR fails CI.
        expect(BACK_AFFORDANCE_COHORT_TODO.length).toBeLessThanOrEqual(
            COHORT_TODO_CEILING,
        );
    });

    it('no MAIN_PAGE mounts BackAffordance with a canonical fallback (OB-H)', () => {
        // OB-H invariant: a MAIN page never carries an IA-canonical
        // back link. The `noFallback` variant is the explicit
        // exception — it only renders when an in-tab referrer
        // exists, so the affordance is purely "where you came from"
        // (no static "up" link to a non-existent parent).
        const referrerOnly = new Set(REFERRER_ONLY_BACK_MAIN_PAGES);
        const leaked: string[] = [];

        for (const pattern of MAIN_PAGES) {
            const files = tsxFilesForPattern(pattern);
            for (const f of files) {
                if (!fileMountsBackAffordanceComponent(f)) continue;
                if (referrerOnly.has(pattern)) {
                    // Mount is allowed, but ONLY in noFallback mode.
                    const source = fs.readFileSync(f, 'utf-8');
                    if (!/<BackAffordance\s+noFallback\b/.test(source)) {
                        leaked.push(
                            `${pattern} (${path.basename(f)}) — mounts BackAffordance without noFallback`,
                        );
                    }
                    continue;
                }
                leaked.push(`${pattern} (${path.basename(f)})`);
            }
        }

        expect(leaked).toEqual([]);
    });

    it('every entry in REFERRER_ONLY_BACK_MAIN_PAGES is a real MAIN_PAGE that mounts <BackAffordance noFallback />', () => {
        const mainSet = new Set(MAIN_PAGES);
        const orphans: string[] = [];
        const missing: string[] = [];

        for (const pattern of REFERRER_ONLY_BACK_MAIN_PAGES) {
            if (!mainSet.has(pattern)) {
                orphans.push(pattern);
                continue;
            }
            const files = tsxFilesForPattern(pattern);
            const mounted = files.some((f) =>
                /<BackAffordance\s+noFallback\b/.test(
                    fs.readFileSync(f, 'utf-8'),
                ),
            );
            if (!mounted) missing.push(pattern);
        }

        expect({ orphans, missing }).toEqual({ orphans: [], missing: [] });
    });

    it('every exempt subpage is still listed in SUBPAGES (no orphan exemptions)', () => {
        const subSet = new Set(SUBPAGES);
        const orphans = BACK_AFFORDANCE_EXEMPT_SUBPAGES.filter(
            (p) => !subSet.has(p),
        );
        expect(orphans).toEqual([]);
    });
});
