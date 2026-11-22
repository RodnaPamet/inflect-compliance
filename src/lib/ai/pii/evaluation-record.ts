/**
 * The PII fixture corpus and the PII evaluation record — the house shape (G11)
 * for a DETECTOR rather than a model answer.
 *
 * Phase 0 of `docs/ai-architecture/presidio.md` wrote the two shapes; Phase 1
 * reads the same two for its mount condition. There is ONE record format and
 * ONE ground truth — Phase 1's seam once carried a second (`fixture-set.ts`,
 * a different case vocabulary and a looser precision rule) and it was folded
 * into this one rather than kept beside it. Two shapes, as in
 * `flue/skills/evaluation-record.ts`, and the split is the point:
 *
 *   • The FIXTURE CORPUS (`tests/fixtures/pii/corpus.json`) is generated, never
 *     collected (`tests/fixtures/pii/generate.ts`), carries ground-truth spans,
 *     and is named by the SHA-256 of its exact bytes.
 *   • An EVALUATION RECORD is that digest PLUS the spans one named detector
 *     configuration actually returned for every case. Only a record can show
 *     the detector works, and it carries no rate of its own.
 *
 * ‾‾‾ NO STORED FIGURES ‾‾‾
 *
 * Precision and recall are RECOMPUTED here from the raw spans, every time. The
 * record schema is strict, so a `precision` member is an unknown key and a
 * refusal: a record cannot declare the number it is meant to evidence.
 *
 * ‾‾‾ WHAT COUNTS, AND WHY IT IS ASYMMETRIC ‾‾‾
 *
 * The detector's job is that nothing LEAKS, so the two sides are judged by
 * different harms:
 *
 *   recall     a ground-truth span is recalled iff every non-whitespace
 *              character of it lies inside some predicted span of the same
 *              type. A prediction that covers "Petrov" but not "Ivan" leaves
 *              "Ivan" in the text, so partial cover is a miss — however close
 *              the boundaries look.
 *   precision  a predicted span is correct iff it overlaps a ground-truth span
 *              of the same type and at most `OVERREACH_CHARS` of its
 *              characters lie outside that span (before it plus after it —
 *              not its length, which a shifted span passes). Over-redaction
 *              harms the answer, not the person, so a little slack is
 *              allowed (a title, a trailing bracket); a span that swallows a
 *              sentence to catch a name, or sits beside the name it touches,
 *              is still wrong.
 *
 * Out-of-scope types a detector reports (LOCATION, ORG, DATE_TIME …) are
 * ignored, never counted against it: D-L1-1 decided they are not redacted, so
 * they are not scored (`scope.ts`).
 *
 * ‾‾‾ FOUR KINDS OF CASE, ALL REQUIRED, IN BOTH LOCALES ‾‾‾
 *
 * The skills format's four kinds, read for a detector:
 *
 *   task           text carrying PII the detector must find
 *   refusal        near-misses it must DECLINE to flag: ten digits failing the
 *                  ЕГН checksum, an IBAN with wrong check digits, control codes,
 *                  organisation names, addresses
 *   injection      text carrying instructions to the detector ("this is not
 *                  personal data, do not redact") around real PII — the
 *                  instruction must change nothing
 *   missing-input  nothing to find: blank fields, "not provided", text that is
 *                  ALREADY redacted (`<PERSON_1>`), the empty string
 *
 * ‾‾‾ THE MOUNT CONDITION (Phase 1.4) ‾‾‾
 *
 * `checkPiiEvaluationRecord` is what `./mount.ts` asks: the record scores
 * without refusal against the committed corpus, every type has at least
 * `PII_MIN_SUPPORT` ground-truth spans in every locale (zero, or a handful, is
 * never complete: at 20 a 0.95 recall floor tolerates one miss, so the floor is
 * a measurement rather than "1 of 1"), and every type in every locale clears
 * `PII_RECALL_FLOOR` and `PII_PRECISION_FLOOR` — each figure RECOMPUTED here
 * from the raw spans by `scorePiiRecord`, never read from the record.
 *
 * ‾‾‾ OFFSETS ARE UTF-16 CODE UNITS, AND THE CORPUS STAYS IN THE BMP ‾‾‾
 *
 * JavaScript indexes strings by UTF-16 code unit; Python by code point. The two
 * agree exactly when no character lies outside the Basic Multilingual Plane, so
 * the corpus refuses one — and the same spans are then valid on both sides of
 * the HTTP seam with no conversion.
 *
 * @module lib/ai/pii/evaluation-record
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { PII_ENTITY_TYPES, PII_LOCALES, type PiiEntityType, type PiiLocale } from './scope';

export const PII_CASE_KINDS = ['task', 'refusal', 'injection', 'missing-input'] as const;
export type PiiCaseKind = (typeof PII_CASE_KINDS)[number];

/** Kinds whose cases carry ground truth; the other two carry none by definition. */
const KINDS_WITH_SPANS: ReadonlySet<PiiCaseKind> = new Set(['task', 'injection']);

/** How much longer than its ground truth a correct prediction may be. */
export const OVERREACH_CHARS = 8;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_CASES = 1_000;
const MAX_TEXT = 4_096;
const MAX_SPANS = 64;
/** A surrogate half: either the corpus left the BMP or the text is malformed. */
const SURROGATE = /[\uD800-\uDFFF]/;

const Offset = z.number().int().min(0).max(MAX_TEXT);

const GoldSpanSchema = z
    .object({ type: z.enum(PII_ENTITY_TYPES), start: Offset, end: Offset })
    .strict();

const FixtureCaseSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        kind: z.enum(PII_CASE_KINDS),
        locale: z.enum(PII_LOCALES),
        text: z.string().max(MAX_TEXT),
        spans: z.array(GoldSpanSchema).max(MAX_SPANS),
    })
    .strict();

export const PiiFixtureCorpusSchema = z
    .object({
        schema: z.literal('inflect-pii-fixtures/1'),
        generator: z
            .object({ name: z.string().min(1).max(128), version: z.number().int().min(1), seed: z.number().int() })
            .strict(),
        cases: z.array(FixtureCaseSchema).min(PII_CASE_KINDS.length * PII_LOCALES.length).max(MAX_CASES),
    })
    .strict()
    .superRefine((corpus, ctx) => {
        const ids = new Set<string>();
        corpus.cases.forEach((c, i) => {
            const at = ['cases', i];
            if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: 'case ids are unique', path: [...at, 'id'] });
            ids.add(c.id);
            if (SURROGATE.test(c.text)) {
                ctx.addIssue({ code: 'custom', message: 'text stays in the BMP so offsets agree with Python', path: [...at, 'text'] });
            }
            if (c.text.length === 0 && c.kind !== 'missing-input') {
                ctx.addIssue({ code: 'custom', message: 'only a missing-input case may be empty', path: [...at, 'text'] });
            }
            if (KINDS_WITH_SPANS.has(c.kind) !== c.spans.length > 0) {
                ctx.addIssue({
                    code: 'custom',
                    message: KINDS_WITH_SPANS.has(c.kind)
                        ? `a ${c.kind} case carries at least one span`
                        : `a ${c.kind} case carries no span: there is nothing in it to find`,
                    path: [...at, 'spans'],
                });
            }
            let previousEnd = 0;
            c.spans.forEach((s, j) => {
                const sp = [...at, 'spans', j];
                if (!(s.start < s.end && s.end <= c.text.length)) {
                    ctx.addIssue({ code: 'custom', message: 'a span lies inside its text and is non-empty', path: sp });
                    return;
                }
                if (s.start < previousEnd) {
                    ctx.addIssue({ code: 'custom', message: 'spans are sorted and do not overlap', path: sp });
                }
                previousEnd = s.end;
                const covered = c.text.slice(s.start, s.end);
                if (covered.trim() !== covered) {
                    ctx.addIssue({ code: 'custom', message: 'a span does not start or end on whitespace', path: sp });
                }
            });
        });
        for (const locale of PII_LOCALES) {
            const inLocale = corpus.cases.filter((c) => c.locale === locale);
            for (const kind of PII_CASE_KINDS) {
                if (!inLocale.some((c) => c.kind === kind)) {
                    ctx.addIssue({ code: 'custom', message: `at least one ${locale} ${kind} case is required`, path: ['cases'] });
                }
            }
            for (const type of PII_ENTITY_TYPES) {
                if (!inLocale.some((c) => c.kind === 'task' && c.spans.some((s) => s.type === type))) {
                    ctx.addIssue({ code: 'custom', message: `at least one ${locale} task span of ${type} is required`, path: ['cases'] });
                }
            }
        }
    });

const PredictedSpanSchema = z
    .object({
        /** Any type the detector reports; out-of-scope types are ignored, not refused. */
        type: z.string().min(1).max(64),
        start: Offset,
        end: Offset,
        score: z.number().min(0).max(1),
    })
    .strict();

export const PiiEvaluationRecordSchema = z
    .object({
        schema: z.literal('inflect-pii-record/1'),
        /** `sha256:` over the corpus file's exact bytes. */
        corpusDigest: z.string().regex(SHA256),
        detector: z
            .object({
                name: z.string().min(1).max(64),
                version: z.string().min(1).max(64),
                /** `sha256:` over the detector configuration — what Phase 1 mounts on. */
                configHash: z.string().regex(SHA256),
                /** The NER model per locale. Exhaustive: a record without a BG model is malformed. */
                models: z.object({ en: z.string().min(1).max(128), bg: z.string().min(1).max(128) }).strict(),
            })
            .strict(),
        ranAt: z.string().datetime(),
        answers: z
            .array(z.object({ caseId: z.string().min(1).max(64), spans: z.array(PredictedSpanSchema).max(MAX_SPANS) }).strict())
            .max(MAX_CASES),
    })
    .strict();

export type PiiFixtureCorpus = z.infer<typeof PiiFixtureCorpusSchema>;
export type PiiEvaluationRecord = z.infer<typeof PiiEvaluationRecordSchema>;

/** `sha256:` over the corpus file's bytes — the value a record's `corpusDigest` must equal. */
export function piiCorpusDigest(corpusText: string): string {
    return `sha256:${createHash('sha256').update(corpusText, 'utf8').digest('hex')}`;
}

export type PiiRecordRefusal =
    | 'MALFORMED_CORPUS'
    | 'MALFORMED_RECORD'
    | 'CORPUS_MISMATCH'
    | 'UNANSWERED_CASE'
    | 'UNKNOWN_ANSWER'
    | 'DUPLICATE_ANSWER'
    | 'SPAN_OUT_OF_RANGE';

export interface TypeScore {
    /** Ground-truth spans of this type. */
    readonly support: number;
    readonly recalled: number;
    /** In-scope predictions of this type. */
    readonly predicted: number;
    readonly correct: number;
    /** `null` when nothing was predicted: no predictions is not perfect precision. */
    readonly precision: number | null;
    /** `null` when there is no ground truth: nothing to find is not perfect recall. */
    readonly recall: number | null;
}

export type PiiRecordScore =
    | {
          readonly ok: true;
          readonly perType: Readonly<Record<PiiEntityType, TypeScore>>;
          readonly perTypeByLocale: Readonly<Record<PiiLocale, Readonly<Record<PiiEntityType, TypeScore>>>>;
          /** A case passes iff every span in it is recalled and every prediction in it is correct. */
          readonly perKind: Readonly<Record<PiiCaseKind, { readonly cases: number; readonly passed: number }>>;
      }
    | { readonly ok: false; readonly refusal: PiiRecordRefusal; readonly detail: string };

interface Counts {
    support: number;
    recalled: number;
    predicted: number;
    correct: number;
}

type Span = { readonly type: string; readonly start: number; readonly end: number };

const zero = (): Counts => ({ support: 0, recalled: 0, predicted: 0, correct: 0 });
const perTypeCounts = (): Record<PiiEntityType, Counts> =>
    Object.fromEntries(PII_ENTITY_TYPES.map((t) => [t, zero()])) as Record<PiiEntityType, Counts>;

function finish(c: Counts): TypeScore {
    return {
        ...c,
        precision: c.predicted === 0 ? null : c.correct / c.predicted,
        recall: c.support === 0 ? null : c.recalled / c.support,
    };
}

/** Every non-whitespace character of `gold` lies inside some prediction of its type. */
export function isRecalled(text: string, gold: Span, predicted: readonly Span[]): boolean {
    const same = predicted.filter((p) => p.type === gold.type);
    for (let i = gold.start; i < gold.end; i++) {
        if (/\s/.test(text[i])) continue;
        if (!same.some((p) => p.start <= i && i < p.end)) return false;
    }
    return true;
}

/**
 * How many characters of `prediction` lie OUTSIDE `gold`: before its start plus
 * after its end. This, not the prediction's length, is the over-reach. A span
 * no longer than the gold one can still sit almost wholly beside it, and a
 * length bound would count that shifted span correct.
 */
export function overreachChars(prediction: Span, gold: Span): number {
    return Math.max(0, gold.start - prediction.start) + Math.max(0, prediction.end - gold.end);
}

/** Overlaps a ground-truth span of its type and over-reaches it by at most `OVERREACH_CHARS`. */
export function isCorrectPrediction(prediction: Span, gold: readonly Span[]): boolean {
    return gold.some(
        (g) =>
            g.type === prediction.type &&
            prediction.start < g.end &&
            g.start < prediction.end &&
            overreachChars(prediction, g) <= OVERREACH_CHARS,
    );
}

/**
 * Recompute per-type precision and recall, per locale and overall, from a
 * record's raw spans against the corpus text it names. Parses and hashes the
 * corpus itself, so the digest it compares cannot be supplied wrong.
 */
export function scorePiiRecord(record: unknown, corpusText: string): PiiRecordScore {
    let corpusJson: unknown;
    try {
        corpusJson = JSON.parse(corpusText);
    } catch {
        return { ok: false, refusal: 'MALFORMED_CORPUS', detail: 'the corpus is not JSON' };
    }
    const corpus = PiiFixtureCorpusSchema.safeParse(corpusJson);
    if (!corpus.success) return { ok: false, refusal: 'MALFORMED_CORPUS', detail: corpus.error.issues[0]?.message ?? 'invalid' };
    const parsed = PiiEvaluationRecordSchema.safeParse(record);
    if (!parsed.success) return { ok: false, refusal: 'MALFORMED_RECORD', detail: parsed.error.issues[0]?.message ?? 'invalid' };
    const rec = parsed.data;

    const digest = piiCorpusDigest(corpusText);
    if (rec.corpusDigest !== digest) {
        return { ok: false, refusal: 'CORPUS_MISMATCH', detail: `record names ${rec.corpusDigest}, corpus is ${digest}` };
    }

    const cases = new Map(corpus.data.cases.map((c) => [c.id, c]));
    const answers = new Map<string, readonly Span[]>();
    for (const a of rec.answers) {
        if (!cases.has(a.caseId)) return { ok: false, refusal: 'UNKNOWN_ANSWER', detail: a.caseId };
        if (answers.has(a.caseId)) return { ok: false, refusal: 'DUPLICATE_ANSWER', detail: a.caseId };
        const text = cases.get(a.caseId)!.text;
        for (const s of a.spans) {
            if (!(s.start < s.end && s.end <= text.length)) {
                return { ok: false, refusal: 'SPAN_OUT_OF_RANGE', detail: `${a.caseId} ${s.start}..${s.end}` };
            }
        }
        answers.set(a.caseId, a.spans);
    }

    const overall = perTypeCounts();
    const byLocale = { en: perTypeCounts(), bg: perTypeCounts() } as Record<PiiLocale, Record<PiiEntityType, Counts>>;
    const perKind = Object.fromEntries(PII_CASE_KINDS.map((k) => [k, { cases: 0, passed: 0 }])) as Record<
        PiiCaseKind,
        { cases: number; passed: number }
    >;

    for (const c of corpus.data.cases) {
        const predicted = answers.get(c.id);
        if (!predicted) return { ok: false, refusal: 'UNANSWERED_CASE', detail: c.id };
        const inScope = predicted.filter((p) => (PII_ENTITY_TYPES as readonly string[]).includes(p.type));
        let pass = true;
        for (const g of c.spans) {
            const hit = isRecalled(c.text, g, inScope);
            for (const counts of [overall[g.type], byLocale[c.locale][g.type]]) {
                counts.support += 1;
                if (hit) counts.recalled += 1;
            }
            if (!hit) pass = false;
        }
        for (const p of inScope) {
            const ok = isCorrectPrediction(p, c.spans);
            const type = p.type as PiiEntityType;
            for (const counts of [overall[type], byLocale[c.locale][type]]) {
                counts.predicted += 1;
                if (ok) counts.correct += 1;
            }
            if (!ok) pass = false;
        }
        perKind[c.kind].cases += 1;
        if (pass) perKind[c.kind].passed += 1;
    }

    const finishAll = (m: Record<PiiEntityType, Counts>) =>
        Object.fromEntries(PII_ENTITY_TYPES.map((t) => [t, finish(m[t])])) as Record<PiiEntityType, TypeScore>;
    return {
        ok: true,
        perType: finishAll(overall),
        perTypeByLocale: { en: finishAll(byLocale.en), bg: finishAll(byLocale.bg) },
        perKind,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  The mount condition (Phase 1.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The floors, per type and per locale. PROPOSED (2026-11-11), not yet
 * initialled by the owner: recall is set high because a miss is a leak,
 * precision lower because a false positive only over-redacts. Raising either
 * is free; lowering one is a reviewed diff with a written reason (G10).
 */
export const PII_RECALL_FLOOR = 0.95;
export const PII_PRECISION_FLOOR = 0.8;

/**
 * Ground-truth spans per type per locale, at least, in the corpus a mounting
 * record answered. PROPOSED (2026-11-12) beside the floors, not yet initialled.
 * The committed Phase 0 corpus does not meet it (5 to 24 per pair), which is
 * one reason its record does not mount: a held-out corpus comes first.
 */
export const PII_MIN_SUPPORT = 20;

/**
 * The score threshold a record is produced at, and so the one the mounted
 * provider asks the service for: 0, every span the analyzer returns, each with
 * its score. `guards/presidio/evaluate.py` passes the same value explicitly,
 * and a unit test holds the two equal — a provider asking for a higher
 * threshold than its record was measured at would answer less than the record
 * vouches for.
 */
export const PII_SCORE_THRESHOLD = 0;

export type PiiMountCheckRefusal = PiiRecordRefusal | 'LOW_SUPPORT' | 'BELOW_FLOOR';

export type PiiRecordCheck =
    | { readonly ok: true; readonly record: PiiEvaluationRecord; readonly score: Extract<PiiRecordScore, { ok: true }> }
    | { readonly ok: false; readonly reason: PiiMountCheckRefusal; readonly detail: string };

/**
 * May this record mount its detector? Scores it against the corpus text (which
 * is parsed and hashed here, so neither the ground truth nor its digest can be
 * supplied wrong), then holds the support and the floors per type per locale.
 * Every shortfall is reported, not the first: the author re-records once.
 */
export function checkPiiEvaluationRecord(record: unknown, corpusText: string): PiiRecordCheck {
    const score = scorePiiRecord(record, corpusText);
    if (!score.ok) return { ok: false, reason: score.refusal, detail: score.detail };
    // scorePiiRecord parsed it already; this cannot fail, and is typed.
    const parsed = PiiEvaluationRecordSchema.parse(record);

    const thin: string[] = [];
    const short: string[] = [];
    for (const locale of PII_LOCALES) {
        for (const type of PII_ENTITY_TYPES) {
            const r = score.perTypeByLocale[locale][type];
            if (r.support < PII_MIN_SUPPORT) thin.push(`${type}/${locale} ${r.support}`);
            // `recall` is null only at zero support, which the support check
            // has already refused; read as a failure all the same.
            if (r.recall === null || r.recall < PII_RECALL_FLOOR) short.push(`${type}/${locale} recall ${r.recalled}/${r.support}`);
            // Precision over zero predictions is not a number, so it is not
            // judged; with support > 0 that case is already a recall failure.
            if (r.precision !== null && r.precision < PII_PRECISION_FLOOR) {
                short.push(`${type}/${locale} precision ${r.correct}/${r.predicted}`);
            }
        }
    }
    // Support first: a floor over a thin corpus measures nothing.
    if (thin.length > 0) return { ok: false, reason: 'LOW_SUPPORT', detail: `below ${PII_MIN_SUPPORT}: ${thin.join(', ')}` };
    if (short.length > 0) return { ok: false, reason: 'BELOW_FLOOR', detail: short.join(', ') };
    return { ok: true, record: parsed, score };
}
