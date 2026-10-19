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

import type { ServicePrincipalDisableStatus } from '@/lib/agentic/service-principal-disable';
import type { EstateStaleReason } from '@/lib/agentic/harness-estate-staleness';

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
let _deprovisionRefused: Counter | null = null;
let _identityLinkReconcile: Counter | null = null;
let _legacyReconcileOutcome: Counter | null = null;
let _legacyReconcileRefused: Counter | null = null;
let _leaverPassOutcome: Counter | null = null;
let _joinerPassOutcome: Counter | null = null;
let _leaverNotification: Counter | null = null;
let _scannerFindingsTruncated: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _harnessScan: Counter | null = null;
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
 * REFUSED_TARGET — READ THE BASIS, NOT JUST THE COUNT. It covers four
 * situations with different responses, and the per-decision `basis.rule` on the
 * leaver pass report names which:
 *   • ON_PREM_MASTERED — a hybrid account. Disable it in AD; the LDAPS
 *     connector is what you want. This is the durable meaning.
 *   • NEVER_OBSERVED — the provider CAN answer the on-premises question and has
 *     not yet for that account. The response is to WAIT for the nightly sync,
 *     not to wire anything up; it clears itself.
 *   • OBSERVATION_STALE — the provider DID answer, too long ago to act on.
 *     Reads like NEVER_OBSERVED and takes the opposite response: waiting does
 *     NOT clear it. The usual cause is that the connection which observed these
 *     accounts was soft-disabled, so the dispatch skips it and nothing
 *     re-stamps them — while a surviving connection's provider-scoped link
 *     reconcile keeps their links looking fresh. Re-enable that connection, or
 *     remove the accounts it left behind.
 *   • PROVIDER_CANNOT_OBSERVE — okta / google-workspace, which report no
 *     on-premises flag at all. There is no sync to wait for and nothing an
 *     operator can do; the refusal is permanent until the platform learns to
 *     tell one of their accounts from a synced one.
 * NEVER_OBSERVED dominates for one deploy cycle after the onPremStateObservedAt
 * migration, which deliberately did not backfill: every pre-existing row refuses
 * that way until its next sync stamps it. Paging on the count alone during that
 * window sends someone to configure a connector they do not need.
 *
 * REFUSED_UNMEASURED — THE MIRROR AND THE DIRECTORY DISAGREE, and the write was
 * withheld. The stored observation said the account was not ACTIVE; the live
 * read says it is. The blast-radius breaker measured a batch this candidate was
 * not in, so writing it would put the cap's numerator and the actual writes out
 * of step — the shape of #2498. Refusing is the closed direction and it has a
 * cost: a terminated person keeps access until somebody acts.
 *
 * On ANY volume this points upstream, not at the leaver path. A whole batch
 * refusing this way is the signature of a sync that marked live accounts
 * deprovisioned (#2499); a single one is usually an account changed in the
 * directory between the 03:00 sync and the 05:00 pass, which clears itself.
 *
 * ALERT ON — even one INDETERMINATE, REFUSED_PROTECTED above single figures,
 * and REFUSED_UNMEASURED on more than a couple in one pass.
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
 * one nobody acts on. It has one now: `readUnsettledBacklog` at the head of
 * `runIdentityLeaverPass`, which runs before every early return.
 *
 * READ THE INSTRUMENT BEFORE WRITING THE ALERT. This is a monotonic Counter
 * fed a LEVEL: three rows stranded and never resolved add +3 every night, so
 * the sum only ever climbs and can never say "the backlog is clear" — only
 * "it stopped growing".
 *
 * THIS COUNTER IS NOT THE ALERT, AND CANNOT BE (#2842). This docblock used to
 * end with an instruction:
 *
 *     ALERT ON — `increase(identity_write_unsettled_total[2d]) > 0`.
 *
 * The PromQL is right and the sentence was wrong, because there is nowhere to
 * put it. Verified on production 2026-09-24:
 *
 *   1. NOTHING SCRAPES THIS. `docker inspect inflect-app-1` shows no `OTEL_*`
 *      environment, so `getMeter()` here hands back a meter with no exporter
 *      and `.add()` is discarded in-process. The series does not exist.
 *   2. NOTHING EVALUATES PROMQL. Prometheus and Alertmanager are not deployed;
 *      `deploy/docker-compose.prod.yml` references neither.
 *      `infra/alerts/rules.yml` holds 22 rules that have never run, and zero of
 *      them mention identity.
 *
 * So a rule added there would be useless twice over — and worse than useless,
 * because the next person grepping for coverage would find it and stop looking.
 * That is exactly how this repo has been bitten before (`external-uptime.yml`
 * records the 25-hour outage that taught it), and it is why the instruction is
 * corrected here rather than deleted: the INTENT — an unsettled write must page
 * somebody — is right and is now implemented, elsewhere.
 *
 * WHERE THE ALERT ACTUALLY LIVES. `infra/reporters/identity-unsettled-reporter.sh`,
 * on a 5-minute systemd timer on the VM, reading the DATABASE and POSTing
 * `custom.googleapis.com/identity/write_unsettled` to GCP Cloud Monitoring;
 * policy at `infra/alerts/policies/identity-write-unsettled.json`, contract at
 * `infra/alerts/gcp-custom-metrics.yml`. Sourcing it from the journal rather
 * than from here also fixes the counter-fed-a-level problem above at the root:
 * a row count is a gauge, so it CAN say "the backlog is clear".
 *
 * It is not applied yet — installing it is an operator action, and the README
 * beside it carries the procedure. Until it is, an unsettled identity write
 * pages nobody. Do not read this block as coverage.
 *
 * KEEP CALLING THIS ANYWAY. It costs nothing, it is the only signal that would
 * light up the moment an OTel exporter is configured, and the log line beside
 * its call site in `readUnsettledBacklog` is real today.
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
/**
 * One harness-scan submission (#3665), by how it ended.
 *
 * Emitted on every terminal path, refusals included, and with `empty` beside
 * `complete`, because the two quiet failures look alike from the scanner's
 * side: a scanner that stopped posting, and one posting reports with nothing
 * in them. A refusal carries its stable reason code (`BAD_SIGNATURE`,
 * `UNTRUSTED_SIGNER`, `REPLAY`, …) — never anything from the report.
 *
 * No tenant label: a handful of outcomes and reasons.
 */
export function recordHarnessScanOutcome(attrs:
    | { outcome: 'ingested'; complete: boolean; empty: boolean }
    | { outcome: 'refused'; reason: string }): void {
    if (!_harnessScan) {
        _harnessScan = getMeter().createCounter('agent_harness.scan.outcome', {
            description: 'Harness scan submissions by outcome',
            unit: '1',
        });
    }
    _harnessScan.add(1, attrs.outcome === 'ingested'
        ? { outcome: attrs.outcome, complete: String(attrs.complete), empty: String(attrs.empty) }
        : { outcome: attrs.outcome, reason: attrs.reason });
}

let _agentReviewAttribution: Counter | null = null;

/**
 * One attempt to store a `discovered-agent-review` run's owner suggestion
 * (#3728), by how it ended.
 *
 * Emitted on every completed run of that workflow, because the quiet failure
 * here is a Register dialog that never shows a suggestion: `no_answer` (no Art
 * 12 row, or the static engine), `no_attribution_in_answer` (the model answered
 * in prose) and `answer_invalid` (an answer the contract refused) all look the
 * same from the tab. `recorded` is the only outcome that changed a row.
 *
 * ALERT ON — a steady `answer_invalid` or `answer_for_another_agent`: the model
 * is producing suggestions nothing can use, or about agents it was not asked
 * about. No tenant label and no identifier of any kind.
 */
export function recordAgentReviewAttribution(attrs: { outcome: string }): void {
    if (!_agentReviewAttribution) {
        _agentReviewAttribution = getMeter().createCounter('agentic.review_attribution.capture', {
            description: 'Discovered-agent review runs by what became of their owner suggestion',
            unit: '1',
        });
    }
    _agentReviewAttribution.add(1, { outcome: attrs.outcome.toLowerCase() });
}

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

/**
 * One joiner pass, by how it ended.
 *
 * Emitted on EVERY terminal path — including the two ladder refusals, which
 * deliberately write no execution row. That asymmetry is the reason this counter
 * matters more than its leaver twin: for a DISABLED tenant the metric is the
 * ONLY evidence the pass fired at all, so without it "the joiner dispatcher
 * stopped" and "every tenant has the joiner switched off" are the same silence.
 *
 * No tenant label: roughly eight outcomes x two writable providers.
 */
export function recordJoinerPassOutcome(attrs: {
    provider: string;
    outcome:
        | 'completed'
        | 'mode_disabled'
        | 'mode_above_clamp'
        | 'no_starters'
        | 'no_department_map'
        | 'no_default_group'
        | 'batch_over_cap'
        | 'error';
}): void {
    if (!_joinerPassOutcome)
        _joinerPassOutcome = getMeter().createCounter('identity.joiner.pass', {
            description: 'Joiner passes by terminal outcome',
            unit: '1',
        });
    _joinerPassOutcome.add(1, { provider: attrs.provider, outcome: attrs.outcome });
}

/**
 * One legacy reconciliation run, counted PER OUTCOME.
 *
 * Adds each outcome's count in one call rather than being invoked per account:
 * a per-account call site would make the counter's total depend on the loop
 * rather than on the engine's own tally, and the two can disagree precisely when
 * a resolution is dropped. `EngineMetrics.byOutcome` is the tally the engine
 * computed, so this emits THAT.
 *
 * A zero is emitted for every outcome the run did not produce. That matters for
 * reading a dashboard: an absent series and a series at zero look identical in
 * most query languages, and "no account was UNMATCHED this run" is a different
 * fact from "this run did not report".
 */
export function recordLegacyReconcileOutcomes(attrs: {
    provider: string;
    byOutcome: Readonly<Record<string, number>>;
}): void {
    if (!_legacyReconcileOutcome)
        _legacyReconcileOutcome = getMeter().createCounter('legacy.reconcile.outcome', {
            description: 'Legacy access reconciliation results by outcome',
            unit: '1',
        });
    for (const [outcome, count] of Object.entries(attrs.byOutcome)) {
        _legacyReconcileOutcome.add(count, { provider: attrs.provider, outcome });
    }
}

let _legacyAdjudicationVerdict: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _legacyAdjudicationNonVerdict: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let _legacyAdjudicationLatency:
    | ReturnType<ReturnType<typeof getMeter>['createHistogram']>
    | undefined;

/**
 * Model verdicts by class, per revision.
 *
 * The REVISION is a dimension and not a label of convenience: thresholds live
 * per revision, so a shift in the AGREES share after a model change is the
 * signal the blind sample exists to corroborate. Folding revisions together
 * would average the old model's precision into the new one's.
 */
export function recordLegacyAdjudicationVerdicts(attrs: {
    model: string;
    revision: string;
    byClass: Readonly<Record<string, number>>;
}): void {
    if (!_legacyAdjudicationVerdict)
        _legacyAdjudicationVerdict = getMeter().createCounter('legacy.adjudication.verdict', {
            description: 'Legacy match verdicts by class',
            unit: '1',
        });
    for (const [verdict, count] of Object.entries(attrs.byClass)) {
        _legacyAdjudicationVerdict.add(count, {
            model: attrs.model,
            revision: attrs.revision,
            verdict,
        });
    }
}

/**
 * Accounts that got NO verdict, by reason.
 *
 * A separate series from the verdicts, for the reason the alias-suspension
 * counter gives one block up: these are not a sixth verdict class. A run where
 * every account came back `MODEL_DRIFT` and a run where every account came back
 * `UNSURE` look identical in a single total and mean opposite things — the first
 * is a model to go and look at, the second is a model working as designed.
 *
 * The reason is the dimension that matters most here. `TIMEOUT` is capacity,
 * `MODEL_DRIFT` is a canary failure, `QUARANTINED` is a hostile record, and
 * `NO_EVALUATION` is a deployment that was never going to produce a verdict.
 */
export function recordLegacyAdjudicationNonVerdicts(attrs: {
    model: string;
    revision: string;
    byReason: Readonly<Record<string, number>>;
}): void {
    if (!_legacyAdjudicationNonVerdict)
        _legacyAdjudicationNonVerdict = getMeter().createCounter(
            'legacy.adjudication.non_verdict',
            { description: 'Legacy match accounts with no verdict, by reason', unit: '1' }
        );
    for (const [reason, count] of Object.entries(attrs.byReason)) {
        _legacyAdjudicationNonVerdict.add(count, {
            model: attrs.model,
            revision: attrs.revision,
            reason,
        });
    }
}

/**
 * Per-call latency, per model.
 *
 * A histogram and not a mean. The pass runs under a 120-second deadline with a
 * per-call timeout of a few seconds, so what decides whether a residue finishes
 * is the TAIL — a mean of 200 ms hides the p99 of three seconds that spends the
 * whole budget on forty accounts.
 */
export function recordLegacyAdjudicationLatency(attrs: {
    model: string;
    latencyMs: number;
}): void {
    if (!_legacyAdjudicationLatency)
        _legacyAdjudicationLatency = getMeter().createHistogram('legacy.adjudication.latency', {
            description: 'Legacy match model call latency',
            unit: 'ms',
        });
    _legacyAdjudicationLatency.record(attrs.latencyMs, { model: attrs.model });
}

let _legacyAliasSuspension: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;

/**
 * Aliases revalidation withdrew, by reason.
 *
 * Its own counter rather than a sixth outcome, for the reason the refusal
 * counter one block down gives: a suspension is not a resolution of an account,
 * it is a change to a standing decision, and folding the two series together
 * would make "how many accounts resolved this way" uncountable.
 *
 * The reason is the dimension that matters. A run suspending twenty aliases
 * because an HR feed re-keyed a department is a routine morning; a run
 * suspending twenty because accounts are being recreated is an incident, and a
 * single `suspended` total cannot tell the two apart.
 */
export function recordLegacyAliasSuspensions(attrs: {
    provider: string;
    byReason: Readonly<Record<string, number>>;
}): void {
    if (!_legacyAliasSuspension)
        _legacyAliasSuspension = getMeter().createCounter('legacy.alias.suspension', {
            description: 'Confirmed legacy aliases withdrawn by revalidation, by reason',
            unit: '1',
        });
    for (const [reason, count] of Object.entries(attrs.byReason)) {
        _legacyAliasSuspension.add(count, { provider: attrs.provider, reason });
    }
}

let _legacyReviewDecision: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;

/**
 * THE REVIEWER OVERRIDE RATE — one increment per decision (#3498).
 *
 * `docs/legacy-access-recertification-design.md` calls this "the production
 * outcome metric" for assisted reconciliation, and until 2026-10-14 it did not
 * exist: `legacy-reviewer-actions.ts` emitted no metric at all. Every other
 * legacy counter measures whether the machinery RAN — outcomes, refusals,
 * latency, suspensions — and none measured whether its output was of any use.
 *
 * It is the only signal that says whether the ASSISTED half earns its place. A
 * suggestion engine whose suggestions are overridden most of the time costs
 * reviewers time while looking busy, and nothing in the product would show it.
 *
 * A COUNTER PAIR, NOT A PRE-DIVIDED RATE. The rate is
 * `(other_candidate + unscored_employee) / (those + engine_leader)`, computed by
 * whoever reads it — so the DENOMINATOR stays visible. A stored ratio of 0.5
 * cannot tell two decisions from two thousand, and this subsystem's own lesson
 * is that a figure which hides its denominator is the one that misleads.
 *
 * `agreement` is a closed set, and the two "no leader to agree with" cases are
 * separate from disagreement on purpose — a tie at the top means the engine
 * declined to lead, so a reviewer picking either candidate has overridden
 * nothing:
 *
 *   engine_leader      chose the engine's single top-scoring candidate
 *   other_candidate    chose a different candidate the engine DID score
 *   unscored_employee  chose somebody the engine never scored (a MANUAL match)
 *   no_employee        classified as NON_PERSON, EXTERNAL or ORPHAN
 *   engine_ambiguous   the engine tied at the top, so it named no leader
 *   engine_none        the engine scored nobody at all
 *   deferred           the reviewer expressed no opinion
 *
 * NO `provider` LABEL, deliberately. This surface has one provider family today
 * (`legacy-mcp`), so the label would be a constant — and deriving it would mean a
 * read whose only purpose is the label. Adding it is a one-line change at the
 * call site if a second legacy provider ever arrives.
 *
 * THE MODEL IS NOT COMPARED HERE, and that is also deliberate. A verdict may be
 * BLIND-HELD, and the blind lane exists precisely so that a reviewer's decision
 * is taken without sight of the model's. Emitting model agreement per decision
 * would put that comparison into a metric the reviewer's own dashboards can read,
 * which is the one place it must not appear. `AiDecisionLog` plus `verdictId`
 * already hold what a later, deliberate comparison needs.
 */
export function recordLegacyReviewDecision(attrs: {
    agreement:
        | 'engine_leader'
        | 'other_candidate'
        | 'unscored_employee'
        | 'no_employee'
        | 'engine_ambiguous'
        | 'engine_none'
        | 'deferred';
    classification: string;
    method: string;
}): void {
    if (!_legacyReviewDecision)
        _legacyReviewDecision = getMeter().createCounter('legacy.review.decision', {
            description:
                'Legacy reconciliation decisions by whether the reviewer followed the engine',
            unit: '1',
        });
    _legacyReviewDecision.add(1, {
        agreement: attrs.agreement,
        classification: attrs.classification,
        method: attrs.method,
    });
}

/**
 * A reconciliation run that refused before resolving anything.
 *
 * Separate from the per-outcome counter deliberately: a refusal produces NO
 * outcomes, so folding it in as a sixth outcome would make the outcome series
 * sum to something that is not the account count, and a refusal is a fact about
 * the RUN rather than about any account.
 */
export function recordLegacyReconcileRefused(attrs: {
    provider: string;
    reason: string;
}): void {
    if (!_legacyReconcileRefused)
        _legacyReconcileRefused = getMeter().createCounter('legacy.reconcile.refused', {
            description: 'Legacy access reconciliation runs refused, by named reason',
            unit: '1',
        });
    _legacyReconcileRefused.add(1, { provider: attrs.provider, reason: attrs.reason });
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
 * A deprovision reconcile was REFUSED by one of its blast-radius rails.
 *
 * A SEPARATE SERIES, not a zero on the one above, because the counter above
 * early-returns on `count <= 0` — so the event with the largest blast radius in
 * that whole function, the one where a sweep was held back, emitted nothing at
 * all while an executed sweep emitted a number. The two are also different
 * questions: `deprovisioned` measures how much moved, this measures how often a
 * rail had to stop it.
 *
 * A non-zero rate is the directory-scoping signature — a baseDN typo, an OU ACL
 * change, a bind account scoped down. Worth alerting on at any rate above zero:
 * a refusal LATCHES (the rows keep their stale `syncedAt` and are re-proposed
 * every pass), so it does not clear itself and the mirror stays knowingly
 * behind the directory until someone looks.
 *
 * `reason` is one of two fixed literals, so cardinality is providers x 2.
 */
export function recordDeprovisionRefused(attrs: { provider: string; reason: 'zero_enumeration' | 'share_cap' }): void {
    if (!_deprovisionRefused)
        _deprovisionRefused = getMeter().createCounter('integration.identity.deprovision.refused', {
            description: 'Identity-sync deprovision reconciles refused by a blast-radius rail',
            unit: '1',
        });
    _deprovisionRefused.add(1, { provider: attrs.provider, reason: attrs.reason });
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

// ═══════════════════════════════════════════════════════════════════
// Agent policy cards (Epic Agentic 5) — the pre-execution gate's own signal
// ═══════════════════════════════════════════════════════════════════
//
// The policy card refuses a tool call BEFORE the tool runs. That is the point
// of it, and it is also why the subsystem cannot be watched the way a check or
// a sync is: a refusal produces no failed job, no error rate and no user-visible
// break — the agent simply gets less done. Nothing degrades. Somebody notices in
// a week, or at audit.
//
// So the two counters below are the instrument, and the shapes they distinguish
// are the reason there are two:
//
//   • MISCONFIGURATION — refusals concentrated on ONE agent and ONE rule,
//     starting at a card edit or a new tool grant, while the agent goes on doing
//     its ordinary work. The fix is an edit; nobody needs waking.
//   • ASI10 (an agent operating outside its intended envelope) — refusals from
//     one agent SPREAD ACROSS RULES, or repeatedly against the action budgets.
//     An agent trying tools it was never granted, reaching data rungs it was
//     never given, and burning its day is not a misconfiguration; the card is
//     working and something upstream is not.
//
// Telling those apart needs the agent AND the rule on the same series, which is
// why `agent` is a label here and `tenant.id` is a label nowhere. The cardinality
// argument is different in kind, not merely in degree: `api.request.count` emits
// for every tenant on every request, so a tenant label creates a series per
// tenant unconditionally. A refusal series exists only for an agent that has
// ACTUALLY BEEN REFUSED — in a healthy deployment, none — and the agent
// population is operator-curated behind a privileged route and a risk
// assessment, not something signups grow.
//
// The EVALUATION counter, which does fire on every call, deliberately carries no
// agent for exactly that reason. It is the denominator; the refusal counter is
// the detail.

let _policyCardEvaluation: Counter | null = null;
let _policyCardRefusal: Counter | null = null;
let _toolManifestDrift: Counter | null = null;
let _peerCardCheck: Counter | null = null;
let _tenantSkillMount: Counter | null = null;
let _tenantSkillReview: Counter | null = null;
let _agentKillRefusal: Counter | null = null;
let _agentKillDrill: Counter | null = null;

/**
 * One policy-card evaluation at the MCP tool boundary.
 *
 * Emitted on EVERY call through the gate, so the four outcomes partition the
 * traffic and the refusal counter has a denominator.
 *
 *   allowed  — a card was in force and permitted the call.
 *   refused  — a card was in force and refused it.
 *   no_card  — the caller IS a registered agent and has no policy card. This is
 *              the governance gap: it looks exactly like an agent whose card
 *              permits everything, because both produce zero refusals for ever.
 *   no_agent — the caller is not an agent at all (a signed-in human, an
 *              ordinary integration key, a tenant with the register switched
 *              off). Separated from `no_card` deliberately: folded together, a
 *              tenant that simply does not run agents would be indistinguishable
 *              from one running agents nobody has written a card for, and the
 *              adoption number would be unreadable in exactly the deployments
 *              where somebody needs to read it.
 *
 * Labels stay bounded and small: four outcomes × two surfaces.
 *
 * ALERT ON — nothing directly. This is the denominator that makes the refusal
 * counter a RATE. A refusal rate that steps up without the evaluation rate
 * moving is a policy change; both moving together is a traffic change.
 */
export function recordPolicyCardEvaluation(attrs: {
    outcome: 'allowed' | 'refused' | 'no_card' | 'no_agent';
    surface: 'tool' | 'resource';
}): void {
    if (!_policyCardEvaluation) {
        _policyCardEvaluation = getMeter().createCounter('agentic.policy_card.evaluation', {
            description:
                'Policy-card evaluations at the MCP tool boundary, by outcome and surface',
            unit: '1',
        });
    }
    _policyCardEvaluation.add(1, { outcome: attrs.outcome, surface: attrs.surface });
}

/**
 * One policy-card REFUSAL, with enough dimension to act on.
 *
 * `agent` and `rule` are both required and neither is sufficient alone: `rule`
 * without `agent` cannot tell one broken card from a fleet-wide problem, and
 * `agent` without `rule` cannot tell a mis-scoped grant from an agent reaching
 * past its envelope. `escalate` is the card's own declaration that this rule is
 * worth waking somebody for; `riskTier` is what decides how fast.
 *
 * The TOOL is deliberately not a label. It is on the `AUTHZ_DENIED` audit row
 * for every one of these, which is the per-call record; adding it here would
 * multiply the series by the catalogue for the one dimension the audit trail
 * already answers precisely.
 *
 * ALERT ON — any refusal with `escalate="true"`, immediately. And on
 * `count(count by (rule) (increase(agentic_policy_card_refusal_total{agent="X"}[1h]))) >= 3`:
 * one agent tripping three different declarations in an hour is the spread that
 * separates the second shape above from the first.
 */
export function recordPolicyCardRefusal(attrs: {
    agentId: string;
    rule: string;
    escalate: boolean;
    riskTier: string | null;
    surface: 'tool' | 'resource';
}): void {
    if (!_policyCardRefusal) {
        _policyCardRefusal = getMeter().createCounter('agentic.policy_card.refusal', {
            description:
                'Tool calls refused by an agent policy card, by agent and by the rule that fired',
            unit: '1',
        });
    }
    _policyCardRefusal.add(1, {
        agent: attrs.agentId,
        rule: attrs.rule,
        escalate: String(attrs.escalate),
        // `unscored` rather than an omitted label: a missing label collapses
        // into whichever series shares the rest of the key, and an unscored
        // agent is the state most worth seeing on its own.
        'risk.tier': attrs.riskTier ?? 'unscored',
        surface: attrs.surface,
    });
}

// ── Tool-manifest pinning (OWASP ASI04) ────────────────────────────────────

/**
 * A tool DEFINITION no longer matches what the tenant approved.
 *
 * This is the tool-poisoning signal, and it is the loudest one this subsystem
 * emits. Unlike a policy-card refusal — which is usually a mis-scoped
 * integration and is expected to fire routinely — a manifest drift means the
 * instruction text or the parameter contract of a tool CHANGED under a tenant
 * that had already seen it. The benign cause is a deploy; there is no other
 * benign cause.
 *
 * `status` is the label that matters: `DESCRIPTION_CHANGED` is the case a pin
 * over name + schema alone would have missed, and the one that corresponds to
 * the published attack. It is separated from `SCHEMA_CHANGED` here rather than
 * collapsed into a single `drift` counter precisely so the two can be alerted on
 * at different thresholds.
 *
 * The tool NAME is a label and the hashes are NOT. A hash is high-cardinality
 * and unbounded — one new series per poisoned description — and it is already on
 * the `AUTHZ_DENIED` audit row, which is the per-call record.
 *
 * ALERT ON — any increase at all, immediately, for `status!="UNPINNED"`. A
 * fleet-wide simultaneous jump across every tenant is a deploy; a jump confined
 * to one tenant or one tool is not, and cannot be.
 */
export function recordToolManifestDrift(attrs: { tool: string; status: string }): void {
    if (!_toolManifestDrift) {
        _toolManifestDrift = getMeter().createCounter('agentic.tool_manifest.drift', {
            description:
                'MCP tool calls whose definition no longer matches the tenant-approved manifest. ' +
                'Most statuses refuse the call; ANNOTATIONS_CHANGED does not, and is counted here ' +
                'so a far end redeclaring a read tool as a write is visible without blocking it. ' +
                'Read the `status` attribute — it is the difference.',
            unit: '1',
        });
    }
    _toolManifestDrift.add(1, { tool: attrs.tool, status: attrs.status });
}

// ── A2A peer agent cards (#3673) ─────────────────────────────────────────────

/**
 * One read of an A2A peer's agent card, and what it found against the pin.
 *
 * `outcome` is `MATCH`, `CHANGED`, `UNPINNED`, or the fetch failure that stopped
 * the read (`TIMEOUT`, `TOO_LARGE`, `NOT_AN_AGENT_CARD`, …). The peer id and
 * the hashes are NOT labels: both are unbounded, and the per-peer record is the
 * audit row an approval writes.
 *
 * ALERT ON — any `outcome="CHANGED"`. A peer's card is another organisation's
 * text, and it changing under a pin is either the partner's release or the
 * thing pinning exists to catch; either way a person must look before traffic
 * resumes. A run of fetch failures for one tenant is a partner that went away
 * or a card that grew past the cap, and the peer is refused until it is read.
 */
export function recordPeerCardCheck(attrs: { outcome: string; context: 'register' | 'read' | 'approve' | 'admission' | 'message' }): void {
    if (!_peerCardCheck) {
        _peerCardCheck = getMeter().createCounter('agentic.peer_card.check', {
            description:
                'Reads of an A2A peer agent card and their verdict against the approved pin. ' +
                'CHANGED and every fetch failure refuse the peer until a person re-approves or the card is read.',
            unit: '1',
        });
    }
    _peerCardCheck.add(1, { outcome: attrs.outcome, context: attrs.context });
}

// ── Tenant-authored skills (#3680) ───────────────────────────────────────────

/**
 * One resolution of a tenant's own skills for a run: `MOUNTED` (zero tenant
 * skills included), or the refusal that stopped the run (`NOT_APPROVED`, `PIN_MISMATCH`, `TEXT_REFUSED`, a recomputed evaluation
 * refusal, `NAME_RESERVED`, `OVER_BUDGET`, …).
 *
 * ALERT ON — any `outcome="PIN_MISMATCH"`. An approved version's decrypted text
 * no longer hashes to the hash its approval pinned, which only a write below
 * the application can cause. Any other refusal is a tenant's own configuration
 * (a skill approved before a scan rule tightened, a catalogue that two
 * approvals filled together), and stops that tenant's runs of one workflow.
 */
export function recordTenantSkillMount(attrs: { outcome: string; context: 'admission' | 'segment' }): void {
    if (!_tenantSkillMount) {
        _tenantSkillMount = getMeter().createCounter('agentic.tenant_skill.mount', {
            description:
                'Resolutions of a tenant\'s own approved skills for a Flue run, and why one was refused. ' +
                'A refusal fails the run closed before anything reaches the model.',
            unit: '1',
        });
    }
    _tenantSkillMount.add(1, { outcome: attrs.outcome, context: attrs.context });
}

/**
 * One act in a tenant skill's review lifecycle (`create`, `edit`,
 * `evaluation`, `submit`, `approve`, `reject`, `retire`) and its outcome:
 * `OK` or the named refusal. A run of `SELF_APPROVAL` or `HASH_CHANGED` is a
 * reviewer working around the four-eyes rule or approving text they did not
 * read, and is worth a look.
 */
export function recordTenantSkillReview(attrs: { action: string; outcome: string }): void {
    if (!_tenantSkillReview) {
        _tenantSkillReview = getMeter().createCounter('agentic.tenant_skill.review', {
            description: 'Acts in the review lifecycle of a tenant-authored skill, by action and outcome.',
            unit: '1',
        });
    }
    _tenantSkillReview.add(1, { action: attrs.action, outcome: attrs.outcome });
}

// ── A2A messages (#3679) ─────────────────────────────────────────────────────

let _a2aMessage: Counter | null = null;

/**
 * One A2A message, in either direction, and what became of it.
 *
 * `direction` is `INBOUND` (a peer's request to this deployment) or
 * `OUTBOUND` (a send to a peer, counted by the dispatch pass or the tool).
 * `outcome` is a closed vocabulary: `ADMITTED`, `ANSWERED`, a refusal reason
 * (`PEER_KILLED`, `BAD_CREDENTIAL`, `SIGNATURE_INVALID`, `PEER_CARD_CHANGED`,
 * `REPLAY`, `QUOTA`, `GUARD_REFUSED`, …), or a journal outcome for a send
 * (`RECORDED_ONLY`, `PROPOSED`, `QUEUED`, `APPLIED`, `ACCEPTED`, `FAILED`,
 * `INDETERMINATE`). The peer id is NOT a label: unbounded, and the receipt
 * rows carry it.
 *
 * ALERT ON — `SIGNATURE_INVALID` or `REPLAY` inbound (somebody holds a peer's
 * credential and not its key, or is replaying it), and any `INDETERMINATE`
 * outbound (a send that may have arrived and could not be confirmed). Silence
 * from a tenant with a live peer is the third signal: the traffic stopped.
 */
export function recordA2aMessage(attrs: { direction: 'INBOUND' | 'OUTBOUND'; outcome: string }): void {
    if (!_a2aMessage) {
        _a2aMessage = getMeter().createCounter('agentic.a2a.message', {
            description:
                'A2A messages exchanged with peer agents, by direction and outcome. Every refusal is '
                + 'counted under its reason; a send that may have arrived and was not confirmed is INDETERMINATE.',
            unit: '1',
        });
    }
    _a2aMessage.add(1, { direction: attrs.direction, outcome: attrs.outcome });
}

// ── The kill switch, and its drill (OWASP ASI08 / ASI10) ───────────────────

/**
 * A tool call refused because a kill switch is in force.
 *
 * `scope` is the label and the agent id is NOT. Two reasons, and the second is
 * the one that matters: an agent id is unbounded cardinality, and the shape an
 * operator reads during an incident is "is anything still trying" — a per-scope
 * count answers that, and the per-call detail is already on the hash-chained
 * `AUTHZ_DENIED` row where a responder can join it to the agent.
 *
 * `drill` separates the nightly synthetic refusal from a real one. Without it
 * every deployment would show a small steady stream of `agent_killed` denials
 * and operators would learn to ignore the series — which is how a security
 * signal stops being read, one level up from the alert this counter exists for.
 *
 * ALERT ON — `drill="false"` and any non-zero rate that OUTLIVES the kill it
 * belongs to. A burst at the moment of a kill is the control working: it is the
 * agents being stopped. A burst that is still going an hour later means
 * something is retrying against a stop nobody has lifted, and the run behind it
 * needs killing at a wider scope or the client needs turning off.
 *
 * A ZERO rate while a kill is in force is NOT reassurance and must not be
 * alerted as such — it is indistinguishable from "no agent tried". The
 * scheduled drill is what turns that absence into a positive signal; see
 * `recordKillSwitchDrill`.
 */
export function recordAgentKillRefusal(attrs: { scope: string; drill: boolean }): void {
    if (!_agentKillRefusal) {
        _agentKillRefusal = getMeter().createCounter('agentic.kill_switch.refusal', {
            description:
                'MCP tool calls refused at the tool boundary because a kill switch is in force',
            unit: '1',
        });
    }
    _agentKillRefusal.add(1, { scope: attrs.scope, drill: String(attrs.drill) });
}

/**
 * One scheduled kill-switch drill, by outcome.
 *
 * This is the counter that makes a SILENT kill switch detectable. Every other
 * signal here fires when the control ACTS; a stop control that has quietly
 * stopped working emits nothing at all, and looks exactly like a quiet week.
 *
 * `PASSED` / `FAILED` / `ERROR` are three different states and are deliberately
 * three labels rather than a boolean: a drill that could not RUN has proved
 * nothing, and folding it into FAILED would page somebody about a broken kill
 * switch when the fault is a database timeout.
 *
 * ALERT ON — any `outcome="FAILED"`, immediately: the drill only fails when a
 * kill was in force and the boundary let a tool call through, or refused it for
 * the wrong reason. Also alert on the ABSENCE of `outcome="PASSED"` for longer
 * than two scheduled intervals — a drill that stopped running is the same
 * evidence gap as a drill that never existed, and an absence is ambiguous unless
 * something asserts the positive.
 */
export function recordKillSwitchDrill(attrs: { outcome: string }): void {
    if (!_agentKillDrill) {
        _agentKillDrill = getMeter().createCounter('agentic.kill_switch.drill', {
            description: 'Scheduled kill-switch drills, by recorded outcome',
            unit: '1',
        });
    }
    _agentKillDrill.add(1, { outcome: attrs.outcome });
}

// ── Agent owner-orphan pass and credential hygiene (#3670) ─────────────────

let _agentOrphanPass: Counter | null = null;
let _agentOrphanPassOrphans: Counter | null = null;
let _credentialHygiene: Counter | null = null;
let _credentialHygieneFindings: Counter | null = null;

/**
 * One owner-orphan pass, per tenant, by how it ended — and the orphans it
 * found, by rung.
 *
 * Emitted on EVERY terminal path, the refusals included, for the leaver's
 * reason: the failure most likely to go unnoticed is the pass not running, and
 * a scheduler that stopped would otherwise look exactly like a quiet week.
 * `swept_nobody` is the sweep that found no tenant to check at all.
 *
 * ALERT ON — `outcome="error"` or `outcome="partial"` at any rate; and the
 * ABSENCE of any outcome for longer than two scheduled intervals. A rate of
 * `orphans` at `mode="AUTOMATIC"` is the number of agents stopped unattended,
 * the figure to watch the first week a tenant is widened.
 *
 * No tenant label: a handful of outcomes x three rungs.
 */
export function recordAgentOwnerOrphanPass(attrs: {
    outcome:
        | 'mode_disabled'
        | 'mode_above_clamp'
        | 'no_active_agents'
        | 'dry_run'
        | 'contained'
        | 'partial'
        | 'error'
        | 'swept_nobody';
    mode: string;
    orphans: number;
}): void {
    if (!_agentOrphanPass) {
        _agentOrphanPass = getMeter().createCounter('agentic.owner_orphan_pass.outcome', {
            description: 'Agent owner-orphan passes by terminal outcome',
            unit: '1',
        });
    }
    _agentOrphanPass.add(1, { outcome: attrs.outcome, mode: attrs.mode });
    if (attrs.orphans > 0) {
        if (!_agentOrphanPassOrphans) {
            _agentOrphanPassOrphans = getMeter().createCounter('agentic.owner_orphan_pass.orphans', {
                description: 'Agents found whose accountable owner has left, by the rung the pass ran at',
                unit: '1',
            });
        }
        _agentOrphanPassOrphans.add(attrs.orphans, { mode: attrs.mode });
    }
}

let _agentServicePrincipalDisable: Counter | null = null;

/**
 * One request to disable a contained agent's Entra service principal (#3671),
 * by what it came to and the external-write rung of the connection it went
 * through.
 *
 * `outcome` is the `ServicePrincipalDisableStatus` verbatim — a closed union of
 * eighteen, so the cardinality is fixed by the type. `rung` is `none` when no
 * connection was resolved (not linked, no paired endpoint).
 *
 * ALERT ON — `outcome="prior_state_unreadable"`, `"refused"` or `"failed"` at
 * any rate: a disable was due and did not happen. A rate of `outcome="queued"`
 * is the number of principals queued for unattended disable, the figure to
 * watch the first week a connection is widened to AUTOMATIC. `not_linked` and
 * `no_paired_endpoint` are the default for every tenant that has not set this
 * up and are not alarms.
 *
 * No tenant label, and no identifier of any kind.
 */
export function recordAgentServicePrincipalDisable(attrs: {
    outcome: ServicePrincipalDisableStatus;
    rung: string;
}): void {
    if (!_agentServicePrincipalDisable) {
        _agentServicePrincipalDisable = getMeter().createCounter(
            'agentic.owner_orphan_pass.service_principal_disable',
            {
                description:
                    'Requests to disable a contained agent\'s Entra service principal, by outcome and rung',
                unit: '1',
            },
        );
    }
    _agentServicePrincipalDisable.add(1, {
        outcome: attrs.outcome.toLowerCase(),
        rung: attrs.rung,
    });
}

/**
 * One credential-hygiene pass, per tenant, by how it ended, and the findings it
 * moved, by transition.
 *
 * `partial` is a pass that could not judge every connection (a secret that
 * would not decrypt): those findings are held, neither raised nor resolved.
 * `no_agent_credentials` is an empty population, recorded as such and never as
 * a clean result.
 *
 * ALERT ON — `outcome="error"`; and the absence of any outcome for two
 * scheduled intervals. A steady rate of `transition="opened"` after the first
 * week is new weak credentials being minted, which is the trend to read.
 */
export function recordAgentCredentialHygiene(attrs: {
    outcome: 'completed' | 'partial' | 'no_agent_credentials' | 'error' | 'swept_nobody';
    opened: number;
    reopened: number;
    resolved: number;
}): void {
    if (!_credentialHygiene) {
        _credentialHygiene = getMeter().createCounter('agentic.credential_hygiene.outcome', {
            description: 'Agent credential-hygiene passes by terminal outcome',
            unit: '1',
        });
    }
    _credentialHygiene.add(1, { outcome: attrs.outcome });
    if (!_credentialHygieneFindings) {
        _credentialHygieneFindings = getMeter().createCounter('agentic.credential_hygiene.findings', {
            description: 'Credential-hygiene findings moved by a pass, by transition',
            unit: '1',
        });
    }
    if (attrs.opened > 0) _credentialHygieneFindings.add(attrs.opened, { transition: 'opened' });
    if (attrs.reopened > 0) _credentialHygieneFindings.add(attrs.reopened, { transition: 'reopened' });
    if (attrs.resolved > 0) _credentialHygieneFindings.add(attrs.resolved, { transition: 'resolved' });
}

let _estateStalenessPass: Counter | null = null;
let _estateEvaluated: Counter | null = null;
let _estateStale: Counter | null = null;

/**
 * One harness-estate staleness pass, per tenant (#3741), and what it measured.
 *
 * Three instruments, because the quiet failures look alike from a findings
 * queue — no stale estate, no estate to judge, and no pass at all all open
 * nothing:
 *
 *   agentic.harness_estate.pass{outcome}     every terminal path: `evaluated`,
 *                                            `no_estates`, `error`, and
 *                                            `swept_nobody` for a sweep that
 *                                            found no tenant to visit
 *   agentic.harness_estate.evaluated         estates judged — the DENOMINATOR.
 *                                            Added on every completed pass, zero
 *                                            included, so "0 stale of 0
 *                                            evaluated" reads as nothing measured
 *   agentic.harness_estate.stale{reason}     estates found stale, by why:
 *                                            `scanner_not_live`,
 *                                            `no_scan_in_window`,
 *                                            `no_complete_scan`
 *
 * ALERT ON — any increase of `.stale` (a client estate's scanner went quiet,
 * stopped reading a source in full, or was retired); any `outcome="error"`;
 * and the ABSENCE of any pass outcome for two days. A `.stale` rate is a count
 * of estate-days, not of estates: a stale estate is counted again on every
 * daily pass until a complete scan arrives.
 *
 * No tenant label, and no estate or scanner identifier: a handful of outcomes
 * and three reasons. Which estate is stale is the finding's to say.
 */
export function recordHarnessEstateStaleness(attrs: {
    outcome: 'evaluated' | 'no_estates' | 'error' | 'swept_nobody';
    evaluated: number;
    staleByReason: Partial<Record<EstateStaleReason, number>>;
}): void {
    if (!_estateStalenessPass) {
        _estateStalenessPass = getMeter().createCounter('agentic.harness_estate.pass', {
            description: 'Harness-estate staleness passes, by terminal outcome',
            unit: '1',
        });
    }
    _estateStalenessPass.add(1, { outcome: attrs.outcome });
    if (attrs.outcome === 'evaluated' || attrs.outcome === 'no_estates') {
        if (!_estateEvaluated) {
            _estateEvaluated = getMeter().createCounter('agentic.harness_estate.evaluated', {
                description: 'Client estates judged against their cadence by a staleness pass',
                unit: '1',
            });
        }
        _estateEvaluated.add(attrs.evaluated);
    }
    for (const [reason, count] of Object.entries(attrs.staleByReason)) {
        if (!count || count <= 0) continue;
        if (!_estateStale) {
            _estateStale = getMeter().createCounter('agentic.harness_estate.stale', {
                description: 'Client estates found stale by a staleness pass, by reason',
                unit: '1',
            });
        }
        _estateStale.add(count, { reason: reason.toLowerCase() });
    }
}

// ── Internal audit's sampling of the auditor's workpapers (#3677) ──────────

let _workpaperReviewSweep: Counter | null = null;
let _workpaperReviewRows: Counter | null = null;

/**
 * One workpaper-review sweep, by how it ended, and the rows it moved, by kind.
 *
 * `no_workpapers` is a run that found nothing in scope — no workpaper to draw,
 * no review to re-assign, no dissent to raise — recorded as such and never as a
 * clean pass. `partial` is a run in which some tenant's write was refused (the
 * next run retries it).
 *
 * ALERT ON — `outcome="error"`; the absence of any outcome for two scheduled
 * intervals; and a non-zero `kind="unassigned"` that does not fall, which is a
 * tenant whose workpapers nobody in internal audit can be asked to review.
 *
 * No tenant label, and no identifier of any kind.
 */
export function recordWorkpaperReviewSweep(attrs: {
    outcome: 'completed' | 'partial' | 'no_workpapers' | 'error';
    drawn: number;
    assigned: number;
    unassigned: number;
    reassigned: number;
    proposalsRaised: number;
}): void {
    if (!_workpaperReviewSweep) {
        _workpaperReviewSweep = getMeter().createCounter('agentic.workpaper_review.sweep', {
            description: "Internal audit's workpaper-sampling sweeps by terminal outcome",
            unit: '1',
        });
    }
    _workpaperReviewSweep.add(1, { outcome: attrs.outcome });
    if (!_workpaperReviewRows) {
        _workpaperReviewRows = getMeter().createCounter('agentic.workpaper_review.rows', {
            description: 'Sampled-workpaper review rows a sweep moved, by kind',
            unit: '1',
        });
    }
    if (attrs.assigned > 0) _workpaperReviewRows.add(attrs.assigned, { kind: 'drawn_assigned' });
    if (attrs.unassigned > 0) _workpaperReviewRows.add(attrs.unassigned, { kind: 'unassigned' });
    if (attrs.reassigned > 0) _workpaperReviewRows.add(attrs.reassigned, { kind: 'reassigned' });
    if (attrs.proposalsRaised > 0) _workpaperReviewRows.add(attrs.proposalsRaised, { kind: 'proposal_raised' });
}

// ── Agent behavioural circuit breaker (OWASP ASI08 / ASI10) ────────────────

let _breakerVerdict: Counter | null = null;
let _breakerTrip: Counter | null = null;
let _breakerRefusal: Counter | null = null;
let _breakerClose: Counter | null = null;

/**
 * Every window the breaker judged, by outcome. The DENOMINATOR that makes the
 * trip counter a rate — and, more importantly, the series that says whether the
 * control is running at all.
 *
 * The four outcomes partition every evaluation:
 *
 *   no_baseline — REFUSED TO JUDGE. The agent has too little history. This is
 *                 the label to watch on a new deployment: it is not an
 *                 all-clear, and a fleet stuck at 100% `no_baseline` is a
 *                 breaker that is protecting nothing while looking healthy.
 *   steady      — judged, nothing fired.
 *   armed       — something fired, but not for long enough to trip.
 *   trip        — latched OPEN.
 *
 * ALERT ON — `no_baseline` as a SHARE of the total staying above ~50% for more
 * than a fortnight. Every agent earns a baseline in twelve of its own active
 * windows, so a share that does not fall is an epoch being advanced on a loop
 * (somebody closing breakers with `ACCEPTED_NEW_BASELINE` rather than fixing an
 * agent), or a ledger that is not being written.
 *
 * And on the whole series going to ZERO while `agentic.policy_card.evaluation`
 * keeps moving: tool calls are still happening and nothing is judging them.
 * That shape is the one an absence cannot be distinguished from — "the breaker
 * found nothing" and "the breaker never ran" produce the same empty page — which
 * is exactly why the denominator is emitted rather than only the trips.
 */
export function recordAgentBreakerVerdict(attrs: {
    outcome: 'no_baseline' | 'steady' | 'armed' | 'trip';
}): void {
    if (!_breakerVerdict) {
        _breakerVerdict = getMeter().createCounter('agentic.circuit_breaker.verdict', {
            description: 'Behavioural circuit-breaker window evaluations, by outcome',
            unit: '1',
        });
    }
    _breakerVerdict.add(1, { outcome: attrs.outcome });
}

/**
 * One breaker LATCHING OPEN, with the signal that carried it.
 *
 * `signal` is the dimension that decides what an operator does next, and the
 * three mean three different investigations:
 *
 *   PROPOSAL_RATE  — a flood. Look for a loop, a retry storm, or a workflow
 *                    that lost its checkpoint.
 *   REJECTION_RATE — humans started rejecting this agent's work. Look at the
 *                    proposals, not the agent: a model or prompt change is the
 *                    usual cause and the queue noticed it first.
 *   TOOL_MIX       — the agent started doing a KIND of thing it has never done.
 *                    This is the rogue-agent shape, and it is the one to treat
 *                    as an incident rather than a tuning problem: no budget was
 *                    exceeded, which is why nothing else fired.
 *
 * The AGENT is a label and the tool names are NOT. Tool names are on the ledger
 * rows and on the `AUTHZ_DENIED` audit trail, which are the per-call records;
 * adding them here would multiply the series by the catalogue for a dimension
 * two other stores already answer precisely.
 *
 * ALERT ON — any increase, immediately, for `signal="TOOL_MIX"`. A fleet-wide
 * simultaneous jump across every tenant is a deploy that changed what tools
 * exist; a jump confined to one agent is not, and cannot be.
 */
export function recordAgentBreakerTrip(attrs: {
    agentId: string;
    signal: string;
    riskTier: string | null;
}): void {
    if (!_breakerTrip) {
        _breakerTrip = getMeter().createCounter('agentic.circuit_breaker.trip', {
            description: 'Agents latched OPEN by the behavioural circuit breaker, by signal',
            unit: '1',
        });
    }
    _breakerTrip.add(1, {
        agent: attrs.agentId,
        signal: attrs.signal,
        // `unscored` rather than an omitted label, for the reason
        // `recordPolicyCardRefusal` gives: a missing label collapses into
        // whichever series shares the rest of the key.
        'risk.tier': attrs.riskTier ?? 'unscored',
    });
}

/**
 * A tool call refused because the agent's breaker is OPEN.
 *
 * Separate from the trip counter because they answer different questions. One
 * trip produces as many refusals as the agent has calls left in it, so this
 * series measures how hard a stopped agent is still pushing — which is the
 * number that says whether somebody needs to revoke the credential rather than
 * wait for the operator.
 *
 * ALERT ON — a refusal rate that does not decay within an hour of a trip. An
 * agent that keeps calling at full rate into a latched breaker is not a
 * misconfiguration.
 */
export function recordAgentBreakerRefusal(attrs: { agentId: string }): void {
    if (!_breakerRefusal) {
        _breakerRefusal = getMeter().createCounter('agentic.circuit_breaker.refusal', {
            description: 'Agent tool calls refused because the behavioural breaker is OPEN',
            unit: '1',
        });
    }
    _breakerRefusal.add(1, { agent: attrs.agentId });
}

/**
 * A human closing a breaker, by the reason they gave.
 *
 * The two reasons are the two stories, and the ratio between them is the health
 * metric for the whole control:
 *
 *   resolved              — "I fixed the agent". The baseline is kept.
 *   accepted_new_baseline — "yes, I changed this agent". The baseline is
 *                           discarded and the agent re-learns.
 *
 * ALERT ON — `accepted_new_baseline` dominating over weeks. It is the reason
 * that makes the breaker forget, and a deployment where every trip is answered
 * with "that's fine now" has a detector calibrated to fire on ordinary work.
 * That is the failure this control dies of, so it is measured rather than
 * assumed.
 */
export function recordAgentBreakerClose(attrs: {
    agentId: string;
    reason: 'resolved' | 'accepted_new_baseline';
}): void {
    if (!_breakerClose) {
        _breakerClose = getMeter().createCounter('agentic.circuit_breaker.close', {
            description: 'Behavioural circuit breakers closed by a human, by the reason given',
            unit: '1',
        });
    }
    _breakerClose.add(1, { agent: attrs.agentId, reason: attrs.reason });
}

// ── Integration passport sweep (#3672) ─────────────────────────────────────

let _passportSweep: Counter | null = null;

/**
 * One tenant's weekly integration-passport pass, by outcome — and once per
 * sweep that discovered no tenant at all (`SWEPT_NOBODY`).
 *
 * The outcomes are the pass's own (`COMPARED`, `BASELINE`,
 * `PRIOR_UNVERIFIABLE`, `NOT_EVIDENCED`, `TRUNCATED`, `NO_CONNECTIONS`) plus the
 * job's (`NO_ACTOR`, `FAILED`). They are kept apart because the quiet failures
 * look alike from a findings queue: a tenant whose drift was compared and found
 * nothing, one whose drift was never compared because no control receives the
 * passport, and a job that stopped running all produce no new finding.
 *
 * ALERT ON — any `FAILED` or `TRUNCATED`; `PRIOR_UNVERIFIABLE` (somebody edited
 * an emitted passport, or its control was unmapped); and the ABSENCE of any
 * outcome for longer than two Sundays. `NOT_EVIDENCED` that persists is a
 * tenant whose drift is not being reported. No tenant label: a handful of
 * outcomes.
 */
export function recordIntegrationPassportSweep(attrs: { outcome: string }): void {
    if (!_passportSweep) {
        _passportSweep = getMeter().createCounter('agentic.integration_passport.sweep', {
            description: 'Weekly integration-passport passes, by outcome',
            unit: '1',
        });
    }
    _passportSweep.add(1, { outcome: attrs.outcome });
}
