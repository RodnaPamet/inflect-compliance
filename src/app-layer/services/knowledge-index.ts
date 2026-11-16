/**
 * Index one source row into the knowledge store (vector store Phase 2.1,
 * `docs/ai-architecture/weaviate.md`). The body of the `knowledge-index` job,
 * which is the only caller outside tests: chunks and their vectors are written
 * by the worker and by nothing else.
 *
 *   (tenantId, sourceModel, sourceId)
 *     │  OFF unless BOTH switches are on — the store (`VECTOR_STORE_BACKEND`)
 *     │  and an embedding route for the tenant's residency (`AI_EMBED_LOCAL_*`).
 *     │  Either missing is a NAMED failure that reads and writes nothing.
 *     ▼
 *   one transaction, under runInTenantContext and a per-source lock:
 *     read the row (KNOWLEDGE_SOURCES) → paragraph@1 chunks → make the
 *     stored KnowledgeChunk rows exactly those (keep / replace / delete)
 *     ▼
 *   the source's stored vectors for this model (VectorRepository.listSourceKeys)
 *     → the chunks whose vector is missing or of other text
 *     → embed them INDEX_EMBED_BATCH (8) at a time, input type `passage`
 *     → upsert each batch's vectors as it comes back
 *
 * ── Idempotent ─────────────────────────────────────────────────────────
 *
 * Every write is keyed by content: a chunk whose text hashes the same is kept,
 * and a chunk whose vector for this model already carries its hash is not
 * embedded again. So a second run over an unchanged source reads, compares and
 * stops — no embedding call, no write (`UNCHANGED`). A run interrupted between
 * batches (a deploy, a timeout) leaves the chunks and the vectors it finished,
 * and the next run embeds only the rest.
 *
 * ── Deletes follow the source ──────────────────────────────────────────
 *
 * Positions the source no longer has are deleted, a position whose text changed
 * is replaced (and its vectors of every model go with it by cascade), and a row
 * that is no longer indexable — gone, unapproved, soft-deleted — loses all its
 * chunks (`SOURCE_NOT_INDEXABLE`).
 *
 * ── Fails closed, never silently ───────────────────────────────────────
 *
 * Every run returns one `KnowledgeIndexOutcome` and records it on
 * `knowledge_index.runs`. A run that could not do its work says which reason
 * stopped it; none of them reads as success.
 *
 * @module app-layer/services/knowledge-index
 */
import { buildSystemContext } from '@/app-layer/context-system';
import { getVectorRepository, VectorStoreError, type VectorRecord, type VectorRepository } from '@/app-layer/repositories/VectorRepository';
import { KnowledgeChunkRepository, type StoredChunk } from '@/app-layer/repositories/KnowledgeChunkRepository';
import type { RequestContext } from '@/app-layer/types';
import {
    getEmbeddingProvider,
    INDEX_EMBED_BATCH,
    type EmbeddingFailure,
    type EmbeddingProvider,
    type EmbeddingProviderChoice,
    type EmbeddingSelection,
} from '@/lib/ai/embeddings';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { chunkParagraphs, PARAGRAPH_CHUNKER_REVISION } from '@/lib/knowledge/paragraph-chunker';
import type { KnowledgeIndexOutcome } from '@/lib/knowledge/index-outcome';
import { logger } from '@/lib/observability/logger';
import { recordKnowledgeIndexRun } from '@/lib/observability/integration-metrics';
import { isKnowledgeSourceModel, KNOWLEDGE_SOURCES, type NotIndexableReason } from './knowledge-sources';

/**
 * The most chunks one source may hold. A source that cuts into more is
 * refused whole (`SOURCE_TOO_LARGE`), its older chunks removed, rather than
 * indexed in part: an index
 * holding the first N chunks of a document answers questions about its
 * beginning and is silent about the rest, and nothing about a hit would say
 * so. At `MAX_CHUNK_CHARS` (1,200) it is about 2.4 million characters, far
 * past any policy; a document that size belongs to the parsing service.
 */
export const MAX_CHUNKS_PER_SOURCE = 2000;

export interface KnowledgeIndexInput {
    readonly tenantId: string;
    readonly sourceModel: string;
    readonly sourceId: string;
}

export interface KnowledgeIndexResult {
    readonly outcome: KnowledgeIndexOutcome;
    /** The chunks the source cuts into now (0 when not indexable). */
    readonly chunks: number;
    readonly chunksWritten: number;
    readonly chunksDeleted: number;
    /** Chunks given a vector this run. */
    readonly embedded: number;
    /** `embed` calls made this run. */
    readonly embedCalls: number;
    /** The embedding model the vectors are filed under, when one was resolved. */
    readonly embeddingModel?: string;
    /** Why the source yields no text, for `SOURCE_NOT_INDEXABLE`. */
    readonly notIndexable?: NotIndexableReason | 'NO_WORDS';
    /** The embedding seam's reason, for `EMBED_FAILED` and `EMBEDDING_NOT_CONFIGURED`. */
    readonly embedFailure?: EmbeddingFailure | string;
    /** The vector store's reason, for `STORE_REFUSED` and `SUPERSEDED`. */
    readonly storeRefusal?: string;
    /** For `EMBED_FAILED`: whether a later attempt could succeed (a timeout, a 5xx). */
    readonly transient?: boolean;
}

/** The two seams, injectable so a test can supply the stub embedder and a chosen backend. */
export interface KnowledgeIndexDeps {
    /** `undefined` = the deployment's (`getVectorRepository()`), which is `null` when off. */
    readonly vectors?: VectorRepository | null;
    /** `undefined` = the deployment's residency-routed factory. */
    readonly embedder?: (sel: EmbeddingSelection) => EmbeddingProviderChoice;
}

/** Failures a later attempt can clear: the service was slow, down or busy. */
const TRANSIENT_EMBED_FAILURES: ReadonlySet<EmbeddingFailure> = new Set(['TIMEOUT', 'NETWORK_ERROR', 'HTTP_STATUS']);

function empty(outcome: KnowledgeIndexOutcome, extra: Partial<KnowledgeIndexResult> = {}): KnowledgeIndexResult {
    return { outcome, chunks: 0, chunksWritten: 0, chunksDeleted: 0, embedded: 0, embedCalls: 0, ...extra };
}

/**
 * The job's context: the tenant's, as a JOB, reading and writing index rows.
 * No admin or audit authority: the job calls no usecase and writes no row a
 * permission gates — chunks are a derivative of rows the tenant already holds.
 */
function indexContext(tenantId: string): RequestContext {
    return buildSystemContext({
        tenantId,
        job: 'knowledge-index',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
    });
}

type ChunkPhase =
    | { readonly kind: 'not-indexable'; readonly reason: NotIndexableReason | 'NO_WORDS'; readonly deleted: number }
    | { readonly kind: 'too-large'; readonly chunks: number }
    | {
          readonly kind: 'chunked';
          readonly stored: readonly StoredChunk[];
          readonly written: number;
          readonly deleted: number;
      };

/** Read the source and make its stored chunks match it, in ONE transaction under the source's lock. */
async function cutAndStoreChunks(
    ctx: RequestContext,
    sourceModel: keyof typeof KNOWLEDGE_SOURCES,
    sourceId: string,
): Promise<ChunkPhase> {
    return runInTenantContext(ctx, async (db) => {
        await KnowledgeChunkRepository.lockSource(db, ctx, sourceModel, sourceId);
        const source = await KNOWLEDGE_SOURCES[sourceModel](db, ctx, sourceId);
        const chunks = source.indexable ? chunkParagraphs(source.text) : [];
        if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
            // Its older chunks go too: they describe text the source no longer
            // holds, and keeping them would answer from a superseded version.
            await KnowledgeChunkRepository.deleteForSource(db, ctx, sourceModel, sourceId);
            return { kind: 'too-large', chunks: chunks.length } as const;
        }
        if (chunks.length === 0) {
            const deleted = await KnowledgeChunkRepository.deleteForSource(db, ctx, sourceModel, sourceId);
            return { kind: 'not-indexable', reason: source.indexable ? 'NO_WORDS' : source.reason, deleted } as const;
        }
        // One past the cap, so a source holding more rows than it may is seen
        // whole and its surplus deleted, never left behind unread.
        const existing = await KnowledgeChunkRepository.listForSource(
            db, ctx, sourceModel, sourceId, MAX_CHUNKS_PER_SOURCE + 1,
        );
        const outcome = await KnowledgeChunkRepository.reconcileSource(
            db, ctx, sourceModel, sourceId, PARAGRAPH_CHUNKER_REVISION, chunks, existing,
        );
        const stored = await KnowledgeChunkRepository.listForSource(db, ctx, sourceModel, sourceId, MAX_CHUNKS_PER_SOURCE);
        return { kind: 'chunked', stored, written: outcome.written, deleted: outcome.deleted } as const;
    });
}

async function readResidency(ctx: RequestContext): Promise<EmbeddingSelection> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: { aiResidency: true } }),
    );
    return { residency: settings?.aiResidency ?? null };
}

/** Embed `pending` in batches of INDEX_EMBED_BATCH and store each batch's vectors as it returns. */
async function embedAndStore(
    ctx: RequestContext,
    vectors: VectorRepository,
    provider: EmbeddingProvider,
    sourceModel: string,
    sourceId: string,
    pending: readonly StoredChunk[],
): Promise<{ embedded: number; calls: number; stop?: Partial<KnowledgeIndexResult> & { outcome: KnowledgeIndexOutcome } }> {
    let embedded = 0;
    let calls = 0;
    for (let start = 0; start < pending.length; start += INDEX_EMBED_BATCH) {
        const batch = pending.slice(start, start + INDEX_EMBED_BATCH);
        calls += 1;
        const result = await provider.embed(
            batch.map((c) => c.text),
            { inputType: 'passage' },
        );
        if (!result.ok) {
            return {
                embedded,
                calls,
                stop: { outcome: 'EMBED_FAILED', embedFailure: result.reason, transient: TRANSIENT_EMBED_FAILURES.has(result.reason) },
            };
        }
        // The provider checks the served model and the dimension; this checks
        // the two facts the store keys on, so a provider that drifted from its
        // own declaration is refused rather than filed under the wrong model.
        if (result.model !== provider.model) {
            return { embedded, calls, stop: { outcome: 'EMBED_FAILED', embedFailure: 'SERVED_MODEL_MISMATCH', transient: false } };
        }
        if (result.vectors.length !== batch.length) {
            return { embedded, calls, stop: { outcome: 'EMBED_FAILED', embedFailure: 'COUNT_MISMATCH', transient: false } };
        }
        const records: VectorRecord[] = batch.map((chunk, i) => ({
            sourceModel,
            sourceId,
            chunkIndex: chunk.chunkIndex,
            embeddingRevision: provider.model,
            contentHash: chunk.contentHash,
            embedding: result.vectors[i],
        }));
        try {
            await vectors.upsert(ctx, records);
        } catch (err) {
            if (!(err instanceof VectorStoreError)) throw err;
            const superseded = err.reason === 'CONTENT_HASH_MISMATCH' || err.reason === 'CHUNK_NOT_FOUND';
            return {
                embedded,
                calls,
                stop: { outcome: superseded ? 'SUPERSEDED' : 'STORE_REFUSED', storeRefusal: err.reason },
            };
        }
        embedded += batch.length;
    }
    return { embedded, calls };
}

/** Index one source. Never throws for a reason it can name; an unexpected fault propagates. */
export async function indexKnowledgeSource(
    input: KnowledgeIndexInput,
    deps: KnowledgeIndexDeps = {},
): Promise<KnowledgeIndexResult> {
    const { sourceModel, sourceId } = input;
    if (!isKnowledgeSourceModel(sourceModel)) return empty('UNKNOWN_SOURCE_MODEL');

    // ── Both switches, before anything is read ─────────────────────────────
    const vectors = deps.vectors === undefined ? getVectorRepository() : deps.vectors;
    if (!vectors) return empty('VECTOR_STORE_DISABLED');
    const ctx = indexContext(input.tenantId);
    const choice = (deps.embedder ?? getEmbeddingProvider)(await readResidency(ctx));
    if (!choice.ok) return empty('EMBEDDING_NOT_CONFIGURED', { embedFailure: choice.reason });
    const provider = choice.provider;
    const embeddingModel = provider.model;

    // ── The chunks, in one transaction ──────────────────────────────────────
    const phase = await cutAndStoreChunks(ctx, sourceModel, sourceId);
    if (phase.kind === 'too-large') return empty('SOURCE_TOO_LARGE', { chunks: phase.chunks, embeddingModel });
    if (phase.kind === 'not-indexable') {
        return empty('SOURCE_NOT_INDEXABLE', { chunksDeleted: phase.deleted, notIndexable: phase.reason, embeddingModel });
    }

    // ── The vectors the chunks still need ───────────────────────────────────
    let stored: Awaited<ReturnType<VectorRepository['listSourceKeys']>>;
    try {
        stored = await vectors.listSourceKeys(ctx, embeddingModel, sourceModel, sourceId, {
            limit: MAX_CHUNKS_PER_SOURCE,
        });
    } catch (err) {
        if (!(err instanceof VectorStoreError)) throw err;
        return {
            ...empty('STORE_REFUSED', { storeRefusal: err.reason, embeddingModel }),
            chunks: phase.stored.length,
            chunksWritten: phase.written,
            chunksDeleted: phase.deleted,
        };
    }
    const hashAt = new Map(stored.map((k) => [k.chunkIndex, k.contentHash]));
    const pending = phase.stored.filter((c) => hashAt.get(c.chunkIndex) !== c.contentHash);

    const run = await embedAndStore(ctx, vectors, provider, sourceModel, sourceId, pending);
    const base = {
        chunks: phase.stored.length,
        chunksWritten: phase.written,
        chunksDeleted: phase.deleted,
        embedded: run.embedded,
        embedCalls: run.calls,
        embeddingModel,
    };
    if (run.stop) return { ...base, ...run.stop };
    const changed = phase.written + phase.deleted + run.embedded > 0;
    return { ...base, outcome: changed ? 'INDEXED' : 'UNCHANGED' };
}

/** `indexKnowledgeSource`, timed, logged and counted on `knowledge_index.runs`. */
export async function indexKnowledgeSourceObserved(
    input: KnowledgeIndexInput,
    deps: KnowledgeIndexDeps = {},
): Promise<KnowledgeIndexResult> {
    const started = performance.now();
    const sourceModel = isKnowledgeSourceModel(input.sourceModel) ? input.sourceModel : 'unknown';
    try {
        const result = await indexKnowledgeSource(input, deps);
        recordKnowledgeIndexRun({
            sourceModel,
            outcome: result.outcome.toLowerCase() as Lowercase<KnowledgeIndexOutcome>,
            durationMs: performance.now() - started,
            embedded: result.embedded,
        });
        // Ids and counts only: never chunk text, never a vector.
        logger.info('knowledge_index.run', {
            component: 'knowledge-index',
            tenantId: input.tenantId,
            sourceModel,
            sourceId: input.sourceId,
            ...result,
        });
        return result;
    } catch (err) {
        recordKnowledgeIndexRun({ sourceModel, outcome: 'error', durationMs: performance.now() - started });
        throw err;
    }
}
