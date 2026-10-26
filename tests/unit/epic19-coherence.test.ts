import { codeOf } from '../helpers/source-blocks';
import { headingLines, mdSection } from '../helpers/markdown-regions';
/**
 * Epic 19 Coherence Guards — Observability & Operational Readiness
 *
 * End-to-end guardrails ensuring:
 * 1. All metrics referenced in dashboards/alerts are emitted by code
 * 2. Dashboard/alert/SLO naming is consistent
 * 3. Route normalization prevents cardinality explosion
 * 4. Health probes are public and correctly routed
 * 5. Barrel exports cover all observability APIs
 * 6. No stray metric name drift between code and infra
 *
 * These tests protect against:
 * - Adding a dashboard panel that references a metric the app doesn't emit
 * - Renaming a metric in code without updating dashboard queries
 * - Breaking probe auth bypass
 * - Forgetting to export new observability functions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

const readAll = (dir: string, ext: string): string =>
    fs.readdirSync(path.join(ROOT, dir))
        .filter((f) => f.endsWith(ext))
        .sort()
        .map((f) => fs.readFileSync(path.join(ROOT, dir, f), 'utf-8'))
        .join('\n');
const OBS_DASHBOARDS = readAll('infra/observability/grafana/dashboards', '.json');
const OBS_RULES = readAll('infra/observability/prometheus/rules', '.yml');
const ALERTING_RULES_PATH = 'infra/observability/prometheus/rules/alerting-rules.yml';

// ─── 1. Metric Emission ↔ Dashboard/Alert Coherence ────────────────────

describe('Epic 19 Coherence: metric names', () => {
    // OTel dot-notation names from metrics.ts
    // #2246 — the ONE TypeScript read in this file is masked at the seam. The
    // Grafana dashboard read below is JSON handed to JSON.parse, and the alert
    // rules read is YAML; neither is a language `codeOf` lexes and both stay
    // raw deliberately rather than spelling the wrong lexer.
    const metricsCode = codeOf(
        fs.readFileSync(path.join(SRC, 'lib/observability/metrics.ts'), 'utf-8'),
    );

    // Extract all OTel metric names (dot-notation)
    const otelNames = (metricsCode.match(/'([a-z]+\.[a-z]+\.[a-z.]+)'/g) || [])
        .map(m => m.replace(/'/g, ''))
        .filter(m => !m.startsWith('http.') && !m.startsWith('error.') && !m.startsWith('job.name')
            && !m.startsWith('job.status') && !m.startsWith('queue.'));

    // What the Prometheus stack loads: every dashboard it provisions and every
    // rule file it reads. infra/dashboards/ and infra/alerts/rules.yml stood
    // here until 2026-10-26; nothing ever loaded either.
    const dashboardContent = OBS_DASHBOARDS;
    const alertContent = OBS_RULES;

    it('should emit all 6 metrics referenced in infra configs', () => {
        const expectedMetrics = [
            'api.request.count',
            'api.request.duration',
            'api.request.errors',
            'job.execution.count',
            'job.execution.duration',
            'job.queue.depth',
        ];

        for (const metric of expectedMetrics) {
            expect(metricsCode).toContain(`'${metric}'`);
        }
    });

    it('should reference every SLO-relevant metric in the dashboard or alerts (Prometheus convention)', () => {
        // Metrics that are intentionally diagnostic-only and not required in dashboards/alerts.
        // - api.request.errors provides per-error-code breakdown; SLO alerts use
        //   api.request.count{status=5xx} instead, which is the business-relevant signal.
        // - repo.method.duration is per-repository-method timing emitted by the
        //   tracing layer; it shows up as span attributes in OTel traces and is
        //   used ad-hoc when chasing slow queries, not on the SLO board.
        const diagnosticOnly = new Set([
            // ─── ASI08/ASI10 agentic controls ───
            //
            // The three that say a CONTROL FAILED have alerts:
            // kill_switch.drill (the stop control is broken or unverified),
            // circuit_breaker.trip (the rogue-agent signal fired), and
            // fanout.halted (a sweep stopped with members unattempted). The rest
            // are the controls WORKING, and an alert on a control working is how
            // an on-call learns to ignore the page.
            //
            // Each is read from the admin surfaces named beside it, and each is
            // the denominator or the detail for one of the three above.
            'agentic.circuit_breaker.verdict',   // per-evaluation; the trip is the event
            'agentic.circuit_breaker.refusal',   // a tripped agent being refused — expected while latched
            'agentic.circuit_breaker.close',     // an operator closing a breaker, by reason
            'agentic.kill_switch.refusal',       // a killed agent being refused — expected, and the point
            'agentic.fanout.member_failed',      // isolation working: one member failed, the sweep continued
            'agentic.run.cap.halt',              // a run hit a declared ceiling — a capacity fact, not an incident
            'agentic.run.cap.utilisation',       // how close healthy runs run to their caps; the leading indicator
            // Size of each sealed workflow-context envelope. The SLO signal for
            // this subsystem is the HALT counter, which has its own critical
            // alert; the size distribution is what an operator reads *after*
            // that fires, to tell the benign cap breach from the tampering
            // codes. A distribution is also the wrong shape for an SLO board
            // whose panels are API/health and job metrics.
            'agentic.workflow.context.bytes',
            // Steps and tokens per agentic run (#3484). "Runs got longer" is a
            // trend to look at, not a page, so neither has an alert; their only
            // panels were on infra/dashboards/grafana-api-slos.json, which no
            // Grafana loaded and which was deleted on 2026-10-26.
            'agent.run.steps',
            'agent.run.tokens',
            'api.request.errors',
            'repo.method.duration',
            // EI-4 — SCIM bearer-token auth outcome counter. A diagnostic
            // signal (brute-force / stale-connector detection) alerted ad-hoc,
            // not an SLO-board metric, so it isn't on the SLO dashboard.
            'scim.auth.count',
            // Aggregation cache hit/miss/compute timing — operators watch the
            // per-aggregation hit ratio ad-hoc in Grafana (see
            // docs/response-caching.md), but it's a performance diagnostic,
            // not an SLO board signal.
            'cache.aggregation.hit',
            'cache.aggregation.miss',
            'cache.aggregation.compute_duration_ms',
            // Perf measurement foundation — slow-query counter. A
            // performance diagnostic watched ad-hoc in Grafana (a model-
            // labelled "suspicious query" signal), not an SLO-board metric.
            'db.slow_query.count',
            // SSR payload cache — per-route hit ratio / fetch timing. A
            // performance diagnostic (watch hit ratio in Grafana), not an
            // SLO-board metric.
            'cache.ssr.hit',
            'cache.ssr.miss',
            'cache.ssr.duration',
            // AI decision log (EU AI Act Art 12/14) — AI-ops quality signals
            // (invocation volume, guard-block rate, human-acceptance rate).
            // Watched ad-hoc for AI drift/cost/quality; not an API-SLO board
            // metric (same class as the ai.risk_assessment.* diagnostics).
            'ai.decision.logged',
            'ai.decision.guard_blocks',
            'ai.decision.outcome',
        ]);

        // Dot → underscore: api.request.count → api_request_count
        for (const otelName of otelNames) {
            if (diagnosticOnly.has(otelName)) continue;

            const promName = otelName.replace(/\./g, '_');
            const referencedInDashboard = dashboardContent.includes(promName);
            const referencedInAlerts = alertContent.includes(promName);

            if (!referencedInDashboard && !referencedInAlerts) {
                fail(
                    `Metric '${otelName}' (Prometheus: '${promName}') is emitted by metrics.ts ` +
                    `but not referenced in any dashboard panel or alert rule. ` +
                    `Either add a panel/alert or add to diagnosticOnly set.`
                );
            }
        }
    });
    // The reverse direction (no dashboard or rule names a metric the app does
    // not emit) is tests/unit/prometheus-rules-match-emitted-metrics.test.ts,
    // which applies the collector's real naming rather than a suffix pattern.
});

// ─── 2–3. Alert Rule Coherence ────────────────────────────────────────
//
// The dashboard-structure block that was section 2 counted the panels of
// infra/dashboards/grafana-api-slos.json, and section 3 counted names in
// infra/alerts/rules.yml. Neither file was ever loaded by anything, and both
// were deleted on 2026-10-26. The security-control and agentic-run alerts
// moved to the rule file the Prometheus stack reads, and this holds them there.

describe('Epic 19 Coherence: alert rules', () => {
    type Rule = { alert?: string; record?: string; labels?: Record<string, string> };
    type Group = { name: string; rules: Rule[] };
    const groups = (yaml.load(fs.readFileSync(path.join(ROOT, ALERTING_RULES_PATH), 'utf-8')) as {
        groups: Group[];
    }).groups;
    const alertsIn = (group: string): string[] =>
        (groups.find((g) => g.name === group)?.rules ?? []).flatMap((r) => (r.alert ? [r.alert] : []));

    // Fire when a security control STOPS applying, or could not be verified,
    // while the system stays otherwise healthy: the condition nothing else
    // surfaces.
    const SECURITY_ALERT_NAMES = [
        'SessionPolicyResolutionFailing',
        'AgenticWorkflowContextIntegrityHalt',
        'AgenticKillSwitchDrillFailed',
        'AgenticKillSwitchDrillUnverified',
        'AgenticCircuitBreakerTripped',
        'AgenticFanOutHalted',
    ];

    // The health of agentic WORK (#3484): is it finishing, being stopped,
    // accumulating. A guard block is a control working, so these are not in
    // the group above.
    const AGENTIC_RUN_ALERT_NAMES = [
        'AgenticRunFailureRateWarning',
        'AgenticGuardBlocksRising',
        'AgenticRunsInFlightSustained',
        'AgenticRunsStartedNotSettling',
    ];

    it('the security_controls group holds exactly the security-control alerts', () => {
        expect(alertsIn('security_controls')).toEqual(SECURITY_ALERT_NAMES);
    });

    it('the agentic_runs group holds exactly the agentic-run alerts', () => {
        expect(alertsIn('agentic_runs')).toEqual(AGENTIC_RUN_ALERT_NAMES);
    });

    it('every alert carries a warning or critical severity', () => {
        const bad = groups.flatMap((g) =>
            g.rules
                .filter((r) => r.alert && !['warning', 'critical'].includes(r.labels?.severity ?? ''))
                .map((r) => `${g.name}/${r.alert}: severity ${r.labels?.severity ?? '(none)'}`),
        );
        expect(bad).toEqual([]);
    });
});

// ─── 4. SLO Document Coherence ─────────────────────────────────────────

describe('Epic 19 Coherence: SLO document', () => {
    const sloContent = fs.readFileSync(
        path.join(ROOT, 'docs/slos.md'), 'utf-8'
    );
    // The two cases below also compared these targets with the thresholds in
    // infra/alerts/rules.yml (> 500, > 2000, 0.001), a file nothing loaded,
    // deleted 2026-10-26. No running alert mirrors the SLO thresholds; the
    // doc's SLO sections say so where they name each SLO's alert.

    it('should define all 4 SLOs', () => {
        // #2246 — "DEFINE an SLO" means a `##` section exists for it, so the
        // read is the level-2 heading lines and not the whole document. Over
        // the document `SLO 1` matched 14 times and `SLO 2` eighteen: the
        // section could be deleted outright and a cross-reference, a summary
        // table row or a revision-history entry kept this green. Narrowed the
        // counts are 1 / 2 / 1 / 1 — the two for `SLO 2` being `SLO 2` and its
        // `SLO 2b` write-latency sibling, both real level-2 sections.
        const sections = headingLines(sloContent, 2);
        expect(sections).toContain('SLO 1');
        expect(sections).toContain('SLO 2');
        expect(sections).toContain('SLO 3');
        expect(sections).toContain('SLO 4');
    });

    it('SLO 2 states its 500ms read target', () => {
        // SLO says < 500ms for P95 — in the read-latency SLO's own section.
        // `500ms` matched 11 times document-wide (k6 budgets, the revision
        // history, the summary table); bound to the section that sets it, 4.
        expect(mdSection(sloContent, 'SLO 2: API Latency — Reads (P95)')).toContain(
            '500ms',
        );
    });

    it('SLO 1 states its 99.9% availability target', () => {
        // 4 matches document-wide → 3 inside the availability SLO.
        expect(mdSection(sloContent, 'SLO 1: API Availability')).toContain('99.9%');
    });
});

// ─── 5. Health Probe Auth Bypass ───────────────────────────────────────

describe('Epic 19 Coherence: probe auth bypass', () => {
    const { isPublicPath } = require('../../src/lib/auth/guard');

    it('livez is publicly accessible', () => {
        expect(isPublicPath('/api/livez')).toBe(true);
    });

    it('readyz is publicly accessible', () => {
        expect(isPublicPath('/api/readyz')).toBe(true);
    });

    it('health (legacy) is publicly accessible', () => {
        expect(isPublicPath('/api/health')).toBe(true);
    });

    it('livez route file exists', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/livez/route.ts'))).toBe(true);
    });

    it('readyz route file exists', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/readyz/route.ts'))).toBe(true);
    });

    it('health route file exists (legacy compat)', () => {
        expect(fs.existsSync(path.join(SRC, 'app/api/health/route.ts'))).toBe(true);
    });
});

// ─── 6. Barrel Export Completeness ─────────────────────────────────────

describe('Epic 19 Coherence: barrel exports', () => {
    const barrel = codeOf(
        fs.readFileSync(path.join(SRC, 'lib/observability/index.ts'), 'utf-8'),
    );

    const requiredExports = [
        // Logger
        'logger', 'createChildLogger',
        // Context
        'runWithRequestContext', 'getRequestContext',
        // Tracing
        'traceUsecase', 'traceOperation',
        // Sentry
        'captureError', 'initSentry',
        // Metrics
        'recordRequestMetrics', 'recordRequestError',
        'recordJobMetrics', 'startQueueDepthReporting', 'normalizeRoute',
        // Job runner
        'runJob',
    ];

    for (const name of requiredExports) {
        it(`should export '${name}'`, () => {
            expect(barrel).toContain(name);
        });
    }
});

// ─── 7. Observability Doc Coherence ────────────────────────────────────

describe('Epic 19 Coherence: documentation', () => {
    it('observability.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'docs/observability.md'))).toBe(true);
    });

    it('slos.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'docs/slos.md'))).toBe(true);
    });

    it('infra/README.md should exist', () => {
        expect(fs.existsSync(path.join(ROOT, 'infra/README.md'))).toBe(true);
    });

    // #2246 — these read MARKDOWN, and each is narrowed to the region the
    // test names rather than masked. `mdCodeOf` keeps a document's CODE and
    // blanks its PROSE, which on a needle like `Operational Runbook` means
    // ZERO matches and an assertion that could never fail again.

    it('observability.md should reference livez, readyz, and health probes', () => {
        // The probes are documented under `## Health Probes`; whole-document
        // counts were 4 / 5 / 1, and that section holds 2 / 3 / 1. The
        // difference is the runbook's simulation commands, which mention the
        // probes without documenting them.
        const probes = mdSection(
            fs.readFileSync(path.join(ROOT, 'docs/observability.md'), 'utf-8'),
            'Health Probes',
        );
        expect(probes).toContain('/api/livez');
        expect(probes).toContain('/api/readyz');
        expect(probes).toContain('/api/health');
    });

    it('observability.md should contain a runbook section', () => {
        // The subject is a SECTION, so read the level-2 heading lines. Against
        // the document, a sentence saying "see the Operational Runbook" was
        // enough — the section itself could be gone.
        const content = fs.readFileSync(path.join(ROOT, 'docs/observability.md'), 'utf-8');
        expect(headingLines(content, 2)).toContain('Operational Runbook');
    });

});

// ─── 8. Route Normalization Stability ──────────────────────────────────

describe('Epic 19 Coherence: route normalization idempotency', () => {
    const { normalizeRoute } = require('../../src/lib/observability/metrics');

    it('normalizeRoute is idempotent (double application produces same result)', () => {
        const routes = [
            '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000',
            '/api/t/tenant-123/evidence',
            '/api/livez',
        ];

        for (const route of routes) {
            const once = normalizeRoute(route);
            const twice = normalizeRoute(once);
            expect(twice).toBe(once);
        }
    });

    it('normalizeRoute handles empty/root paths gracefully', () => {
        expect(() => normalizeRoute('')).not.toThrow();
        expect(() => normalizeRoute('/')).not.toThrow();
    });
});

// ─── 9. Job Runner emits metrics (wiring guard) ───────────────────────

describe('Epic 19 Coherence: job runner metrics wiring', () => {
    it('job-runner.ts imports recordJobMetrics', () => {
        const code = codeOf(
            fs.readFileSync(path.join(SRC, 'lib/observability/job-runner.ts'), 'utf-8'),
        );
        expect(code).toContain("import { recordJobMetrics } from './metrics'");
    });

    it('executor-registry.ts imports recordJobMetrics', () => {
        const code = codeOf(
            fs.readFileSync(path.join(SRC, 'app-layer/jobs/executor-registry.ts'), 'utf-8'),
        );
        expect(code).toContain("import { recordJobMetrics } from '@/lib/observability/metrics'");
    });

    it('withApiErrorHandling uses recordRequestMetrics', () => {
        const code = codeOf(
            fs.readFileSync(path.join(SRC, 'lib/errors/api.ts'), 'utf-8'),
        );
        expect(code).toContain('recordRequestMetrics');
    });
});

// ─── 10. Infra Config Files Valid ─────────────────────────────────────

describe('Epic 19 Coherence: infra config integrity', () => {
    it('OTel collector config exists and references OTLP port', () => {
        const raw = fs.readFileSync(
            path.join(ROOT, 'infra/otel-collector/config.yml'), 'utf-8'
        );
        expect(raw).toContain('4318');
    });
});
