/**
 * What the metrics module actually EMITS.
 *
 * The existing `observability-metrics.test.ts` runs against the OTel noop
 * meter, so every assertion in it is `not.toThrow()`. That executes the code
 * but cannot see a wrong decision: swap the success and failure counters in
 * `recordAuditStreamDelivery`, put `tenantId` on a metric label, or observe a
 * BullMQ state the cardinality rules exclude, and every one of those tests
 * still passes.
 *
 * This file installs a RECORDING meter in place of the noop one, so the
 * assertions can be about the instrument each call reaches, the value, and the
 * exact label set. It also drives the two observable gauges' scrape callbacks,
 * which the noop meter never invokes at all — that is where the
 * reportable-state filter and both swallow-everything catch blocks live.
 */

interface Emission {
    instrument: string;
    value: number;
    attrs: Record<string, unknown> | undefined;
}

const adds: Emission[] = [];
const records: Emission[] = [];
type ObserveResult = { observe: (value: number, attrs?: Record<string, unknown>) => void };
type GaugeCallback = (result: ObserveResult) => void | Promise<void>;
const gaugeCallbacks = new Map<string, GaugeCallback>();
/**
 * One entry per instrument CONSTRUCTION. `adds`/`records` are keyed by
 * instrument name, so a module that rebuilt its counter on every call would be
 * indistinguishable there — this is the only place that difference is visible.
 * Deliberately NOT cleared per test: the lazy getters cache at module scope,
 * so the invariant is one construction for the whole file.
 */
const instrumentCreations: string[] = [];

jest.mock('@opentelemetry/api', () => ({
    metrics: {
        getMeter: () => ({
            createCounter: (name: string) => (instrumentCreations.push(name), {
                add: (value: number, attrs?: Record<string, unknown>) => {
                    adds.push({ instrument: name, value, attrs });
                },
            }),
            createHistogram: (name: string) => (instrumentCreations.push(name), {
                record: (value: number, attrs?: Record<string, unknown>) => {
                    records.push({ instrument: name, value, attrs });
                },
            }),
            createObservableGauge: (name: string) => ({
                addCallback: (cb: GaugeCallback) => {
                    gaugeCallbacks.set(name, cb);
                },
            }),
        }),
    },
}));

import {
    recordAggregationCacheHit,
    recordAggregationCacheMiss,
    recordSsrCacheHit,
    recordSsrCacheMiss,
    recordRequestMetrics,
    recordRequestError,
    recordJobMetrics,
    recordAuditStreamDelivery,
    recordAuditStreamBufferOverflow,
    recordFieldDecryptFailure,
    recordTenantContextMismatch,
    recordSessionPolicyResolution,
    recordVerificationEmailDelivery,
    recordEntraGroupResolution,
    recordSlowQuery,
    recordAiRiskAssessment,
    recordAiDecisionLogged,
    recordAiDecisionOutcome,
    startQueueDepthReporting,
    startAuditStreamBufferReporting,
    _resetQueueDepthForTesting,
    _resetAuditStreamBufferGaugeForTesting,
} from '@/lib/observability/metrics';

/** Every counter `add` that landed on `instrument`. */
function addsTo(instrument: string): Emission[] {
    return adds.filter((e) => e.instrument === instrument);
}

/** Every histogram `record` that landed on `instrument`. */
function recordsTo(instrument: string): Emission[] {
    return records.filter((e) => e.instrument === instrument);
}

beforeEach(() => {
    adds.length = 0;
    records.length = 0;
});

// ══════════════════════════════════════════════════════════════════════
// Request / job / audit-stream — which instrument, which labels
// ══════════════════════════════════════════════════════════════════════

describe('recordRequestMetrics', () => {
    it('labels count and duration with the NORMALISED route, never the raw one', () => {
        recordRequestMetrics({
            method: 'GET',
            route: '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000',
            status: 200,
            durationMs: 12,
        });

        const expected = {
            'http.method': 'GET',
            'http.route': '/api/t/:tenantSlug/controls/:id',
            'http.status_code': 200,
        };
        expect(addsTo('api.request.count')).toEqual([
            { instrument: 'api.request.count', value: 1, attrs: expected },
        ]);
        expect(recordsTo('api.request.duration')).toEqual([
            { instrument: 'api.request.duration', value: 12, attrs: expected },
        ]);
    });
});

describe('recordRequestError', () => {
    it('emits one error count carrying the error code and the normalised route', () => {
        recordRequestError({
            method: 'DELETE',
            route: '/t/acme-corp/risks',
            errorCode: 'NOT_FOUND',
        });

        expect(addsTo('api.request.errors')).toEqual([
            {
                instrument: 'api.request.errors',
                value: 1,
                attrs: {
                    'http.method': 'DELETE',
                    'http.route': '/t/:tenantSlug/risks',
                    'error.code': 'NOT_FOUND',
                },
            },
        ]);
    });
});

describe('recordJobMetrics', () => {
    it('maps the success boolean onto the job.status label, both ways', () => {
        recordJobMetrics({ jobName: 'key-rotation', success: true, durationMs: 100 });
        recordJobMetrics({ jobName: 'key-rotation', success: false, durationMs: 200 });

        expect(addsTo('job.execution.count').map((e) => e.attrs)).toEqual([
            { 'job.name': 'key-rotation', 'job.status': 'success' },
            { 'job.name': 'key-rotation', 'job.status': 'failure' },
        ]);
        expect(recordsTo('job.execution.duration').map((e) => e.value)).toEqual([100, 200]);
    });
});

describe('recordAuditStreamDelivery', () => {
    it('counts a success on the success instrument only, labelled by status', () => {
        recordAuditStreamDelivery({ outcome: 'success', status: 200, attempts: 1, durationMs: 50 });

        expect(addsTo('audit_stream.delivery.success')).toEqual([
            {
                instrument: 'audit_stream.delivery.success',
                value: 1,
                attrs: { 'http.status_code': 200 },
            },
        ]);
        expect(addsTo('audit_stream.delivery.failures')).toHaveLength(0);
    });

    it('counts a failure on the failures instrument only', () => {
        recordAuditStreamDelivery({ outcome: 'failure', status: 0, attempts: 3, durationMs: 5_000 });

        expect(addsTo('audit_stream.delivery.failures')).toEqual([
            {
                instrument: 'audit_stream.delivery.failures',
                value: 1,
                attrs: { 'http.status_code': 0 },
            },
        ]);
        expect(addsTo('audit_stream.delivery.success')).toHaveLength(0);
    });

    it('records attempts and duration once per batch, labelled by outcome not status', () => {
        // The retry-pressure histogram is what tells an operator the SIEM is
        // flaky; labelling it by status instead of outcome would split the
        // series across every HTTP code the downstream returns.
        recordAuditStreamDelivery({ outcome: 'failure', status: 503, attempts: 3, durationMs: 4_200 });

        expect(recordsTo('audit_stream.delivery.attempts')).toEqual([
            {
                instrument: 'audit_stream.delivery.attempts',
                value: 3,
                attrs: { outcome: 'failure' },
            },
        ]);
        expect(recordsTo('audit_stream.delivery.duration')).toEqual([
            {
                instrument: 'audit_stream.delivery.duration',
                value: 4_200,
                attrs: { outcome: 'failure' },
            },
        ]);
    });

    it('overflow is an unlabelled count of one dropped event', () => {
        recordAuditStreamBufferOverflow();
        expect(addsTo('audit_stream.buffer.overflow_dropped')).toEqual([
            {
                instrument: 'audit_stream.buffer.overflow_dropped',
                value: 1,
                attrs: undefined,
            },
        ]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Encryption signals — the labels the Epic B read/write paths rely on
// ══════════════════════════════════════════════════════════════════════

describe('recordFieldDecryptFailure', () => {
    it('carries model, field, ciphertext version and the failure CLASS', () => {
        // The three outcomes have opposite correct responses. Before the
        // outcome label they were one undifferentiated number, and a genuine
        // key mismatch was invisible inside routine no-DEK noise.
        recordFieldDecryptFailure({
            model: 'Finding',
            field: 'description',
            version: 'v2',
            outcome: 'decrypt_failed',
        });

        expect(addsTo('encryption.field.decrypt_failed')).toEqual([
            {
                instrument: 'encryption.field.decrypt_failed',
                value: 1,
                attrs: {
                    model: 'Finding',
                    field: 'description',
                    'ciphertext.version': 'v2',
                    outcome: 'decrypt_failed',
                },
            },
        ]);
    });

    it('keeps the by-design class on its own label value', () => {
        recordFieldDecryptFailure({
            model: '*',
            field: 'body',
            version: 'unknown',
            outcome: 'no_dek_by_design',
        });
        expect(addsTo('encryption.field.decrypt_failed')[0].attrs).toMatchObject({
            outcome: 'no_dek_by_design',
        });
    });
});

describe('recordTenantContextMismatch', () => {
    it('separates the corrupting `mismatch` from the merely `unscoped` write', () => {
        recordTenantContextMismatch({ model: 'Task', operation: 'update', outcome: 'mismatch' });
        recordTenantContextMismatch({ model: 'Finding', operation: 'create', outcome: 'unscoped' });

        expect(addsTo('encryption.write.tenant_context_mismatch').map((e) => e.attrs)).toEqual([
            { model: 'Task', operation: 'update', outcome: 'mismatch' },
            { model: 'Finding', operation: 'create', outcome: 'unscoped' },
        ]);
    });
});

describe('recordSlowQuery', () => {
    it('labels by model ONLY — raw SQL and bound params never reach a label', () => {
        recordSlowQuery('Evidence');
        expect(addsTo('db.slow_query.count')).toEqual([
            { instrument: 'db.slow_query.count', value: 1, attrs: { model: 'Evidence' } },
        ]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Auth-adjacent counters
// ══════════════════════════════════════════════════════════════════════

describe('recordSessionPolicyResolution', () => {
    it('records the failed outcome — the signal that the session caps did not apply', () => {
        recordSessionPolicyResolution({ outcome: 'failed' });
        expect(addsTo('session.policy.resolution')).toEqual([
            {
                instrument: 'session.policy.resolution',
                value: 1,
                attrs: { outcome: 'failed' },
            },
        ]);
    });

    it('records the ok outcome on the same instrument, so a ratio is derivable', () => {
        recordSessionPolicyResolution({ outcome: 'ok' });
        expect(addsTo('session.policy.resolution')[0].attrs).toEqual({ outcome: 'ok' });
    });
});

describe('recordVerificationEmailDelivery', () => {
    it('routes a sent outcome to the sent counter, labelled by flow only', () => {
        recordVerificationEmailDelivery({ outcome: 'sent', flow: 'register' });

        expect(addsTo('auth.verification_email.sent')).toEqual([
            {
                instrument: 'auth.verification_email.sent',
                value: 1,
                attrs: { flow: 'register' },
            },
        ]);
        expect(addsTo('auth.verification_email.failed')).toHaveLength(0);
    });

    it('routes a failed outcome to the failed counter', () => {
        recordVerificationEmailDelivery({ outcome: 'failed', flow: 'resend' });

        expect(addsTo('auth.verification_email.failed')).toEqual([
            {
                instrument: 'auth.verification_email.failed',
                value: 1,
                attrs: { flow: 'resend' },
            },
        ]);
        expect(addsTo('auth.verification_email.sent')).toHaveLength(0);
    });
});

describe('recordEntraGroupResolution', () => {
    it('records the Graph fetch duration only on the overage path', () => {
        recordEntraGroupResolution({
            source: 'graph_overage',
            outcome: 'resolved',
            groupCount: 250,
            graphFetchDurationMs: 120,
        });

        expect(recordsTo('auth.entra.graph_fetch.duration')).toEqual([
            {
                instrument: 'auth.entra.graph_fetch.duration',
                value: 120,
                attrs: { outcome: 'resolved' },
            },
        ]);
    });

    it('does NOT record a Graph duration for a token-sourced sign-in that supplies one', () => {
        // A token-claim resolution made no Graph call; a duration on that path
        // is meaningless and would pollute the latency series.
        recordEntraGroupResolution({
            source: 'token',
            outcome: 'resolved',
            groupCount: 3,
            graphFetchDurationMs: 999,
        });

        expect(recordsTo('auth.entra.graph_fetch.duration')).toHaveLength(0);
        expect(recordsTo('auth.entra.group_count')).toEqual([
            {
                instrument: 'auth.entra.group_count',
                value: 3,
                attrs: { source: 'token' },
            },
        ]);
    });

    it('skips the duration histogram when the overage path omits the duration', () => {
        recordEntraGroupResolution({ source: 'graph_overage', outcome: 'empty', groupCount: 0 });

        expect(recordsTo('auth.entra.graph_fetch.duration')).toHaveLength(0);
        expect(addsTo('auth.entra.group_resolution')[0].attrs).toEqual({
            source: 'graph_overage',
            outcome: 'empty',
        });
    });
});

// ══════════════════════════════════════════════════════════════════════
// AI metrics — every conditional emission
// ══════════════════════════════════════════════════════════════════════

describe('recordAiRiskAssessment', () => {
    it('emits calls + duration on every generation, and nothing conditional', () => {
        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'failure',
            durationMs: 900,
            fallback: false,
        });

        const labels = { provider: 'anthropic', outcome: 'failure' };
        expect(addsTo('ai.risk_assessment.calls')).toEqual([
            { instrument: 'ai.risk_assessment.calls', value: 1, attrs: labels },
        ]);
        expect(recordsTo('ai.risk_assessment.duration')).toEqual([
            { instrument: 'ai.risk_assessment.duration', value: 900, attrs: labels },
        ]);
        expect(addsTo('ai.risk_assessment.fallbacks')).toHaveLength(0);
        expect(recordsTo('ai.risk_assessment.suggestions')).toHaveLength(0);
        expect(addsTo('ai.risk_assessment.tokens')).toHaveLength(0);
    });

    it('counts a fallback with the provider label but no outcome label', () => {
        recordAiRiskAssessment({
            provider: 'stub',
            outcome: 'success',
            durationMs: 5,
            fallback: true,
            suggestionCount: 2,
        });

        expect(addsTo('ai.risk_assessment.fallbacks')).toEqual([
            { instrument: 'ai.risk_assessment.fallbacks', value: 1, attrs: { provider: 'stub' } },
        ]);
    });

    it('records the suggestion count only when the generation SUCCEEDED', () => {
        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'failure',
            durationMs: 10,
            fallback: false,
            suggestionCount: 4,
        });
        expect(recordsTo('ai.risk_assessment.suggestions')).toHaveLength(0);

        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'success',
            durationMs: 10,
            fallback: false,
            suggestionCount: 4,
        });
        expect(recordsTo('ai.risk_assessment.suggestions')).toEqual([
            {
                instrument: 'ai.risk_assessment.suggestions',
                value: 4,
                attrs: { provider: 'anthropic' },
            },
        ]);
    });

    it('records a ZERO suggestion count — an empty generation is data, not absence', () => {
        // The gate is `typeof === 'number'`, not truthiness. A truthiness test
        // here would silently drop every zero-suggestion generation, which is
        // exactly the population an operator wants to see.
        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'success',
            durationMs: 10,
            fallback: false,
            suggestionCount: 0,
        });
        expect(recordsTo('ai.risk_assessment.suggestions')).toEqual([
            {
                instrument: 'ai.risk_assessment.suggestions',
                value: 0,
                attrs: { provider: 'anthropic' },
            },
        ]);
    });

    it('splits token usage by kind, and gates each half independently', () => {
        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'success',
            durationMs: 10,
            fallback: false,
            promptTokens: 1_200,
        });
        expect(addsTo('ai.risk_assessment.tokens')).toEqual([
            {
                instrument: 'ai.risk_assessment.tokens',
                value: 1_200,
                attrs: { provider: 'anthropic', kind: 'prompt' },
            },
        ]);

        adds.length = 0;
        recordAiRiskAssessment({
            provider: 'anthropic',
            outcome: 'success',
            durationMs: 10,
            fallback: false,
            promptTokens: 30,
            completionTokens: 70,
        });
        expect(addsTo('ai.risk_assessment.tokens')).toEqual([
            {
                instrument: 'ai.risk_assessment.tokens',
                value: 30,
                attrs: { provider: 'anthropic', kind: 'prompt' },
            },
            {
                instrument: 'ai.risk_assessment.tokens',
                value: 70,
                attrs: { provider: 'anthropic', kind: 'completion' },
            },
        ]);
    });
});

describe('recordAiDecisionLogged', () => {
    it('does not touch the guard-block counter when the guard passed', () => {
        recordAiDecisionLogged({ provider: 'anthropic', feature: 'risk-suggest' });

        expect(addsTo('ai.decision.logged')).toEqual([
            {
                instrument: 'ai.decision.logged',
                value: 1,
                attrs: { provider: 'anthropic', feature: 'risk-suggest' },
            },
        ]);
        expect(addsTo('ai.decision.guard_blocks')).toHaveLength(0);
    });

    it('counts a guard block alongside the invocation, with the same labels', () => {
        recordAiDecisionLogged({ provider: 'anthropic', feature: 'risk-suggest', guardBlocked: true });

        expect(addsTo('ai.decision.guard_blocks')).toEqual([
            {
                instrument: 'ai.decision.guard_blocks',
                value: 1,
                attrs: { provider: 'anthropic', feature: 'risk-suggest' },
            },
        ]);
        expect(addsTo('ai.decision.logged')).toHaveLength(1);
    });

    it('treats an explicit guardBlocked=false as not blocked', () => {
        recordAiDecisionLogged({ provider: 'openai', feature: 'summarise', guardBlocked: false });
        expect(addsTo('ai.decision.guard_blocks')).toHaveLength(0);
    });
});

describe('recordAiDecisionOutcome', () => {
    it('labels the human-oversight outcome so acceptance rate is derivable', () => {
        recordAiDecisionOutcome({ outcome: 'EDITED' });
        expect(addsTo('ai.decision.outcome')).toEqual([
            { instrument: 'ai.decision.outcome', value: 1, attrs: { outcome: 'EDITED' } },
        ]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Observable gauges — the scrape callbacks the noop meter never runs
// ══════════════════════════════════════════════════════════════════════

describe('job.queue.depth gauge callback', () => {
    beforeEach(() => {
        gaugeCallbacks.delete('job.queue.depth');
        _resetQueueDepthForTesting();
    });

    afterEach(() => {
        _resetQueueDepthForTesting();
    });

    /** Drive one scrape of the registered gauge and collect what it observed. */
    async function scrape(): Promise<Array<{ value: number; attrs: Record<string, unknown> | undefined }>> {
        const cb = gaugeCallbacks.get('job.queue.depth');
        if (!cb) throw new Error('queue-depth gauge was never registered');
        const observed: Array<{ value: number; attrs: Record<string, unknown> | undefined }> = [];
        await cb({
            observe: (value: number, attrs?: Record<string, unknown>) => {
                observed.push({ value, attrs });
            },
        });
        return observed;
    }

    it('observes exactly the four reportable states, each with the queue label', async () => {
        startQueueDepthReporting(() => ({
            getJobCounts: async () => ({ waiting: 5, active: 2, delayed: 1, failed: 0 }),
        }));

        expect(await scrape()).toEqual([
            { value: 5, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'waiting' } },
            { value: 2, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'active' } },
            { value: 1, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'delayed' } },
            { value: 0, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'failed' } },
        ]);
    });

    it('ignores BullMQ states outside the reportable list — cardinality discipline', async () => {
        startQueueDepthReporting(() => ({
            getJobCounts: async () => ({
                waiting: 1,
                paused: 99,
                completed: 12_345,
                'waiting-children': 7,
            }),
        }));

        const observed = await scrape();
        expect(observed.map((o) => o.attrs?.['queue.state'])).toEqual(['waiting']);
    });

    it('skips a state the queue did not report rather than observing undefined', async () => {
        // `counts[state] !== undefined` is the guard. Without it the gauge
        // observes `undefined` for every absent state, which OTel turns into
        // NaN data points.
        startQueueDepthReporting(() => ({
            getJobCounts: async () => ({ waiting: 3, failed: 4 }),
        }));

        const observed = await scrape();
        expect(observed).toStrictEqual([
            { value: 3, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'waiting' } },
            { value: 4, attrs: { 'queue.name': 'inflect-jobs', 'queue.state': 'failed' } },
        ]);
    });

    it('swallows a queue that is not available and observes nothing', async () => {
        // A worker whose Redis connection is down must degrade to a silent
        // gauge, never to a rejected scrape that takes the exporter with it.
        startQueueDepthReporting(() => {
            throw new Error('redis down');
        });

        await expect(scrape()).resolves.toStrictEqual([]);
    });

    it('swallows a rejected getJobCounts too', async () => {
        startQueueDepthReporting(() => ({
            getJobCounts: async () => {
                throw new Error('ECONNRESET');
            },
        }));

        await expect(scrape()).resolves.toStrictEqual([]);
    });
});

describe('audit_stream.buffer.depth gauge callback', () => {
    beforeEach(() => {
        gaugeCallbacks.delete('audit_stream.buffer.depth');
        _resetAuditStreamBufferGaugeForTesting();
    });

    afterEach(() => {
        _resetAuditStreamBufferGaugeForTesting();
    });

    async function scrape(): Promise<number[]> {
        const cb = gaugeCallbacks.get('audit_stream.buffer.depth');
        if (!cb) throw new Error('buffer-depth gauge was never registered');
        const observed: number[] = [];
        await cb({ observe: (value: number) => { observed.push(value); } });
        return observed;
    }

    it('observes the current total buffered depth at scrape time', async () => {
        let depth = 7;
        startAuditStreamBufferReporting(() => depth);

        expect(await scrape()).toEqual([7]);
        depth = 41;
        expect(await scrape()).toEqual([41]);
    });

    it('swallows a throwing depth reader and observes nothing', async () => {
        startAuditStreamBufferReporting(() => {
            throw new Error('buffer module not loaded');
        });

        await expect(scrape()).resolves.toStrictEqual([]);
    });

    it('keeps the FIRST registration when called twice — the flag is not a re-bind', async () => {
        startAuditStreamBufferReporting(() => 1);
        startAuditStreamBufferReporting(() => 2);

        expect(await scrape()).toEqual([1]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Cache counters — the two pairs nothing calls today
// ══════════════════════════════════════════════════════════════════════

describe('aggregation cache counters', () => {
    it('counts a hit on the hit instrument and records NO compute duration', () => {
        // A hit that also recorded a compute duration would inflate the
        // miss-latency series with near-zero cache reads and hide a genuinely
        // slow aggregation behind a healthy-looking median.
        recordAggregationCacheHit('risk-heatmap');

        expect(addsTo('cache.aggregation.hit')).toEqual([
            { instrument: 'cache.aggregation.hit', value: 1, attrs: { aggregation: 'risk-heatmap' } },
        ]);
        expect(addsTo('cache.aggregation.miss')).toHaveLength(0);
        expect(recordsTo('cache.aggregation.compute_duration_ms')).toHaveLength(0);
    });

    it('counts a miss AND the compute it paid for, both keyed by aggregation', () => {
        recordAggregationCacheMiss('control-coverage', 412);

        expect(addsTo('cache.aggregation.miss')).toEqual([
            {
                instrument: 'cache.aggregation.miss',
                value: 1,
                attrs: { aggregation: 'control-coverage' },
            },
        ]);
        expect(recordsTo('cache.aggregation.compute_duration_ms')).toEqual([
            {
                instrument: 'cache.aggregation.compute_duration_ms',
                value: 412,
                attrs: { aggregation: 'control-coverage' },
            },
        ]);
        expect(addsTo('cache.aggregation.hit')).toHaveLength(0);
    });

    it('reuses one instrument across calls rather than creating a second', () => {
        // The lazy `if (!_instrument)` guard. Re-creating a counter per call
        // resets its accumulation and produces a sawtooth in the exported
        // series that reads as traffic falling off a cliff.
        recordAggregationCacheHit('a');
        recordAggregationCacheHit('b');

        expect(addsTo('cache.aggregation.hit').map((e) => e.attrs)).toEqual([
            { aggregation: 'a' },
            { aggregation: 'b' },
        ]);
        // The load-bearing half: two `add` calls, ONE construction. Without
        // this the assertion above passes with the lazy guard deleted.
        expect(
            instrumentCreations.filter((n) => n === 'cache.aggregation.hit'),
        ).toHaveLength(1);
    });
});

describe('SSR payload cache counters', () => {
    it('labels the shared duration histogram outcome=hit on a hit', () => {
        // Hit and miss share ONE duration histogram, separated only by the
        // `outcome` label. Swapping the two labels is invisible in the code
        // and inverts every SSR cache dashboard.
        recordSsrCacheHit('/t/:tenantSlug/risks', 3);

        expect(addsTo('cache.ssr.hit')).toEqual([
            { instrument: 'cache.ssr.hit', value: 1, attrs: { route: '/t/:tenantSlug/risks' } },
        ]);
        expect(recordsTo('cache.ssr.duration')).toEqual([
            {
                instrument: 'cache.ssr.duration',
                value: 3,
                attrs: { route: '/t/:tenantSlug/risks', outcome: 'hit' },
            },
        ]);
        expect(addsTo('cache.ssr.miss')).toHaveLength(0);
    });

    it('labels the same histogram outcome=miss on a miss', () => {
        recordSsrCacheMiss('/t/:tenantSlug/controls', 280);

        expect(addsTo('cache.ssr.miss')).toEqual([
            { instrument: 'cache.ssr.miss', value: 1, attrs: { route: '/t/:tenantSlug/controls' } },
        ]);
        expect(recordsTo('cache.ssr.duration')).toEqual([
            {
                instrument: 'cache.ssr.duration',
                value: 280,
                attrs: { route: '/t/:tenantSlug/controls', outcome: 'miss' },
            },
        ]);
        expect(addsTo('cache.ssr.hit')).toHaveLength(0);
    });

    it('keeps both outcomes on ONE histogram so the hit ratio is derivable', () => {
        recordSsrCacheHit('/t/:tenantSlug/risks', 2);
        recordSsrCacheMiss('/t/:tenantSlug/risks', 300);

        expect(recordsTo('cache.ssr.duration').map((e) => e.attrs?.outcome)).toEqual([
            'hit',
            'miss',
        ]);
    });
});
