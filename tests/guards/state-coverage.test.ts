/**
 * Polish PR-10 — state-coverage ratchet (loading + empty).
 *
 * The states a user sees most often during failure deserve the
 * most polish. Loading and empty states are where polish either
 * compounds or evaporates — they're usually the surfaces a user
 * sees during their *most frustrated* moments.
 *
 * What this ratchet enforces
 *
 *   1. Every dashboard file (page.tsx or *Client.tsx under any
 *      `dashboard/` directory) MUST reference `SkeletonDashboard`
 *      from `@/components/ui/skeleton` if the file has an
 *      `if (loading)` branch. Hand-rolled `<div className="p-12
 *      text-center animate-pulse">Loading…</div>` is banned.
 *
 *   2. Every list-page client (under `src/app/.../page.tsx` whose
 *      filename matches `*Client.tsx` and contains a DataTable
 *      reference) SHOULD reference one of the Skeleton primitives
 *      when it has an `if (loading)` branch — but DataTable's
 *      built-in `loading` prop also satisfies this, so the rule is
 *      lighter here.
 *
 *   3. The route-specific `DashboardSkeleton` stays OUT of the
 *      shared primitives module. It is a tracing of one page's
 *      sections in that page's order, so it belongs beside that
 *      page; `skeleton.tsx` holds shapes with no opinion about
 *      what they stand in for. See the split's rationale in
 *      `src/app/t/[tenantSlug]/(app)/dashboard/DashboardSkeleton.tsx`.
 *
 * What this ratchet does NOT police
 *   Detail pages — they delegate loading to `EntityDetailLayout
 *   loading`, which already paints `DetailLoadingSkeleton` from
 *   the shell.
 *
 *   Server components — they render synchronously, no loading
 *   branch needed.
 *
 * Pairs with:
 *   - src/components/ui/skeleton.tsx (the SkeletonDashboard /
 *     SkeletonTable / SkeletonDetailTabs primitives).
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — every assertion below reads through `codeOf`, which masks
// comments at the READ SEAM. Without it "delete the component, keep the
// comment that names it" is a green diff, and on a `.not.toMatch` the mirror
// image holds: prose mentioning the forbidden symbol fails a guard whose code
// is fine. String literals are KEPT, so the import-path assertions still see
// what they are about.
//
// The raw reader survives for the SCANNER below, which feeds a regex test
// rather than an `expect` — it is looking for an `if (loading)` branch, and
// masking is irrelevant to whether the file is an offender.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

const code = (rel: string): string =>
    codeOf(fs.readFileSync(path.resolve(ROOT, rel), 'utf8'));

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
    /loading\.tsx$/,
];

const EXEMPT_DASHBOARDS = new Set<string>([
    // Issues dashboard is a redirect — no loading state.
    'src/app/t/[tenantSlug]/(app)/issues/dashboard/page.tsx',
]);

interface Hit {
    file: string;
    reason: string;
}

function findDashboardFiles(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(ROOT, full);
            if (entry.isDirectory()) walk(full);
            else if (
                /\.(tsx|jsx)$/.test(entry.name) &&
                !EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))
            ) {
                if (
                    /\/dashboard\/(page|.*Client)\.(tsx|jsx)$/.test(rel) &&
                    !EXEMPT_DASHBOARDS.has(rel)
                ) {
                    out.push(rel);
                }
            }
        }
    }
    walk(path.join(ROOT, 'src/app'));
    return out;
}

const HAS_LOADING_BRANCH_RE = /if\s*\(\s*loading[^)]*\)\s*(?:return|\{)/;
const HAS_SKELETON_DASHBOARD_RE =
    /SkeletonDashboard|<DashboardLayout\s+loading|<DashboardSkeleton/;

describe('State coverage ratchet (Polish PR-10)', () => {
    it('every dashboard file with a loading branch references SkeletonDashboard', () => {
        const offenders: Hit[] = [];
        for (const rel of findDashboardFiles()) {
            const abs = path.resolve(ROOT, rel);
            const content = fs.readFileSync(abs, 'utf8');
            if (!HAS_LOADING_BRANCH_RE.test(content)) continue;
            if (HAS_SKELETON_DASHBOARD_RE.test(content)) continue;
            offenders.push({
                file: rel,
                reason:
                    'has `if (loading)` branch but does not reference SkeletonDashboard',
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file} — ${o.reason}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} dashboard file(s) with a loading branch that don't reference SkeletonDashboard.\n\nA user on a slow connection deserves a real skeleton that maps to the page they're about to see — not a generic "Loading..." string. Replace the inline div with:\n\n  if (loading) return <SkeletonDashboard />;\n\nAnd import: import { SkeletonDashboard } from '@/components/ui/skeleton';\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_DASHBOARDS) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_DASHBOARDS.size).toBeLessThanOrEqual(2);
    });

    it('the dashboard scanner finds at least the expected canonical files', () => {
        const found = findDashboardFiles();
        // Sanity check — must find risks, tasks, controls, vendors,
        // tests dashboards (5 minimum) so a future code reorg doesn't
        // silently turn the ratchet into a no-op.
        expect(found.length).toBeGreaterThanOrEqual(5);
    });

    // ── The route-specific skeleton lives beside its route ───────────
    //
    // Both halves are asserted, because either one alone is satisfiable
    // by the wrong state: the new file could exist while the old export
    // lingered (two copies to keep in step), or the export could be
    // gone with nothing in its place (a dashboard with no loading
    // shell). Note the scanner above does NOT reach the new file —
    // its pattern is `dashboard/(page|*Client).tsx` — so the move
    // cannot have bought this guard's silence.
    describe('DashboardSkeleton is route-local, not a shared primitive', () => {
        const LOCAL =
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardSkeleton.tsx';

        it('the compliance dashboard shell lives beside the route', () => {
            expect(fs.existsSync(path.resolve(ROOT, LOCAL))).toBe(true);
            const src = code(LOCAL);
            expect(src).toMatch(/export function DashboardSkeleton\(/);
            // It composes the primitives rather than re-deriving them.
            expect(src).toMatch(/from '@\/components\/ui\/skeleton'/);
        });

        it('the route-level loading.tsx imports it LOCALLY, not from the barrel', () => {
            expect(
                code('src/app/t/[tenantSlug]/(app)/dashboard/loading.tsx'),
            ).toMatch(
                /import \{ DashboardSkeleton \} from '\.\/DashboardSkeleton'/,
            );
        });

        it('the shared primitives module no longer exports it', () => {
            const primitives = code('src/components/ui/skeleton.tsx');
            expect(primitives).not.toMatch(/export function DashboardSkeleton\b/);
            // `SkeletonDashboard` is a DIFFERENT component — the generic
            // list-dashboard shell — and must survive the split. Without
            // this, deleting both would pass the line above.
            expect(primitives).toMatch(/export function SkeletonDashboard\(/);
        });
    });
});
