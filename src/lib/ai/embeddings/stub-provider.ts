/**
 * Deterministic stand-ins for tests and evaluation harnesses.
 *
 * NEVER CHOSEN BY THE FACTORY. `select.ts` refuses an unconfigured route rather
 * than falling back here, because a stub vector written into an index is a
 * passage that can never be found again by a real model, and nothing about the
 * row would say so. A caller that wants the stub constructs it by name.
 *
 * The embedding stub is FEATURE HASHING, not random bytes: each lower-cased
 * word is hashed into a signed bucket and the vector is L2-normalised, so two
 * texts sharing words have a positive cosine. That gives a retrieval test a
 * signal to assert on, with no model, no network and no randomness — the same
 * text always yields the same vector, on every machine.
 *
 * @module lib/ai/embeddings/stub-provider
 */
import { createHash } from 'node:crypto';

import {
    EMBEDDING_PROVIDER_IDS,
    MAX_EMBED_BATCH,
    MAX_RERANK_PASSAGES,
    orderRerankHits,
    type EmbedOptions,
    type EmbeddingProvider,
    type EmbeddingResult,
    type RerankOptions,
    type RerankProvider,
    type RerankResult,
} from './types';

export const STUB_EMBEDDING_MODEL = 'stub-feature-hash@1';
export const STUB_RERANK_MODEL = 'stub-word-overlap@1';
export const STUB_DEFAULT_DIMENSIONS = 64;

function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function bucketOf(word: string, dimensions: number): { index: number; sign: 1 | -1 } {
    const digest = createHash('sha256').update(word).digest();
    return { index: digest.readUInt32BE(0) % dimensions, sign: digest[4] & 1 ? 1 : -1 };
}

/** The stub's vector for one text: feature-hashed and L2-normalised (all-zero for no words). */
export function stubVector(text: string, dimensions: number): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const word of words(text)) {
        const { index, sign } = bucketOf(word, dimensions);
        vector[index] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
}

export class StubEmbeddingProvider implements EmbeddingProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.stub;
    readonly model = STUB_EMBEDDING_MODEL;
    readonly specifier = `${EMBEDDING_PROVIDER_IDS.stub}/${STUB_EMBEDDING_MODEL}`;

    constructor(readonly dimensions: number = STUB_DEFAULT_DIMENSIONS) {}

    // The input type is accepted and deliberately ignored: a symmetric stub
    // gives a test a fixed point to compare a real asymmetric model against.
    async embed(texts: readonly string[], _opts: EmbedOptions): Promise<EmbeddingResult> {
        if (texts.length === 0) return { ok: false, reason: 'EMPTY_INPUT' };
        if (texts.length > MAX_EMBED_BATCH) return { ok: false, reason: 'BATCH_TOO_LARGE' };
        return {
            ok: true,
            vectors: texts.map((t) => stubVector(t, this.dimensions)),
            model: this.model,
            dimensions: this.dimensions,
        };
    }
}

export class StubRerankProvider implements RerankProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.stub;
    readonly model = STUB_RERANK_MODEL;
    readonly specifier = `${EMBEDDING_PROVIDER_IDS.stub}/${STUB_RERANK_MODEL}`;

    /** Score = the share of the query's distinct words the passage contains. */
    async rerank(query: string, passages: readonly string[], opts: RerankOptions): Promise<RerankResult> {
        if (passages.length === 0) return { ok: false, reason: 'EMPTY_INPUT' };
        if (passages.length > MAX_RERANK_PASSAGES) return { ok: false, reason: 'BATCH_TOO_LARGE' };
        const asked = new Set(words(query));
        const hits = passages.map((passage, index) => {
            const have = new Set(words(passage));
            let shared = 0;
            for (const w of asked) if (have.has(w)) shared += 1;
            return { index, score: asked.size === 0 ? 0 : shared / asked.size };
        });
        return { ok: true, hits: orderRerankHits(hits, opts.topN), model: this.model };
    }
}
