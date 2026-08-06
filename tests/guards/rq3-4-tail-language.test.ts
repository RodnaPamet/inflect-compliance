/**
 * RQ3-4 — "tail-aware language, everywhere" ratchet.
 *
 * Regression class guarded: a per-risk ALE surface dropping back to a bare
 * mean where tail data exists. Every named surface (list chip, detail meta
 * strip, explainer quant line, coherence rows, top-10, PDF/PPTX rows) must
 * render through the ONE formatter — `formatTailAwareAle` in
 * `src/lib/tail-language.ts`.
 *
 * SCOPE (narrowed 2026-08-06, B3-2). This file used to also assert:
 *
 *   - the formatter's UI copy verbatim, including an EM-DASH:
 *     `/\(mean — run a simulation for tails\)/` and
 *     `/bad year \$\{money\(aleP90\)\} \(P90\)/`. Copy-editing a string —
 *     or typing a hyphen where an em-dash was — turned CI red. Wording is
 *     not an architectural contract, and asserting it here means the build
 *     breaks for a change no user could call a regression.
 *   - literal LOOP-VARIABLE names: `formatTailAwareAle\(row\.ale, …` and
 *     `\(f\.ale, …`. Renaming `f` to `finding` failed the build.
 *   - a MAGIC BYTE WINDOW into RisksClient.tsx — `indexOf('data-testid=…')`
 *     to the next `</span>` — to check the chip body. Any upstream edit
 *     that moved the markup silently changed what was being asserted.
 *
 * What survives is the one thing a reader would actually call a contract:
 * each surface routes through the shared formatter and the tail endpoint
 * stays wired to the RQ3-1 cache. Even that is source-regex, so B3-4
 * replaces it with a rendered test that asserts the VISIBLE two-register
 * output. See CLAUDE.md → "Epic-ratchet lifecycle".
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const lib = read('src/lib/tail-language.ts');
const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const detailPage = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const explainer = read('src/app-layer/usecases/risk-score-explanation.ts');
const renderer = read('src/app-layer/reports/risk-report-render.ts');
const reportUsecase = read('src/app-layer/usecases/risk-report.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/tail-percentiles/route.ts');

describe('RQ3-4 — one formatter, two registers', () => {
    test('the formatter exists and only claims a tail when P90 exceeds the mean', () => {
        expect(lib).toMatch(/export function formatTailAwareAle/);
        // The guard that matters: P90 at or below the mean is not tail data,
        // so the second register must not render. This is a condition, not
        // copy — the wording around it is free to change.
        expect(lib).toMatch(/aleP90 > aleMean/);
    });

    test('the cache endpoint serves the RQ3-1 spine', () => {
        expect(route).toMatch(/getPerRiskPercentiles/);
        expect(route).toMatch(/export const GET = withApiErrorHandling/);
    });
});

describe('RQ3-4 — zero surfaces render a bare mean where tails exist', () => {
    test('risk register chip', () => {
        expect(risksClient).toMatch(/formatTailAwareAle\(/);
        expect(risksClient).toMatch(/\/risks\/tail-percentiles/);
    });

    test('risk detail meta strip', () => {
        expect(detailPage).toMatch(/formatTailAwareAle\(/);
        expect(detailPage).toMatch(/\/risks\/tail-percentiles/);
    });

    test('score explainer quant line', () => {
        expect(explainer).toMatch(/formatTailAwareAle\(/);
        expect(explainer).toMatch(/getPerRiskPercentiles/);
    });

    test('dashboard top-10 and coherence rows', () => {
        // Both regions route through the formatter (whatever the locals are
        // named), and — the actual regression class — no ALE anywhere on the
        // page is formatted as a bare mean. The negative is the load-bearing
        // half: it stays true as widgets are added, where a call-site count
        // would not.
        expect((dashboard.match(/formatTailAwareAle\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(dashboard).not.toMatch(/money\([^)]*\.ale\b/);
        expect(dashboard).not.toMatch(/formatCompactCurrency\([^)]*\.ale\b/);
    });

    test('PDF + PPTX rows, and the CSV data column', () => {
        expect(renderer).toMatch(/formatTailAwareAle\(/);
        // The CSV header is a real external contract — consumers parse it.
        expect(renderer).toMatch(/Risk,Category,ALE,Bad year \(P90\)/);
        // The bad-year cell stays empty rather than repeating the mean when
        // there is no tail data. Asserted as a condition on aleP90 vs ale,
        // not as the exact source expression that implements it.
        expect(renderer).toMatch(/r\.aleP90 != null && r\.aleP90 > r\.ale/);
        expect(reportUsecase).toMatch(/aleP90:/);
    });
});
