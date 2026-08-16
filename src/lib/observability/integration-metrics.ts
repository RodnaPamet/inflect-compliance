/**
 * H6 — integration / check observability.
 *
 * This is a MONITORING product whose defining failure mode is a check going
 * green (or a sync corrupting data) SILENTLY. The generic `job.execution.count`
 * only reflects whether the job WRAPPER returned — it stays `success` even when
 * a collector internally recorded ERROR, resolved a false PASSED, or a sync
 * deprovisioned the tail. These domain metrics make each of those alertable.
 *
 * All lazy-initialised (mirrors `metrics.ts`) so cold start pays nothing until
 * the first emit. None of this gates `/api/readyz` — it is out-of-band +
 * fail-safe, like the audit-stream metrics; escalation is alert-based.
 */
import { metrics } from '@opentelemetry/api';

const METER_NAME = 'inflect-compliance-integrations';
function getMeter() {
    return metrics.getMeter(METER_NAME);
}

type Counter = ReturnType<ReturnType<typeof getMeter>['createCounter']>;
type Histogram = ReturnType<ReturnType<typeof getMeter>['createHistogram']>;

let _checkOutcome: Counter | null = null;
let _checkDuration: Histogram | null = null;
let _syncTruncated: Counter | null = null;
let _identityDeprovisioned: Counter | null = null;
let _scannerFindingsTruncated: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _deviceReport: Counter | null = null;
let _aiGeneration: Counter | null = null;
let _aiTokens: Histogram | null = null;

/**
 * Record the outcome of a scheduled/manual integration check as its
 * `IntegrationExecution` is finalized. `NOT_APPLICABLE` (H2) is first-class so
 * "went green" vs "no data" is distinguishable on the dashboard.
 */
export function recordCheckOutcome(attrs: { provider: string; checkType: string; status: string; durationMs?: number }): void {
    if (!_checkOutcome) _checkOutcome = getMeter().createCounter('integration.check.outcome', { description: 'Integration check outcomes by provider/check/status', unit: '1' });
    if (!_checkDuration) _checkDuration = getMeter().createHistogram('integration.check.duration', { description: 'Integration check duration', unit: 'ms' });
    const labels = { provider: attrs.provider, 'check.type': attrs.checkType, status: attrs.status };
    _checkOutcome.add(1, labels);
    if (typeof attrs.durationMs === 'number') _checkDuration.record(attrs.durationMs, labels);
    // Track last-observed timestamp per provider for the freshness gauge. A
    // silently-dead collector stops recording outcomes, so its staleness climbs.
    _lastOutcomeMs[attrs.provider] = Date.now();
}

// ─── Per-provider freshness (the "collector silently dead" detector) ───
const _lastOutcomeMs: Record<string, number> = {};
let _freshnessGaugeStarted = false;

/**
 * Register the observable gauge `integration.check.staleness_seconds` — per
 * provider, the seconds since its last recorded check outcome. A provider whose
 * collector has silently died stops emitting, so its staleness climbs without
 * bound; alert on `> N days`. In-memory (no per-scrape DB query); idempotent.
 * Register once at startup.
 */
export function startIntegrationFreshnessReporting(now: () => number = Date.now): void {
    if (_freshnessGaugeStarted) return;
    _freshnessGaugeStarted = true;
    const gauge = getMeter().createObservableGauge('integration.check.staleness_seconds', {
        description: 'Seconds since the last recorded check outcome, per provider',
        unit: 's',
    });
    gauge.addCallback((result) => {
        try {
            for (const [provider, ts] of Object.entries(_lastOutcomeMs)) {
                result.observe(Math.max(0, Math.round((now() - ts) / 1000)), { provider });
            }
        } catch {
            /* noop — the gauge simply won't report this cycle */
        }
    });
}

/** Reset in-memory freshness state (testing only). @internal */
export function _resetIntegrationFreshnessForTesting(): void {
    for (const k of Object.keys(_lastOutcomeMs)) delete _lastOutcomeMs[k];
    _freshnessGaugeStarted = false;
}

/**
 * An enumeration hit its cap with more pages available (identity or HRIS). A
 * non-zero rate is the H3 silent-truncation signature.
 */
export function recordSyncTruncated(attrs: { provider: string }): void {
    if (!_syncTruncated) _syncTruncated = getMeter().createCounter('integration.sync.truncated', { description: 'Sync enumerations truncated at the cap (data-integrity risk)', unit: '1' });
    _syncTruncated.add(1, { provider: attrs.provider });
}

/**
 * The size of an identity-sync deprovision reconcile batch. A spike is the H3
 * wrongful-mass-deprovision signature — alert on sudden jumps.
 */
/**
 * A scanner ingest discarded above-threshold findings at the materialisation
 * cap. Unlike the sync caps — which were removed in favour of draining — this
 * one stays, because each skipped iteration is a WRITE and an unbounded write
 * loop is a different risk from an unbounded read. So it must be visible: a
 * non-zero rate means a compliance record is incomplete, and the CI pipeline
 * that produced the scan has no other way to learn it.
 */
export function recordScannerFindingsTruncated(attrs: { source: string; dropped: number }): void {
    if (attrs.dropped <= 0) return;
    if (!_scannerFindingsTruncated) _scannerFindingsTruncated = getMeter().createCounter('scanner.findings.truncated', { description: 'Above-threshold scanner findings dropped at the materialisation cap', unit: '1' });
    _scannerFindingsTruncated.add(attrs.dropped, { source: attrs.source });
}

export function recordIdentityDeprovisioned(attrs: { provider: string; count: number }): void {
    if (attrs.count <= 0) return;
    if (!_identityDeprovisioned) _identityDeprovisioned = getMeter().createCounter('integration.identity.deprovisioned', { description: 'Accounts deprovisioned by an identity-sync reconcile', unit: '1' });
    _identityDeprovisioned.add(attrs.count, { provider: attrs.provider });
}

/**
 * A device-agent posture report was ingested. No tenant label (cardinality) —
 * an abusive looping token surfaces as a global-rate spike.
 */
export function recordDeviceReport(): void {
    if (!_deviceReport) _deviceReport = getMeter().createCounter('integration.device.report', { description: 'Device-agent posture reports ingested', unit: '1' });
    _deviceReport.add(1);
}

/**
 * An AI generation on the questionnaire/assistant surfaces (H4 amplification
 * visibility). `feature` is a low-cardinality label; token counts feed a
 * histogram when the provider reports usage.
 */
export function recordAiGeneration(attrs: { feature: 'questionnaire' | 'assistant'; tokens?: number }): void {
    if (!_aiGeneration) _aiGeneration = getMeter().createCounter('ai.generation.count', { description: 'AI generations by feature', unit: '1' });
    _aiGeneration.add(1, { feature: attrs.feature });
    if (typeof attrs.tokens === 'number' && attrs.tokens > 0) {
        if (!_aiTokens) _aiTokens = getMeter().createHistogram('ai.generation.tokens', { description: 'AI generation token usage', unit: '1' });
        _aiTokens.record(attrs.tokens, { feature: attrs.feature });
    }
}
