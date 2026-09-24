import { codeOf } from '../helpers/source-blocks';
import { headingLines, mdSection } from '../helpers/markdown-regions';
/**
 * Observability Infrastructure Validation Tests
 *
 * Epic 19 Phase 2: Validates that the SLO documentation, Grafana dashboard,
 * and alert rules are syntactically correct, internally consistent, and
 * aligned with the actual telemetry emitted by the application.
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

// ─── Dashboard JSON Validation ─────────────────────────────────────────

describe('Grafana dashboard config', () => {
    const dashboardPath = path.join(ROOT, 'infra/dashboards/grafana-api-slos.json');

    it('should exist at infra/dashboards/grafana-api-slos.json', () => {
        expect(fs.existsSync(dashboardPath)).toBe(true);
    });

    it('should be valid JSON', () => {
        const raw = fs.readFileSync(dashboardPath, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('should have a title and uid', () => {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));
        expect(dashboard.title).toBeDefined();
        expect(dashboard.uid).toBe('inflect-compliance-slos');
    });

    it('should have at least 8 non-row panels', () => {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));
        const panels = dashboard.panels.filter((p: { type: string }) => p.type !== 'row');
        expect(panels.length).toBeGreaterThanOrEqual(8);
    });

    it('should include panels for all 4 SLO categories', () => {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));
        const titles = dashboard.panels
            .map((p: { title?: string }) => p.title?.toLowerCase() || '')
            .join(' ');

        expect(titles).toContain('availability');
        expect(titles).toContain('latency');
        expect(titles).toContain('error rate');
        expect(titles).toContain('request rate');
    });

    it('should include job execution metric panels', () => {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));
        const titles = dashboard.panels
            .map((p: { title?: string }) => p.title?.toLowerCase() || '')
            .join(' ');

        expect(titles).toContain('job execution');
        expect(titles).toContain('job duration');
        expect(titles).toContain('queue depth');
    });

    it('should reference real OTel metric names (api_request_count, api_request_duration)', () => {
        const raw = fs.readFileSync(dashboardPath, 'utf-8');
        expect(raw).toContain('api_request_count');
        expect(raw).toContain('api_request_duration');
    });

    it('should exclude health probes from latency queries', () => {
        const raw = fs.readFileSync(dashboardPath, 'utf-8');
        // The latency panels should filter out livez/readyz/health
        expect(raw).toContain('/api/(livez|readyz|health');
    });

    it('should have unique panel IDs', () => {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf-8'));
        const ids = dashboard.panels.map((p: { id: number }) => p.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
    });

    it('should use Prometheus datasource references', () => {
        const raw = fs.readFileSync(dashboardPath, 'utf-8');
        expect(raw).toContain('DS_PROMETHEUS');
    });
});

// ─── Alert Rules Validation ────────────────────────────────────────────

describe('Alert rules config', () => {
    const alertsPath = path.join(ROOT, 'infra/alerts/rules.yml');

    it('should exist at infra/alerts/rules.yml', () => {
        expect(fs.existsSync(alertsPath)).toBe(true);
    });

    it('should contain all required alert names', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        const requiredAlerts = [
            'ApiErrorRateWarning',
            'ApiErrorRateCritical',
            'ApiP95LatencyWarning',
            'ApiP95LatencyCritical',
            'ReadyzProbeFailure',
            'ReadyzProbeCritical',
            'LivezProbeFailure',
            'ApiAvailabilityBurnRateHigh',
            'JobFailureRateWarning',
            'QueueDepthBacklogWarning',
        ];

        for (const alert of requiredAlerts) {
            expect(raw).toContain(alert);
        }
    });

    it('should reference real OTel metric names', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        expect(raw).toContain('api_request_count');
        expect(raw).toContain('api_request_duration_bucket');
        expect(raw).toContain('job_execution_count');
        expect(raw).toContain('job_queue_depth');
    });

    it('should have severity labels on all alerts', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        // Count alert definitions vs severity labels
        const alertCount = (raw.match(/- alert:/g) || []).length;
        const severityCount = (raw.match(/severity:/g) || []).length;
        expect(severityCount).toBeGreaterThanOrEqual(alertCount);
    });

    it('should have runbook annotations on all alerts', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        const alertCount = (raw.match(/- alert:/g) || []).length;
        const descriptionCount = (raw.match(/description:/g) || []).length;
        expect(descriptionCount).toBeGreaterThanOrEqual(alertCount);
    });

    it('should have dashboard links in annotations', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        expect(raw).toContain('inflect-compliance-slos');
    });

    it('should use correct severity tiers (warning and critical only)', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        const severityMatches = raw.match(/severity:\s*(\w+)/g) || [];
        const severities = severityMatches.map(s => s.replace('severity:', '').trim());
        const validSeverities = new Set(['warning', 'critical']);
        for (const sev of severities) {
            expect(validSeverities.has(sev)).toBe(true);
        }
    });

    it('should exclude health probes from latency alerts', () => {
        const raw = fs.readFileSync(alertsPath, 'utf-8');
        expect(raw).toContain('/api/(livez|readyz|health');
    });
});

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

describe('SLO / dashboard / alert alignment', () => {
    it('should use consistent metric names across all configs', () => {
        // The SLO doc's side of the three-way comparison is its telemetry
        // INVENTORY — the section that declares which metrics the SLOs stand
        // on. Document-wide the two needles matched 11 and 10 times, so a
        // PromQL sample or a revision-history line satisfied this while the
        // inventory itself said something else. Bound: 2 and 1.
        const slo = mdSection(
            fs.readFileSync(path.join(ROOT, 'docs/slos.md'), 'utf-8'),
            'Telemetry Inventory',
        );
        // JSON and YAML — data, not a commented language; left whole.
        const dashboard = fs.readFileSync(path.join(ROOT, 'infra/dashboards/grafana-api-slos.json'), 'utf-8');
        const alerts = fs.readFileSync(path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8');

        // All three should reference the same core metrics
        const coreMetrics = ['api_request_count', 'api_request_duration'];
        for (const metric of coreMetrics) {
            expect(slo).toContain(metric);
            expect(dashboard).toContain(metric);
            expect(alerts).toContain(metric);
        }
    });

    it('should reference the same dashboard UID in alerts', () => {
        const dashboard = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/dashboards/grafana-api-slos.json'), 'utf-8'));
        const alerts = fs.readFileSync(path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8');

        expect(alerts).toContain(dashboard.uid);
    });

    it('should align error rate thresholds between SLO doc and alert rules', () => {
        // Both thresholds live in SLO 1's `### Alert Thresholds` severity
        // table — the Warning and Critical rows. That is the table the alert
        // rules are supposed to mirror, so it is what this reads.
        const slo = mdSection(
            fs.readFileSync(path.join(ROOT, 'docs/slos.md'), 'utf-8'),
            'Alert Thresholds',
        );
        const alerts = fs.readFileSync(path.join(ROOT, 'infra/alerts/rules.yml'), 'utf-8');

        // SLO doc says error rate > 1% warning, > 5% critical
        expect(slo).toContain('error rate > 0.1%');
        expect(alerts).toContain('0.01'); // 1% as decimal

        expect(slo).toContain('error rate > 0.5%');
        expect(alerts).toContain('0.05'); // 5% as decimal
    });

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
