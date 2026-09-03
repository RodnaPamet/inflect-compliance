/**
 * GUARDRAIL — org-dashboard chart rendering reliability.
 *
 * Every chart on the org dashboard must render reliably in production:
 * a sized container (never a 0-height collapse), client-only (the
 * auto-sizer measures the DOM, so it must run after hydration), with
 * explicit loading + empty states — no silent blank boxes.
 *
 * The bug this locks against: the Security-Maturity radar rendered as a
 * blank gray box because its auto-sizer (`ParentSize` inside
 * `<ChartFrame>`) measured a 0-height box (collapsible `min-h-0` flex
 * parent + a percentage-height chain). The fix hardened the SHARED
 * `<ChartFrame>` (the auto-sizer behind radar / line / gantt) plus the
 * maturity-widget container.
 *
 * Behavioural proof lives in tests/rendered/dashboard-radar-render.test.tsx.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const FRAME = read('src/components/ui/charts/chart-frame.tsx');
const MATURITY = read('src/app/org/[orgSlug]/(app)/OrgMaturityWidget.tsx');
const RENDERER = read(
    'src/components/ui/dashboard-widgets/ChartRenderer.tsx',
);

describe('GUARDRAIL: org dashboard chart rendering reliability', () => {
    describe('ChartFrame — the shared hardened chart container', () => {
        it('pins a definite, non-zero min-height (no 0-height collapse)', () => {
            expect(FRAME).toMatch(/DEFAULT_MIN_HEIGHT\s*=\s*([1-9]\d{2,})/);
            expect(FRAME).toMatch(/minHeight:\s*`\$\{minHeight\}px`/);
        });

        it('is client-only — gates the auto-sizer behind a mounted check', () => {
            // The DOM-measuring auto-sizer must only run after hydration.
            expect(FRAME).toMatch(/^['"]use client['"]/m);
            expect(FRAME).toMatch(/useState\(false\)/);
            expect(FRAME).toMatch(/setMounted\(true\)/);
            expect(FRAME).toMatch(/!mounted/);
        });

        it('gives the auto-sizer a guaranteed box (absolute inset-0 fill)', () => {
            // The measured area is positioned `absolute inset-0` so the
            // frame's used height resolves to its min-height — ParentSize
            // always measures a real box.
            expect(FRAME).toMatch(/absolute inset-0/);
            expect(FRAME).toMatch(/<ParentSize\b/);
        });

        it('declares loading + empty + error states (not a bare div)', () => {
            expect(FRAME).toMatch(/state\.kind === ['"]loading['"]/);
            expect(FRAME).toMatch(/state\.kind === ['"]empty['"]/);
            expect(FRAME).toMatch(/state\.kind === ['"]error['"]/);
            expect(FRAME).toMatch(/<Skeleton\b/);
            expect(FRAME).toMatch(/<EmptyState\b/);
        });

        it('floors a 0-height measure rather than painting a 0-tall chart', () => {
            expect(FRAME).toMatch(/height === 0 \? floor/);
            // …and falls back to the skeleton (never blank) on a 0 width.
            expect(FRAME).toMatch(/width === 0/);
        });
    });

    describe('OrgMaturityWidget — the bolt-on maturity radar', () => {
        it('renders the radar in a guaranteed-min-height slot', () => {
            // The chart slot carries an explicit min-h-[…px] floor — never
            // a collapsible `min-h-0` flex child (the original bug).
            expect(MATURITY).toMatch(/min-h-\[\d+px\]\s+flex-1/);
            expect(MATURITY).not.toMatch(/min-h-0\s+flex-1/);
        });

        it('shows an empty state (not a blank chart) when there is no data', () => {
            expect(MATURITY).toMatch(/chartEmpty\(\)/);
            expect(MATURITY).toMatch(/emptyFallback=/);
        });
    });

    describe('ChartRenderer — engine-rendered dashboard widgets', () => {
        it('delegates the collapsible (time-series) chart to the hardened TimeSeriesChart', () => {
            // The only renderer arm that can collapse to 0-height is the
            // ParentSize-measured time-series (`area`). It renders through
            // `<TimeSeriesChart>`, whose `<ChartFrame>` owns the non-zero
            // min-height floor asserted above. (The old orphaned
            // `ChartContentSurface` min-h-[160px] wrapper was never on the
            // render path and has been removed.)
            expect(RENDERER).toMatch(/<TimeSeriesChart/);
        });
    });
});
