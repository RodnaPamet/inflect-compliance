/**
 * The retriever revision key — what a RAG evaluation record is keyed by, and so
 * what the `search_knowledge` mount gate compares (`nemotron-retriever.md`
 * Phase 2.2, `weaviate.md` Phase 3.5, `ragas.md` Phase 0.6).
 *
 * `{ embeddingModel, dimensions, rerankModel, chunker, k, indexParams }` — the
 * record's own `retrieverRevision` (`src/lib/ai/evals/rag-record.ts`), field for
 * field, so a record and the store it measured cannot describe the revision in
 * two vocabularies. The store is pgvector and dense-only (D-L4-1, the 2026-11-11
 * re-plan), so there is no hybrid `alpha`; `dimensions` and the ANN
 * `indexParams` are in the key because both move recall.
 *
 * A change to ANY of them is a new revision, and a new revision has no
 * evaluation record until one is produced (G11). `rerankModel` is part of the
 * key from the start, so adding a reranker to a chain is a new revision rather
 * than a silent change under an old record: `null` (no reranker) and a model id
 * never produce the same key.
 *
 * The key names MODELS, never provider ids or URLs. Phase 3.4 requires a vector
 * produced on the CPU arm and on the GPU arm to be interchangeable under ONE
 * revision, and that is only expressible if where a model runs is not part of
 * what the model is.
 *
 * @module lib/ai/embeddings/revision
 */
import { canonicalJson } from '@/lib/canonical-json';
import { RagIndexParamsSchema, type RagIndexParams } from '@/lib/ai/evals/rag-record';

export interface RetrieverRevision {
    /** The embedding model id (a specifier's model part, never the provider id). */
    readonly embeddingModel: string;
    /** The embedding's dimension count, as the store holds it. */
    readonly dimensions: number;
    /** The rerank model id, or `null` when the chain has no reranker. */
    readonly rerankModel: string | null;
    /** The chunker's own versioned id, e.g. `paragraph@1`. */
    readonly chunker: string;
    /** How many hits the retriever returns. */
    readonly k: number;
    /** The ANN index the search runs on, every parameter that moves recall or latency. */
    readonly indexParams: RagIndexParams;
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

/** The largest dimension count a revision may name (the record's own bound). */
const MAX_REVISION_DIMENSIONS = 4_096;

function nonEmpty(value: string): boolean {
    return value.trim().length > 0 && value === value.trim();
}

/**
 * The canonical key. A JSON array in a FIXED field order, so the encoding is
 * independent of property order in the input object and no field value can
 * forge a separator (a model id containing `;` or `=` stays one string). The
 * index parameters are an object, written in canonical JSON (sorted keys), so
 * their member order does not move the key either.
 *
 * Refuses a revision that would be ambiguous: an empty or padded name (two
 * spellings of one model would be two revisions, or one name standing for two),
 * a non-integer or out-of-range `k` or `dimensions`, and index parameters the
 * record's own schema would refuse.
 */
export function retrieverRevisionKey(revision: RetrieverRevision): string {
    if (!nonEmpty(revision.embeddingModel)) throw new InvalidRetrieverRevisionError('embeddingModel');
    if (!Number.isInteger(revision.dimensions) || revision.dimensions < 1 || revision.dimensions > MAX_REVISION_DIMENSIONS) {
        throw new InvalidRetrieverRevisionError('dimensions');
    }
    if (revision.rerankModel !== null && !nonEmpty(revision.rerankModel)) {
        throw new InvalidRetrieverRevisionError('rerankModel');
    }
    if (!nonEmpty(revision.chunker)) throw new InvalidRetrieverRevisionError('chunker');
    if (!Number.isInteger(revision.k) || revision.k < 1 || revision.k > MAX_RETRIEVER_K) {
        throw new InvalidRetrieverRevisionError('k');
    }
    const index = RagIndexParamsSchema.safeParse(revision.indexParams);
    if (!index.success) throw new InvalidRetrieverRevisionError('indexParams');
    return JSON.stringify([
        'retriever@2',
        revision.embeddingModel,
        revision.dimensions,
        revision.rerankModel,
        revision.chunker,
        revision.k,
        canonicalJson(index.data),
    ]);
}

/** True only when both revisions produce the same key. */
export function sameRetrieverRevision(a: RetrieverRevision, b: RetrieverRevision): boolean {
    return retrieverRevisionKey(a) === retrieverRevisionKey(b);
}
