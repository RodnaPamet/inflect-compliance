/**
 * The second stage, and what happens when it cannot run
 * (`nemotron-retriever.md` Phase 2: "a reranker failure degrades to the hybrid
 * order with a WARN and an outcome label, never to an empty result").
 *
 * The passages arrive in HYBRID order, already hydrated under RLS by the
 * caller — this module never reads a store. It sends at most
 * `MAX_RERANK_PASSAGES` of them, and whatever the reranker does, it returns an
 * order over the passages it was given:
 *
 *   • reranked     — the cross-encoder's order, top `topN`;
 *   • not reranked — the first `topN` of the hybrid order, with the reason.
 *
 * The WARN and the outcome label are the provider's (`tei-provider.ts`
 * records both on every failure); a route that is not configured at all is a
 * deployment fact rather than an incident, and is reported in `reason` only.
 *
 * @module lib/ai/embeddings/rerank-fallback
 */
import { MAX_RERANK_PASSAGES, type EmbeddingFailure, type RerankProvider } from './types';

export type RerankOrder =
    | { readonly reranked: true; readonly order: readonly number[] }
    | {
          readonly reranked: false;
          readonly order: readonly number[];
          readonly reason: EmbeddingFailure | 'NO_RERANK_PROVIDER';
      };

function hybridOrder(count: number, topN: number): number[] {
    return Array.from({ length: Math.max(0, Math.min(count, topN)) }, (_, i) => i);
}

export async function rerankOrKeepHybridOrder(
    provider: RerankProvider | null,
    query: string,
    passages: readonly string[],
    opts: { readonly topN: number; readonly signal?: AbortSignal },
): Promise<RerankOrder> {
    const pool = passages.slice(0, MAX_RERANK_PASSAGES);
    if (provider === null) {
        return { reranked: false, order: hybridOrder(pool.length, opts.topN), reason: 'NO_RERANK_PROVIDER' };
    }
    if (pool.length === 0) return { reranked: false, order: [], reason: 'EMPTY_INPUT' };
    const result = await provider.rerank(query, pool, { topN: opts.topN, signal: opts.signal });
    if (!result.ok) {
        return { reranked: false, order: hybridOrder(pool.length, opts.topN), reason: result.reason };
    }
    return { reranked: true, order: result.hits.map((h) => h.index) };
}
