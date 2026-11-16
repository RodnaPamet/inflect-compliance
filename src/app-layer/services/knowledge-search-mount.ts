/**
 * WHETHER `search_knowledge` IS OFFERED — the mount gate (vector store Phase
 * 3.5, `docs/ai-architecture/weaviate.md`; G11 of the master roadmap: no
 * record, no tool).
 *
 * The same shape as the skills mount gate (`flue/skills/mount-gate.ts`) and the
 * PII detector's (`src/lib/ai/pii/mount.ts`), and it consumes the RAG
 * evaluation record format Ragas Phase 0 defined (`src/lib/ai/evals/rag-record.ts`)
 * — it defines no format of its own. Three answers:
 *
 *   ABSENT     the vector store is off (`VECTOR_STORE_BACKEND` is not
 *              `pgvector`) or no embedding route is configured. Nothing is
 *              offered and nothing is read (G9).
 *   UNMOUNTED  both are on, and no committed record vouches for the retriever
 *              revision this deployment would run — none for this revision,
 *              one that does not answer the committed authored set, one the
 *              recompute refuses, one a budget stopped, or one whose recomputed
 *              retrieval figures miss a D-L4-9 floor. The tool is absent from
 *              every catalogue, and a run that would have been offered it
 *              records the omission (`RETRIEVER_NOT_EVALUATED`).
 *   MOUNTED    the newest record for this revision passes.
 *
 * ── WHICH RECORD DECIDES ────────────────────────────────────────────────────
 *
 * Records are read from `evals/rag/records/*.json`, the set they answer from
 * `evals/rag/sets/*.json` (an AUTHORED set, by its content hash: a synthetic
 * set is a supplement and never opens the gate), and the cost meter's facts
 * from `evals/cost-meter/`, all relative to the working directory, so the
 * runtime image carries all three (`Dockerfile`;
 * `tests/guardrails/catalogue-reaches-production.test.ts` holds it). A record
 * is this deployment's when its `retrieverRevision` has the same key as
 * `knowledgeRetrieverRevision(route)`; file names mean nothing. The NEWEST by
 * `ranAt` decides, passing or not — an older pass never stands in for a newer
 * failure — and every record is schema-checked before any is ordered, because
 * a malformed one cannot be placed in time and so cannot be ruled out.
 *
 * ── THE FLOORS ARE D-L4-9'S, DECIDED ────────────────────────────────────────
 *
 * recall@10 at least 0.95 of an exact scan, and p95 latency at most 300 ms at
 * k = 10. D-L4-9 (owner, 2026-11-12) adopted them as the trigger for the
 * vector store's Phase 4 (Weaviate); the owner decided on 2026-11-16 that the
 * SAME values also decide whether `search_knowledge` is offered. They live in
 * ONE place, `src/lib/ai/evals/rag-retrieval-floors.ts`, which the Ragas
 * nightly reads its figures against too, and this gate asks
 * `readRetrievalFloors` rather than comparing on its own, so the nightly's
 * verdict and the gate's cannot disagree. Until Ragas Phase 2 defines
 * answer-quality floors (`evals/rag/floors.json`), the retrieval floors are
 * the only ones the gate checks; Phase 2's join it then.
 *
 * Both figures are RECOMPUTED by `checkRagEvaluationRecord` from each case's
 * raw probe; a `null` figure (nothing to compute it over) never passes.
 *
 * @module app-layer/services/knowledge-search-mount
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { vectorStoreEnabled } from '@/app-layer/repositories/vector-store-switch';
import { modelOf, resolveEmbeddingRoute, retrieverRevisionKey, type RetrieverRevision } from '@/lib/ai/embeddings';
import {
    checkRagEvaluationRecord,
    checkRagEvaluationSet,
    RagEvaluationRecordSchema,
    type RagEvaluationRefusal,
    type RetrievalFloorFigures,
} from '@/lib/ai/evals/rag-record';
import { readRetrievalFloors } from '@/lib/ai/evals/rag-retrieval-floors';

import { knowledgeRetrieverRevision } from './knowledge-search-revision';

export const RAG_RECORDS_DIR = path.join('evals', 'rag', 'records');
export const RAG_SETS_DIR = path.join('evals', 'rag', 'sets');
export const COST_METER_DIR = path.join('evals', 'cost-meter');

/** The Ragas job's share in `shares.json`. */
const RAGAS_SHARE = 'ragas';

export type KnowledgeSearchMountRefusal =
    | 'RECORDS_UNREADABLE'
    | 'NO_RECORD'
    | 'NO_SET'
    | 'SET_NOT_AUTHORED'
    | 'COST_METER_UNREADABLE'
    | RagEvaluationRefusal
    | 'BUDGET_EXHAUSTED'
    | 'RECALL_NOT_MEASURED'
    | 'RECALL_BELOW_FLOOR'
    | 'LATENCY_NOT_MEASURED'
    | 'LATENCY_ABOVE_CEILING';

export type KnowledgeSearchMount =
    | { readonly state: 'ABSENT'; readonly reason: 'VECTOR_STORE_DISABLED' | 'EMBEDDING_NOT_CONFIGURED' }
    | {
          readonly state: 'UNMOUNTED';
          readonly reason: KnowledgeSearchMountRefusal;
          readonly detail: string;
          readonly revision: RetrieverRevision;
      }
    | {
          readonly state: 'MOUNTED';
          readonly revision: RetrieverRevision;
          readonly record: { readonly file: string; readonly ranAt: string };
          readonly figures: RetrievalFloorFigures;
      };

/** Test seams. Production passes nothing: the env decides the route and the working directory holds the files. */
export interface ResolveKnowledgeSearchMountOptions {
    /** Overrides `VECTOR_STORE_BACKEND`. */
    readonly storeEnabled?: boolean;
    /** Overrides the embedding route: the model and dimensions it serves, or `null` for none configured. */
    readonly route?: { readonly model: string; readonly dimensions: number } | null;
    /** The directory `evals/` is read under. */
    readonly root?: string;
}

/** Every `.json` file in a directory, parsed. Throws on an unreadable one: one is never skipped. */
function readJsonFiles(dir: string): { file: string; raw: unknown }[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((file) => ({ file, raw: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as unknown }));
}

function currentRoute(): { model: string; dimensions: number } | null {
    const route = resolveEmbeddingRoute();
    return route.ok ? { model: modelOf(route.specifier), dimensions: route.dimensions } : null;
}

/** The record's own revision key, or null when it cannot be keyed (the schema check refuses it first). */
function recordKey(raw: unknown): string | null {
    const parsed = RagEvaluationRecordSchema.shape.retrieverRevision.safeParse((raw as { retrieverRevision?: unknown } | null)?.retrieverRevision);
    if (!parsed.success) return null;
    try {
        return retrieverRevisionKey(parsed.data);
    } catch {
        return null;
    }
}

export function resolveKnowledgeSearchMount(opts: ResolveKnowledgeSearchMountOptions = {}): KnowledgeSearchMount {
    const storeOn = opts.storeEnabled ?? vectorStoreEnabled();
    if (!storeOn) return { state: 'ABSENT', reason: 'VECTOR_STORE_DISABLED' };
    const route = 'route' in opts ? opts.route : currentRoute();
    if (!route) return { state: 'ABSENT', reason: 'EMBEDDING_NOT_CONFIGURED' };

    const revision = knowledgeRetrieverRevision(route);
    const key = retrieverRevisionKey(revision);
    const unmounted = (reason: KnowledgeSearchMountRefusal, detail: string): KnowledgeSearchMount => ({
        state: 'UNMOUNTED',
        reason,
        detail,
        revision,
    });

    // The production reads are spelled out literally so
    // tests/guardrails/catalogue-reaches-production.test.ts can derive each
    // directory and hold the runtime image to copying it. `opts.root` is the
    // test seam.
    const recordsDir = opts.root !== undefined ? path.join(opts.root, RAG_RECORDS_DIR) : path.join(process.cwd(), 'evals/rag/records');
    const setsDir = opts.root !== undefined ? path.join(opts.root, RAG_SETS_DIR) : path.join(process.cwd(), 'evals/rag/sets');
    const meterDir = opts.root !== undefined ? path.join(opts.root, COST_METER_DIR) : path.join(process.cwd(), 'evals/cost-meter');

    let records: { file: string; raw: unknown }[];
    try {
        records = readJsonFiles(recordsDir);
    } catch (e) {
        return unmounted('RECORDS_UNREADABLE', e instanceof Error ? e.message : String(e));
    }

    // Every record is schema-checked before any is ordered: a malformed one
    // cannot be ruled out as this revision's newest.
    const mine: { file: string; raw: unknown; ranAt: string; at: number }[] = [];
    let others = 0;
    for (const r of records) {
        const parsed = RagEvaluationRecordSchema.safeParse(r.raw);
        if (!parsed.success) {
            return unmounted('MALFORMED_RECORD', `${r.file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        }
        if (recordKey(r.raw) !== key) {
            others += 1;
            continue;
        }
        mine.push({ file: r.file, raw: r.raw, ranAt: parsed.data.ranAt, at: Date.parse(parsed.data.ranAt) });
    }
    mine.sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : a.at - b.at));
    const newest = mine[mine.length - 1];
    if (!newest) {
        return unmounted(
            'NO_RECORD',
            `no record under ${RAG_RECORDS_DIR} is for this retriever revision (${route.model}, ${route.dimensions} dimensions)` +
                (others > 0 ? `; ${others} record(s) are for other revisions` : ''),
        );
    }

    // The set the record answers, found by its content hash among the
    // committed sets. Only an AUTHORED set opens the gate.
    let sets: { file: string; raw: unknown }[];
    try {
        sets = readJsonFiles(setsDir);
    } catch (e) {
        return unmounted('NO_SET', e instanceof Error ? e.message : String(e));
    }
    const wanted = (newest.raw as { setHash: string }).setHash;
    const set = sets
        .map((s) => ({ ...s, check: checkRagEvaluationSet(s.raw) }))
        .find((s) => s.check.ok && s.check.hash === wanted);
    if (!set || !set.check.ok) return unmounted('NO_SET', `${newest.file} answers ${wanted}, which no set under ${RAG_SETS_DIR} hashes to`);
    if (set.check.set.provenance !== 'authored') {
        return unmounted('SET_NOT_AUTHORED', `${newest.file} answers ${set.file}, a ${set.check.set.provenance} set`);
    }

    // The cost meter's facts: the price table by the hash of its exact bytes,
    // and the Ragas job's share.
    let priceTable: { hash: string; models: string[] };
    let shareUsd: number;
    try {
        const priceBytes = fs.readFileSync(path.join(meterDir, 'prices.json'));
        const prices = JSON.parse(priceBytes.toString('utf-8')) as { models?: Record<string, unknown> };
        priceTable = {
            hash: `sha256:${createHash('sha256').update(priceBytes).digest('hex')}`,
            models: Object.keys(prices.models ?? {}),
        };
        const shares = JSON.parse(fs.readFileSync(path.join(meterDir, 'shares.json'), 'utf-8')) as {
            shares?: Record<string, { usd?: unknown }>;
        };
        const usd = shares.shares?.[RAGAS_SHARE]?.usd;
        if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error(`shares.json names no ${RAGAS_SHARE} share`);
        shareUsd = usd;
    } catch (e) {
        return unmounted('COST_METER_UNREADABLE', e instanceof Error ? e.message : String(e));
    }

    const check = checkRagEvaluationRecord(newest.raw, set.raw, { priceTable, shareUsd });
    if (!check.ok) return unmounted(check.reason, `${newest.file}: ${check.detail}`);
    if (!check.floor.eligible) return unmounted('BUDGET_EXHAUSTED', `${newest.file}: a run the budget stopped never passes a floor`);

    // D-L4-9's floors, read through the one function the nightly reads them
    // through: a null figure is "not assessed", never a pass.
    const figures = check.retrievalFloors;
    const floors = readRetrievalFloors(figures);
    if (floors.recallAt10VsExact.meets === null) {
        return unmounted('RECALL_NOT_MEASURED', `${newest.file}: no probe carried an exact top-10`);
    }
    if (!floors.recallAt10VsExact.meets) {
        return unmounted(
            'RECALL_BELOW_FLOOR',
            `${newest.file}: recall@10 against exact search is ${figures.recallAt10VsExact?.toFixed(4)}, the floor (D-L4-9) is ${floors.recallAt10VsExact.floor}`,
        );
    }
    if (floors.p95LatencyMs.meets === null) return unmounted('LATENCY_NOT_MEASURED', `${newest.file}: no probe carried a latency`);
    if (!floors.p95LatencyMs.meets) {
        return unmounted(
            'LATENCY_ABOVE_CEILING',
            `${newest.file}: p95 latency is ${figures.p95LatencyMs} ms, the ceiling (D-L4-9) is ${floors.p95LatencyMs.floor} ms`,
        );
    }
    return { state: 'MOUNTED', revision, record: { file: newest.file, ranAt: newest.ranAt }, figures };
}

let cached: KnowledgeSearchMount | null = null;

/**
 * The process's answer. The route is env and the records ship in the image, so
 * neither changes while the process runs; resolved once.
 */
export function getKnowledgeSearchMount(): KnowledgeSearchMount {
    if (cached === null) cached = resolveKnowledgeSearchMount();
    return cached;
}

/** Is `search_knowledge` offered by this process? */
export function knowledgeSearchMounted(): boolean {
    return getKnowledgeSearchMount().state === 'MOUNTED';
}
