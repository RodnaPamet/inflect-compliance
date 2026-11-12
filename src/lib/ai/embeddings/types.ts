/**
 * The embedding and rerank seam — the contracts every engine, index job and
 * search path speaks (`docs/ai-architecture/nemotron-retriever.md`, Phases 1
 * and 2).
 *
 * Two rules shape every type here:
 *
 *   • A provider id names a RESIDENCY, never a vendor or a model. The ids are
 *     the ones `flue/model-selection.ts` uses for the same reason: the routing
 *     decision is "where may this tenant's text go", and a vendor name in the id
 *     would make that decision unreadable at the call site.
 *   • A call DEGRADES rather than throws. Every failure is a named value in the
 *     result, so an index job can count it, a search path can fall back to the
 *     hybrid order, and nothing is mistaken for "no results".
 *
 * The model is CONFIGURATION, not code (owner decision D-L4-3 leaves the
 * choice to the Phase 0 benchmark). Nothing in this directory names a model.
 *
 * @module lib/ai/embeddings/types
 */

/** Provider ids, by residency. `inflect-stub` is never chosen by the factory. */
export const EMBEDDING_PROVIDER_IDS = {
    /** A service inside the deployment's perimeter (TEI on the VM's CPU). */
    local: 'inflect-local',
    /** The deterministic stub. Constructed by tests and eval harnesses only. */
    stub: 'inflect-stub',
} as const;

export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[keyof typeof EMBEDDING_PROVIDER_IDS];

/**
 * Asymmetric retrieval models score a query and a passage differently. Mixing
 * them silently degrades recall, which is why the input type is REQUIRED on
 * every call rather than defaulted.
 */
export type EmbeddingInputType = 'query' | 'passage';

/** At most this many texts per `embed` call (the doc's batch bound). */
export const MAX_EMBED_BATCH = 64;

/** At most this many passages per `rerank` call (the hybrid top-50). */
export const MAX_RERANK_PASSAGES = 50;

/**
 * Why a call produced nothing. Each is an outcome label on
 * `embeddings.requests`, lower-cased.
 */
export type EmbeddingFailure =
    /** The provider was handed a specifier addressed to another provider. Nothing was sent. */
    | 'SPECIFIER_NOT_THIS_PROVIDER'
    /** No texts (or, for rerank, no passages). Nothing was sent. */
    | 'EMPTY_INPUT'
    /** More than the per-call bound. Nothing was sent. */
    | 'BATCH_TOO_LARGE'
    /** The request body would exceed its byte cap. Nothing was sent. */
    | 'INPUT_TOO_LARGE'
    /**
     * The endpoint is, or resolves to, an address outside the deployment's
     * perimeter (`perimeter.ts`). Nothing was sent.
     */
    | 'ENDPOINT_OUTSIDE_PERIMETER'
    /** The service answered with a redirect, which is never followed. */
    | 'REDIRECT_REFUSED'
    /** The deadline passed before the whole body was read. */
    | 'TIMEOUT'
    /** The caller's own signal aborted the call. */
    | 'ABORTED'
    /** The service answered with a non-2xx status. */
    | 'HTTP_STATUS'
    /** The response body passed its byte cap. Reading was aborted at the cap. */
    | 'RESPONSE_TOO_LARGE'
    /** The body was not the shape the service's API defines. */
    | 'MALFORMED_RESPONSE'
    /** A different number of vectors / scores than texts sent, or a repeated index. */
    | 'COUNT_MISMATCH'
    /** A vector of a different length than the configured dimension. */
    | 'DIMENSION_MISMATCH'
    /**
     * The service did not report serving the configured model — it named
     * another, or none. TEI serves one model per process whatever a request
     * asks for, so what it SAYS it served is the only binding between the
     * model id on a result (and on the revision key) and the vectors.
     */
    | 'SERVED_MODEL_MISMATCH'
    /** The connection failed before an answer. */
    | 'NETWORK_ERROR';

export type EmbeddingResult =
    | {
          readonly ok: true;
          /** One vector per input text, in input order. */
          readonly vectors: readonly (readonly number[])[];
          /** The model id (the specifier's model part), never the provider id. */
          readonly model: string;
          readonly dimensions: number;
      }
    | { readonly ok: false; readonly reason: EmbeddingFailure; readonly status?: number };

export interface EmbedOptions {
    readonly inputType: EmbeddingInputType;
    /** The caller's own cancellation; the provider's deadline applies regardless. */
    readonly signal?: AbortSignal;
}

export interface EmbeddingProvider {
    readonly providerId: EmbeddingProviderId;
    /** `<providerId>/<model>` — the routing decision this provider was built from. */
    readonly specifier: string;
    readonly model: string;
    readonly dimensions: number;
    embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult>;
}

/** One reranked passage: its index in the input and the cross-encoder's score. */
export interface RerankHit {
    readonly index: number;
    readonly score: number;
}

export type RerankResult =
    | {
          readonly ok: true;
          /** Highest score first; ties by input index. At most `topN`. */
          readonly hits: readonly RerankHit[];
          readonly model: string;
      }
    | { readonly ok: false; readonly reason: EmbeddingFailure; readonly status?: number };

export interface RerankOptions {
    readonly topN: number;
    readonly signal?: AbortSignal;
}

export interface RerankProvider {
    readonly providerId: EmbeddingProviderId;
    readonly specifier: string;
    readonly model: string;
    rerank(query: string, passages: readonly string[], opts: RerankOptions): Promise<RerankResult>;
}

/** Highest score first, ties by input index, then at most `topN`. */
export function orderRerankHits(hits: readonly RerankHit[], topN: number): RerankHit[] {
    return [...hits].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(0, topN));
}

/**
 * The provider id a specifier routes to. A specifier with no `/` yields the
 * whole string, which matches no provider id — so an unparseable specifier is
 * refused by every provider rather than read as anybody's.
 */
export function providerIdOf(specifier: string): string {
    const slash = specifier.indexOf('/');
    return slash === -1 ? specifier : specifier.slice(0, slash);
}

/** The model part of a specifier (everything after the first `/`), or `''`. */
export function modelOf(specifier: string): string {
    const slash = specifier.indexOf('/');
    return slash === -1 ? '' : specifier.slice(slash + 1);
}
