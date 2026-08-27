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
let _syncConflict: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _outboundWrite: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _calendarPush: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _calendarRevoked: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _identityDeprovisioned: Counter | null = null;
let _identityLinkReconcile: Counter | null = null;
let _leaverPassOutcome: Counter | null = null;
let _leaverNotification: Counter | null = null;
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
 * Two systems of record disagreed about the same entity, and something decided
 * which one won.
 *
 * ALERTABLE ON PURPOSE, and deliberately NOT routed through the orchestrator's
 * injectable `SyncEventLogger`. That logger defaults to `noopSyncLogger`, so a
 * caller that constructs an orchestrator without one silences every conflict by
 * omission — the failure being invisible is the entire problem, and a signal
 * that can be turned off by forgetting to turn it on is not a signal.
 *
 * `resolution` distinguishes the three outcomes because they mean different
 * things operationally: `manual` parks the mapping and needs a human, while
 * `local_wins` / `remote_wins` DISCARD one side's value silently and are the
 * ones worth watching a rate on. A steady remote_wins rate on an entity people
 * edit locally means their edits are being thrown away every sync.
 */
export function recordSyncConflict(attrs: {
    provider: string;
    direction: string;
    resolution: 'local_wins' | 'remote_wins' | 'manual';
}): void {
    if (!_syncConflict) _syncConflict = getMeter().createCounter('integration.sync.conflict', { description: 'Local/remote divergence on a synced entity, by how it was resolved', unit: '1' });
    _syncConflict.add(1, { provider: attrs.provider, direction: attrs.direction, resolution: attrs.resolution });
}

/**
 * An outbound write to a remote system, by what it did.
 *
 * `adopted` is the one to watch and the reason this is not a simple
 * success/failure counter. It means a previous attempt created the remote
 * record and died before recording its id — so a non-zero rate says retries are
 * happening in the dangerous window, and a rate that ever exceeded the create
 * rate would mean the correlation lookup had stopped matching and duplicates
 * were being made. Collapsing it into `created` would hide exactly that.
 *
 * `failed` counts writes that did not happen, which is NOT the same as writes
 * that failed silently — those are the ones nothing can count, and the reason
 * the mapping validation refuses before the request rather than after it.
 */
export function recordOutboundWrite(attrs: {
    provider: string;
    action: 'created' | 'adopted' | 'updated' | 'conflict' | 'failed';
}): void {
    if (!_outboundWrite) _outboundWrite = getMeter().createCounter('integration.outbound.write', { description: 'Outbound writes to a remote system, by outcome', unit: '1' });
    _outboundWrite.add(1, { provider: attrs.provider, action: attrs.action });
}

/**
 * One user's calendar push, by outcome.
 *
 * `revoked` and `throttled` are kept SEPARATE from `failed`, and that
 * separation is the metric's whole value. A revocation is permanent and
 * actionable only by the user; a throttle is temporary and actionable only by
 * us; a failure is a bug. Collapsing them produces a single number that rises
 * for three unrelated reasons and can be acted on for none.
 *
 * PER-USER PUSH MEANS REQUEST VOLUME SCALES WITH HEADCOUNT, not tenant count,
 * so this is the surface most likely to meet a provider rate limit. A rising
 * `throttled` rate is the early warning, and it arrives long before anything
 * fails.
 *
 * Labelled by provider only. A userId label would be unbounded cardinality —
 * one metric series per employee is how an observability change becomes the
 * outage.
 */
export function recordCalendarPushOutcome(attrs: {
    provider: string;
    outcome: 'pushed' | 'nothing-to-do' | 'revoked' | 'throttled' | 'failed';
}): void {
    if (!_calendarPush) _calendarPush = getMeter().createCounter('calendar.push.outcome', { description: "One user's calendar push, by outcome", unit: '1' });
    _calendarPush.add(1, { provider: attrs.provider, outcome: attrs.outcome });
}

/**
 * A user's consent was found withdrawn, and the connection stopped.
 *
 * Separate from the `revoked` push outcome above because they answer different
 * questions: this fires ONCE per revocation and is the alertable event, while
 * the push outcome fires on the run that discovered it. If a revoked connection
 * were ever re-scheduled, the push counter would climb while this one stayed
 * flat — which is precisely the "fails every night forever" state this whole
 * module exists to prevent, made visible as a divergence between two series.
 */
export function recordCalendarConsentRevoked(attrs: { provider: string }): void {
    if (!_calendarRevoked) _calendarRevoked = getMeter().createCounter('calendar.consent.revoked', { description: 'Calendar consent found withdrawn at the provider', unit: '1' });
    _calendarRevoked.add(1, { provider: attrs.provider });
}

/**
 * The outcome of one attempted directory WRITE on the leaver path.
 *
 * Separate from `recordIdentityDeprovisioned`, which counts rows this product
 * marked deprovisioned in its OWN database. This counts what happened in a
 * CUSTOMER'S directory, and the two diverge in exactly the situations worth
 * alerting on.
 *
 * `outcome` carries every refusal distinctly rather than collapsing them,
 * because an operator's next action differs for each: REFUSED_MODE is normal
 * for a tenant still climbing the ladder, REFUSED_TARGET has TWO meanings (see
 * below), REFUSED_PROTECTED on any volume means the roster is naming service
 * accounts, and INDETERMINATE means somebody must go and look at the directory.
 *
 * REFUSED_TARGET — READ THE BASIS, NOT JUST THE COUNT. It covers three
 * situations with different responses, and the per-decision `basis.rule` on the
 * leaver pass report names which:
 *   • ON_PREM_MASTERED — a hybrid account. Disable it in AD; the LDAPS
 *     connector is what you want. This is the durable meaning.
 *   • NEVER_OBSERVED — the provider CAN answer the on-premises question and has
 *     not yet for that account. The response is to WAIT for the nightly sync,
 *     not to wire anything up; it clears itself.
 *   • PROVIDER_CANNOT_OBSERVE — okta / google-workspace, which report no
 *     on-premises flag at all. There is no sync to wait for and nothing an
 *     operator can do; the refusal is permanent until the platform learns to
 *     tell one of their accounts from a synced one.
 * NEVER_OBSERVED dominates for one deploy cycle after the onPremStateObservedAt
 * migration, which deliberately did not backfill: every pre-existing row refuses
 * that way until its next sync stamps it. Paging on the count alone during that
 * window sends someone to configure a connector they do not need.
 *
 * ALERT ON — even one INDETERMINATE, and REFUSED_PROTECTED above single
 * figures.
 */
export function recordIdentityWriteOutcome(attrs: {
    provider: string;
    action: 'disable' | 'enable' | 'create';
    outcome: string;
}): void {
    getMeter()
        .createCounter('identity.write.outcome', {
            description: 'Directory write attempts on the joiner/leaver path, by outcome',
        })
        .add(1, { provider: attrs.provider, action: attrs.action, outcome: attrs.outcome });
}

/**
 * A leaver batch refused wholesale by the blast-radius breaker.
 *
 * Deliberately its own counter rather than an `outcome` label: a tripped
 * breaker is not N refusals, it is ONE decision about a batch, and folding it
 * into the per-account counter would make a single bad roster look like a
 * hundred separate problems.
 *
 * ALERT ON — every occurrence. The breaker firing means an input looked like a
 * broken feed, which is worth a human either way.
 */
export function recordIdentityBatchRefused(attrs: {
    provider: string;
    proposed: number;
    population: number;
}): void {
    getMeter()
        .createCounter('identity.write.batch_refused', {
            description: 'Leaver batches refused whole by the blast-radius breaker',
        })
        .add(1, {
            provider: attrs.provider,
            // The COUNTS are deliberately not labels — an unbounded cardinality
            // of batch sizes would blow up the series. They belong in the log
            // line, which carries them.
        });
    void attrs.proposed;
    void attrs.population;
}

/**
 * Directory writes whose outcome was never confirmed, as a gauge-style count.
 *
 * These are the rows that need a human: PENDING (we crashed before reporting)
 * and INDETERMINATE (the call never reported back). Both mean the directory may
 * or may not have changed.
 *
 * `listUnsettledWrites` existed with NO caller, which made the whole
 * capture-before-write rail invisible in production — a rail nobody can see is
 * one nobody acts on.
 *
 * ALERT ON — a sustained non-zero.
 */
export function recordIdentityWritesUnsettled(attrs: { tenantId: string; count: number }): void {
    getMeter()
        .createCounter('identity.write.unsettled', {
            description: 'Directory writes whose outcome was never confirmed',
        })
        .add(attrs.count, { tenant_id: attrs.tenantId });
}

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

/**
 * One worker<->directory-account link-reconciliation pass.
 *
 * Emitted on EVERY terminal path including `skipped`, because the failure this
 * counter exists to catch is the pass not running at all — and a counter that
 * fires only on success makes "nothing reconciled last night" indistinguishable
 * from "nothing needed reconciling". `findLeaverCandidates` reads link
 * freshness, so a silently-stopped reconciler empties the leaver candidate set
 * without emptying any log: the leaver pass would run, report success, and
 * disable nobody.
 *
 * No tenant label — cardinality stays at roughly three outcomes x four
 * providers, and a tenant that stops reconciling shows up as a rate change.
 */
/**
 * One leaver pass, by how it ended.
 *
 * Emitted on EVERY terminal path — including the refusals and the boring
 * `no_terminated` — because the failure most likely to go unnoticed here is the
 * pass silently not running. Every other identity counter fires only when work
 * happens, so a scheduler that stopped dispatching would look exactly like a
 * quiet week. A flat non-zero rate is the signal that it is alive.
 *
 * No tenant label: roughly eight outcomes x two writable providers.
 */
export function recordLeaverPassOutcome(attrs: {
    provider: string;
    outcome:
        | 'completed'
        | 'batch_refused'
        | 'mode_disabled'
        | 'mode_above_clamp'
        | 'no_terminated'
        | 'no_fresh_links'
        | 'writer_refused'
        | 'error';
}): void {
    if (!_leaverPassOutcome)
        _leaverPassOutcome = getMeter().createCounter('identity.leaver.pass', {
            description: 'Leaver passes by terminal outcome',
            unit: '1',
        });
    _leaverPassOutcome.add(1, { provider: attrs.provider, outcome: attrs.outcome });
}

export function recordIdentityLinkReconcile(attrs: {
    provider: string;
    outcome: 'reconciled' | 'skipped' | 'error';
}): void {
    if (!_identityLinkReconcile)
        _identityLinkReconcile = getMeter().createCounter('identity.link.reconcile', {
            description: 'Worker<->directory-account link reconciliation passes by outcome',
            unit: '1',
        });
    _identityLinkReconcile.add(1, { provider: attrs.provider, outcome: attrs.outcome });
}

/**
 * One leaver notification, per recipient, by what became of it.
 *
 * Emitted from `notifyLeaverOutcome` itself rather than from its caller, for the
 * same reason `identity.write.unsettled` is emitted from the reader that
 * produces the number: a counter incremented by the caller can drift from what
 * the function actually did, and the drift is invisible precisely when it
 * matters.
 *
 * `failed` is the one that needs an alert. A dropped notification is otherwise a
 * log line and nothing else — and the failure mode is not evenly distributed:
 * the enqueue happens inside a leaver batch already holding a customer's
 * directory rate limit, and the fault most likely to break the insert (Postgres
 * unavailable) is the same one that produces the INDETERMINATE outcome the
 * message exists to report. The message most worth delivering is the one most
 * likely to be lost.
 *
 * `suppressed` is NOT a failure: the outbox dedupes per (tenant, type, toEmail,
 * entity, day), so a second pass over the same journal row is correctly silent.
 * Counted separately so a rising suppressed rate is legible as dedupe rather
 * than mistaken for delivery.
 *
 * `no_recipient` is the quietest failure of the four and the reason this is not
 * simply a failure counter: a tenant whose privileged members hold no email
 * address, or a leaver with no manager in the org chart, produces no row, no
 * error, and no retry. Nobody is told, and until now nothing said so.
 *
 * No tenant label — cardinality is four results x two audiences.
 */
export function recordLeaverNotification(attrs: {
    provider: string;
    audience: 'IT' | 'MANAGER';
    result: 'enqueued' | 'suppressed' | 'failed' | 'no_recipient';
}): void {
    if (!_leaverNotification)
        _leaverNotification = getMeter().createCounter('identity.leaver.notification', {
            description: 'Leaver notifications by audience and delivery result',
            unit: '1',
        });
    _leaverNotification.add(1, {
        provider: attrs.provider,
        audience: attrs.audience,
        result: attrs.result,
    });
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

// ─────────────────────────────────────────────────────────────────────
//  H3-1 — the hardening work is only as good as its visibility
//
//  The four preceding PRs each added a behaviour whose ONLY signal was a
//  log line: throttles absorbed or deferred, credentials marked revoked,
//  queue retries suppressed, fan-out enqueues dropped, sync locks
//  contended. Every one of those is a thing an operator would want to
//  alert on, and none of them was countable.
//
//  Modelled on the Epic E.2 audit-stream set (success/failure counters +
//  an attempts histogram for retry pressure), because the failure shapes
//  are the same shape: an out-of-band path that fails safe, where the
//  only way to notice degradation is a metric.
// ─────────────────────────────────────────────────────────────────────

let _httpThrottled: Counter | null = null;
let _httpAttempts: Histogram | null = null;
let _authState: Counter | null = null;
let _queueRetryBypass: Counter | null = null;
let _dispatchEnqueueFailed: Counter | null = null;
let _syncLock: Counter | null = null;

/**
 * A provider throttled us (429 / Retry-After).
 *
 * `outcome` is the load-bearing label:
 *   - `absorbed` — waited it out in-process and carried on;
 *   - `deferred` — the wait exceeded the budget, so the tick ended and the
 *     next scheduled run picks it up.
 *
 * A rising `absorbed` rate is a provider getting tighter; any sustained
 * `deferred` rate means syncs are being pushed to the next cycle, which is the
 * point at which data starts going stale and nothing else says so.
 */
export function recordIntegrationThrottled(attrs: {
    provider: string;
    outcome: 'absorbed' | 'deferred';
    retryAfterMs?: number | null;
}): void {
    if (!_httpThrottled) {
        _httpThrottled = getMeter().createCounter('integration.http.throttled', {
            description: 'Provider 429/throttle responses, by whether the wait was absorbed or deferred',
            unit: '1',
        });
    }
    _httpThrottled.add(1, { provider: attrs.provider, outcome: attrs.outcome });
}

/**
 * Attempts made inside ONE resilient-fetch call (1 = no retry).
 *
 * The audit-stream analogue: the counter says whether it worked, the histogram
 * says how hard it had to try. A distribution creeping from 1 toward the cap is
 * a provider degrading well before any failure rate moves.
 */
export function recordIntegrationHttpAttempts(attrs: {
    provider: string;
    attempts: number;
    outcome: 'ok' | 'throttled' | 'terminal' | 'error';
}): void {
    if (!_httpAttempts) {
        _httpAttempts = getMeter().createHistogram('integration.http.attempts', {
            description: 'Attempts per resilient-fetch call (1 = no retry, up to the cap)',
            unit: '1',
        });
    }
    _httpAttempts.record(attrs.attempts, { provider: attrs.provider, outcome: attrs.outcome });
}

/**
 * A connection's credential was marked bad, or recovered.
 *
 * Deliberately a counter rather than a gauge of currently-broken connections: a
 * gauge would need a per-scrape DB query across every tenant. The `marked` rate
 * is the alertable signal, and `recovered` is what tells you an operator acted
 * rather than the alert simply going quiet.
 */
export function recordConnectionAuthState(attrs: {
    provider: string;
    state: 'marked' | 'recovered';
}): void {
    if (!_authState) {
        _authState = getMeter().createCounter('integration.connection.auth_state', {
            description: 'Connections marked credential-revoked, or cleared after recovery',
            unit: '1',
        });
    }
    _authState.add(1, { provider: attrs.provider, state: attrs.state });
}

/**
 * A job failure was flagged `noRetry`, so BullMQ did not immediately re-run it.
 *
 * Worth counting separately from the failure itself: this is the difference
 * between "a sync failed" and "a sync failed AND we deliberately declined to
 * retry it", and the second needs its own eye — a bug in the classifier shows
 * up here as a suppression rate that does not match the failure mix.
 */
export function recordQueueRetryBypass(attrs: { jobName: string; reason: 'terminal' | 'rate_limited' | 'truncated' }): void {
    if (!_queueRetryBypass) {
        _queueRetryBypass = getMeter().createCounter('integration.queue.retry_bypassed', {
            description: 'Job failures where the queue retry was deliberately suppressed',
            unit: '1',
        });
    }
    _queueRetryBypass.add(1, { job_name: attrs.jobName, reason: attrs.reason });
}

/**
 * A fan-out enqueue threw and was skipped.
 *
 * The dispatcher now continues past these instead of aborting, which is right —
 * but it means the loss is silent unless it is counted. Any non-zero rate is
 * connections that did not get a sync this cycle.
 */
export function recordDispatchEnqueueFailed(attrs: { component: string }): void {
    if (!_dispatchEnqueueFailed) {
        _dispatchEnqueueFailed = getMeter().createCounter('integration.dispatch.enqueue_failed', {
            description: 'Fan-out enqueues that threw and were skipped (connection not synced this cycle)',
            unit: '1',
        });
    }
    _dispatchEnqueueFailed.add(1, { component: attrs.component });
}

/**
 * Per-connection sync-lock outcome.
 *
 *   - `busy`   — another run held it; this one skipped. Routine in small
 *     numbers, a queue backing up if sustained.
 *   - `reaped` — a lease was taken from a previous holder, meaning that run
 *     exceeded the TTL or its worker died. This is the one to alert on: it says
 *     either that syncs are overrunning their budget, or that workers are being
 *     killed mid-sync.
 */
export function recordSyncLock(attrs: {
    component: string;
    outcome: 'acquired' | 'busy' | 'reaped' | 'release_lost';
}): void {
    if (!_syncLock) {
        _syncLock = getMeter().createCounter('integration.sync.lock', {
            description: 'Per-connection sync-lock outcomes (acquired/busy/reaped/release_lost)',
            unit: '1',
        });
    }
    _syncLock.add(1, { component: attrs.component, outcome: attrs.outcome });
}
