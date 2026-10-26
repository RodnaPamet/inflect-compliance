import { codeOf } from '../helpers/source-blocks';
import { headingLines, mdSection } from '../helpers/markdown-regions';
/**
 * Observability Infrastructure Validation Tests
 *
 * Epic 19 Phase 2: Validates that the SLO documentation is complete and
 * names the telemetry the application actually emits.
 *
 * ── #2246 Class A: every `docs/slos.md` assertion is NARROWED ──────────
 *
 * This file held the largest single-document population left in the issue —
 * 23 assertions, all against the whole 32 KB of `docs/slos.md`. A whole-
 * document read is what makes a documentation guard un-failable: the needle
 * only has to appear SOMEWHERE, and `slos.md` carries a summary table, a
 * load-test chapter, a metric-dependency appendix and a revision history, so
 * nearly every term in it appears several times in places the assertion is not
 * about. Measured over the live document, whole-document → bound region:
 *
 *     500ms                 11 → 1     api_request_count     11 → 2
 *     99.9%                  4 → 1     /api/livez             6 → 1
 *     < 1%                   4 → 1     /api/readyz            6 → 1
 *     Critical               7 → 1     30-day                 6 → 1
 *     SLO 1 (heading)       14 → 1     7-day                  3 → 1
 *
 * A masker is the wrong tool here and was measured as such: `mdCodeOf` keeps
 * a document's CODE and blanks its PROSE, and of the needles above it takes
 * `500ms`, `99.9%`, `99.95%`, `< 1%`, `30-day`, `7-day` and every `SLO N`
 * heading to ZERO — an assertion that could never fail again. The identifier
 * needles (`api_request_count`, `histogram_quantile`, the probe paths) survive
 * it at their FULL count, so it would have bought nothing for them either.
 *
 * No needle reaches zero under the regions below; each was counted twice
 * before the edit. `mdSection` binds to the FIRST heading of a given text, so
 * the repeated `### Exclusions` / `### Alert Thresholds` / `### Measurement
 * Formula` sections resolve to SLO 1's and SLO 2's respectively — which is
 * why the two that need a different SLO's copy nest the call.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// The Grafana dashboard and alert-rule blocks that stood here read
// infra/dashboards/grafana-api-slos.json and infra/alerts/rules.yml, which no
// stack ever loaded and were deleted on 2026-10-26. The rules and dashboards
// the Prometheus stack does load are held to the metrics the app emits by
// tests/unit/prometheus-rules-match-emitted-metrics.test.ts.

// ─── SLO Documentation Validation ──────────────────────────────────────

describe('SLO documentation', () => {
    const sloPath = path.join(ROOT, 'docs/slos.md');

    it('should exist at docs/slos.md', () => {
        expect(fs.existsSync(sloPath)).toBe(true);
    });

    it('should define all 4 SLOs', () => {
        // "DEFINE an SLO" = it has a `##` section. Bound to the level-2
        // heading lines, a summary-table row or a cross-reference no longer
        // stands in for the section existing.
        const sections = headingLines(fs.readFileSync(sloPath, 'utf-8'), 2);
        expect(sections).toContain('SLO 1: API Availability');
        expect(sections).toContain('SLO 2: API Latency');
        expect(sections).toContain('SLO 3: API Error Rate');
        expect(sections).toContain('SLO 4: Health Check');
    });

    it('should specify target values for each SLO', () => {
        // `## SLO Summary Table` is literally the place the document states
        // every target, and it holds all four needles exactly once. Against
        // the whole document `500ms` matched 11 times — nine of them k6
        // budgets and revision-history entries that are not targets at all.
        const targets = mdSection(
            fs.readFileSync(sloPath, 'utf-8'),
            'SLO Summary Table',
        );
        expect(targets).toContain('99.9%');   // availability
        expect(targets).toContain('500ms');   // P95 latency
        expect(targets).toContain('< 1%');    // error rate
        expect(targets).toContain('99.95%');  // health check
    });

    it('should reference the actual OTel metric names', () => {
        // The inventory section is where the document names its telemetry;
        // whole-document counts 11 / 10 / 3 → 2 / 1 / 1 here.
        const inventory = mdSection(
            fs.readFileSync(sloPath, 'utf-8'),
            'Telemetry Inventory',
        );
        expect(inventory).toContain('api_request_count');
        expect(inventory).toContain('api_request_duration');
        expect(inventory).toContain('api_request_errors');
    });

    it('should document exclusions', () => {
        // The first `### Exclusions` is SLO 1's, and it is the table that
        // lists these three probes as excluded — 6 / 6 / 4 document-wide,
        // 1 / 1 / 1 here. The other matches are the probes being DISCUSSED,
        // which is not the same as being excluded.
        const exclusions = mdSection(fs.readFileSync(sloPath, 'utf-8'), 'Exclusions');
        expect(exclusions).toContain('/api/livez');
        expect(exclusions).toContain('/api/readyz');
        expect(exclusions).toContain('/api/health');
    });

    it('should include measurement formulas (PromQL)', () => {
        // SLO 2's own `### Measurement Formula` — the percentile formula.
        // SLO 1's (the first in the document) computes a ratio and carries no
        // `histogram_quantile`, so the nested call is load-bearing, not tidy.
        const raw = fs.readFileSync(sloPath, 'utf-8');
        const formula = mdSection(
            mdSection(raw, 'SLO 2: API Latency — Reads (P95)'),
            'Measurement Formula',
        );
        expect(formula).toContain('histogram_quantile');
        expect(formula).toContain('rate(');
    });

    it('should include alert threshold guidance', () => {
        // The first `### Alert Thresholds` is SLO 1's severity table.
        // `Warning` matched 4 times and `Critical` 7 across the document —
        // including a `## Critical user journeys` heading in the load-test
        // chapter, which has nothing to do with alert severity.
        const thresholds = mdSection(
            fs.readFileSync(sloPath, 'utf-8'),
            'Alert Thresholds',
        );
        expect(thresholds).toContain('Warning');
        expect(thresholds).toContain('Critical');
    });

    it('should specify time windows', () => {
        // Two different SLOs, so two regions: the 30-day window belongs to
        // SLO 1 and the 7-day one to SLO 4. Binding both to either would take
        // one of them to zero — measured, and the reason this is not one call.
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(
            mdSection(mdSection(raw, 'SLO 1: API Availability'), 'Time Window'),
        ).toContain('30-day');
        expect(
            mdSection(
                mdSection(raw, 'SLO 4: Health Check Availability'),
                'Time Window',
            ),
        ).toContain('7-day');
    });
});

// ─── Cross-File Consistency ────────────────────────────────────────────

describe('SLO / collector / code alignment', () => {
    it('should have a matching OTel Collector config', () => {
        const collectorConfig = path.join(ROOT, 'infra/otel-collector/config.yml');
        expect(fs.existsSync(collectorConfig)).toBe(true);

        const raw = fs.readFileSync(collectorConfig, 'utf-8');
        expect(raw).toContain('4318'); // OTLP HTTP port
        expect(raw).toContain('prometheusremotewrite');
    });

    it('should align SLO metric names with the code emitting them', () => {
        // Verify the metrics.ts file uses the same metric base names
        const metricsCode = codeOf(
            fs.readFileSync(
            path.join(ROOT, 'src/lib/observability/metrics.ts'), 'utf-8'
        ),
        );

        // metrics.ts uses OTel dot-notation: api.request.count
        // SLOs + dashboards use Prometheus underscore-notation: api_request_count
        // These must be the same metric (dots → underscores)
        expect(metricsCode).toContain("'api.request.count'");
        expect(metricsCode).toContain("'api.request.duration'");
        expect(metricsCode).toContain("'api.request.errors'");
    });
});
