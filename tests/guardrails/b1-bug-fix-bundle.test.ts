/**
 * B1 — bug-fix bundle structural ratchet.
 *
 * Four independent bugs closed by this PR; each locked here so a
 * future PR can't silently re-introduce.
 *
 *   1. Calendar date offset — date-picker boundary now re-anchors
 *      RDP local-midnight → UTC-midnight so clicking May 24 in
 *      negative timezones doesn't round-trip to May 23.
 *   2. Task assignee population — `UserCombobox` reads from a
 *      non-admin endpoint (`/users/assignable`) so EDITOR / READER
 *      users see the roster.
 *   3. Linking dropdowns — `TraceabilityPanel` unwraps the
 *      `{ rows, truncated }` cap shape that the list endpoints
 *      return; pre-fix the dropdowns silently rendered empty.
 *   4. Dashboard card filtering — every KPI either focuses a
 *      chart (coverage / risks / evidence / findings) or navigates
 *      to its entity list (tasks / policies); no more dead clicks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B1 — bug-fix bundle', () => {
    describe('Bug 1 — calendar date offset (TZ-aware boundary)', () => {
        const picker = read('src/components/ui/date-picker/date-picker.tsx');
        const utils = read('src/components/ui/date-picker/date-utils.ts');

        it('single picker re-anchors RDP local-midnight to UTC-midnight on select', () => {
            expect(picker).toMatch(/function fromRDPSingle/);
            expect(picker).toMatch(
                /new Date\(\s*Date\.UTC\(\s*local\.getFullYear\(\)/,
            );
            expect(picker).toMatch(/fromRDPSingle\(next\)/);
        });

        it('single picker re-anchors stored UTC-midnight back to local for display', () => {
            expect(picker).toMatch(/function toRDPSingle/);
            expect(picker).toMatch(
                /new Date\(\s*v\.getUTCFullYear\(\)/,
            );
        });

        it('range picker bridges both directions', () => {
            // The range-picker uses the utility helpers, not bespoke
            // ones — lock that the helpers themselves do the bridge.
            const block = utils.slice(
                utils.indexOf('export function toDateRangeValue'),
                utils.indexOf('export function fromDateRangeValue') + 600,
            );
            expect(block).toMatch(/localMidnightToUtcMidnight/);
            expect(block).toMatch(/utcMidnightToLocalMidnight/);
        });
    });

    describe('Bug 2 — task assignee population', () => {
        const usecase = read('src/app-layer/usecases/tenant-admin.ts');
        const route = read(
            'src/app/api/t/[tenantSlug]/users/assignable/route.ts',
        );
        const ui = read('src/components/ui/user-combobox.tsx');

        it('listAssignableUsers usecase exists with assertCanRead gate', () => {
            expect(usecase).toMatch(/export async function listAssignableUsers/);
            // Inside the function body — runs BEFORE the DB call.
            const fnStart = usecase.indexOf(
                'export async function listAssignableUsers',
            );
            const fnBody = usecase.slice(fnStart, fnStart + 800);
            expect(fnBody).toMatch(/assertCanRead\(ctx\)/);
        });

        it('non-admin API route exists', () => {
            expect(route).toMatch(/listAssignableUsers/);
            expect(route).toMatch(/getTenantCtx/);
            // No requirePermission gate — this is read-tier for all members.
            expect(route).not.toMatch(/requirePermission/);
        });

        it('UserCombobox fetches the non-admin endpoint', () => {
            expect(ui).toMatch(
                /\/api\/t\/\$\{tenantSlug\}\/users\/assignable/,
            );
            // Strip comments before checking — the rationale comment
            // INSIDE the function explains why `/admin/members` is
            // retired; the executable code is what we care about.
            const fetchBlock = ui.slice(
                ui.indexOf('export function useTenantMembers'),
                ui.indexOf('// ─── Option projection'),
            );
            const stripped = fetchBlock
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            expect(stripped).not.toMatch(/\/admin\/members/);
        });
    });

    describe('Bug 3 — linking dropdowns (TraceabilityPanel)', () => {
        const src = read('src/components/TraceabilityPanel.tsx');

        it('unwraps every list-endpoint shape via the `unwrap` helper', () => {
            // The helper recognises bare arrays, `{ rows }` cap shape,
            // entity-keyed shape, and `{ items }` pagination shape.
            expect(src).toMatch(/const unwrap/);
            // Variable-name-agnostic: the helper was typed (`d: unknown` →
            // narrowed via a local `o`), so match `<ident>.rows`/`.items`.
            expect(src).toMatch(/Array\.isArray\(\w+\.rows\)/);
            expect(src).toMatch(/Array\.isArray\(\w+\.items\)/);
        });

        it('all three fetchers route through `unwrap`', () => {
            // Three useEffects — one per entity. Each should call unwrap.
            const occurrences = src.match(/unwrap\(d,/g) ?? [];
            expect(occurrences.length).toBeGreaterThanOrEqual(3);
        });

        it('legacy `d.risks || []` shape fallback is retired', () => {
            // The old shape never matched the cap'd response and
            // collapsed every dropdown to empty.
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.risks\s*\|\|\s*\[\]/);
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.controls\s*\|\|\s*\[\]/);
            expect(src).not.toMatch(/Array\.isArray\(d\)\s*\?\s*d\s*:\s*d\.assets\s*\|\|\s*\[\]/);
        });
    });

    describe('Bug 4 — dashboard card filtering', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
        );

        it('the four core entities are chart-bound via their kpiKey binding', () => {
            // The old `CHART_BOUND_KPIS` set was a vestigial classifier —
            // once tasks/policies got their own donuts it listed EVERY
            // KPI, making it a no-op (see the sibling assertion: every
            // tile is chart-bound, none navigates). It was removed as
            // dead code (CodeQL js/unused-local-variable). The real
            // chart-focus mechanism is the per-tile `kpiKey` binding,
            // asserted here directly.
            expect(src).toMatch(/kpiKey="coverage"/);
            expect(src).toMatch(/kpiKey="risks"/);
            expect(src).toMatch(/kpiKey="evidence"/);
            expect(src).toMatch(/kpiKey="findings"/);
        });

        it('tasks + policies are now chart-bound (own a donut) — no navigation', () => {
            // Superseded the original B1 workaround: tasks/policies used
            // to navigate to their list page because they had no chart to
            // focus. They now own the Task-status / Policy-status donuts,
            // so EVERY KPI tile focuses a chart and none navigates.
            expect(src).toMatch(/['"]tasks['"]/);
            expect(src).toMatch(/['"]policies['"]/);
            // The nav map is gone; a click only toggles chart focus.
            expect(src).not.toMatch(/KPI_NAV_HREF/);
            // Each KPI's donut box is bound to its key.
            expect(src).toMatch(/<StatusDonutSection[\s\S]*?kpiKey="tasks"/);
            expect(src).toMatch(/<StatusDonutSection[\s\S]*?kpiKey="policies"/);
        });

        it('all four chart-bound trend cards are wrapped in ChartFocusWrapper', () => {
            // The TrendSection block spans ~30 lines and contains four
            // <TrendCard> instances, each now under a wrapper.
            const block = src.slice(
                src.indexOf('function TrendSection'),
                src.indexOf('function TrendEmptyState'),
            );
            const wrapperCount = (block.match(/<ChartFocusWrapper kpiKey="/g) ?? []).length;
            expect(wrapperCount).toBe(4);
        });

        // (The dashboard's Risk Matrix + Evidence Expiry widgets — and their
        // chart-focus wrappers — were removed; that B1 binding test retired
        // with them. The four TrendCard focus wrappers above still hold.)
    });
});
