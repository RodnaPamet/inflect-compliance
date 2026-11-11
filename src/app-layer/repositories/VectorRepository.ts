/**
 * VectorRepository — the ONLY way into the vector store.
 *
 * Layer 4's vector index (docs/ai-architecture/weaviate.md; owner decision
 * D-L4-1, 2026-11-11: pgvector first). Every reader and writer of vectors
 * goes through this module; the backends under `./vector/` are importable
 * from here and from each other only (ESLint `local/vector-store-single-seam`,
 * which also refuses the table's name in any other file under `src/`).
 *
 * ── What it guarantees, whatever the backend ─────────────────────────
 *
 *  1. TENANT FROM CONTEXT. Every method takes `ctx: RequestContext` and no
 *     method takes a tenant id; the backend files a row under `ctx.tenantId`
 *     and reads only that tenant's rows. (The pgvector backend adds RLS.)
 *  2. VECTORS ONLY (D-L4-2). A record is a key, a content hash and a vector.
 *     A record carrying any other member — `text`, `content`, a whole chunk
 *     spread into it — is refused `UNKNOWN_RECORD_FIELD`, never trimmed.
 *  3. ONE VECTOR SPACE PER REVISION. A call writes one embedding revision of
 *     one dimension count; search compares a query only with vectors of its
 *     own revision, and a dimension mismatch is refused, never coerced.
 *  4. REBUILDABLE FROM POSTGRES. The store holds nothing the system of record
 *     cannot recompute. `rebuildRevision` makes the tenant's rows of a
 *     revision EXACTLY the records a source yields — re-running it is a
 *     no-op, and running it into an empty store reproduces the same keys and
 *     hashes. A source that yields nothing is refused unless the caller says
 *     the tenant really has no chunks (`allowEmpty`), because "rebuild from an
 *     empty read" and "the source is broken" look the same and only one of
 *     them should erase the index.
 *  5. BOUNDED. `k ≤ MAX_SEARCH_K`, a write batch ≤ `MAX_UPSERT_BATCH`, a key
 *     listing ≤ `MAX_LIST_KEYS`.
 *
 * ── Off by default ───────────────────────────────────────────────────
 *
 * `getVectorRepository()` returns `null` unless `VECTOR_STORE_BACKEND` is
 * exactly `pgvector`; any other value, a typo included, is off. Absent config
 * constructs nothing. The in-process backend is never selected here: it exists
 * for tests (`createVectorRepository(createInProcessVectorStore())`).
 *
 * Search returns REFERENCES and scores, never text. Hydrating a hit's text is
 * the caller's read of the source row through its own repository, under RLS —
 * which is also why a stale reference left by an interrupted rebuild is
 * harmless: its source row no longer reads.
 */

import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import type { RequestContext } from '@/app-layer/types';
import { env } from '@/env';
import { logger } from '@/lib/observability';
import { createPgvectorStore } from './vector/pgvector-store';
import {
    MAX_CHUNK_INDEX,
    MAX_DIMENSIONS,
    MAX_LIST_KEYS,
    MAX_SEARCH_K,
    MAX_UPSERT_BATCH,
    VectorStoreError,
    keyOf,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './vector/types';

export {
    MAX_LIST_KEYS,
    MAX_SEARCH_K,
    MAX_UPSERT_BATCH,
    VectorStoreError,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
};
export type { VectorStoreRefusal } from './vector/types';

// ─── Validation ──────────────────────────────────────────────────────

const SOURCE_MODEL = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/);
const SOURCE_ID = z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/);
const EMBEDDING_REVISION = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/);
const CONTENT_HASH = z.string().regex(/^[0-9a-f]{64}$/);
const EMBEDDING = z
    .array(z.number().finite())
    .min(1)
    .max(MAX_DIMENSIONS)
    .refine((v) => v.some((x) => x !== 0), 'a zero vector has no direction');

/** `.strict()` is the vectors-only rule at run time: an unnamed member is refused. */
const RECORD = z
    .object({
        sourceModel: SOURCE_MODEL,
        sourceId: SOURCE_ID,
        chunkIndex: z.number().int().min(0).max(MAX_CHUNK_INDEX),
        embeddingRevision: EMBEDDING_REVISION,
        contentHash: CONTENT_HASH,
        embedding: EMBEDDING,
    })
    .strict();

const QUERY = z
    .object({
        embeddingRevision: EMBEDDING_REVISION,
        embedding: EMBEDDING,
        k: z.number().int().min(1).max(MAX_SEARCH_K),
        sourceModels: z.array(SOURCE_MODEL).min(1).max(32).optional(),
    })
    .strict();

/** Parse a scalar argument, refusing with a named reason rather than a ZodError. */
function must<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new VectorStoreError('INVALID_QUERY', `invalid ${field}`);
    return result.data;
}

function validateBatch(records: readonly VectorRecord[], revision?: string): VectorRecord[] {
    if (records.length > MAX_UPSERT_BATCH) {
        throw new VectorStoreError('BATCH_TOO_LARGE', `at most ${MAX_UPSERT_BATCH} records per call`);
    }
    const parsed: VectorRecord[] = [];
    for (const raw of records) {
        const result = RECORD.safeParse(raw);
        if (!result.success) {
            const unknown = result.error.issues.some((i) => i.code === 'unrecognized_keys');
            // The issue paths name fields, never values: no vector or text reaches a message.
            throw new VectorStoreError(
                unknown ? 'UNKNOWN_RECORD_FIELD' : 'INVALID_RECORD',
                unknown
                    ? 'a vector record carries only its key, contentHash and embedding (vectors-only rule)'
                    : `invalid field(s): ${[...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ')}`,
            );
        }
        parsed.push(result.data);
    }
    const first = parsed[0];
    const seen = new Set<string>();
    for (const r of parsed) {
        if (r.embeddingRevision !== (revision ?? first.embeddingRevision)) {
            throw new VectorStoreError('MIXED_REVISIONS', 'one call writes one embedding revision');
        }
        if (r.embedding.length !== first.embedding.length) {
            throw new VectorStoreError('DIMENSION_MISMATCH', 'one call writes one dimension count');
        }
        const key = keyOf(r);
        if (seen.has(key)) {
            throw new VectorStoreError('DUPLICATE_KEY_IN_BATCH', 'a key appears twice in one call');
        }
        seen.add(key);
    }
    return parsed;
}

// ─── Outcome metric ──────────────────────────────────────────────────

type Operation = 'upsert' | 'search' | 'list_keys' | 'delete_source' | 'delete_tenant' | 'rebuild';
let requestCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | undefined;

function recordRequest(operation: Operation, backend: VectorStoreBackend['kind'], outcome: string): void {
    requestCounter ??= metrics
        .getMeter('inflect-compliance')
        .createCounter('vector_index.requests', { description: 'Vector store requests by outcome', unit: '1' });
    requestCounter.add(1, { operation, backend, outcome });
}

// ─── The repository ──────────────────────────────────────────────────

export interface VectorRepository {
    readonly backend: VectorStoreBackend['kind'];
    upsert(ctx: RequestContext, records: readonly VectorRecord[]): Promise<UpsertOutcome>;
    search(ctx: RequestContext, query: VectorSearchQuery): Promise<VectorMatch[]>;
    listKeys(
        ctx: RequestContext,
        embeddingRevision: string,
        options?: { limit?: number },
    ): Promise<StoredVectorKey[]>;
    deleteSource(ctx: RequestContext, sourceModel: string, sourceId: string): Promise<number>;
    deleteTenant(ctx: RequestContext): Promise<number>;
    rebuildRevision(
        ctx: RequestContext,
        embeddingRevision: string,
        source: AsyncIterable<readonly VectorRecord[]> | Iterable<readonly VectorRecord[]>,
        options?: { allowEmpty?: boolean },
    ): Promise<RebuildOutcome & { seen: number }>;
}

export function createVectorRepository(store: VectorStoreBackend): VectorRepository {
    async function observed<T>(op: Operation, ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
        try {
            const result = await fn();
            recordRequest(op, store.kind, 'ok');
            return result;
        } catch (err) {
            const outcome = err instanceof VectorStoreError ? err.reason : 'error';
            recordRequest(op, store.kind, outcome);
            logger.warn('vector_index.request_failed', {
                component: 'vector-index',
                operation: op,
                backend: store.kind,
                outcome,
                tenantId: ctx.tenantId,
            });
            throw err;
        }
    }

    return {
        backend: store.kind,

        upsert(ctx, records) {
            return observed('upsert', ctx, async () => {
                const parsed = validateBatch(records);
                if (parsed.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
                return store.upsert(ctx, parsed);
            });
        },

        search(ctx, query) {
            return observed('search', ctx, async () => {
                const parsed = QUERY.safeParse(query);
                if (!parsed.success) {
                    throw new VectorStoreError(
                        'INVALID_QUERY',
                        `invalid field(s): ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}`,
                    );
                }
                return store.search(ctx, parsed.data);
            });
        },

        listKeys(ctx, embeddingRevision, options) {
            return observed('list_keys', ctx, async () => {
                must(EMBEDDING_REVISION, embeddingRevision, 'embeddingRevision');
                const limit = Math.min(Math.max(1, Math.trunc(options?.limit ?? MAX_LIST_KEYS)), MAX_LIST_KEYS);
                return store.listKeys(ctx, embeddingRevision, limit);
            });
        },

        deleteSource(ctx, sourceModel, sourceId) {
            return observed('delete_source', ctx, async () => {
                must(SOURCE_MODEL, sourceModel, 'sourceModel');
                must(SOURCE_ID, sourceId, 'sourceId');
                return store.deleteSource(ctx, sourceModel, sourceId);
            });
        },

        deleteTenant(ctx) {
            return observed('delete_tenant', ctx, () => store.deleteTenant(ctx));
        },

        rebuildRevision(ctx, embeddingRevision, source, options) {
            return observed('rebuild', ctx, async () => {
                must(EMBEDDING_REVISION, embeddingRevision, 'embeddingRevision');
                // Validate every batch as it passes, and refuse an empty source
                // INSIDE the iteration — before it completes — so the backend's
                // delete-what-was-not-seen step is never reached on a read that
                // yielded nothing.
                async function* checked(): AsyncGenerator<readonly VectorRecord[]> {
                    let seen = 0;
                    let dimensions: number | null = null;
                    for await (const batch of source) {
                        const parsed = validateBatch(batch, embeddingRevision);
                        if (parsed.length === 0) continue;
                        dimensions ??= parsed[0].embedding.length;
                        if (parsed[0].embedding.length !== dimensions) {
                            throw new VectorStoreError('DIMENSION_MISMATCH', 'one rebuild writes one dimension count');
                        }
                        seen += parsed.length;
                        yield parsed;
                    }
                    if (seen === 0 && !options?.allowEmpty) {
                        throw new VectorStoreError(
                            'EMPTY_REBUILD_SOURCE',
                            'the source yielded no records; pass allowEmpty only when the tenant has no chunks',
                        );
                    }
                }
                return store.rebuildRevision(ctx, embeddingRevision, checked());
            });
        },
    };
}

let configured: VectorRepository | null | undefined;

/**
 * The deployment's vector repository, or `null` when the vector store is off.
 * Only `VECTOR_STORE_BACKEND=pgvector` turns it on.
 */
export function getVectorRepository(): VectorRepository | null {
    if (configured === undefined) {
        configured =
            env.VECTOR_STORE_BACKEND === 'pgvector' ? createVectorRepository(createPgvectorStore()) : null;
    }
    return configured;
}
