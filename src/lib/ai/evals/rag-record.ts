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
 *     product gave, what it retrieved, and the four raw Ragas metric values.
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
 * a set with no case of a kind is refused at parse, so `null` cannot pass for a
 * perfect score by having nothing to average.
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

const SHA256 = /^sha256:[0-9a-f]{64}$/;
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

const RecordCaseSchema = z
    .object({
        caseId: z.string().regex(CASE_ID),
        /** The answer the product gave, verbatim. */
        answer: z.string().max(MAX_TEXT),
        /** What the retriever returned for the question, in rank order. */
        retrieved: z
            .array(
                z
                    .object({
                        sourceModel: z.string().min(1).max(64),
                        sourceKey: z.string().regex(SOURCE_KEY),
                        chunkIndex: z.number().int().min(0),
                    })
                    .strict(),
            )
            .max(MAX_K),
        metrics: z
            .object({
                faithfulness: MetricValue,
                answerRelevancy: MetricValue,
                contextPrecision: MetricValue,
                contextRecall: MetricValue,
            })
            .strict(),
        /** The judge's raw outputs, kept for audit; never parsed into a figure here. */
        judgeOutputs: z
            .array(z.object({ metric: z.enum(RAG_METRICS), output: z.string().max(MAX_TEXT) }).strict())
            .max(RAG_METRICS.length * 4),
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
                /** Hybrid weight between keyword and vector scores. */
                alpha: z.number().min(0).max(1),
            })
            .strict(),
        judgeRevision: z
            .object({
                provider: z.string().min(1).max(64),
                model: z.string().min(1).max(128),
                /** Ragas's `answer_relevancy` embeds; it names its own model. */
                embeddingModel: z.string().min(1).max(128),
                ragasVersion: z.string().min(1).max(32),
            })
            .strict(),
        ranAt: z.string().datetime(),
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
    | 'DUPLICATE_CASE';

export type RagCheck<T> = ({ ok: true } & T) | { ok: false; reason: RagEvaluationRefusal; detail: string };

/** A metric's mean over the cases that scored it; `null` when none did. */
export interface MetricAggregate {
    mean: number | null;
    scored: number;
    unscored: number;
}

export interface KindAggregate {
    cases: number;
    metrics: Record<RagMetric, MetricAggregate>;
    /** injection only: answers that emitted none of the case's forbidden markers. */
    injectionResisted: { resisted: number; total: number } | null;
}

export type RagAggregates = Record<RagCaseKind, KindAggregate>;

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
 * the raw per-case values. Every case of the set is answered exactly once; an
 * answer to a case the set does not hold is refused, never ignored.
 *
 * This says nothing about floors: whether the aggregates are good enough is
 * Phase 2's `floors.json`, read by the mount gate.
 */
export function checkRagEvaluationRecord(
    rawRecord: unknown,
    rawSet: unknown,
): RagCheck<{ record: RagEvaluationRecord; set: RagEvaluationSet; aggregates: RagAggregates }> {
    const setCheck = checkRagEvaluationSet(rawSet);
    if (!setCheck.ok) return setCheck;
    const { set, hash } = setCheck;

    const parsed = RagEvaluationRecordSchema.safeParse(rawRecord);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED_RECORD', detail: issues(parsed.error) };
    const record = parsed.data;

    if (record.setHash !== hash) {
        return { ok: false, reason: 'SET_HASH_MISMATCH', detail: `record answers ${record.setHash}, the set is ${hash}` };
    }

    const setIds = new Set(set.cases.map((c) => c.id));
    const byCase = new Map<string, RagEvaluationRecord['cases'][number]>();
    for (const c of record.cases) {
        if (!setIds.has(c.caseId)) return { ok: false, reason: 'UNKNOWN_CASE', detail: c.caseId };
        if (byCase.has(c.caseId)) return { ok: false, reason: 'DUPLICATE_CASE', detail: c.caseId };
        byCase.set(c.caseId, c);
    }

    const aggregates = {} as RagAggregates;
    for (const kind of RAG_CASE_KINDS) {
        const cases = set.cases.filter((c) => c.kind === kind);
        const answered = [];
        for (const c of cases) {
            const r = byCase.get(c.id);
            // An unanswered case makes the RECORD incomplete: no aggregate over
            // the rest would describe the set it names.
            if (r === undefined) return { ok: false, reason: 'UNANSWERED_CASE', detail: c.id };
            answered.push({ setCase: c, recordCase: r });
        }
        const metrics = {} as Record<RagMetric, MetricAggregate>;
        for (const m of RAG_METRICS) metrics[m] = aggregateMetric(answered.map((a) => a.recordCase.metrics[m]));
        aggregates[kind] = {
            cases: answered.length,
            metrics,
            injectionResisted:
                kind === 'injection'
                    ? {
                          resisted: answered.filter((a) => !followedInjection(a.setCase.forbidden ?? [], a.recordCase.answer)).length,
                          total: answered.length,
                      }
                    : null,
        };
    }
    return { ok: true, record, set, aggregates };
}
