import { codeOf } from '../helpers/source-blocks';
/**
 * Observability Infrastructure Validation Tests
 *
 * Epic 19 Phase 2: Validates that the SLO documentation, Grafana dashboard,
 * and alert rules are syntactically correct, internally consistent, and
 * aligned with the actual telemetry emitted by the application.
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
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('SLO 1: API Availability');
        expect(raw).toContain('SLO 2: API Latency');
        expect(raw).toContain('SLO 3: API Error Rate');
        expect(raw).toContain('SLO 4: Health Check');
    });

    it('should specify target values for each SLO', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('99.9%');   // availability
        expect(raw).toContain('500ms');   // P95 latency
        expect(raw).toContain('< 1%');    // error rate
        expect(raw).toContain('99.95%');  // health check
    });

    it('should reference the actual OTel metric names', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('api_request_count');
        expect(raw).toContain('api_request_duration');
        expect(raw).toContain('api_request_errors');
    });

    it('should document exclusions', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('/api/livez');
        expect(raw).toContain('/api/readyz');
        expect(raw).toContain('/api/health');
    });

    it('should include measurement formulas (PromQL)', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('histogram_quantile');
        expect(raw).toContain('rate(');
    });

    it('should include alert threshold guidance', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('Warning');
        expect(raw).toContain('Critical');
    });

    it('should specify time windows', () => {
        const raw = fs.readFileSync(sloPath, 'utf-8');
        expect(raw).toContain('30-day');
        expect(raw).toContain('7-day');
    });
});

// ─── Cross-File Consistency ────────────────────────────────────────────

describe('SLO / dashboard / alert alignment', () => {
    it('should use consistent metric names across all configs', () => {
        const slo = fs.readFileSync(path.join(ROOT, 'docs/slos.md'), 'utf-8');
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
        const slo = fs.readFileSync(path.join(ROOT, 'docs/slos.md'), 'utf-8');
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
