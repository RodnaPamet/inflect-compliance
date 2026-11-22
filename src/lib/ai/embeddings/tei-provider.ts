/**
 * Hugging Face Text Embeddings Inference (TEI), inside the deployment —
 * the `inflect-local` embedding and rerank providers.
 *
 *   embed  → POST <base>/v1/embeddings   (TEI's OpenAI-compatible route)
 *   rerank → GET  <base>/info, then POST <base>/rerank (TEI's cross-encoder route)
 *
 * All through {@link requestJsonBounded}, which dials only through the shared
 * in-deployment rule (`src/lib/ai/in-deployment-service.ts`): every resolved
 * address inside the deployment and pinned, a deadline, a byte cap that aborts.
 * The base URL is OPERATOR configuration read in `select.ts`; nothing a tenant
 * writes reaches it. Neither provider names a model in code — the model, its
 * dimension and its query/passage prefixes are configuration until the Phase 0
 * benchmark decides them (D-L4-3).
 *
 * ── THE SPECIFIER IS RE-CHECKED AT THE SOCKET ──────────────────────────────
 *
 * A provider is built from a specifier (`inflect-local/<model>`) the residency
 * routing chose, and it re-reads that specifier before every send, the way
 * `assistant/turn-provider.ts` re-checks a Flue specifier. A specifier
 * addressed to another provider sends NOTHING and returns
 * `SPECIFIER_NOT_THIS_PROVIDER`. The model on the wire is always the
 * specifier's model part, so no other model can be ASKED for.
 *
 * ── AND THE MODEL THAT ANSWERED IS CHECKED ──────────────────────────────────
 *
 * Asking is not the same as being answered. TEI serves ONE model per process:
 * `/v1/embeddings` ignores the request's `model` and `/rerank` takes none. A
 * container moved to another model of the same dimension would answer every
 * call `ok`, under the configured id, and the retriever revision key — which
 * names that id — would still match an evaluation record made with the old
 * model. So the id a result carries must be the id the SERVICE reports:
 *
 *   • embed  — the response's own `model` (TEI writes its `model_id` there);
 *   • rerank — `/info`'s `model_id`, read BEFORE any passage is sent, so no
 *     passage reaches a reranker that is not the configured one.
 *
 * Absent or different is `SERVED_MODEL_MISMATCH`, and the answer is refused
 * whole. The comparison is exact: the operator names the model as TEI's
 * `--model-id` names it.
 *
 * Texts are never logged; a failure logs its reason, the provider and the
 * model, and the count of texts.
 *
 * @module lib/ai/embeddings/tei-provider
 */
import { z } from 'zod';

import { logger } from '@/lib/observability';

import { getJsonBounded, postJsonBounded, type BoundedPostFailure } from './http';
import { outcomeOf, recordEmbeddingRequest, type EmbeddingOperation } from './metrics';
import {
    EMBEDDING_PROVIDER_IDS,
    MAX_EMBED_BATCH,
    MAX_RERANK_PASSAGES,
    modelOf,
    orderRerankHits,
    providerIdOf,
    type EmbedOptions,
    type EmbeddingFailure,
    type EmbeddingProvider,
    type EmbeddingResult,
    type RerankOptions,
    type RerankProvider,
    type RerankResult,
} from './types';

/** Each call's deadline, covering DNS, the response head and the body read. */
export const TEI_DEADLINE_MS = 15_000;
/** The largest request body either route sends. */
export const TEI_MAX_REQUEST_BYTES = 1024 * 1024;
/** 64 vectors × 4096 floats as JSON is about 6.5 MB; 8 MiB is the ceiling. */
export const TEI_MAX_EMBED_RESPONSE_BYTES = 8 * 1024 * 1024;
/** 50 `{index, score}` pairs are a few KiB. */
export const TEI_MAX_RERANK_RESPONSE_BYTES = 256 * 1024;
/** TEI's `/info` is a small object; a megabyte would be a different service. */
export const TEI_MAX_INFO_RESPONSE_BYTES = 64 * 1024;

export interface TeiEmbeddingRoute {
    readonly specifier: string;
    readonly baseUrl: string;
    readonly dimensions: number;
    readonly queryPrefix: string;
    readonly passagePrefix: string;
}

export interface TeiRerankRoute {
    readonly specifier: string;
    readonly baseUrl: string;
}

const embeddingsResponseSchema = z.object({
    // Optional in the SCHEMA so its absence is reported as the model question
    // it is (SERVED_MODEL_MISMATCH), not as a malformed body.
    model: z.string().optional(),
    data: z.array(
        z.object({
            index: z.number().int().nonnegative(),
            embedding: z.array(z.number()),
        }),
    ),
});

const infoResponseSchema = z.object({ model_id: z.string().optional() });

const rerankResponseSchema = z.array(
    z.object({
        index: z.number().int().nonnegative(),
        score: z.number(),
    }),
);

function endpoint(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

/** Records the metric, logs a failure, and returns the result unchanged. */
function settle<R extends EmbeddingResult | RerankResult>(
    operation: EmbeddingOperation,
    model: string,
    started: number,
    count: number,
    result: R,
): R {
    const reason = result.ok ? null : result.reason;
    recordEmbeddingRequest({
        provider: EMBEDDING_PROVIDER_IDS.local,
        operation,
        outcome: outcomeOf(reason),
        durationMs: Date.now() - started,
    });
    if (!result.ok) {
        logger.warn('embeddings.request_failed', {
            provider: EMBEDDING_PROVIDER_IDS.local,
            operation,
            model,
            reason: result.reason,
            status: result.status,
            count,
        });
    }
    return result;
}

function transportFailure(r: { reason: BoundedPostFailure; status?: number }): {
    ok: false;
    reason: EmbeddingFailure;
    status?: number;
} {
    return r.status === undefined ? { ok: false, reason: r.reason } : { ok: false, reason: r.reason, status: r.status };
}

export class TeiEmbeddingProvider implements EmbeddingProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.local;
    readonly specifier: string;
    readonly model: string;
    readonly dimensions: number;

    constructor(private readonly route: TeiEmbeddingRoute) {
        this.specifier = route.specifier;
        this.model = modelOf(route.specifier);
        this.dimensions = route.dimensions;
    }

    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        const started = Date.now();
        const done = (r: EmbeddingResult) => settle('embed', this.model, started, texts.length, r);

        // The socket-boundary re-check. Nothing below runs for a specifier
        // this provider does not own.
        if (providerIdOf(this.specifier) !== this.providerId || this.model === '') {
            return done({ ok: false, reason: 'SPECIFIER_NOT_THIS_PROVIDER' });
        }
        if (texts.length === 0) return done({ ok: false, reason: 'EMPTY_INPUT' });
        if (texts.length > MAX_EMBED_BATCH) return done({ ok: false, reason: 'BATCH_TOO_LARGE' });

        const prefix = opts.inputType === 'query' ? this.route.queryPrefix : this.route.passagePrefix;
        const body = JSON.stringify({
            model: this.model,
            input: texts.map((t) => `${prefix}${t}`),
            encoding_format: 'float',
        });
        if (byteLength(body) > TEI_MAX_REQUEST_BYTES) return done({ ok: false, reason: 'INPUT_TOO_LARGE' });

        const res = await postJsonBounded(endpoint(this.route.baseUrl, '/v1/embeddings'), body, {
            service: 'embed',
            deadlineMs: TEI_DEADLINE_MS,
            maxResponseBytes: TEI_MAX_EMBED_RESPONSE_BYTES,
            signal: opts.signal,
        });
        if (!res.ok) return done(transportFailure(res));

        const parsed = embeddingsResponseSchema.safeParse(res.json);
        if (!parsed.success) return done({ ok: false, reason: 'MALFORMED_RESPONSE' });
        // The model that ANSWERED, not the one asked for (module header).
        if (parsed.data.model !== this.model) return done({ ok: false, reason: 'SERVED_MODEL_MISMATCH' });

        // Exactly one vector per text, each index once, each of the configured
        // dimension. A short answer is not a partial success: a missing vector
        // is a passage nobody can find.
        const rows = parsed.data.data;
        if (rows.length !== texts.length) return done({ ok: false, reason: 'COUNT_MISMATCH' });
        const vectors: (readonly number[])[] = new Array<readonly number[]>(texts.length);
        const seen = new Set<number>();
        for (const row of rows) {
            if (row.index >= texts.length || seen.has(row.index)) {
                return done({ ok: false, reason: 'COUNT_MISMATCH' });
            }
            if (row.embedding.length !== this.dimensions) {
                return done({ ok: false, reason: 'DIMENSION_MISMATCH' });
            }
            seen.add(row.index);
            vectors[row.index] = row.embedding;
        }
        return done({ ok: true, vectors, model: this.model, dimensions: this.dimensions });
    }
}

export class TeiRerankProvider implements RerankProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.local;
    readonly specifier: string;
    readonly model: string;

    constructor(private readonly route: TeiRerankRoute) {
        this.specifier = route.specifier;
        this.model = modelOf(route.specifier);
    }

    async rerank(query: string, passages: readonly string[], opts: RerankOptions): Promise<RerankResult> {
        const started = Date.now();
        const done = (r: RerankResult) => settle('rerank', this.model, started, passages.length, r);

        if (providerIdOf(this.specifier) !== this.providerId || this.model === '') {
            return done({ ok: false, reason: 'SPECIFIER_NOT_THIS_PROVIDER' });
        }
        if (passages.length === 0) return done({ ok: false, reason: 'EMPTY_INPUT' });
        if (passages.length > MAX_RERANK_PASSAGES) return done({ ok: false, reason: 'BATCH_TOO_LARGE' });

        const body = JSON.stringify({ query, texts: passages, raw_scores: false, return_text: false, truncate: true });
        if (byteLength(body) > TEI_MAX_REQUEST_BYTES) return done({ ok: false, reason: 'INPUT_TOO_LARGE' });

        // TEI serves one reranker per process and takes no model field, so the
        // served model is read from /info BEFORE any passage is sent.
        const info = await getJsonBounded(endpoint(this.route.baseUrl, '/info'), {
            service: 'rerank',
            deadlineMs: TEI_DEADLINE_MS,
            maxResponseBytes: TEI_MAX_INFO_RESPONSE_BYTES,
            signal: opts.signal,
        });
        if (!info.ok) return done(transportFailure(info));
        const served = infoResponseSchema.safeParse(info.json);
        if (!served.success) return done({ ok: false, reason: 'MALFORMED_RESPONSE' });
        if (served.data.model_id !== this.model) return done({ ok: false, reason: 'SERVED_MODEL_MISMATCH' });

        const res = await postJsonBounded(endpoint(this.route.baseUrl, '/rerank'), body, {
            service: 'rerank',
            deadlineMs: TEI_DEADLINE_MS,
            maxResponseBytes: TEI_MAX_RERANK_RESPONSE_BYTES,
            signal: opts.signal,
        });
        if (!res.ok) return done(transportFailure(res));

        const parsed = rerankResponseSchema.safeParse(res.json);
        if (!parsed.success) return done({ ok: false, reason: 'MALFORMED_RESPONSE' });

        // Every passage scored exactly once. An unscored passage would sort
        // as if it had lost, which is a claim the cross-encoder never made.
        const hits = parsed.data;
        const seen = new Set<number>();
        for (const hit of hits) {
            if (hit.index >= passages.length || seen.has(hit.index)) {
                return done({ ok: false, reason: 'COUNT_MISMATCH' });
            }
            seen.add(hit.index);
        }
        if (seen.size !== passages.length) return done({ ok: false, reason: 'COUNT_MISMATCH' });
        return done({ ok: true, hits: orderRerankHits(hits, opts.topN), model: this.model });
    }
}
