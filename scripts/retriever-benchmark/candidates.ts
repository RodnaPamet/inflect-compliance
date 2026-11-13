/**
 * What the D-L4-3 benchmark compares, and the engine it runs them on.
 *
 * D-L4-3 as amended 2026-11-13 (owner): Layer 4 compares small open models
 * only, multilingual among them, because the product serves Bulgarian as well
 * as English. Nemotron is not a Layer 4 candidate; it stays only in the
 * retriever's optional Layer 5 phase (a GPU engine), so it is not listed here.
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
     * A commit to pin, or null to resolve `main` to its commit through the
     * Hub API (`hub.ts`) BEFORE the engine starts. Either way TEI is started
     * with `--revision <commit>` and the record names that commit. TEI's
     * `/info` cannot be asked: its `model_sha` is the `--revision` argument
     * echoed back (router/src/lib.rs, `model_sha: revision`), null when none
     * was passed. Pin each commit here once a first run has named it.
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
    /** Trained for questions beyond English (the Bulgarian slice). */
    readonly multilingual: boolean;
}

export interface RerankCandidate {
    readonly id: string;
    readonly model: string;
    /** As `EmbedCandidate.revision`. */
    readonly revision: string | null;
    readonly parametersM: number;
    readonly multilingual: boolean;
}

export const EMBED_CANDIDATES: readonly EmbedCandidate[] = [
    {
        id: 'bge-small-en',
        model: 'BAAI/bge-small-en-v1.5',
        revision: null,
        parametersM: 33,
        queryPrefix: 'Represent this sentence for searching relevant passages: ',
        passagePrefix: '',
        multilingual: false,
    },
    {
        id: 'e5-small',
        model: 'intfloat/e5-small-v2',
        revision: null,
        parametersM: 33,
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        multilingual: false,
    },
    {
        id: 'multilingual-e5-small',
        model: 'intfloat/multilingual-e5-small',
        revision: null,
        parametersM: 118,
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        multilingual: true,
    },
];

export const RERANK_CANDIDATES: readonly RerankCandidate[] = [
    {
        id: 'bge-reranker-base',
        model: 'BAAI/bge-reranker-base',
        revision: null,
        parametersM: 278,
        multilingual: false,
    },
    {
        id: 'bge-reranker-v2-m3',
        model: 'BAAI/bge-reranker-v2-m3',
        revision: null,
        parametersM: 568,
        multilingual: true,
    },
];

/**
 * The model types TEI's CPU image REFUSES to start, by its own words
 * (backends/candle/src/lib.rs at v1.9.4: `(Config::Llama(_), Device::Cpu |
 * Device::Metal(_)) => Err(BackendError::Start("Llama is only supported on
 * Cuda devices in fp16 with flash attention enabled"))`, and the same for
 * Mistral and Qwen2; `llama_bidirec` is a serde alias of Llama). Tied to
 * `TEI_CPU_IMAGE`: a new image is a re-read of that file.
 *
 * No candidate here is of those types; the check stays because a candidate
 * added later may be (the Nemotron models, which D-L4-3 compared until its
 * 2026-11-13 amendment, are Llama-based). Such a model is refused unless its
 * repository carries an ONNX export, which TEI's ORT backend tries first
 * (`download_onnx`: `model.onnx*` or `onnx/model.onnx*`).
 */
const TEI_CPU_REFUSED: Readonly<Record<string, string>> = {
    llama: 'Llama is only supported on Cuda devices in fp16 with flash attention enabled',
    llama_bidirec: 'Llama is only supported on Cuda devices in fp16 with flash attention enabled',
    mistral: 'Mistral is only supported on Cuda devices in fp16 with flash attention enabled',
    qwen2: 'Qwen2 is only supported on Cuda devices in fp16 with flash attention enabled',
};

/** What the Hub says a model revision is: enough to know whether TEI CPU starts it. */
export interface HubModelFacts {
    readonly modelType: string | null;
    readonly files: readonly string[];
}

/**
 * TEI CPU's own refusal for this model, or null when it may start it. Asked
 * BEFORE a container starts, so a candidate the engine cannot serve costs one
 * metadata request rather than a weights download and a failed load.
 * An unknown model type is not refused here: the engine is asked, and a
 * failed load is a failure file like any other.
 */
export function teiCpuRefusal(facts: HubModelFacts): string | null {
    const refusal = facts.modelType === null ? undefined : TEI_CPU_REFUSED[facts.modelType];
    if (refusal === undefined) return null;
    const onnx = facts.files.some((f) => f.startsWith('model.onnx') || f.startsWith('onnx/model.onnx'));
    return onnx ? null : `${refusal} (model_type ${facts.modelType}, no ONNX export in the repository)`;
}

/** Embed hits the reranker re-orders (nemotron-retriever.md Phase 2: ≤ 50). */
export const RERANK_DEPTH = 50;

/**
 * D-L4-3's margin, as an absolute drop in recall@10, overall and on the
 * Bulgarian slice (D-L4-10, decided 2026-11-12). On 200 English cases the
 * standard error of a recall near 0.8 is about 0.028, so 0.05 is roughly two
 * standard errors; on the 50-case Bulgarian slice it is nearer one, which is
 * why D-L4-10 leaves growing that slice open.
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
