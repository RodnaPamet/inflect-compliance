/**
 * The embedding seam's outcome metric (new-subsystem checklist §4).
 *
 *   • `embeddings.requests` — Counter   { provider, operation, outcome }
 *   • `embeddings.request.duration` — Histogram (ms) { provider, operation, outcome }
 *
 * `outcome` is `ok` or the lower-cased `EmbeddingFailure`, so "went green",
 * "refused before sending" and "the service is down" are three different
 * series rather than one error count. Labels are closed sets — no tenant id,
 * no model id, no text — so cardinality is bounded by the type system.
 *
 * @module lib/ai/embeddings/metrics
 */
import { metrics } from '@opentelemetry/api';

import type { EmbeddingFailure, EmbeddingProviderId } from './types';

const METER_NAME = 'inflect-compliance';

export type EmbeddingOperation = 'embed' | 'rerank';
export type EmbeddingOutcome = 'ok' | Lowercase<EmbeddingFailure>;

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
type Histogram = ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;

let requests: Counter | null = null;
let duration: Histogram | null = null;

function instruments(): { requests: Counter; duration: Histogram } {
    const meter = metrics.getMeter(METER_NAME);
    requests ??= meter.createCounter('embeddings.requests', {
        description: 'Embedding and rerank calls, by provider, operation and outcome',
        unit: '1',
    });
    duration ??= meter.createHistogram('embeddings.request.duration', {
        description: 'Wall-clock duration of an embedding or rerank call',
        unit: 'ms',
    });
    return { requests, duration };
}

export function outcomeOf(reason: EmbeddingFailure | null): EmbeddingOutcome {
    return reason === null ? 'ok' : (reason.toLowerCase() as Lowercase<EmbeddingFailure>);
}

export function recordEmbeddingRequest(input: {
    provider: EmbeddingProviderId;
    operation: EmbeddingOperation;
    outcome: EmbeddingOutcome;
    durationMs: number;
}): void {
    const labels = { provider: input.provider, operation: input.operation, outcome: input.outcome };
    const { requests: counter, duration: histogram } = instruments();
    counter.add(1, labels);
    histogram.record(Math.max(0, input.durationMs), labels);
}
