/**
 * The Ragas nightly's RETRIEVAL stage (Ragas Phase 1, `docs/ai-architecture/ragas.md`;
 * the two figures are vector store Phase 3.6, `docs/ai-architecture/weaviate.md`).
 *
 * For every question in the set, over the PROBE tenant `corpus.ts` built (the
 * seed policies plus distractors at the stated size):
 *
 *   ANN    the PRODUCT's search: `VectorRepository.search` at k = 10 under the
 *          evaluated tenant's context, pinned to the index path
 *          (`strategy: 'index'`) — the one seam every caller, the
 *          `search_knowledge` tool included, goes through. Its wall time is
 *          the latency sample (one untimed search first, so the first sample
 *          is not a cold connection).
 *   EXACT  computed HERE, not by the store: the store's own statement
 *          (`buildSearchQuery`, so the distance, the tenant filter and the
 *          tie-break are the ones the ANN ran) in a transaction of this
 *          stage's own, under the same tenant context and RLS, with index and
 *          bitmap scans switched off. Its plan is read once and refused if it
 *          touches an index: an "exact" list that came from the HNSW index
 *          would make recall 1 by construction.
 *
 * Both lists are mapped back to the set's keys through the manifest; a hit on
 * a source the manifest does not hold for this tenant is refused
 * (FOREIGN_SOURCE) — it would be another tenant's row.
 *
 * The output carries what a record's retrieval half needs and nothing a record
 * must not hold: the set's hash, the retriever revision (`search-seam.ts`: the
 * one place this stage meets the search it measures; the revision is the one
 * the `search_knowledge` mount gate keys its records by), the corpus counts, and
 * each case's raw probe. Every question's ANN plan is read under the store's
 * settings, and a run whose plans disagree with the revision — `hnsw` stated,
 * a question planned on the tenant's B-tree and a sort, or an index built or
 * searched otherwise than the revision states — is refused. The figures are
 * recomputed from the probes by `rag-record.ts`, never written here.
 *
 * Usage:
 *   npx tsx scripts/rag-eval/probe.ts --set evals/rag/sets/seed-policies.json \
 *       --manifest rag-out/corpus.json --host github-actions-ubuntu-latest \
 *       --out rag-out/retrieval.json [--embedder stub]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext, runWithoutRls } from '@/lib/db/rls-middleware';
import type { PrismaTx } from '@/lib/db-context';
import { buildSearchQuery } from '@/app-layer/repositories/vector/pgvector-store';
import type { VectorMatch } from '@/app-layer/repositories/VectorRepository';
import { indexContext, readResidency, type KnowledgeIndexDeps } from '@/app-layer/services/knowledge-index';
import { getEmbeddingProvider, type EmbeddingProvider } from '@/lib/ai/embeddings';
import {
    checkRagEvaluationSet,
    RECALL_AT,
    ragSetHash,
    type RagEvaluationRecord,
    type RagEvaluationSet,
    type RagProbeCorpus,
} from '@/lib/ai/evals/rag-record';

import type { CorpusManifest, CorpusTenant } from './corpus';
import { annQuery, retrieverRevision, searchSettings, type SearchSettings } from './search-seam';
import { assertLoopbackDatabase, embedderDeps, parseArgs, vectorsOf, type EmbedderMode } from './shared';

type RetrieverRevision = RagEvaluationRecord['retrieverRevision'];
type IndexParams = RetrieverRevision['indexParams'];
type ChunkRef = RagEvaluationRecord['cases'][number]['retrieved'][number];
type RetrievalProbe = RagEvaluationRecord['cases'][number]['retrievalProbe'];

export const PROBE_OUTPUT_KIND = 'rag-retrieval-probe@1';
const EMBED_BATCH = 32;

export interface ProbeOutput {
    readonly kind: typeof PROBE_OUTPUT_KIND;
    readonly setHash: string;
    readonly ranAt: string;
    readonly retrieverRevision: RetrieverRevision;
    readonly probeCorpus: RagProbeCorpus;
    /** Questions whose ANN statement was planned on an HNSW index, and the rest (a B-tree and a sort: exact). */
    readonly annPlans: { readonly hnsw: number; readonly other: number };
    readonly cases: ReadonlyArray<{ readonly caseId: string; readonly retrievalProbe: RetrievalProbe }>;
}

export class ProbeRefusal extends Error {
    constructor(
        readonly reason:
            | 'VECTOR_STORE_OFF'
            | 'EMBEDDING_NOT_CONFIGURED'
            | 'EMBED_FAILED'
            | 'MODEL_MISMATCH'
            | 'FOREIGN_SOURCE'
            | 'EXACT_SCAN_USED_AN_INDEX'
            | 'INDEX_UNREADABLE'
            | 'PLANS_DISAGREE_WITH_REVISION'
            | 'EMPTY_CORPUS',
        detail: string,
    ) {
        super(`${reason}: ${detail}`);
        this.name = 'ProbeRefusal';
    }
}

/** Every `Index Name` a JSON plan's nodes name. */
export function indexNamesIn(plan: unknown): string[] {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
            const o = node as Record<string, unknown>;
            if (typeof o['Index Name'] === 'string') out.push(o['Index Name']);
            for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
        }
    };
    walk(plan);
    return out;
}

/**
 * An HNSW index definition (`pg_indexes.indexdef`) as the record states it.
 * pgvector's defaults stand in for a `WITH` it does not set (m 16,
 * ef_construction 64); an operator class it does not know is refused.
 */
export function hnswParamsFrom(
    indexdef: string,
    search: { iterativeScan: 'off' | 'strict_order' | 'relaxed_order'; efSearch: number; maxScanTuples: number },
): Extract<IndexParams, { method: 'hnsw' }> {
    const ops = /vector_(cosine|l2|ip)_ops/.exec(indexdef)?.[1];
    if (!ops) throw new ProbeRefusal('INDEX_UNREADABLE', 'the HNSW index names no pgvector operator class this harness knows');
    const withParam = (name: string, fallback: number) => {
        const m = new RegExp(`${name}\\s*=\\s*'?(\\d+)'?`).exec(/WITH\s*\(([^)]*)\)/i.exec(indexdef)?.[1] ?? '');
        return m ? Number(m[1]) : fallback;
    };
    return {
        method: 'hnsw',
        distance: ops === 'cosine' ? 'cosine' : ops === 'l2' ? 'l2' : 'inner_product',
        m: withParam('m', 16),
        efConstruction: withParam('ef_construction', 64),
        efSearch: search.efSearch,
        iterativeScan: search.iterativeScan,
        maxScanTuples: search.maxScanTuples,
    };
}

async function explain(tx: PrismaTx, query: Prisma.Sql): Promise<unknown> {
    const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
    return rows[0]?.['QUERY PLAN'];
}

/** Every HNSW index in the database, by name, with its definition. */
async function hnswIndexes(): Promise<Array<{ indexname: string; indexdef: string }>> {
    return runWithoutRls({ reason: 'admin-script' }, (db) =>
        db.$queryRaw<Array<{ indexname: string; indexdef: string }>>(Prisma.sql`
            SELECT indexname, indexdef FROM pg_indexes WHERE indexdef ILIKE '%USING hnsw%'`),
    );
}

/**
 * How the store's statement is planned for one question, under the store's own
 * search settings: the HNSW index it uses, if any, and the server's
 * `hnsw.max_scan_tuples`. The planner decides per statement — on a small table
 * it takes the tenant's B-tree and sorts, which is an exact search — so every
 * question's plan is read, and the record says `exact` unless one used HNSW.
 */
async function annPlanOf(
    ctx: RequestContext,
    model: string,
    embedding: readonly number[],
    dims: number,
    hnsw: ReadonlyArray<{ indexname: string; indexdef: string }>,
): Promise<{ hnswIndex: { indexname: string; indexdef: string } | null; maxScanTuples: string | null }> {
    const settings = searchSettings(RECALL_AT);
    const query = buildSearchQuery(ctx, { embeddingRevision: model, embedding, k: RECALL_AT }, dims);
    const { names, maxScanTuples } = await runInTenantContext(ctx, async (tx) => {
        await tx.$queryRaw(Prisma.sql`
            SELECT set_config('hnsw.iterative_scan', ${settings.iterativeScan}, true),
                   set_config('hnsw.ef_search', ${String(settings.efSearch)}, true)`);
        if (settings.maxScanTuples !== null) {
            await tx.$queryRaw(Prisma.sql`SELECT set_config('hnsw.max_scan_tuples', ${String(settings.maxScanTuples)}, true)`);
        }
        const plan = await explain(tx, query);
        const setting = await tx.$queryRaw<Array<{ v: string | null }>>(Prisma.sql`SELECT current_setting('hnsw.max_scan_tuples', true) AS v`);
        return { names: indexNamesIn(plan), maxScanTuples: setting[0]?.v ?? null };
    });
    return { hnswIndex: hnsw.find((i) => names.includes(i.indexname)) ?? null, maxScanTuples };
}

/** The revision's index parameters from the plans its questions ran under. */
export function indexParamsFromPlans(
    plans: ReadonlyArray<{ hnswIndex: { indexname: string; indexdef: string } | null; maxScanTuples: string | null }>,
    settings: SearchSettings,
): IndexParams {
    const used = [...new Map(plans.filter((p) => p.hnswIndex).map((p) => [p.hnswIndex!.indexname, p])).values()];
    // The store's `<=>` (cosine distance), as buildSearchQuery spells it.
    if (used.length === 0) return { method: 'exact', distance: 'cosine' };
    if (used.length > 1) {
        throw new ProbeRefusal('INDEX_UNREADABLE', `the questions were planned on ${used.length} different HNSW indexes`);
    }
    // What the server says it searched with, read after the settings were
    // applied: a server that does not know the setting (pgvector before 0.8)
    // or did not take the value is refused, never assumed.
    const tuples = used[0].maxScanTuples === null ? null : Number(used[0].maxScanTuples);
    if (tuples === null || !Number.isInteger(tuples) || tuples < 1) {
        throw new ProbeRefusal('INDEX_UNREADABLE', 'the server did not report hnsw.max_scan_tuples');
    }
    if (settings.maxScanTuples !== null && tuples !== settings.maxScanTuples) {
        throw new ProbeRefusal('INDEX_UNREADABLE', `the server reports hnsw.max_scan_tuples ${tuples}; the store sets ${settings.maxScanTuples}`);
    }
    return hnswParamsFrom(used[0].hnswIndex!.indexdef, { iterativeScan: settings.iterativeScan, efSearch: settings.efSearch, maxScanTuples: tuples });
}

/**
 * Refuse figures the plans do not support. A revision stating `hnsw` must have
 * had EVERY question planned on that HNSW index, built and searched exactly as
 * the revision states (distance, build parameters, `ef_search`, iterative scan
 * mode, `max_scan_tuples`), or recall@10 would partly be the exact scan's 1 or
 * another configuration's figure, and the D-L4-9 floor gates whether
 * `search_knowledge` is offered; a revision stating `exact` must have had none
 * planned on an index.
 */
export function assertPlansMatchRevision(revision: IndexParams, observed: IndexParams, plans: ReadonlyArray<{ hnswIndex: unknown }>): void {
    const onIndex = plans.filter((p) => p.hnswIndex).length;
    if (revision.method === 'exact') {
        if (onIndex > 0) throw new ProbeRefusal('PLANS_DISAGREE_WITH_REVISION', `the revision states an exact search, and ${onIndex} question(s) were planned on an HNSW index`);
        return;
    }
    if (onIndex !== plans.length) {
        throw new ProbeRefusal(
            'PLANS_DISAGREE_WITH_REVISION',
            `the revision states the HNSW index, and ${plans.length - onIndex} of ${plans.length} question(s) were planned without it (grow the probe tenant)`,
        );
    }
    if (observed.method !== 'hnsw' || observed.m !== revision.m || observed.efConstruction !== revision.efConstruction || observed.distance !== revision.distance) {
        throw new ProbeRefusal('PLANS_DISAGREE_WITH_REVISION', 'the index the questions were planned on is not built as the revision states');
    }
    if (observed.efSearch !== revision.efSearch || observed.iterativeScan !== revision.iterativeScan || observed.maxScanTuples !== revision.maxScanTuples) {
        throw new ProbeRefusal(
            'PLANS_DISAGREE_WITH_REVISION',
            `the questions were searched with ef_search ${observed.efSearch}, ${observed.iterativeScan}, max_scan_tuples ${observed.maxScanTuples}; ` +
                `the revision states ${revision.efSearch}, ${revision.iterativeScan}, ${revision.maxScanTuples}`,
        );
    }
}

/** The exact top-k over the tenant's rows: the store's statement, sequentially scanned, in a transaction of our own. */
async function exactTopK(
    ctx: RequestContext,
    model: string,
    embedding: readonly number[],
    dims: number,
    hnswNames: ReadonlySet<string>,
): Promise<VectorMatch[]> {
    const query = buildSearchQuery(ctx, { embeddingRevision: model, embedding, k: RECALL_AT }, dims);
    return runInTenantContext(ctx, async (tx) => {
        // The embedding table is read sequentially; the join to the chunk
        // table may still use its primary key, which decides no ranking.
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = on`);
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_indexscan = off`);
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_bitmapscan = off`);
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_indexonlyscan = off`);
        const used = indexNamesIn(await explain(tx, query)).filter((n) => hnswNames.has(n));
        if (used.length > 0) throw new ProbeRefusal('EXACT_SCAN_USED_AN_INDEX', `the exact plan used ${used.join(', ')}`);
        const rows = await tx.$queryRaw<Array<{ sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; score: number }>>(query);
        return rows.map((r) => ({ ...r, chunkIndex: Number(r.chunkIndex), score: Number(r.score) }));
    });
}

/** Map store hits to the set's keys; a source the tenant's manifest does not hold is refused. */
export function toChunkRefs(hits: readonly Pick<VectorMatch, 'sourceModel' | 'sourceId' | 'chunkIndex'>[], tenant: CorpusTenant): ChunkRef[] {
    const keyOf = new Map(tenant.sources.map((s) => [`${s.sourceModel}\u0000${s.sourceId}`, s.sourceKey]));
    return hits.map((h) => {
        const key = keyOf.get(`${h.sourceModel}\u0000${h.sourceId}`);
        if (key === undefined) throw new ProbeRefusal('FOREIGN_SOURCE', `a hit names ${h.sourceModel} ${h.sourceId}, which is not one of ${tenant.slug}'s sources`);
        return { sourceModel: 'Policy', sourceKey: key, chunkIndex: h.chunkIndex };
    });
}

async function embedQuestions(provider: EmbeddingProvider, questions: readonly string[]): Promise<{ vectors: number[][]; model: string; dims: number }> {
    const vectors: number[][] = [];
    let model = '';
    let dims = 0;
    for (let i = 0; i < questions.length; i += EMBED_BATCH) {
        const r = await provider.embed(questions.slice(i, i + EMBED_BATCH), { inputType: 'query' });
        if (!r.ok) throw new ProbeRefusal('EMBED_FAILED', r.reason);
        vectors.push(...r.vectors.map((v) => [...v]));
        model = r.model;
        dims = r.dimensions;
    }
    return { vectors, model, dims };
}

async function corpusCounts(tenantId: string, model: string, host: string): Promise<RagProbeCorpus> {
    const rows = await runWithoutRls({ reason: 'admin-script' }, (db) =>
        db.$queryRaw<Array<{ tenant: bigint; table: bigint; tenants: bigint }>>(Prisma.sql`
            SELECT COUNT(*) FILTER (WHERE "tenantId" = ${tenantId}) AS tenant,
                   COUNT(*) AS "table",
                   COUNT(DISTINCT "tenantId") AS tenants
            FROM "KnowledgeChunkEmbedding" WHERE "embeddingModel" = ${model}`),
    );
    const r = rows[0];
    return { host, tenantChunks: Number(r.tenant), tableChunks: Number(r.table), tenants: Math.max(1, Number(r.tenants)) };
}

export interface ProbeOptions {
    readonly set: RagEvaluationSet;
    readonly manifest: CorpusManifest;
    readonly host: string;
    readonly deps?: KnowledgeIndexDeps;
    readonly now?: () => Date;
}

/** One plan per question: the HNSW index it used, if any, and the server's `hnsw.max_scan_tuples`. */
export type QuestionPlan = Awaited<ReturnType<typeof annPlanOf>>;

/**
 * The measurements alone — each question's ANN and exact lists, its latency
 * and its plan — BEFORE they are held to the revision. Nothing here is a
 * record or becomes one: `runRetrievalProbe` is the only way to an output,
 * and it refuses measurements whose plans disagree with the revision.
 */
export async function measureRetrieval(opts: ProbeOptions): Promise<{
    readonly model: string;
    readonly dims: number;
    readonly probeCorpus: RagProbeCorpus;
    readonly plans: readonly QuestionPlan[];
    readonly cases: ReadonlyArray<{ readonly caseId: string; readonly retrievalProbe: RetrievalProbe }>;
}> {
    const deps = opts.deps ?? {};
    const vectors = vectorsOf(deps);
    if (!vectors || vectors.backend !== 'pgvector') {
        throw new ProbeRefusal('VECTOR_STORE_OFF', 'the probe measures the pgvector store; VECTOR_STORE_BACKEND is not pgvector');
    }
    const tenant = opts.manifest.probeTenant;
    const ctx = indexContext(tenant.id);
    const choice = (deps.embedder ?? getEmbeddingProvider)(await readResidency(ctx));
    if (!choice.ok) throw new ProbeRefusal('EMBEDDING_NOT_CONFIGURED', choice.reason);
    const cases = opts.set.cases;
    const { vectors: queryVectors, model, dims } = await embedQuestions(choice.provider, cases.map((c) => c.question));
    if (model !== opts.manifest.embeddingModel) {
        throw new ProbeRefusal('MODEL_MISMATCH', `the corpus was indexed with ${opts.manifest.embeddingModel}, the questions embed with ${model}`);
    }
    const probeCorpus = await corpusCounts(ctx.tenantId, model, opts.host);
    if (probeCorpus.tenantChunks === 0) throw new ProbeRefusal('EMPTY_CORPUS', `${tenant.slug} holds no chunk of the model`);

    const hnsw = await hnswIndexes();
    const hnswNames = new Set(hnsw.map((i) => i.indexname));
    // Untimed: the first search on a fresh pool pays for the connection.
    await vectors.search(ctx, annQuery({ embeddingRevision: model, embedding: queryVectors[0], k: RECALL_AT }));

    const out: Array<{ caseId: string; retrievalProbe: RetrievalProbe }> = [];
    const plans: QuestionPlan[] = [];
    for (let i = 0; i < cases.length; i++) {
        plans.push(await annPlanOf(ctx, model, queryVectors[i], dims, hnsw));
        const started = performance.now();
        const ann = await vectors.search(ctx, annQuery({ embeddingRevision: model, embedding: queryVectors[i], k: RECALL_AT }));
        const latencyMs = performance.now() - started;
        // Every exact plan is read too: one question's sequential scan proves
        // nothing about the next one's.
        const exact = await exactTopK(ctx, model, queryVectors[i], dims, hnswNames);
        out.push({
            caseId: cases[i].id,
            retrievalProbe: { ann: toChunkRefs(ann, tenant), exact: toChunkRefs(exact, tenant), latencyMs: Math.round(latencyMs * 1000) / 1000 },
        });
    }
    return { model, dims, probeCorpus, plans, cases: out };
}

export async function runRetrievalProbe(opts: ProbeOptions): Promise<ProbeOutput> {
    const { model, dims, probeCorpus, plans, cases: out } = await measureRetrieval(opts);
    const observed = indexParamsFromPlans(plans, searchSettings(RECALL_AT));
    const revision = retrieverRevision({ model, dimensions: dims });
    assertPlansMatchRevision(revision.indexParams, observed, plans);
    return {
        kind: PROBE_OUTPUT_KIND,
        setHash: ragSetHash(opts.set),
        ranAt: (opts.now ?? (() => new Date()))().toISOString(),
        retrieverRevision: revision,
        probeCorpus,
        annPlans: { hnsw: plans.filter((p) => p.hnswIndex).length, other: plans.filter((p) => !p.hnswIndex).length },
        cases: out,
    };
}

export async function main(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv, ['set', 'manifest', 'host', 'out', 'embedder', 'stub-dimensions']);
    assertLoopbackDatabase(process.env);
    const setCheck = checkRagEvaluationSet(JSON.parse(readFileSync(args.set ?? 'evals/rag/sets/seed-policies.json', 'utf-8')));
    if (!setCheck.ok) throw new Error(`rag-eval probe: the set is refused: ${setCheck.reason} ${setCheck.detail}`);
    if (!args.manifest || !args.out || !args.host) throw new Error('rag-eval probe: --manifest, --host and --out are required');
    const output = await runRetrievalProbe({
        set: setCheck.set,
        manifest: JSON.parse(readFileSync(args.manifest, 'utf-8')) as CorpusManifest,
        host: args.host,
        deps: embedderDeps((args.embedder ?? 'deployment') as EmbedderMode, Number(args['stub-dimensions'] ?? 384)),
    });
    writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
    console.info(
        `[rag-eval probe] ${output.cases.length} questions; ${output.retrieverRevision.embeddingModel} (${output.retrieverRevision.indexParams.method}); ` +
            `tenant ${output.probeCorpus.tenantChunks} of ${output.probeCorpus.tableChunks} chunks across ${output.probeCorpus.tenants} tenants`,
    );
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[rag-eval probe] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
