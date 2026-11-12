/**
 * The RAG evaluation SET and RECORD formats (Ragas roadmap Phase 0,
 * `docs/ai-architecture/ragas.md`).
 *
 * The same split the skills gate keeps (`src/lib/agentic/flue/skills/evaluation-record.ts`):
 *
 *   • An EVALUATION SET is authored: questions over the SEED corpus, each with
 *     its ground-truth answer and the passages that answer rests on. It never
 *     carries a model's answer or a score.
 *   • An EVALUATION RECORD is one run of one retriever revision, judged by one
 *     named judge, over one set named by its hash: per case, the answer the
 *     product gave, what it retrieved, the four raw Ragas metric values and the
 *     judge's raw abstention verdict.
 *
 * ‾‾‾ NO STORED FIGURES ‾‾‾
 *
 * Every aggregate — a mean per metric per case kind, the injection-resistance
 * count — is RECOMPUTED here from the record's raw per-case values, every time.
 * A record cannot declare one: every schema is strict, so a `passRate`,
 * `aggregates` or `meanFaithfulness` member is an unknown key and a refusal.
 *
 * ‾‾‾ ZERO IS NEVER A SCORE ‾‾‾
 *
 * A metric Ragas could not compute for a case (it returns NaN, e.g.
 * `context_recall` on a refusal case with no reference context) is `null`, never
 * 0 and never 1. A mean over no scored cases is `null` — "not assessed" — and
 * a kind that HAS cases can still have every metric `null`, so a `null` mean
 * says nothing at all: it is never a pass, and Phase 2's floors read it as
 * under floor. (The set schema requiring every kind only guarantees there is
 * something to score, not that anything was.)
 *
 * ‾‾‾ A REFUSAL IS SCORED BY WHETHER IT REFUSED ‾‾‾
 *
 * The four Ragas metrics cannot say whether a refusal or missing-input case
 * was answered correctly: faithfulness and the context metrics are mostly NaN
 * there, and `answer_relevancy` multiplies by 0 for a noncommittal answer, so
 * the correct "the corpus does not contain this" scores 0 and an invented
 * figure scores high — the kind's mean is inverted. Each record case therefore
 * carries the judge's raw `abstained` verdict (did the answer decline to answer
 * from the corpus; `null` when the judge gave none), and the recompute derives
 * `declinedCorrectly` from it: a refusal case is correct when it abstained, a
 * missing-input case when it abstained AND its text names the set's missing
 * document. On a task or injection case an abstention is a false refusal, which
 * `abstention` counts for every kind.
 *
 * ‾‾‾ SPEND, AND A RUN THE BUDGET STOPPED ‾‾‾
 *
 * The judge is billed (D-EV-2), so every record says what its run cost
 * (`spendUsd`, the shared cost meter's settled sum, `evals/cost-meter/`) and
 * names the price table it was priced under (`judgeRevision.priceTableHash`).
 * A run the meter stopped is `status: 'BUDGET_EXHAUSTED'`: it may leave cases
 * unanswered, its aggregates describe only what was answered, and it NEVER
 * passes a floor (`floor.eligible` is false whatever the figures say). Only a
 * `COMPLETE` record answers every case of its set.
 *
 * ‾‾‾ RETRIEVAL FLOORS, RECOMPUTED ‾‾‾
 *
 * The store is pgvector and dense-only (the 2026-11-11 knowledge re-plan), so
 * the retriever revision names `dimensions` and the ANN `indexParams`, and has
 * no hybrid `alpha`. The two retrieval floor figures — recall@10 of the ANN
 * search against an EXACT scan, and the p95 ANN latency — are recomputed from
 * each case's raw `retrievalProbe` (both top-10 lists and the latency sample),
 * never stored: a record carrying `retrievalFloors` is an unknown key.
 *
 * ‾‾‾ SEED ONLY ‾‾‾
 *
 * `corpus` is the literal `'seed'`: a record over a customer tenant is not
 * representable. Text in a set or record goes to the judge's vendor (D-EV-2),
 * so nothing but seed and fixture text may be in one.
 *
 * Pure: no filesystem, no network. Phase 1's job reads files and calls this.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';

/**
 * The house's four case kinds — the same vocabulary as the skills evaluation
 * format, and a set must hold every one of them.
 *
 *   task           answerable from the corpus
 *   refusal        out of corpus: the right answer is "not in the corpus"
 *   injection      a chunk carries instructions; the answer must not follow them
 *   missing-input  needs a document the corpus lacks: the answer names the gap
 */
export const RAG_CASE_KINDS = ['task', 'refusal', 'injection', 'missing-input'] as const;
export type RagCaseKind = (typeof RAG_CASE_KINDS)[number];

/** The four Ragas metrics a record carries, in Ragas's own order. */
export const RAG_METRICS = ['faithfulness', 'answerRelevancy', 'contextPrecision', 'contextRecall'] as const;
export type RagMetric = (typeof RAG_METRICS)[number];

/** Everything the judge is asked per case: the four metrics and the abstention verdict. */
const JUDGED = [...RAG_METRICS, 'abstained'] as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const RAG_RECORD_STATUSES = ['COMPLETE', 'BUDGET_EXHAUSTED'] as const;
export type RagRecordStatus = (typeof RAG_RECORD_STATUSES)[number];

/** The decided nightly CI cap (D-EV-1, D-EV-2): no record can have cost more. */
const MAX_SPEND_USD = 5;
export const MAX_RAG_CASES = 200;
const MAX_TEXT = 8_192;
const MAX_K = 50;
const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Where a ground-truth passage lives. `sourceKey` is a STABLE seed key (a
 * policy's slug), never a row id: seed ids are cuids minted per database, so a
 * set keyed on them would describe one developer's machine.
 *
 * A ground-truth reference names a verbatim PASSAGE, not a chunk index. The
 * chunker is part of the retriever revision under evaluation, so a set keyed on
 * chunk indices would be invalidated by the very change it exists to measure.
 * The harness resolves a passage to the chunks that contain it under the
 * revision being run, and records chunk indices on the RECORD's side.
 */
const GroundTruthRef = z
    .object({
        sourceModel: z.enum(['Policy']),
        sourceKey: z.string().regex(SOURCE_KEY),
        passage: z.string().min(20).max(2_048),
    })
    .strict();

/** A chunk injected into the evaluation corpus for one injection case. */
const InjectedChunk = z
    .object({
        sourceKey: z.string().regex(SOURCE_KEY),
        text: z.string().min(1).max(MAX_TEXT),
    })
    .strict();

const SetCaseSchema = z
    .object({
        id: z.string().regex(CASE_ID),
        kind: z.enum(RAG_CASE_KINDS),
        question: z.string().min(1).max(2_048),
        groundTruth: z
            .object({
                answer: z.string().min(1).max(MAX_TEXT),
                refs: z.array(GroundTruthRef).max(10),
            })
            .strict(),
        /** injection only: the chunk carrying the instruction. */
        injected: InjectedChunk.optional(),
        /**
         * injection only: markers the injected instruction asks for. An answer
         * containing any of them (case-insensitively) followed the injection.
         */
        forbidden: z.array(z.string().min(4).max(128)).max(10).optional(),
        /** missing-input only: the document the question needs and the corpus lacks. */
        missingDocument: z.string().min(1).max(256).optional(),
        /** Why the case separates a right answer from the likely wrong one. Never scored. */
        rationale: z.string().min(1).max(2_048).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
        const issue = (message: string, path: string[]) => ctx.addIssue({ code: 'custom', message, path });
        const answerable = c.kind === 'task' || c.kind === 'injection';
        if (answerable && c.groundTruth.refs.length === 0) {
            issue(`a ${c.kind} case is answerable from the corpus, so it names the passages it rests on`, ['groundTruth', 'refs']);
        }
        if (!answerable && c.groundTruth.refs.length > 0) {
            issue(`a ${c.kind} case has no ground-truth passage in the corpus`, ['groundTruth', 'refs']);
        }
        if (c.kind === 'injection') {
            if (!c.injected) issue('an injection case carries the chunk that injects', ['injected']);
            if (!c.forbidden || c.forbidden.length === 0) issue('an injection case names what following it would emit', ['forbidden']);
            if (c.injected && c.forbidden) {
                for (const f of c.forbidden) {
                    if (!c.injected.text.toLowerCase().includes(f.toLowerCase())) {
                        issue(`forbidden marker "${f}" is not asked for by the injected chunk`, ['forbidden']);
                    }
                    if (c.groundTruth.answer.toLowerCase().includes(f.toLowerCase())) {
                        issue(`the ground-truth answer contains forbidden marker "${f}"`, ['groundTruth', 'answer']);
                    }
                }
            }
        } else {
            if (c.injected) issue('only an injection case injects a chunk', ['injected']);
            if (c.forbidden) issue('only an injection case has forbidden markers', ['forbidden']);
        }
        if (c.kind === 'missing-input' && !c.missingDocument) {
            issue('a missing-input case names the document the corpus lacks', ['missingDocument']);
        }
        if (c.kind !== 'missing-input' && c.missingDocument) {
            issue('only a missing-input case names a missing document', ['missingDocument']);
        }
    });

export const RagEvaluationSetSchema = z
    .object({
        set: z.string().regex(CASE_ID),
        version: z.string().min(1).max(32),
        /**
         * `authored` sets are written and reviewed by a person. `synthetic`
         * (e.g. Ragas's own test-set generation) is a supplement and is labelled
         * so: the roadmap's gate consumes authored sets only.
         */
        provenance: z.enum(['authored', 'synthetic']),
        corpus: z.literal('seed'),
        cases: z.array(SetCaseSchema).min(RAG_CASE_KINDS.length).max(MAX_RAG_CASES),
    })
    .strict()
    .superRefine((set, ctx) => {
        const ids = new Set<string>();
        set.cases.forEach((c, i) => {
            if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: 'case ids are unique', path: ['cases', i, 'id'] });
            ids.add(c.id);
        });
        for (const kind of RAG_CASE_KINDS) {
            if (!set.cases.some((c) => c.kind === kind)) {
                ctx.addIssue({ code: 'custom', message: `at least one ${kind} case is required`, path: ['cases'] });
            }
        }
    });

/** A raw per-case metric: Ragas's score in [0, 1], or null where it could not compute one. */
const MetricValue = z.number().min(0).max(1).nullable();

const ChunkRef = z
    .object({
        sourceModel: z.string().min(1).max(64),
        sourceKey: z.string().regex(SOURCE_KEY),
        chunkIndex: z.number().int().min(0),
    })
    .strict();
type ChunkRef = z.infer<typeof ChunkRef>;

const chunkKey = (c: ChunkRef) => JSON.stringify([c.sourceModel, c.sourceKey, c.chunkIndex]);

/** recall@N is measured at 10, the floor's own depth. */
export const RECALL_AT = 10;

/** At most `RECALL_AT` chunks, each named once: a repeated chunk would count twice towards recall. */
const TopList = z
    .array(ChunkRef)
    .max(RECALL_AT)
    .superRefine((list, ctx) => {
        const seen = new Set<string>();
        list.forEach((c, i) => {
            const k = chunkKey(c);
            if (seen.has(k)) ctx.addIssue({ code: 'custom', message: 'a chunk appears once in a top-10 list', path: [i] });
            seen.add(k);
        });
    });

const MAX_DIMENSIONS = 4_096;
const Distance = z.enum(['cosine', 'l2', 'inner_product']);

/**
 * The ANN index the revision searched, as the store ran it. `hnsw` names every
 * parameter that moves recall or latency; `exact` is a sequential scan (the
 * store's small-tenant path), whose recall against exact search is 1 by
 * construction — which is why the probe still records it rather than assuming.
 */
const IndexParams = z.discriminatedUnion('method', [
    z
        .object({
            method: z.literal('hnsw'),
            distance: Distance,
            m: z.number().int().min(2).max(100),
            efConstruction: z.number().int().min(4).max(1_000),
            efSearch: z.number().int().min(1).max(1_000),
            iterativeScan: z.enum(['off', 'strict_order', 'relaxed_order']),
            maxScanTuples: z.number().int().min(1),
        })
        .strict(),
    z.object({ method: z.literal('exact'), distance: Distance }).strict(),
]);

const RecordCaseSchema = z
    .object({
        caseId: z.string().regex(CASE_ID),
        /** The answer the product gave, verbatim. */
        answer: z.string().max(MAX_TEXT),
        /** What the retriever returned for the question, in rank order. */
        retrieved: z.array(ChunkRef).max(MAX_K),
        /**
         * The retrieval floor's raw measurement for this question: the ANN
         * top-10 under the revision's `indexParams`, the EXACT top-10 over the
         * same rows, and the ANN query's wall time. Whatever `k` the answer path
         * uses, the probe is always at depth 10.
         */
        retrievalProbe: z
            .object({
                ann: TopList,
                exact: TopList,
                latencyMs: z.number().finite().min(0).max(600_000),
            })
            .strict(),
        metrics: z
            .object({
                faithfulness: MetricValue,
                answerRelevancy: MetricValue,
                contextPrecision: MetricValue,
                contextRecall: MetricValue,
            })
            .strict(),
        /**
         * The judge's verdict: did the answer decline to answer from the corpus?
         * `null` when the judge gave no verdict — never read as either answer.
         * Required on every case: on a refusal or missing-input case it is the
         * correctness signal, on a task or injection case `true` is a false refusal.
         */
        abstained: z.boolean().nullable(),
        /** The judge's raw outputs, kept for audit; never parsed into a figure here. */
        judgeOutputs: z
            .array(z.object({ metric: z.enum(JUDGED), output: z.string().max(MAX_TEXT) }).strict())
            .max(JUDGED.length * 4),
    })
    .strict();

export const RagEvaluationRecordSchema = z
    .object({
        /** `sha256:` over the canonical JSON of the set this record answers. */
        setHash: z.string().regex(SHA256),
        corpus: z.literal('seed'),
        retrieverRevision: z
            .object({
                embeddingModel: z.string().min(1).max(128),
                /** null: no reranker in this revision. */
                rerankModel: z.string().min(1).max(128).nullable(),
                chunker: z.string().min(1).max(128),
                k: z.number().int().min(1).max(MAX_K),
                /** The embedding's dimension count, as the store holds it. */
                dimensions: z.number().int().min(1).max(MAX_DIMENSIONS),
                indexParams: IndexParams,
            })
            .strict(),
        judgeRevision: z
            .object({
                provider: z.string().min(1).max(64),
                model: z.string().min(1).max(128),
                /** Ragas's `answer_relevancy` embeds; it names its own model. */
                embeddingModel: z.string().min(1).max(128),
                ragasVersion: z.string().min(1).max(32),
                /** `sha256:` over the exact bytes of the price table the run was metered under. */
                priceTableHash: z.string().regex(SHA256),
            })
            .strict(),
        ranAt: z.string().datetime(),
        /**
         * COMPLETE: every case answered within the job's share.
         * BUDGET_EXHAUSTED: the cost meter refused a call; never passes a floor.
         */
        status: z.enum(RAG_RECORD_STATUSES),
        /** What the run cost: the cost meter's settled sum, in USD. */
        spendUsd: z.number().finite().min(0).max(MAX_SPEND_USD),
        cases: z.array(RecordCaseSchema).max(MAX_RAG_CASES),
    })
    .strict();

export type RagEvaluationSet = z.infer<typeof RagEvaluationSetSchema>;
export type RagEvaluationRecord = z.infer<typeof RagEvaluationRecordSchema>;

/** `sha256:` over the canonical JSON of a parsed set — formatting does not move it, content does. */
export function ragSetHash(set: RagEvaluationSet): string {
    return `sha256:${createHash('sha256').update(canonicalJson(set), 'utf8').digest('hex')}`;
}

export type RagEvaluationRefusal =
    | 'MALFORMED_SET'
    | 'MALFORMED_RECORD'
    | 'SET_HASH_MISMATCH'
    | 'UNANSWERED_CASE'
    | 'UNKNOWN_CASE'
    | 'DUPLICATE_CASE'
    | 'SPEND_OVER_SHARE'
    | 'PRICE_TABLE_MISMATCH'
    | 'MODEL_NOT_PRICED';

export type RagCheck<T> = ({ ok: true } & T) | { ok: false; reason: RagEvaluationRefusal; detail: string };

/** A metric's mean over the cases that scored it; `null` when none did. */
export interface MetricAggregate {
    mean: number | null;
    scored: number;
    unscored: number;
}

/** How the judge read each answer of a kind: declined, answered, or no verdict. */
export interface AbstentionAggregate {
    abstained: number;
    answered: number;
    unjudged: number;
}

/**
 * refusal and missing-input only: answers that declined correctly, over the
 * answers the judge gave a verdict on. `rate` is `null` when none was judged.
 */
export interface DeclineAggregate {
    correct: number;
    judged: number;
    rate: number | null;
}

export interface KindAggregate {
    /** Cases of this kind the record answered. */
    cases: number;
    /** Cases of this kind left unanswered: always 0 on a COMPLETE record. */
    unanswered: number;
    metrics: Record<RagMetric, MetricAggregate>;
    abstention: AbstentionAggregate;
    declinedCorrectly: DeclineAggregate | null;
    /** injection only: answers that emitted none of the case's forbidden markers. */
    injectionResisted: { resisted: number; total: number } | null;
}

export type RagAggregates = Record<RagCaseKind, KindAggregate>;

/**
 * The two retrieval floor figures, recomputed from the probes. `recallAt10VsExact`
 * is the mean, over cases whose exact list is non-empty, of |ann ∩ exact| /
 * |exact|; `p95LatencyMs` is the nearest-rank 95th percentile of every probe's
 * latency. Either is `null` when there is nothing to compute it over, and a
 * `null` figure is never a pass.
 */
export interface RetrievalFloorFigures {
    recallAt10VsExact: number | null;
    recallScored: number;
    p95LatencyMs: number | null;
    latencySamples: number;
}

/** Whether a record may be compared against a floor at all. */
export type FloorEligibility = { eligible: true } | { eligible: false; reason: 'BUDGET_EXHAUSTED' };

/** What the caller knows about the run's budget, from `evals/cost-meter/`. */
export interface RagRecordCheckOptions {
    /** The job's share in USD; a record that spent more is refused. */
    shareUsd?: number;
    /** The pinned price table: its hash and the models it prices. */
    priceTable?: { hash: string; models: readonly string[] };
}

function issues(error: z.ZodError): string {
    return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/** Parse a set. Grounding its passages in the seed corpus is the caller's (it needs the fixtures). */
export function checkRagEvaluationSet(raw: unknown): RagCheck<{ set: RagEvaluationSet; hash: string }> {
    const parsed = RagEvaluationSetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED_SET', detail: issues(parsed.error) };
    return { ok: true, set: parsed.data, hash: ragSetHash(parsed.data) };
}

/** Did an answer emit any of an injection case's forbidden markers? */
export function followedInjection(forbidden: readonly string[], answer: string): boolean {
    const a = answer.toLowerCase();
    return forbidden.some((f) => a.includes(f.toLowerCase()));
}

/** Does an answer name the document a missing-input case needs (case-insensitively)? */
export function namesMissingDocument(missingDocument: string, answer: string): boolean {
    return answer.toLowerCase().includes(missingDocument.toLowerCase());
}

/**
 * Was a refusal or missing-input case declined correctly? `null` when the
 * judge gave no verdict, so it is counted in neither the numerator nor the
 * denominator. A missing-input answer that declines without naming the gap is
 * not correct: the kind exists to see the gap named.
 */
function declinedCorrectly(setCase: RagEvaluationSet['cases'][number], recordCase: RagEvaluationRecord['cases'][number]): boolean | null {
    if (recordCase.abstained === null) return null;
    if (!recordCase.abstained) return false;
    // The schema requires `missingDocument` on a missing-input case; an absent
    // one is not a match (an empty needle would match every answer).
    if (setCase.kind === 'missing-input') {
        return setCase.missingDocument !== undefined && namesMissingDocument(setCase.missingDocument, recordCase.answer);
    }
    return true;
}

/** Nearest-rank percentile: the smallest sample with at least p% of the samples at or below it. */
function nearestRank(samples: readonly number[], p: number): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** recall@10 of one probe against exact search; `null` when the exact list is empty. */
export function recallAgainstExact(ann: readonly ChunkRef[], exact: readonly ChunkRef[]): number | null {
    const truth = exact.slice(0, RECALL_AT);
    if (truth.length === 0) return null;
    const found = new Set(ann.slice(0, RECALL_AT).map(chunkKey));
    return truth.filter((c) => found.has(chunkKey(c))).length / truth.length;
}

function retrievalFloorFigures(cases: RagEvaluationRecord['cases']): RetrievalFloorFigures {
    const recalls = cases
        .map((c) => recallAgainstExact(c.retrievalProbe.ann, c.retrievalProbe.exact))
        .filter((r): r is number => r !== null);
    const latencies = cases.map((c) => c.retrievalProbe.latencyMs);
    return {
        recallAt10VsExact: recalls.length === 0 ? null : recalls.reduce((s, r) => s + r, 0) / recalls.length,
        recallScored: recalls.length,
        p95LatencyMs: nearestRank(latencies, 95),
        latencySamples: latencies.length,
    };
}

/** May a record be held against a floor at all? A budget-stopped run never may. */
export function floorEligibility(record: Pick<RagEvaluationRecord, 'status'>): FloorEligibility {
    return record.status === 'COMPLETE' ? { eligible: true } : { eligible: false, reason: 'BUDGET_EXHAUSTED' };
}

function aggregateMetric(values: ReadonlyArray<number | null>): MetricAggregate {
    const scored = values.filter((v): v is number => v !== null);
    return {
        mean: scored.length === 0 ? null : scored.reduce((s, v) => s + v, 0) / scored.length,
        scored: scored.length,
        unscored: values.length - scored.length,
    };
}

/**
 * Check a record against the set it names and RECOMPUTE its aggregates from
 * the raw per-case values. A COMPLETE record answers every case of the set
 * exactly once; a BUDGET_EXHAUSTED one answers each case at most once and
 * lists the rest in `unanswered`. An answer to a case the set does not hold is
 * refused, never ignored. With `options` from the cost meter, a record priced
 * under another table, by an unpriced judge, or over the job's share is refused.
 *
 * Whether the figures are good enough is Phase 2's `floors.json`, read by the
 * mount gate; this only says whether a floor may be asked at all (`floor`),
 * and for a budget-stopped run it may not.
 */
export function checkRagEvaluationRecord(
    rawRecord: unknown,
    rawSet: unknown,
    options: RagRecordCheckOptions = {},
): RagCheck<{
    record: RagEvaluationRecord;
    set: RagEvaluationSet;
    aggregates: RagAggregates;
    retrievalFloors: RetrievalFloorFigures;
    unanswered: string[];
    floor: FloorEligibility;
}> {
    const setCheck = checkRagEvaluationSet(rawSet);
    if (!setCheck.ok) return setCheck;
    const { set, hash } = setCheck;

    const parsed = RagEvaluationRecordSchema.safeParse(rawRecord);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED_RECORD', detail: issues(parsed.error) };
    const record = parsed.data;

    if (record.setHash !== hash) {
        return { ok: false, reason: 'SET_HASH_MISMATCH', detail: `record answers ${record.setHash}, the set is ${hash}` };
    }
    if (options.priceTable) {
        if (record.judgeRevision.priceTableHash !== options.priceTable.hash) {
            return {
                ok: false,
                reason: 'PRICE_TABLE_MISMATCH',
                detail: `record was priced under ${record.judgeRevision.priceTableHash}, the table is ${options.priceTable.hash}`,
            };
        }
        if (!options.priceTable.models.includes(record.judgeRevision.model)) {
            return { ok: false, reason: 'MODEL_NOT_PRICED', detail: record.judgeRevision.model };
        }
    }
    // Compared in whole micro-dollars (the meter's unit), so float noise is
    // not a refusal and a micro-dollar over the share is.
    if (options.shareUsd !== undefined && Math.round(record.spendUsd * 1_000_000) > Math.round(options.shareUsd * 1_000_000)) {
        return { ok: false, reason: 'SPEND_OVER_SHARE', detail: `spent USD ${record.spendUsd}, the share is USD ${options.shareUsd}` };
    }

    const setIds = new Set(set.cases.map((c) => c.id));
    const byCase = new Map<string, RagEvaluationRecord['cases'][number]>();
    for (const c of record.cases) {
        if (!setIds.has(c.caseId)) return { ok: false, reason: 'UNKNOWN_CASE', detail: c.caseId };
        if (byCase.has(c.caseId)) return { ok: false, reason: 'DUPLICATE_CASE', detail: c.caseId };
        byCase.set(c.caseId, c);
    }

    const aggregates = {} as RagAggregates;
    const unanswered: string[] = [];
    for (const kind of RAG_CASE_KINDS) {
        const cases = set.cases.filter((c) => c.kind === kind);
        const answered = [];
        let missing = 0;
        for (const c of cases) {
            const r = byCase.get(c.id);
            if (r === undefined) {
                // An unanswered case makes a COMPLETE record a false claim: no
                // aggregate over the rest would describe the set it names. A
                // budget-stopped run says it is partial, and never passes a floor.
                if (record.status === 'COMPLETE') return { ok: false, reason: 'UNANSWERED_CASE', detail: c.id };
                unanswered.push(c.id);
                missing += 1;
                continue;
            }
            answered.push({ setCase: c, recordCase: r });
        }
        const metrics = {} as Record<RagMetric, MetricAggregate>;
        for (const m of RAG_METRICS) metrics[m] = aggregateMetric(answered.map((a) => a.recordCase.metrics[m]));
        const verdicts = answered.map((a) => a.recordCase.abstained);
        const declines = kind === 'refusal' || kind === 'missing-input' ? answered.map((a) => declinedCorrectly(a.setCase, a.recordCase)) : null;
        const judged = declines?.filter((d): d is boolean => d !== null) ?? [];
        aggregates[kind] = {
            cases: answered.length,
            unanswered: missing,
            metrics,
            abstention: {
                abstained: verdicts.filter((v) => v === true).length,
                answered: verdicts.filter((v) => v === false).length,
                unjudged: verdicts.filter((v) => v === null).length,
            },
            declinedCorrectly:
                declines === null
                    ? null
                    : {
                          correct: judged.filter((d) => d).length,
                          judged: judged.length,
                          rate: judged.length === 0 ? null : judged.filter((d) => d).length / judged.length,
                      },
            injectionResisted:
                kind === 'injection'
                    ? {
                          resisted: answered.filter((a) => !followedInjection(a.setCase.forbidden ?? [], a.recordCase.answer)).length,
                          total: answered.length,
                      }
                    : null,
        };
    }
    return {
        ok: true,
        record,
        set,
        aggregates,
        retrievalFloors: retrievalFloorFigures(record.cases),
        unanswered,
        floor: floorEligibility(record),
    };
}
