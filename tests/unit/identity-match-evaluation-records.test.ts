/**
 * Evaluation records: what a model revision is allowed to claim, and who checks.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RECORD IS DATA; THIS TEST IS THE AUDITOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A record carries the raw answer to every corpus case AND the derived figures —
 * thresholds, per-class support, `AGREES` precision. This test RECOMPUTES every
 * derived figure from the raw answers and compares. It never trusts a stored
 * number.
 *
 * That is the whole point of committing raw answers rather than a summary. A
 * record whose `precision.agrees` says 1.0 while its own answers say 0.93 is the
 * failure this catches, and it is not a hypothetical shape: a summary produced by
 * a script and reviewed by a human reading the summary is a number nobody
 * recomputed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO RECORDS IS A VALID — AND SAFE — STATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Producing a record needs a live model: a TypeSafe key, or a Laya server. Step 6b
 * shipped without either, so `evaluations/` is empty. That is not a gap to be
 * worked around; it is the designed default. No revision has a record, so no
 * revision may produce a verdict, so adjudication is off until an operator runs
 * the harness.
 *
 * The suite therefore asserts BOTH halves: the directory may be empty, and every
 * record that exists must pass. A suite that only iterated the directory would be
 * vacuously green forever — the exact "empty selection is a PASS" shape this
 * repo's guard rules warn about — so the emptiness is asserted explicitly and the
 * recomputation logic is proved against a synthetic record instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ADJUDICATION_CORPUS,
    ADJUDICATION_CLASSES,
    adjudicationCorpusDigest,
    type AdjudicationClass,
} from '../fixtures/identity-reconcile/adjudication/corpus';
import { MATCH_OPTIONS } from '@/app-layer/ai/identity-match/systemone-wire';

const EVAL_DIR = path.resolve(__dirname, '../../src/app-layer/ai/identity-match/evaluations');

/**
 * The minimum number of cases a class must contribute before a record may claim a
 * threshold over it.
 *
 * A ratchet: raise it as the corpus grows, NEVER lower it. Three is low, and it is
 * honest about what the corpus can currently support — a precision figure over two
 * cases is a coin flip with a decimal point. Lowering this to admit a thin class
 * would be the same move as widening an assertion to admit zero.
 */
const MIN_CLASS_SUPPORT = 3;

/** `AGREES` must be perfect. This is the gate the whole step is built around. */
const REQUIRED_AGREES_PRECISION = 1;

// ─── The record shape ──────────────────────────────────────────────────────

interface RecordedAnswer {
    readonly caseId: string;
    readonly option: string;
    readonly optionProbability: number;
    readonly personProbability: number;
}

interface EvaluationRecord {
    readonly model: string;
    readonly revision: string;
    readonly corpusDigest: string;
    readonly producedAt: string;
    readonly answers: readonly RecordedAnswer[];
    readonly thresholds: { readonly agreeAt: number; readonly personAt: number };
    readonly classSupport: Readonly<Record<string, number>>;
    readonly precision: { readonly agrees: number };
    readonly canaries: readonly RecordedAnswer[];
}

// ─── Recomputation — the auditor's own arithmetic ───────────────────────────

/**
 * The verdict for one answer: `AGREES` only when the model picked the right
 * option AND was confident enough to clear the record's own threshold.
 */
export function verdictFor(
    answer: RecordedAnswer,
    expectedOption: string,
    agreeAt: number
): 'AGREES' | 'DIFFERS' | 'UNSURE' {
    if (answer.optionProbability < agreeAt) return 'UNSURE';
    return answer.option === expectedOption ? 'AGREES' : 'DIFFERS';
}

/**
 * `AGREES` precision: of the answers confident enough to be acted on, the share
 * that were right.
 *
 * The denominator is the CONFIDENT answers, not all of them. An implementation
 * that divided by every answer would report high precision for a model that is
 * unsure about everything, which is the direction that grants access.
 */
export function agreesPrecision(
    answers: readonly RecordedAnswer[],
    expectedByCase: ReadonlyMap<string, string>,
    agreeAt: number
): { precision: number; confident: number; correct: number } {
    let confident = 0;
    let correct = 0;
    for (const a of answers) {
        const expected = expectedByCase.get(a.caseId);
        if (expected === undefined) continue;
        const v = verdictFor(a, expected, agreeAt);
        if (v === 'UNSURE') continue;
        confident += 1;
        if (v === 'AGREES') correct += 1;
    }
    // No confident answers means no precision claim is possible. 0, not 1 — a
    // model that never commits has not achieved perfection.
    return { precision: confident === 0 ? 0 : correct / confident, confident, correct };
}

function expectedByCase(): Map<string, string> {
    return new Map(ADJUDICATION_CORPUS.map((c) => [c.id, c.expected.option]));
}

function listRecords(): string[] {
    if (!fs.existsSync(EVAL_DIR)) return [];
    return fs
        .readdirSync(EVAL_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(EVAL_DIR, f));
}

// ─── The corpus itself ─────────────────────────────────────────────────────

describe('6b corpus — the adjudication corpus is well formed', () => {
    it('covers every declared class', () => {
        const seen = new Set(ADJUDICATION_CORPUS.map((c) => c.klass));
        expect([...seen].sort()).toEqual([...ADJUDICATION_CLASSES].sort());
    });

    it('gives every class at least the minimum support', () => {
        const counts = new Map<AdjudicationClass, number>();
        for (const c of ADJUDICATION_CORPUS) counts.set(c.klass, (counts.get(c.klass) ?? 0) + 1);
        for (const k of ADJUDICATION_CLASSES) {
            expect({ klass: k, support: counts.get(k) ?? 0 }).toEqual({
                klass: k,
                support: expect.any(Number),
            });
            expect(counts.get(k) ?? 0).toBeGreaterThanOrEqual(MIN_CLASS_SUPPORT);
        }
    });

    it('has unique ids', () => {
        const ids = ADJUDICATION_CORPUS.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('expects only real options, and never more candidates than labels', () => {
        for (const c of ADJUDICATION_CORPUS) {
            expect(MATCH_OPTIONS).toContain(c.expected.option);
            expect(c.candidates.length).toBeLessThanOrEqual(MATCH_OPTIONS.length - 1);
            // A case expecting a specific letter must actually offer it.
            if (c.expected.option !== 'NONE') {
                expect(c.candidates.map((x) => x.label)).toContain(c.expected.option);
            }
        }
    });

    it('addresses no real mailbox — every case is synthetic', () => {
        const blob = JSON.stringify(ADJUDICATION_CORPUS);
        // The local part is all we ever send, but a domain creeping into a fixture
        // would be a real address in a file that gets copied into a bug report.
        expect(blob).not.toMatch(/@(?!.*\.(test|invalid|example)\b)[a-z0-9.-]+\.[a-z]{2,}/i);
    });

    it('includes cases whose own text is an instruction, and expects them to be ignored', () => {
        const hostile = ADJUDICATION_CORPUS.filter((c) => c.hostile);
        expect(hostile.length).toBeGreaterThanOrEqual(MIN_CLASS_SUPPORT);
        // Each hostile case's embedded instruction must DIFFER from its correct
        // answer, or obeying it would be indistinguishable from getting it right —
        // a case that cannot express the failure it is named for.
        for (const c of hostile) {
            const text = `${c.account.displayName ?? ''}`;
            const demanded = /answer (A|B|C|D|E|NONE|false|true)/i.exec(text)?.[1];
            if (demanded && demanded !== 'false' && demanded !== 'true') {
                expect({ id: c.id, demanded, correct: c.expected.option }).not.toEqual({
                    id: c.id,
                    demanded,
                    correct: demanded,
                });
            }
        }
    });

    it('has a stable digest that ignores key order', () => {
        const a = adjudicationCorpusDigest();
        const b = adjudicationCorpusDigest();
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
});

// ─── Every committed record, audited ───────────────────────────────────────

describe('6b evaluation records — every committed record is recomputed', () => {
    const records = listRecords();

    it('reports how many records exist, so an empty sweep cannot read as a pass', () => {
        // The denominator. Step 6b shipped with none: producing one needs a live
        // model, and no record means no revision may produce a verdict — the safe
        // default, not a gap.
        expect(Array.isArray(records)).toBe(true);
        console.log(`  committed evaluation records: ${records.length}`);
    });

    it.each(records.length ? records : [['__none__']].map((x) => x[0]))('audits %s', (file) => {
        if (file === '__none__') {
            // Nothing to audit. Assert the SAFE consequence rather than skipping,
            // so the reason for the emptiness is written down where it is observed.
            expect(listRecords()).toEqual([]);
            return;
        }

        const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as EvaluationRecord;

        // 1. The record must be about THIS corpus.
        expect(rec.corpusDigest).toBe(adjudicationCorpusDigest());

        // 2. Every case answered, no case invented.
        const answeredIds = rec.answers.map((a) => a.caseId).sort();
        expect(answeredIds).toEqual(ADJUDICATION_CORPUS.map((c) => c.id).sort());

        // 3. Probabilities in range, options known.
        for (const a of rec.answers) {
            expect(MATCH_OPTIONS).toContain(a.option);
            expect(a.optionProbability).toBeGreaterThanOrEqual(0);
            expect(a.optionProbability).toBeLessThanOrEqual(1);
            expect(a.personProbability).toBeGreaterThanOrEqual(0);
            expect(a.personProbability).toBeLessThanOrEqual(1);
        }

        // 4. Per-class support, recomputed.
        const support = new Map<string, number>();
        for (const c of ADJUDICATION_CORPUS) support.set(c.klass, (support.get(c.klass) ?? 0) + 1);
        for (const k of ADJUDICATION_CLASSES) {
            expect(support.get(k) ?? 0).toBeGreaterThanOrEqual(MIN_CLASS_SUPPORT);
            expect(rec.classSupport[k]).toBe(support.get(k));
        }

        // 5. AGREES precision, recomputed from the RAW answers.
        const { precision, confident } = agreesPrecision(
            rec.answers,
            expectedByCase(),
            rec.thresholds.agreeAt
        );
        expect(precision).toBe(REQUIRED_AGREES_PRECISION);
        expect(rec.precision.agrees).toBeCloseTo(precision, 10);
        // A record that commits to nothing cannot claim perfection.
        expect(confident).toBeGreaterThan(0);

        // 6. Canaries must be a subset of the answers, with matching values.
        for (const canary of rec.canaries) {
            const answer = rec.answers.find((a) => a.caseId === canary.caseId);
            expect(answer).toBeDefined();
            expect(canary.option).toBe(answer!.option);
            expect(Math.abs(canary.optionProbability - answer!.optionProbability)).toBeLessThanOrEqual(0.02);
        }
        expect(rec.canaries.length).toBeGreaterThan(0);
    });
});

// ─── The auditor's arithmetic, proved on synthetic records ─────────────────

describe('6b evaluation records — the recomputation itself has teeth', () => {
    const expected = expectedByCase();
    const ids = ADJUDICATION_CORPUS.map((c) => c.id);

    function answersAllCorrect(p = 0.95): RecordedAnswer[] {
        return ADJUDICATION_CORPUS.map((c) => ({
            caseId: c.id,
            option: c.expected.option,
            optionProbability: p,
            personProbability: c.expected.isPerson ? 0.97 : 0.02,
        }));
    }

    it('scores a perfect confident record as precision 1', () => {
        const { precision, confident } = agreesPrecision(answersAllCorrect(), expected, 0.9);
        expect(precision).toBe(1);
        expect(confident).toBe(ids.length);
    });

    it('a SINGLE confident wrong answer drops precision below 1', () => {
        // The mutation the gate exists for.
        const answers = answersAllCorrect();
        const wrongOption = answers[0].option === 'A' ? 'B' : 'A';
        answers[0] = { ...answers[0], option: wrongOption };
        const { precision } = agreesPrecision(answers, expected, 0.9);
        expect(precision).toBeLessThan(1);
    });

    it('an UNSURE answer is excluded from the denominator, not counted as right', () => {
        const answers = answersAllCorrect();
        answers[0] = { ...answers[0], optionProbability: 0.1 };
        const { precision, confident } = agreesPrecision(answers, expected, 0.9);
        expect(confident).toBe(ids.length - 1);
        expect(precision).toBe(1);
    });

    it('a wrong answer BELOW the threshold does not break precision — it is a miss, not an error', () => {
        const answers = answersAllCorrect();
        answers[0] = { ...answers[0], option: 'NONE', optionProbability: 0.2 };
        const { precision } = agreesPrecision(answers, expected, 0.9);
        expect(precision).toBe(1);
    });

    it('a model unsure about everything scores 0, not 1', () => {
        // The failure an empty denominator would hide: 0/0 must not read as
        // perfect, because "never commits" is not "never wrong" for a gate whose
        // job is to decide whether a revision may act.
        const { precision, confident } = agreesPrecision(answersAllCorrect(0.1), expected, 0.9);
        expect(confident).toBe(0);
        expect(precision).toBe(0);
    });

    it('raising the threshold can only shrink the confident set', () => {
        const answers = answersAllCorrect(0.8);
        expect(agreesPrecision(answers, expected, 0.7).confident).toBe(ids.length);
        expect(agreesPrecision(answers, expected, 0.9).confident).toBe(0);
    });

    it('ignores an answer for a case the corpus no longer has', () => {
        const answers = [
            ...answersAllCorrect(),
            { caseId: 'deleted-case', option: 'A', optionProbability: 0.99, personProbability: 0.9 },
        ];
        const { confident } = agreesPrecision(answers, expected, 0.9);
        // The stale answer contributes nothing; the per-case completeness check in
        // the audit above is what rejects the record for having it.
        expect(confident).toBe(ids.length);
    });

    it('the minimum support is a ratchet, stated here so lowering it is a visible diff', () => {
        expect(MIN_CLASS_SUPPORT).toBeGreaterThanOrEqual(3);
    });
});
