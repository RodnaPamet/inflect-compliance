/**
 * What the D-L4-3 benchmark compares, and the engine it runs them on.
 *
 * Changing this file changes the benchmark, so it is reviewed like code: a new
 * candidate, a new image digest or a new margin is a diff somebody reads before
 * the workflow is dispatched, never an input typed into the dispatch form.
 *
 * The workflow's matrix lists `EMBED_CANDIDATES` by id;
 * `tests/unit/retriever-benchmark.test.ts` fails when the two disagree.
 */

/**
 * Hugging Face Text Embeddings Inference, CPU build, by index digest.
 * Tag `cpu-1.9.4`, read from ghcr.io on 2026-11-11. One image serves every
 * candidate: embedding through `/embed`, cross-encoders through `/rerank`.
 */
export const TEI_CPU_IMAGE =
    'ghcr.io/huggingface/text-embeddings-inference@sha256:2538ea1c9640d3763b15af668039d24172d063b42337b0c27796fc2be180c78d';

export interface EmbedCandidate {
    readonly id: string;
    readonly model: string;
    /**
     * A commit to pin, or null to load the default branch and RECORD the
     * commit the engine reports. A record never names a branch: scoring
     * refuses a revision that is not a 40-character commit. Pin each commit
     * here once a first run has named it.
     */
    readonly revision: string | null;
    /** Declared on the model card; "the smaller" in D-L4-3 compares this. */
    readonly parametersM: number;
    /**
     * Asymmetric retrieval models score a query and a passage differently;
     * sending both unprefixed silently lowers recall (nemotron-retriever.md,
     * Phase 1 hardening). Taken from each model card.
     */
    readonly queryPrefix: string;
    readonly passagePrefix: string;
    readonly nemotron: boolean;
}

export interface RerankCandidate {
    readonly id: string;
    readonly model: string;
    readonly revision: string | null;
    readonly parametersM: number;
    readonly nemotron: boolean;
}

export const EMBED_CANDIDATES: readonly EmbedCandidate[] = [
    {
        id: 'nemotron-embed-1b',
        model: 'nvidia/llama-nemotron-embed-1b-v2',
        revision: null,
        parametersM: 1236,
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        nemotron: true,
    },
    {
        id: 'bge-small-en',
        model: 'BAAI/bge-small-en-v1.5',
        revision: null,
        parametersM: 33,
        queryPrefix: 'Represent this sentence for searching relevant passages: ',
        passagePrefix: '',
        nemotron: false,
    },
    {
        id: 'e5-small',
        model: 'intfloat/e5-small-v2',
        revision: null,
        parametersM: 33,
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        nemotron: false,
    },
];

export const RERANK_CANDIDATES: readonly RerankCandidate[] = [
    {
        id: 'nemotron-rerank-1b',
        model: 'nvidia/llama-nemotron-rerank-1b-v2',
        revision: null,
        parametersM: 1236,
        nemotron: true,
    },
    {
        id: 'bge-reranker-base',
        model: 'BAAI/bge-reranker-base',
        revision: null,
        parametersM: 278,
        nemotron: false,
    },
];

/** Embed hits the reranker re-orders (nemotron-retriever.md Phase 2: ≤ 50). */
export const RERANK_DEPTH = 50;

/**
 * D-L4-3's margin, as an absolute drop in recall@10. PROPOSED, to be
 * confirmed by the owner before the first dispatch: on 200 cases the standard
 * error of a recall near 0.8 is about 0.028, so 0.05 is roughly two standard
 * errors — a smaller margin would choose between models on noise.
 */
export const D_L4_3_RECALL_MARGIN = 0.05;

/** Timed repetitions per latency probe, after `PROBE_WARMUP` untimed ones. */
export const PROBE_SAMPLES = 20;
export const PROBE_WARMUP = 3;
/** Nemotron-retriever.md Phase 0.3: batch 32. */
export const PROBE_BATCH = 32;

export function embedCandidate(id: string): EmbedCandidate {
    const c = EMBED_CANDIDATES.find((x) => x.id === id);
    if (!c) throw new Error(`unknown embed candidate ${id}; known: ${EMBED_CANDIDATES.map((x) => x.id).join(', ')}`);
    return c;
}
