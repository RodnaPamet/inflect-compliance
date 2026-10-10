/**
 * What a model revision is allowed to claim, and where that claim lives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO RECORDS IS THE SAFE DEFAULT, NOT A GAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A revision without a committed record produces NO verdicts — every account
 * gets the non-verdict reason `NO_EVALUATION` and its queue row is identical to
 * the one it would have with adjudication off. Step 6b shipped with zero
 * records, because producing one needs a live model, and that is the designed
 * state rather than something to work around: changing a model is a reviewed
 * pull request, not a config change.
 *
 * So `findEvaluationRecord` returning null is an ordinary answer. Nothing may
 * treat it as an error, and nothing may fall back to default thresholds — a
 * default threshold is exactly the thing a record exists to prevent somebody
 * inventing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR THRESHOLDS, AND WHY THEY LIVE PER-REVISION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The design document's verdict table needs four: accept, person, non-person,
 * and a margin over the runner-up. Step 6b's record carried the first two; the
 * other two are added here, with no migration cost because no record exists
 * yet. Owner decision, 2026-10-10.
 *
 * They are per-revision rather than global constants because the thing they
 * bound is CALIBRATION, which is a property of a revision. In particular:
 *
 *   - `nonPersonAt` is NOT assumed to be `1 - personAt`. A model can be
 *     well-calibrated about "this is a person" and badly calibrated about the
 *     negation, and deriving one from the other hard-codes that it cannot be.
 *   - `agreeMargin` is per-revision because a revision that needs a wider gap
 *     to reach 100 % `AGREES` precision must be able to say so. CI recomputes
 *     that precision from the record's own raw answers against its own declared
 *     thresholds, so a revision cannot buy precision by declaring a threshold it
 *     does not meet.
 *
 * @module app-layer/ai/identity-match/evaluation-record
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One raw model answer from the synthetic adjudication corpus. */
export interface RecordedAnswer {
    readonly caseId: string;
    readonly option: string;
    readonly optionProbability: number;
    readonly personProbability: number;
}

/**
 * The thresholds a revision declares.
 *
 * All four are REQUIRED. An optional threshold would be a threshold with a
 * default, and a default threshold is the thing this record exists to stop.
 */
export interface EvaluationThresholds {
    /** P(option) at or above which an answer may be acted on. */
    readonly agreeAt: number;
    /** P(person) at or above which the subject is treated as a person. */
    readonly personAt: number;
    /** P(person) at or BELOW which the subject is treated as a non-person. */
    readonly nonPersonAt: number;
    /** The gap the top option needs over the runner-up before `AGREES`. */
    readonly agreeMargin: number;
}

export interface EvaluationRecord {
    readonly model: string;
    readonly revision: string;
    readonly corpusDigest: string;
    readonly producedAt: string;
    readonly answers: readonly RecordedAnswer[];
    readonly thresholds: EvaluationThresholds;
    readonly classSupport: Readonly<Record<string, number>>;
    readonly precision: { readonly agrees: number };
    readonly canaries: readonly RecordedAnswer[];
}

/**
 * Where committed records live. One JSON file per revision.
 *
 * A directory rather than a database table, deliberately: a record is reviewed
 * in a pull request, and CI recomputes it. A row somebody could INSERT would
 * make "changing a model is a reviewed change" untrue.
 */
export const EVALUATION_DIR = path.resolve(__dirname, 'evaluations');

/** Every committed record file, or an empty list when the directory is absent. */
export function listEvaluationRecordFiles(): readonly string[] {
    if (!fs.existsSync(EVALUATION_DIR)) return [];
    return fs
        .readdirSync(EVALUATION_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(EVALUATION_DIR, f));
}

/**
 * The record for exactly this revision, or null.
 *
 * EXACTLY. Not the newest, not the closest, not the one for the same model
 * family — the endpoint reports a revision and only that revision's record may
 * authorise a verdict. A near-match would be the vendor-update failure the
 * canary exists to catch, waved through at the step before the canary runs.
 */
export function findEvaluationRecord(
    model: string,
    revision: string
): EvaluationRecord | null {
    for (const file of listEvaluationRecordFiles()) {
        try {
            const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as EvaluationRecord;
            if (rec.model === model && rec.revision === revision) return rec;
        } catch {
            // A malformed record is NOT a reason to fall through to another
            // one, but it is also not this function's job to adjudicate: the
            // 6b audit test recomputes every committed record and fails CI on a
            // bad one. Skipping here means a broken file produces
            // NO_EVALUATION — the safe outcome — rather than an exception in a
            // background job.
            continue;
        }
    }
    return null;
}

/**
 * Does this record declare all four thresholds, as numbers in [0, 1]?
 *
 * Checked at READ time as well as in the audit test, because the two answer
 * different questions: the audit test asks "is every committed record sound",
 * and this asks "may I act on the one I just read". A record committed before
 * the shape gained its third and fourth threshold would pass the first question
 * historically and must still fail the second.
 */
export function thresholdsAreComplete(rec: EvaluationRecord): boolean {
    const t = rec.thresholds as Partial<EvaluationThresholds> | undefined;
    if (!t) return false;
    for (const k of ['agreeAt', 'personAt', 'nonPersonAt', 'agreeMargin'] as const) {
        const v = t[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return false;
    }
    // A non-person threshold at or above the person threshold makes the two
    // verdict rows overlap, and the table's first-match-wins order would then
    // silently decide every ambiguous subject as NOT_A_PERSON.
    return (t.nonPersonAt as number) < (t.personAt as number);
}
