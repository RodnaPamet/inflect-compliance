/**
 * PR-A — Dashboard balance + Reports card ratchet.
 *
 *   1. The Evidence Status surface is now a single `<Card>` with a
 *      `<Heading>` + a non-wrapping `<StatusBreakdown>` + an
 *      optional trend mini-chart, matching the Compliance Alerts
 *      card's visual weight. The Card carries the canonical
 *      `id="evidence-status"` E2E selector preserved from the
 *      pre-PR-A composition.
 *
 *   2. The Control Coverage `<ProgressCard>` accepts a `trend`
 *      prop and the dashboard threads the coverage-over-time
 *      series into it.
 *
 *   3. `<ProgressCard>` itself renders the trend slot below the
 *      segment legend (gated on `trend.points.length > 0`) and
 *      uses the shared `<TrendCard>` primitive — no hand-rolled
 *      sparkline.
 *
 *   4. The Reports SoA tab table card uses the canonical
 *      `cardVariants()` density (was `density: 'none'`) so the
 *      table presentation matches the Controls / Risks / Assets
 *      list pages.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-A — dashboard balance + reports card', () => {
    describe('ProgressCard trend slot', () => {
        const src = read('src/components/ui/ProgressCard.tsx');

        it('declares the ProgressCardTrend prop shape', () => {
            expect(src).toMatch(/export interface ProgressCardTrend/);
            expect(src).toMatch(
                /points:\s*ReadonlyArray<\{\s*date:\s*Date;\s*value:\s*number\s*\}>/,
            );
            expect(src).toMatch(/colorClassName:\s*string/);
        });

        it('renders the trend via the shared TrendCard primitive', () => {
            // The trend mini-chart MUST go through TrendCard — a
            // hand-rolled svg+polyline would diverge visually from
            // the Trend section below. Anchor on both the import
            // and the JSX usage in the trend branch.
            expect(src).toMatch(
                /import\s*\{\s*TrendCard\s*\}\s*from\s*['"]@\/components\/ui\/TrendCard['"]/,
            );
            // The JSX usage sits inside the `trend &&
            // trend.points.length > 0` branch.
            expect(src).toMatch(
                /trend &&\s*trend\.points\.length > 0[\s\S]{0,800}<TrendCard\b/,
            );
            // Stable testid lets the dashboard ratchet locate the
            // trend slot without coupling to internal structure.
            expect(src).toMatch(/data-testid="progress-card-trend"/);
        });
    });

    describe('Dashboard adoption', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
        );

        it('passes the coverage trend to the Control Coverage card', () => {
            // Anchor on the `<ProgressCard id="control-coverage"` so
            // a future refactor that swaps the card identity has to
            // touch this assertion too.
            expect(src).toMatch(
                /ProgressCard[\s\S]{0,2000}id="control-coverage"[\s\S]{0,3000}trend=\{[\s\S]{0,400}trendBundle\?\.coverage/,
            );
        });
    });

    describe('Reports SoA table card', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/reports/soa/SoAClient.tsx',
        );

        it('uses default cardVariants density (no `density: "none"`)', () => {
            // Anchor the assertion to the SoA-table card-card
            // div via the new testid. The pre-PR-A wrapper passed
            // `density: 'none'`; matching the Controls/Risks list-
            // page DataTable card means the card-default density.
            //
            // The "soa-table-card" anchor + the `cardVariants()`
            // call site appear inside the same JSX expression. A
            // future refactor that forgets the default density will
            // re-introduce `cardVariants({ density: 'none' })` here
            // and trip the second assertion.
            const cardIdx = src.indexOf('data-testid="soa-table-card"');
            expect(cardIdx).toBeGreaterThan(0);
            // The preceding ~150 chars are the wrapper open tag.
            const wrapper = src.slice(Math.max(0, cardIdx - 200), cardIdx + 80);
            expect(wrapper).toMatch(/cardVariants\(\)/);
            expect(wrapper).not.toMatch(/density:\s*['"]none['"]/);
        });
    });
});
