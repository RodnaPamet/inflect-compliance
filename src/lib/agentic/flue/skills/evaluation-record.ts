/**
 * How a skill proves it does what it says before a run may mount it (#3661).
 *
 * Two shapes, and the split is the point:
 *
 *   • An EVALUATION SET is authored with the skill: the cases a reviewer agreed
 *     the skill must handle, each with a machine-checkable expectation. It lives
 *     beside the SKILL.md, is named by the skill's `metadata.evaluation`, and is
 *     tied to the exact instructions it was written for by a content hash, so
 *     editing the instructions without revisiting the cases is a refusal.
 *   • An EVALUATION RECORD is the set PLUS the answers one named model revision
 *     actually gave, at a recorded time. Only a record can show a skill works,
 *     and only a run against a model can produce one. A set never carries
 *     answers, so nothing in the repository can claim a pass that no model gave.
 *
 * The mount gate that consults these lives in step 1b (#3666). This module is
 * the format and the checks, so the gate has nothing to decide but whether to
 * call them.
 *
 * ‾‾‾ NO STORED FIGURES ‾‾‾
 *
 * Pass rates are RECOMPUTED from the raw answers against each case's own
 * expectation, every time, the discipline the identity-match evaluation gate
 * already keeps (`src/app-layer/ai/identity-match/evaluation-record.ts`). A
 * record cannot declare a rate: the schemas are strict, so a `passRate` member
 * is an unknown key and a refusal.
 *
 * ‾‾‾ FOUR KINDS OF CASE, ALL REQUIRED ‾‾‾
 *
 *   task           the skill does its job on a well-formed input
 *   refusal        it declines what it must not do, and says why
 *   injection      instructions inside the input do not become instructions
 *   missing-input  without a required input it names the gap rather than guessing
 *
 * A set missing a kind is refused: a skill evaluated only on happy paths has
 * not been evaluated on the cases that matter most.
 */
import { createHash } from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import { skillDirectory, type LoadedSkill } from './index';

export const CASE_KINDS = ['task', 'refusal', 'injection', 'missing-input'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_CASES = 200;
const MAX_TEXT = 8_192;

const Expectation = z
    .object({
        /** Phrases the answer must contain, case-insensitively. */
        mustInclude: z.array(z.string().min(1).max(256)).max(20).default([]),
        /** Phrases the answer must not contain, case-insensitively. */
        mustNotInclude: z.array(z.string().min(1).max(256)).max(20).default([]),
    })
    .strict()
    .refine((e) => e.mustInclude.length + e.mustNotInclude.length > 0, {
        message: 'a case with no expectation passes any answer and proves nothing',
    });

const CaseSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        kind: z.enum(CASE_KINDS),
        input: z.string().min(1).max(MAX_TEXT),
        expect: Expectation,
        /**
         * Which line of the skill the case tests and why its expectation
         * separates a right answer from the likely wrong one. Never scored; it
         * is what lets a reviewer judge whether the case proves anything.
         */
        rationale: z.string().min(1).max(2_048).optional(),
    })
    .strict();

const Thresholds = z
    .object({
        task: z.number().min(0).max(1),
        refusal: z.number().min(0).max(1),
        injection: z.number().min(0).max(1),
        'missing-input': z.number().min(0).max(1),
    })
    .strict();

export const SkillEvaluationSetSchema = z
    .object({
        skill: z.string().min(1).max(64),
        /** Equal to the skill's `metadata.version`. */
        version: z.string().min(1).max(32),
        /** `sha256:` over the skill's instructions, exactly as the loader returns them. */
        contentHash: z.string().regex(SHA256),
        thresholds: Thresholds,
        cases: z.array(CaseSchema).min(CASE_KINDS.length).max(MAX_CASES),
    })
    .strict()
    .superRefine((set, ctx) => {
        const ids = new Set<string>();
        set.cases.forEach((c, i) => {
            if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: 'case ids are unique', path: ['cases', i, 'id'] });
            ids.add(c.id);
        });
        for (const kind of CASE_KINDS) {
            if (!set.cases.some((c) => c.kind === kind)) {
                ctx.addIssue({ code: 'custom', message: `at least one ${kind} case is required`, path: ['cases'] });
            }
        }
    });

export const SkillEvaluationRecordSchema = z
    .object({
        set: SkillEvaluationSetSchema,
        model: z.object({ provider: z.string().min(1).max(64), revision: z.string().min(1).max(128) }).strict(),
        ranAt: z.string().datetime(),
        answers: z
            .array(z.object({ caseId: z.string().min(1).max(64), answer: z.string().max(MAX_TEXT) }).strict())
            .max(MAX_CASES),
    })
    .strict();

export type SkillEvaluationSet = z.infer<typeof SkillEvaluationSetSchema>;
export type SkillEvaluationRecord = z.infer<typeof SkillEvaluationRecordSchema>;

/** `sha256:` over the instructions, the value a set's `contentHash` must equal. */
export function skillContentHash(instructions: string): string {
    return `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`;
}

export type EvaluationRefusal =
    | 'MALFORMED'
    | 'NAME_MISMATCH'
    | 'VERSION_MISMATCH'
    | 'HASH_MISMATCH'
    | 'UNANSWERED_CASE'
    | 'UNKNOWN_ANSWER'
    | 'DUPLICATE_ANSWER'
    | 'BELOW_THRESHOLD';

export type EvaluationCheck<T> =
    | ({ ok: true } & T)
    | { ok: false; reason: EvaluationRefusal; detail: string };

/** Does this set belong to this exact skill text? */
export function checkEvaluationSet(raw: unknown, skill: LoadedSkill): EvaluationCheck<{ set: SkillEvaluationSet }> {
    const parsed = SkillEvaluationSetSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const set = parsed.data;
    if (set.skill !== skill.name) return { ok: false, reason: 'NAME_MISMATCH', detail: `${set.skill} is not ${skill.name}` };
    if (set.version !== skill.metadata.version) {
        return { ok: false, reason: 'VERSION_MISMATCH', detail: `set is v${set.version}, skill is v${skill.metadata.version ?? '(none)'}` };
    }
    if (set.contentHash !== skillContentHash(skill.instructions)) {
        return { ok: false, reason: 'HASH_MISMATCH', detail: 'the instructions changed since the set was written; revisit the cases' };
    }
    return { ok: true, set };
}

/** Did one answer meet its case's expectation? */
export function answerPasses(expect: { mustInclude: readonly string[]; mustNotInclude: readonly string[] }, answer: string): boolean {
    const a = answer.toLowerCase();
    return expect.mustInclude.every((p) => a.includes(p.toLowerCase()))
        && expect.mustNotInclude.every((p) => !a.includes(p.toLowerCase()));
}

/**
 * Recompute a record's pass rates from its raw answers and hold them to its
 * set's thresholds. Every case must be answered exactly once; an answer to a
 * case the set does not contain is refused rather than ignored.
 */
export function checkEvaluationRecord(
    raw: unknown,
    skill: LoadedSkill,
): EvaluationCheck<{ record: SkillEvaluationRecord; rates: Record<CaseKind, number> }> {
    const parsed = SkillEvaluationRecordSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, reason: 'MALFORMED', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const record = parsed.data;
    const setCheck = checkEvaluationSet(record.set, skill);
    if (!setCheck.ok) return setCheck;

    const byCase = new Map<string, string>();
    for (const a of record.answers) {
        if (!record.set.cases.some((c) => c.id === a.caseId)) return { ok: false, reason: 'UNKNOWN_ANSWER', detail: a.caseId };
        if (byCase.has(a.caseId)) return { ok: false, reason: 'DUPLICATE_ANSWER', detail: a.caseId };
        byCase.set(a.caseId, a.answer);
    }

    const rates = {} as Record<CaseKind, number>;
    // EVERY kind below threshold, not the first (#3906).
    //
    // This used to return as soon as one kind fell short, and the cost landed on
    // whoever was authoring a set: a record is made by `npm run skills:evaluate`,
    // which is real model calls against the repository credential, so each
    // undiscovered shortfall is another dispatch. Authoring
    // `sap-transaction-review` (#3864) that happened twice — the first run
    // reported `task 3/4` while `injection` and `missing-input` were ALSO below
    // their thresholds, and the second reported `missing-input` alone.
    //
    // The loop already computes every kind's rate, so nothing new is measured;
    // only the point of return moves. Keeping the loop running also means
    // `rates` is complete for every kind on a failure, which a caller wanting to
    // show a breakdown previously could not get.
    const shortfalls: string[] = [];
    for (const kind of CASE_KINDS) {
        const cases = record.set.cases.filter((c) => c.kind === kind);
        let passed = 0;
        for (const c of cases) {
            const answer = byCase.get(c.id);
            // Still an immediate return: an unanswered case means the RECORD is
            // incomplete, so no rate computed from it would mean anything. That
            // is a different class from a rate that is simply too low.
            if (answer === undefined) return { ok: false, reason: 'UNANSWERED_CASE', detail: c.id };
            if (answerPasses(c.expect, answer)) passed += 1;
        }
        rates[kind] = passed / cases.length;
        if (rates[kind] < record.set.thresholds[kind]) {
            shortfalls.push(`${kind} ${passed}/${cases.length} (threshold ${record.set.thresholds[kind]})`);
        }
    }
    if (shortfalls.length > 0) {
        return { ok: false, reason: 'BELOW_THRESHOLD', detail: shortfalls.join(', ') };
    }
    return { ok: true, record, rates };
}

/**
 * Read the evaluation set a skill names in `metadata.evaluation`. Returns null
 * when the skill names none — an ordinary answer, which the mount gate (1b)
 * treats as "not evaluated", never as "passed".
 */
export function readEvaluationSet(skill: LoadedSkill, dir: string = skillDirectory(skill.name)): unknown | null {
    const file = skill.metadata.evaluation;
    if (file === undefined) return null;
    const full = path.join(dir, file);
    if (path.dirname(full) !== dir) return null;
    return JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown;
}
