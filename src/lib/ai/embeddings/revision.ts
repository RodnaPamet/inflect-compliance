/**
 * The retriever revision key — what an evaluation record is keyed by, and so
 * what the `search_knowledge` mount gate compares (`nemotron-retriever.md`
 * Phase 2.2, `weaviate.md`).
 *
 * `{ embeddingModel, rerankModel, chunker, k, alpha }`. A change to ANY of them
 * is a new revision, and a new revision has no evaluation record until one is
 * produced (G11). `rerankModel` is part of the key from the start, so adding a
 * reranker to a chain is a new revision rather than a silent change under an
 * old record: `null` (no reranker) and a model id never produce the same key.
 *
 * The key names MODELS, never provider ids or URLs. Phase 3.4 requires a vector
 * produced on the CPU arm and on the GPU arm to be interchangeable under ONE
 * revision, and that is only expressible if where a model runs is not part of
 * what the model is.
 *
 * @module lib/ai/embeddings/revision
 */

export interface RetrieverRevision {
    /** The embedding model id (a specifier's model part, never the provider id). */
    readonly embeddingModel: string;
    /** The rerank model id, or `null` when the chain has no reranker. */
    readonly rerankModel: string | null;
    /** The chunker's own versioned id, e.g. `markdown-heading@1`. */
    readonly chunker: string;
    /** How many hits the retriever returns. */
    readonly k: number;
    /** The hybrid weight: 0 is pure keyword, 1 pure vector. */
    readonly alpha: number;
}

/** Thrown for a revision no evaluation record could honestly be keyed by. */
export class InvalidRetrieverRevisionError extends Error {
    constructor(readonly field: keyof RetrieverRevision) {
        super(`Invalid retriever revision: ${field}`);
        this.name = 'InvalidRetrieverRevisionError';
    }
}

/** The largest `k` a revision may name. The rerank pool is 50; k never exceeds it. */
export const MAX_RETRIEVER_K = 50;

function nonEmpty(value: string): boolean {
    return value.trim().length > 0 && value === value.trim();
}

/**
 * The canonical key. A JSON array in a FIXED field order, so the encoding is
 * independent of property order in the input object and no field value can
 * forge a separator (a model id containing `;` or `=` stays one string).
 *
 * Refuses a revision that would be ambiguous: an empty or padded name (two
 * spellings of one model would be two revisions, or one name standing for two),
 * a non-integer or out-of-range `k`, an `alpha` outside [0, 1].
 */
export function retrieverRevisionKey(revision: RetrieverRevision): string {
    if (!nonEmpty(revision.embeddingModel)) throw new InvalidRetrieverRevisionError('embeddingModel');
    if (revision.rerankModel !== null && !nonEmpty(revision.rerankModel)) {
        throw new InvalidRetrieverRevisionError('rerankModel');
    }
    if (!nonEmpty(revision.chunker)) throw new InvalidRetrieverRevisionError('chunker');
    if (!Number.isInteger(revision.k) || revision.k < 1 || revision.k > MAX_RETRIEVER_K) {
        throw new InvalidRetrieverRevisionError('k');
    }
    if (!Number.isFinite(revision.alpha) || revision.alpha < 0 || revision.alpha > 1) {
        throw new InvalidRetrieverRevisionError('alpha');
    }
    return JSON.stringify([
        'retriever@1',
        revision.embeddingModel,
        revision.rerankModel,
        revision.chunker,
        revision.k,
        revision.alpha,
    ]);
}

/** True only when both revisions produce the same key. */
export function sameRetrieverRevision(a: RetrieverRevision, b: RetrieverRevision): boolean {
    return retrieverRevisionKey(a) === retrieverRevisionKey(b);
}
