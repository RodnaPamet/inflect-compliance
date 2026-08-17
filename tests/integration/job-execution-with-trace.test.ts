/**
 * Integration test — distributed trace continuity across the
 * web → BullMQ-worker boundary.
 *
 * Stands up a REAL OTel SDK (NodeTracerProvider + an in-memory span
 * exporter + the default W3C TraceContext propagator) and drives the
 * actual propagation seam end to end:
 *
 *   1. a web-tier span injects its context into a carrier (the call
 *      `enqueue` makes), the carrier rides on a job payload, and
 *   2. the worker-side `runJobInTraceContext` extracts + activates it
 *      and runs the job inside a child span.
 *
 * Assertion: the job-execution span lands in the SAME trace as the
 * originating web span and is parented to it — i.e. an operator
 * pivoting from a slow HTTP request sees the async work as one trace.
 *
 * No Redis / no live worker process: the worker's own bullmq plumbing
 * is not under test here, the propagation contract is.
 */
import {
    trace,
    context,
    propagation,
    SpanStatusCode,
} from '@opentelemetry/api';
import {
    NodeTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
    type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import {
    runJobInTraceContext,
    readTraceCarrier,
    stripTraceCarrier,
    OTEL_CARRIER_KEY,
} from '@/lib/observability/job-trace';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeAll(() => {
    // Reset any globals a prior test file in this worker may have set,
    // then register our own real provider + the default W3C propagator.
    trace.disable();
    context.disable();
    propagation.disable();

    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
});

afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

beforeEach(() => {
    exporter.reset();
});

/**
 * Mirror the web tier: run `fn` inside an HTTP-handler span and
 * capture the carrier `enqueue` would attach to the job payload.
 */
async function simulateWebEnqueue(): Promise<{
    carrier: Record<string, string>;
    traceId: string;
    spanId: string;
}> {
    const tracer = trace.getTracer('test.web');
    const carrier: Record<string, string> = {};
    let traceId = '';
    let spanId = '';

    await tracer.startActiveSpan('http POST /policies/[id]/publish', async (span) => {
        traceId = span.spanContext().traceId;
        spanId = span.spanContext().spanId;
        // This is the exact call src/app-layer/jobs/queue.ts makes.
        propagation.inject(context.active(), carrier);
        span.end();
    });

    return { carrier, traceId, spanId };
}

describe('job execution inherits the originating trace', () => {
    it('links the execute span as a child of the web span (same trace)', async () => {
        const web = await simulateWebEnqueue();
        expect(web.carrier.traceparent).toBeDefined();

        // The job payload as it lands in Redis: typed fields + the carrier.
        const payload = {
            tenantId: 'tenant-123',
            policyId: 'pol-9',
            [OTEL_CARRIER_KEY]: web.carrier,
        };

        // Worker side — REAL code path.
        const seenByExecutor = await runJobInTraceContext(
            readTraceCarrier(payload),
            'execute audit-pack-rebuild',
            { 'job.name': 'audit-pack-rebuild' },
            async () => stripTraceCarrier(payload),
        );

        // The executor must NOT see the carrier sentinel.
        expect(seenByExecutor).not.toHaveProperty(OTEL_CARRIER_KEY);
        expect(seenByExecutor).toEqual({ tenantId: 'tenant-123', policyId: 'pol-9' });

        const spans = exporter.getFinishedSpans();
        const webSpan = spans.find((s) => s.name.startsWith('http '));
        const execSpan = spans.find((s) => s.name === 'execute audit-pack-rebuild');

        expect(webSpan).toBeDefined();
        expect(execSpan).toBeDefined();

        // Same trace …
        expect(execSpan!.spanContext().traceId).toBe(web.traceId);
        // … and the execute span is parented to the web span.
        const parentId = (execSpan as ReadableSpan).parentSpanContext?.spanId;
        expect(parentId).toBe(web.spanId);
        expect(execSpan!.status.code).toBe(SpanStatusCode.OK);
    });

    it('marks the execute span ERROR and re-throws when the job fails', async () => {
        const web = await simulateWebEnqueue();
        const payload = { tenantId: 't1', [OTEL_CARRIER_KEY]: web.carrier };

        await expect(
            runJobInTraceContext(
                readTraceCarrier(payload),
                'execute failing-job',
                { 'job.name': 'failing-job' },
                async () => {
                    throw new Error('boom');
                },
            ),
        ).rejects.toThrow('boom');

        const execSpan = exporter
            .getFinishedSpans()
            .find((s) => s.name === 'execute failing-job');
        expect(execSpan).toBeDefined();
        expect(execSpan!.status.code).toBe(SpanStatusCode.ERROR);
        // Same trace as the originating request even on the failure path.
        expect(execSpan!.spanContext().traceId).toBe(web.traceId);
        expect(execSpan!.events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('re-throws the SAME error object, preserving its class', async () => {
        // The span wrapper sits between the worker's throw and BullMQ's retry
        // decision, and that decision is made with `instanceof
        // UnrecoverableError`. Re-wrapping the error here — `throw new
        // Error(err.message)`, which reads like a tidy-up and preserves the
        // message the assertion above checks — would silently restore the
        // amplification H1-2 removed: a throttled or credential-revoked sync
        // would go back to being retried three times in ~35s, and no test
        // would notice.
        class SentinelError extends Error {}
        const thrown = new SentinelError('sentinel');

        const caught = await runJobInTraceContext(
            {},
            'execute sentinel-job',
            {},
            async () => {
                throw thrown;
            },
        ).catch((e) => e);

        expect(caught).toBe(thrown);
        expect(caught).toBeInstanceOf(SentinelError);
    });

    it('starts a fresh root trace when no carrier is present (legacy/orphan job)', async () => {
        // A job enqueued before this feature shipped has no carrier.
        const payload = { tenantId: 't1' };

        await runJobInTraceContext(
            readTraceCarrier(payload),
            'execute legacy-job',
            {},
            async () => undefined,
        );

        const execSpan = exporter
            .getFinishedSpans()
            .find((s) => s.name === 'execute legacy-job');
        expect(execSpan).toBeDefined();
        // No parent — it is its own root.
        expect((execSpan as ReadableSpan).parentSpanContext).toBeUndefined();
    });
});
