/**
 * THE AUDITOR'S NARRATIVE OF A PERIOD'S WORKPAPERS, AS A CONTRACT (#3749).
 *
 * An `audit-narrative` run is taught `iam-audit-procedures` and answers with
 * one JSON block: per workpaper of the period, the conclusion it records, the
 * exception codes the narrative discusses, and the narrative itself, a few
 * sentences a reviewer reads beside the workpaper. This module is the only way
 * that answer becomes something storable.
 *
 * Two halves, both pure:
 *
 *   1. `readNarrativeFromAnswer` — the answer text to a parsed block, through
 *      the strict schema, or a named refusal. The same reading rules as the
 *      review run's attribution (`answerCandidates`): fenced blocks or a bare
 *      object, prose skipped, two different claims ambiguous.
 *   2. `checkNarrativesAgainstRecord` — the parsed block against the stored
 *      workpapers of the period the run was asked about. A narrative states
 *      NOTHING the workpaper does not record:
 *        • its conclusion must be the workpaper's, and its text may name no
 *          other conclusion word;
 *        • every exception code it lists must be one the workpaper records,
 *          and a workpaper with exceptions must have at least one named;
 *        • every code-shaped token in its text must be a code the workpaper
 *          records — an exception's, a unit outcome's, or its conclusion basis;
 *        • its text names no e-mail address (the skill cites unit ids).
 *      One narrative that fails refuses the whole answer: a model that misstated
 *      one workpaper is not trusted for the others.
 *
 * What the checks cannot do is read prose for meaning. A narrative can still
 * describe a sample badly in words; what it cannot do is carry a conclusion or
 * a code the record does not, which is the part a reviewer would take on trust.
 */
import { z } from 'zod';

import { CODE, PERIOD_LABEL, UNIT_ID } from './audit-workpaper';
import { answerCandidates, MAX_ANSWER_CHARS, MAX_CANDIDATES } from './review-attribution';

/** The skill whose answer this is; a run that did not mount it has none. */
export const NARRATIVE_SKILL = 'iam-audit-procedures';

/** The longest narrative stored for one workpaper. */
export const MAX_NARRATIVE_CHARS = 400;

/**
 * The most narratives one answer carries. Bounded by what the decision log
 * keeps of an agentic run's answer (4000 characters): six narratives at the
 * text bound, with their keys, fit under it, and a seventh would not.
 */
export const MAX_NARRATIVES_PER_ANSWER = 6;

/** The most exception codes one narrative lists. */
export const MAX_CODES_PER_NARRATIVE = 20;

export const NARRATIVE_CONCLUSIONS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
export type NarrativeConclusion = (typeof NARRATIVE_CONCLUSIONS)[number];

const NarrativeSchema = z
    .object({
        workpaperId: z.string().regex(UNIT_ID),
        conclusion: z.enum(NARRATIVE_CONCLUSIONS),
        exceptionCodes: z.array(z.string().regex(CODE)).max(MAX_CODES_PER_NARRATIVE),
        text: z.string().trim().min(1).max(MAX_NARRATIVE_CHARS),
    })
    .strict();

export const AuditNarrativeAnswerSchema = z
    .object({
        periodLabel: z.string().regex(PERIOD_LABEL),
        narratives: z.array(NarrativeSchema).min(1).max(MAX_NARRATIVES_PER_ANSWER),
    })
    .strict();

export type AuditNarrativeAnswer = z.infer<typeof AuditNarrativeAnswerSchema>;
export type WorkpaperNarrative = AuditNarrativeAnswer['narratives'][number];

export type NarrativeAnswerRefusal =
    /** The text offers no narrative block at all. */
    | 'NO_NARRATIVE_IN_ANSWER'
    /** A block claimed to be the narrative and does not satisfy the schema. */
    | 'ANSWER_INVALID'
    /** More than one narrative block, and they disagree — or more blocks than are read. */
    | 'ANSWER_AMBIGUOUS'
    /** Longer than any answer the decision log can hold. */
    | 'ANSWER_TOO_LONG';

export type NarrativeAnswerReading =
    | { readonly ok: true; readonly answer: AuditNarrativeAnswer }
    | { readonly ok: false; readonly reason: NarrativeAnswerRefusal; readonly issues: readonly string[] };

/** A value that presents itself as the narrative block: an object with `narratives`. */
function claimsNarrative(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.prototype.hasOwnProperty.call(value, 'narratives');
}

/**
 * Read the narrative block a run's answer gives, or say why there is none.
 * Schema issues are reported by path and code only — never with the value,
 * which is the model's text.
 */
export function readNarrativeFromAnswer(text: string): NarrativeAnswerReading {
    if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: 'ANSWER_TOO_LONG', issues: [] };
    const values = answerCandidates(text);
    if (values === null) {
        return { ok: false, reason: 'ANSWER_AMBIGUOUS', issues: [`more than ${MAX_CANDIDATES} blocks`] };
    }
    const claims = values.filter(claimsNarrative);
    if (claims.length === 0) return { ok: false, reason: 'NO_NARRATIVE_IN_ANSWER', issues: [] };

    const parsed: AuditNarrativeAnswer[] = [];
    for (const claim of claims) {
        const result = AuditNarrativeAnswerSchema.safeParse(claim);
        if (!result.success) {
            return {
                ok: false,
                reason: 'ANSWER_INVALID',
                issues: result.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
            };
        }
        parsed.push(result.data);
    }
    const first = JSON.stringify(parsed[0]);
    if (parsed.some((p) => JSON.stringify(p) !== first)) {
        return { ok: false, reason: 'ANSWER_AMBIGUOUS', issues: [`${parsed.length} different narrative blocks`] };
    }
    return { ok: true, answer: parsed[0] };
}

/** What the record says about one workpaper, read from the database at capture. */
export interface WorkpaperRecordFacts {
    readonly id: string;
    readonly periodLabel: string;
    readonly conclusion: NarrativeConclusion;
    readonly conclusionBasis: string;
    /**
     * The codes its exceptions carry, from the stored per-unit record.
     * `null` when that record no longer re-validates: then nothing about its
     * exceptions can be checked, and a narrative of it is refused.
     */
    readonly exceptionCodes: readonly string[] | null;
    /**
     * The codes the per-unit outcomes carry, which include an untestable
     * unit's (`DISABLE_TIME_UNKNOWN`) that no exception does. `null` as above.
     */
    readonly outcomeCodes: readonly string[] | null;
}

export type NarrativeRecordRefusal =
    /** The block is about a different period from the one the run was asked about. */
    | 'PERIOD_MISMATCH'
    /** One workpaper narrated twice. */
    | 'DUPLICATE_WORKPAPER'
    /** A workpaper id that is not one of this tenant's workpapers for the period. */
    | 'UNKNOWN_WORKPAPER'
    /** The stored per-unit record no longer re-validates, so nothing can be checked. */
    | 'WORKPAPER_UNREADABLE'
    /** The conclusion stated is not the one the workpaper records. */
    | 'CONCLUSION_MISMATCH'
    /** The text names a conclusion word other than the one the workpaper records. */
    | 'TEXT_STATES_ANOTHER_CONCLUSION'
    /** An exception code listed that the workpaper does not record. */
    | 'UNRECORDED_EXCEPTION_CODE'
    /** The workpaper records exceptions and the narrative names none of them. */
    | 'EXCEPTIONS_UNNAMED'
    /** A code-shaped token in the text that the workpaper does not record. */
    | 'TEXT_CITES_UNRECORDED_CODE'
    /** The text carries an e-mail address. */
    | 'TEXT_NAMES_AN_ADDRESS';

export type NarrativeRecordCheck =
    | { readonly ok: true; readonly narratives: readonly WorkpaperNarrative[] }
    | { readonly ok: false; readonly reason: NarrativeRecordRefusal; readonly workpaperId: string | null };

/** Whole uppercase words, so "passed" in prose is not a conclusion. */
const CONCLUSION_WORD = /\b(PASS|PASSED|FAIL|FAILED|INCONCLUSIVE)\b/g;
const WORD_TO_CONCLUSION: Readonly<Record<string, NarrativeConclusion>> = {
    PASS: 'PASS',
    PASSED: 'PASS',
    FAIL: 'FAIL',
    FAILED: 'FAIL',
    INCONCLUSIVE: 'INCONCLUSIVE',
};
/** A code-shaped token: uppercase, with at least one underscore (`LEAVER_DISABLED_LATE`). */
const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** An address: something@host.tld. The text is at most 400 characters. */
const ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Hold each narrative of a parsed answer to the stored record of the period.
 * `records` are this tenant's workpapers for `periodLabel`, as the capture
 * read them; nothing in the answer is taken for a fact about them.
 */
export function checkNarrativesAgainstRecord(
    answer: AuditNarrativeAnswer,
    periodLabel: string,
    records: readonly WorkpaperRecordFacts[],
): NarrativeRecordCheck {
    const refuse = (reason: NarrativeRecordRefusal, workpaperId: string | null = null): NarrativeRecordCheck => ({
        ok: false,
        reason,
        workpaperId,
    });
    if (answer.periodLabel !== periodLabel) return refuse('PERIOD_MISMATCH');

    const byId = new Map(records.filter((r) => r.periodLabel === periodLabel).map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (const n of answer.narratives) {
        if (seen.has(n.workpaperId)) return refuse('DUPLICATE_WORKPAPER', n.workpaperId);
        seen.add(n.workpaperId);

        const record = byId.get(n.workpaperId);
        if (!record) return refuse('UNKNOWN_WORKPAPER', n.workpaperId);
        if (record.exceptionCodes === null || record.outcomeCodes === null) {
            return refuse('WORKPAPER_UNREADABLE', n.workpaperId);
        }

        if (n.conclusion !== record.conclusion) return refuse('CONCLUSION_MISMATCH', n.workpaperId);
        for (const m of n.text.matchAll(CONCLUSION_WORD)) {
            if (WORD_TO_CONCLUSION[m[1]] !== record.conclusion) {
                return refuse('TEXT_STATES_ANOTHER_CONCLUSION', n.workpaperId);
            }
        }

        const recorded = new Set(record.exceptionCodes);
        if (n.exceptionCodes.some((c) => !recorded.has(c))) return refuse('UNRECORDED_EXCEPTION_CODE', n.workpaperId);
        if (recorded.size > 0 && n.exceptionCodes.length === 0) return refuse('EXCEPTIONS_UNNAMED', n.workpaperId);

        const citable = new Set([...recorded, ...record.outcomeCodes, record.conclusionBasis]);
        for (const m of n.text.matchAll(CODE_TOKEN)) {
            if (!citable.has(m[0])) return refuse('TEXT_CITES_UNRECORDED_CODE', n.workpaperId);
        }

        if (ADDRESS.test(n.text)) return refuse('TEXT_NAMES_AN_ADDRESS', n.workpaperId);
    }
    return { ok: true, narratives: answer.narratives };
}
