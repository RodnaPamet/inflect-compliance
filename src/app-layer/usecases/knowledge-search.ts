/**
 * `searchKnowledge` — the read usecase behind the `search_knowledge` tool
 * (vector store Phase 3.1 and 3.3, `docs/ai-architecture/weaviate.md`).
 *
 *   question ─ embed (input type `query`, the tenant's residency route)
 *            ─ VectorRepository.search: cosine over the revision's partial
 *              HNSW index, this tenant's rows only (RLS + the tenantId filter;
 *              exact below a per-tenant row count, see `pgvector-store.ts`),
 *              restricted to the source models the caller may READ
 *            ─ hydrate under RLS: the chunk's text from `KnowledgeChunk`
 *              (decrypted by the manifest), the citation from the source row
 *            → hits: { sourceModel, sourceId, chunkIndex, score, text, citation }
 *
 * ── Who may read what ───────────────────────────────────────────────────────
 *
 * The tool's authorization is the funnel's (`runReadTool`: exposure, card,
 * scope, `policies.view`); this usecase applies the same read policy the
 * source's own pages apply, PER SOURCE MODEL, and searches only the models it
 * admits (`KNOWLEDGE_SOURCE_READ_POLICY`). A source the caller may not read is
 * never searched rather than searched and filtered, so it cannot crowd the
 * `k` hits the caller may see. With no admitted model the call is refused by
 * the first policy's own error.
 *
 * ── What can be wrong, and what it returns ─────────────────────────────────
 *
 * A hit is dropped when its chunk no longer reads under RLS, when the chunk's
 * text no longer hashes to what the vector was computed from (a re-cut the
 * index job has not caught up with), or when its source has no citation (gone
 * or soft-deleted). The store off, the gate closed, the embedding route absent
 * or failing: a named `unavailable` answer, never an empty list that would
 * read as "the corpus says nothing".
 *
 * The text returned is UNTRUSTED: it is tenant-authored policy text. Every
 * engine's call reaches this through `runGuardedTool`, which scans the result
 * with `guardUntrustedInput` and `guardEgress` before the model sees it, and a
 * flagged result latches the run's review (G4).
 *
 * @module app-layer/usecases/knowledge-search
 */
import {
    getVectorRepository,
    VectorStoreError,
    type VectorMatch,
    type VectorRepository,
    type VectorSearchQuery,
} from '@/app-layer/repositories/VectorRepository';
import { KnowledgeChunkRepository } from '@/app-layer/repositories/KnowledgeChunkRepository';
import { assertCanReadPolicies } from '@/app-layer/policies/policy.policies';
import { readResidency } from '@/app-layer/services/knowledge-index';
import { getKnowledgeSearchMount, type KnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';
import {
    KNOWLEDGE_RETRIEVAL_K,
    KNOWLEDGE_SEARCH_DEFAULT_K,
    KNOWLEDGE_SEARCH_MAX_K,
} from '@/app-layer/services/knowledge-search-revision';
import {
    KNOWLEDGE_CITATIONS,
    KNOWLEDGE_SOURCE_MODELS,
    type KnowledgeCitation,
    type KnowledgeSourceModel,
} from '@/app-layer/services/knowledge-sources';
import type { RequestContext } from '@/app-layer/types';
import { getEmbeddingProvider, type EmbeddingProviderChoice, type EmbeddingSelection } from '@/lib/ai/embeddings';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { chunkContentHash } from '@/lib/knowledge/paragraph-chunker';

export { KNOWLEDGE_SEARCH_DEFAULT_K, KNOWLEDGE_SEARCH_MAX_K };

/** The longest question embedded; `tei-embed` truncates past the model's window. */
export const MAX_KNOWLEDGE_QUERY_CHARS = 1_000;

/**
 * The read policy each source model's own pages apply. A model is searched
 * only for a caller its policy admits. Keyed exhaustively on the source union,
 * so a source added to the index without a policy is a compile error.
 */
export const KNOWLEDGE_SOURCE_READ_POLICY: Readonly<Record<KnowledgeSourceModel, (ctx: RequestContext) => void>> = {
    PolicyVersion: assertCanReadPolicies,
};

export interface KnowledgeSearchInput {
    readonly query: string;
    /** 1..`KNOWLEDGE_SEARCH_MAX_K`; absent = `KNOWLEDGE_SEARCH_DEFAULT_K`. */
    readonly k?: number;
}

export interface KnowledgeHit {
    readonly sourceModel: string;
    readonly sourceId: string;
    readonly chunkIndex: number;
    /** Cosine similarity, rounded to four places. */
    readonly score: number;
    /** The chunk's text, decrypted. Tenant-authored: untrusted. */
    readonly text: string;
    readonly citation: KnowledgeCitation;
}

export type KnowledgeSearchUnavailable =
    | 'VECTOR_STORE_DISABLED'
    | 'EMBEDDING_NOT_CONFIGURED'
    | 'NOT_EVALUATED'
    | 'REVISION_CHANGED'
    | 'EMBED_FAILED'
    | 'STORE_REFUSED';

export type KnowledgeSearchResult =
    | {
          readonly available: true;
          readonly embeddingModel: string;
          readonly hits: readonly KnowledgeHit[];
          /** Hits the index named that did not survive hydration (see the header). */
          readonly droppedStale: number;
      }
    | { readonly available: false; readonly reason: KnowledgeSearchUnavailable; readonly detail?: string };

/** Seams, for tests. The tool passes none. */
export interface KnowledgeSearchDeps {
    readonly vectors?: VectorRepository | null;
    readonly embedder?: (sel: EmbeddingSelection) => EmbeddingProviderChoice;
    readonly mount?: KnowledgeSearchMount;
}

/** The source models this caller may read, in index order; throws the first refusal when none. */
export function readableSourceModels(ctx: RequestContext): KnowledgeSourceModel[] {
    const admitted: KnowledgeSourceModel[] = [];
    let firstRefusal: unknown = null;
    for (const model of KNOWLEDGE_SOURCE_MODELS) {
        try {
            KNOWLEDGE_SOURCE_READ_POLICY[model](ctx);
            admitted.push(model);
        } catch (err) {
            firstRefusal ??= err;
        }
    }
    if (admitted.length === 0) throw firstRefusal;
    return admitted;
}

/**
 * THE store query `searchKnowledge` issues for a caller: the revision's depth
 * (`KNOWLEDGE_RETRIEVAL_K`, whatever `k` the caller asked for) over the
 * source models the caller may read, on the store's default strategy. The
 * Ragas probe builds its ANN arm from this function
 * (`scripts/rag-eval/search-seam.ts`), so the figures a record carries are
 * measured on the product's own call; `tests/unit/rag-eval-gate-agreement.test.ts`
 * fails if the two ever differ in depth or filter.
 */
export function knowledgeVectorQuery(
    ctx: RequestContext,
    embeddingRevision: string,
    embedding: readonly number[],
): VectorSearchQuery & { readonly sourceModels: readonly KnowledgeSourceModel[] } {
    return { embeddingRevision, embedding, k: KNOWLEDGE_RETRIEVAL_K, sourceModels: readableSourceModels(ctx) };
}

export async function searchKnowledge(
    ctx: RequestContext,
    input: KnowledgeSearchInput,
    deps: KnowledgeSearchDeps = {},
): Promise<KnowledgeSearchResult> {
    const sourceModels = readableSourceModels(ctx);
    const k = Math.min(Math.max(1, Math.trunc(input.k ?? KNOWLEDGE_SEARCH_DEFAULT_K)), KNOWLEDGE_SEARCH_MAX_K);
    const query = input.query.trim().slice(0, MAX_KNOWLEDGE_QUERY_CHARS);

    // ── The gate again, at execution ────────────────────────────────────────
    // The registry withholds the tool while the gate is closed; this keeps "no
    // record, no search" true for any other caller of the usecase too.
    const mount = deps.mount ?? getKnowledgeSearchMount();
    if (mount.state === 'ABSENT') return { available: false, reason: mount.reason };
    if (mount.state === 'UNMOUNTED') return { available: false, reason: 'NOT_EVALUATED', detail: mount.reason };

    const vectors = deps.vectors === undefined ? getVectorRepository() : deps.vectors;
    if (!vectors) return { available: false, reason: 'VECTOR_STORE_DISABLED' };
    const choice = (deps.embedder ?? getEmbeddingProvider)(await readResidency(ctx));
    if (!choice.ok) return { available: false, reason: 'EMBEDDING_NOT_CONFIGURED', detail: choice.reason };
    const provider = choice.provider;
    // The search must run the revision the record measured.
    if (provider.model !== mount.revision.embeddingModel || provider.dimensions !== mount.revision.dimensions) {
        return { available: false, reason: 'REVISION_CHANGED' };
    }

    const embedded = await provider.embed([query], { inputType: 'query' });
    if (!embedded.ok) return { available: false, reason: 'EMBED_FAILED', detail: embedded.reason };
    if (embedded.model !== provider.model || embedded.vectors.length !== 1) {
        return { available: false, reason: 'EMBED_FAILED', detail: 'SERVED_MODEL_MISMATCH' };
    }

    let matches: VectorMatch[];
    try {
        matches = await vectors.search(ctx, knowledgeVectorQuery(ctx, provider.model, embedded.vectors[0]));
    } catch (err) {
        if (!(err instanceof VectorStoreError)) throw err;
        return { available: false, reason: 'STORE_REFUSED', detail: err.reason };
    }
    // Every search retrieves the revision's k and keeps the caller's first k,
    // so the answer is a prefix of what the record evaluated.
    const top = matches.slice(0, k);
    if (top.length === 0) return { available: true, embeddingModel: provider.model, hits: [], droppedStale: 0 };

    const hits = await runInTenantContext(ctx, async (db) => {
        const chunks = await KnowledgeChunkRepository.findByKeys(db, ctx, top);
        const byKey = new Map(chunks.map((c) => [`${c.sourceModel}\u0000${c.sourceId}\u0000${c.chunkIndex}`, c]));
        const citations = new Map<string, KnowledgeCitation>();
        for (const model of sourceModels) {
            const ids = [...new Set(top.filter((m) => m.sourceModel === model).map((m) => m.sourceId))];
            for (const [id, c] of await KNOWLEDGE_CITATIONS[model](db, ctx, ids)) citations.set(`${model}\u0000${id}`, c);
        }
        const out: KnowledgeHit[] = [];
        for (const m of top) {
            const chunk = byKey.get(`${m.sourceModel}\u0000${m.sourceId}\u0000${m.chunkIndex}`);
            const citation = citations.get(`${m.sourceModel}\u0000${m.sourceId}`);
            // The vector was computed from this text, or the hit is not cited.
            if (!chunk || !citation || chunk.contentHash !== m.contentHash || chunkContentHash(chunk.text) !== m.contentHash) continue;
            out.push({
                sourceModel: m.sourceModel,
                sourceId: m.sourceId,
                chunkIndex: m.chunkIndex,
                score: Math.round(m.score * 10_000) / 10_000,
                text: chunk.text,
                citation,
            });
        }
        return out;
    });
    return { available: true, embeddingModel: provider.model, hits, droppedStale: top.length - hits.length };
}
