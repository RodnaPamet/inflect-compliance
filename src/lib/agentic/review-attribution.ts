/**
 * THE REVIEW RUN'S OWNER SUGGESTION, FROM ANSWER TO STORED ROW AND BACK (#3728,
 * a follow-up of #3712 under the agentic IAM roadmap).
 *
 * A `discovered-agent-review` run on the Flue engine is taught
 * `nhi-ownership-attribution`, and its answer lands in exactly one column: the
 * run's Art 12 decision row, `AiDecisionLog.outputSummary`, sanitised and
 * bounded by `logAiDecision` (`tests/guards/flue-model-output-has-one-destination.test.ts`).
 * This module is the pure half of turning that text into the suggestion the
 * harness tab's Register dialog shows, and of reading the stored row back.
 *
 * ── MODEL OUTPUT IS UNTRUSTED INPUT ─────────────────────────────────────────
 *
 *   • BOUNDED. The text is refused above `MAX_ANSWER_CHARS`, and at most
 *     `MAX_CANDIDATES` JSON blocks are read from it; more is an answer this
 *     module will not choose from.
 *   • SCHEMA-VALIDATED. Every candidate that claims to be an attribution parses
 *     through the skill's own output contract (`parseOwnershipAttribution`):
 *     closed statuses with no `LINKED`, ids and evidence pointers bounded, a
 *     pointer that looks like a secret refused, and the grade and outcome
 *     re-derived from the answer's own signals.
 *   • NEVER CHOSEN BETWEEN. One claim, or several identical ones, is the
 *     answer. A claim that does not parse refuses the whole answer, and two
 *     claims that disagree are ambiguous: picking the one that happens to parse
 *     would let a model hedge and have the hedge recorded as its view.
 *   • PERSON-FREE ON THE WAY OUT. The stored signals keep the kind, the
 *     evidence pointer and whether a person was named — never whom. The one
 *     person reference a SUGGESTED answer carries is stored apart from them
 *     (`proposedOwnerRef`, encrypted) and never reaches a view built here.
 *
 * PURE: no clock, no I/O.
 */
import { z } from 'zod';

import { MAX_EVIDENCE_CHARS } from './harness-contract';
import {
    ATTRIBUTION_STATUSES,
    OWNER_SIGNAL_KINDS,
    parseOwnershipAttribution,
    type OwnershipAttribution,
} from './iam-skill-outputs';
import type { ShadowSuggestion } from './harness-read-model';
import { toSignalProvenance, type IntakeSignalProvenance } from './registration-intake';

/** The skill whose answer this is; a run that did not mount it has none. */
export const ATTRIBUTION_SKILL = 'nhi-ownership-attribution';

/**
 * The longest answer text read. The Art 12 summary is already cut at the
 * agentic bound (4000, `decision-log`), and the guard on that bound holds it at
 * or under 8000 — so this is a backstop that a widened log cannot slide past.
 */
export const MAX_ANSWER_CHARS = 8000;

/** The most JSON blocks read from one answer. */
export const MAX_CANDIDATES = 8;

/** The most signals one stored suggestion holds — the contract's own bound. */
export const MAX_STORED_SIGNALS = 50;

export type AnswerRefusal =
    /** The text names no attribution at all — prose, or only the assessment. */
    | 'NO_ATTRIBUTION_IN_ANSWER'
    /** An attribution was claimed and does not satisfy the output contract. */
    | 'ANSWER_INVALID'
    /** More than one attribution, and they disagree — or more blocks than are read. */
    | 'ANSWER_AMBIGUOUS'
    /** Longer than any answer the decision log can hold. */
    | 'ANSWER_TOO_LONG';

export type AnswerReading =
    | { readonly ok: true; readonly attribution: OwnershipAttribution }
    | { readonly ok: false; readonly reason: AnswerRefusal; readonly issues: readonly string[] };

const FENCE = '```';

/**
 * The JSON values an answer offers, in order: each fenced block whose info
 * string is empty or `json`, and the whole text when it is itself one object.
 * `null` when there are more blocks than `MAX_CANDIDATES` — an answer that
 * long is not one this reader chooses from.
 *
 * A linear scan with `indexOf`, not a regular expression: the text is the
 * model's, and a backtracking pattern over it is a cost the model would set.
 */
export function answerCandidates(text: string): unknown[] | null {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
        const open = text.indexOf(FENCE, from);
        if (open < 0) break;
        const lineEnd = text.indexOf('\n', open + FENCE.length);
        if (lineEnd < 0) break;
        const close = text.indexOf(FENCE, lineEnd + 1);
        if (close < 0) break;
        const info = text.slice(open + FENCE.length, lineEnd).trim().toLowerCase();
        if (info === '' || info === 'json') {
            blocks.push(text.slice(lineEnd + 1, close));
            if (blocks.length > MAX_CANDIDATES) return null;
        }
        from = close + FENCE.length;
    }
    const whole = text.trim();
    if (blocks.length === 0 && whole.startsWith('{') && whole.endsWith('}')) blocks.push(whole);

    const values: unknown[] = [];
    for (const block of blocks) {
        try {
            values.push(JSON.parse(block));
        } catch {
            // Not JSON: prose in a fence, or a block cut by the summary bound.
            // It claims nothing, so it is skipped rather than refused — a cut
            // attribution is caught below only if it still parses, and one
            // that does not parse was never offered as an answer.
        }
    }
    return values;
}

/**
 * Does this value present itself as an ownership attribution? An object with a
 * `status`, and not the assessment (which carries `verdicts`). The test is
 * deliberately loose: anything that LOOKS like an attribution must then pass
 * the contract, so a near-miss is refused rather than ignored.
 */
function claimsAttribution(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.prototype.hasOwnProperty.call(value, 'status') && !Object.prototype.hasOwnProperty.call(value, 'verdicts');
}

/** Read the attribution a review answer gives, or say why there is none to record. */
export function readAttributionFromAnswer(text: string): AnswerReading {
    if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: 'ANSWER_TOO_LONG', issues: [] };
    const values = answerCandidates(text);
    if (values === null) {
        return { ok: false, reason: 'ANSWER_AMBIGUOUS', issues: [`more than ${MAX_CANDIDATES} blocks`] };
    }
    const claims = values.filter(claimsAttribution);
    if (claims.length === 0) return { ok: false, reason: 'NO_ATTRIBUTION_IN_ANSWER', issues: [] };

    const parsed: OwnershipAttribution[] = [];
    for (const claim of claims) {
        const verdict = parseOwnershipAttribution(claim);
        if (!verdict.ok) return { ok: false, reason: 'ANSWER_INVALID', issues: verdict.issues.slice(0, 20) };
        parsed.push(verdict.value);
    }
    // Identical repeats are one answer; anything else is a choice this module
    // will not make for the model.
    const first = JSON.stringify(parsed[0]);
    if (parsed.some((p) => JSON.stringify(p) !== first)) {
        return { ok: false, reason: 'ANSWER_AMBIGUOUS', issues: [`${parsed.length} different attributions`] };
    }
    return { ok: true, attribution: parsed[0] };
}

/** What a parsed attribution stores: everything but the person, and the person apart. */
export interface StoredAttributionFields {
    readonly status: OwnershipAttribution['status'];
    readonly grade: 'STRONG' | 'WEAK' | null;
    readonly unmatchedReason: 'NO_OWNER_SIGNAL' | 'OWNER_DEPARTED' | null;
    readonly signals: readonly IntakeSignalProvenance[];
    /** The person a SUGGESTED answer named. Server-side only. */
    readonly proposedOwnerRef: string | null;
}

export function storedAttributionFields(a: OwnershipAttribution): StoredAttributionFields {
    const signals = toSignalProvenance(a.signals);
    if (a.status === 'SUGGESTED') {
        return { status: 'SUGGESTED', grade: a.grade, unmatchedReason: null, signals, proposedOwnerRef: a.proposedOwnerRef };
    }
    return {
        status: a.status,
        grade: null,
        unmatchedReason: a.status === 'UNMATCHED' ? a.reason : null,
        signals,
        proposedOwnerRef: null,
    };
}

const StoredSignalsSchema = z
    .array(
        z
            .object({
                kind: z.enum(OWNER_SIGNAL_KINDS),
                evidence: z.string().min(1).max(MAX_EVIDENCE_CHARS),
                namesPerson: z.boolean(),
            })
            .strict(),
    )
    .max(MAX_STORED_SIGNALS);

/** The stored signals, re-validated; `null` when they do not. */
export function parseStoredSignals(raw: string | null | undefined): IntakeSignalProvenance[] | null {
    if (typeof raw !== 'string') return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    const parsed = StoredSignalsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** The columns a stored row offers a VIEW. No `proposedOwnerRef`: a view never has one to drop. */
export interface StoredSuggestionRow {
    readonly runId: string;
    readonly runCompletedAt: Date;
    readonly status: string;
    readonly grade: string | null;
    readonly unmatchedReason: string | null;
    readonly signalsJson: string | null;
}

const isStatus = (v: string): v is ShadowSuggestion['status'] =>
    (ATTRIBUTION_STATUSES as readonly string[]).includes(v);

/**
 * The suggestion as the harness tab may show it, or `null` when the stored row
 * does not re-validate — the shape the migration's CHECK holds, re-checked on
 * the way out, so a row nobody could have written shows nothing rather than
 * something wrong.
 */
export function storedSuggestionView(row: StoredSuggestionRow): ShadowSuggestion | null {
    const signals = parseStoredSignals(row.signalsJson);
    if (signals === null || !isStatus(row.status)) return null;
    const grade = row.grade === 'STRONG' || row.grade === 'WEAK' ? row.grade : null;
    const reason =
        row.unmatchedReason === 'NO_OWNER_SIGNAL' || row.unmatchedReason === 'OWNER_DEPARTED' ? row.unmatchedReason : null;
    if ((row.status === 'SUGGESTED') !== (grade !== null) || row.grade !== grade) return null;
    if ((row.status === 'UNMATCHED') !== (reason !== null) || row.unmatchedReason !== reason) return null;
    // A SUGGESTED answer rests on at least one signal (the contract's `min(1)`).
    if (row.status === 'SUGGESTED' && signals.length === 0) return null;
    return {
        runId: row.runId,
        runCompletedAt: row.runCompletedAt.toISOString(),
        status: row.status,
        grade,
        unmatchedReason: reason,
        signals,
    };
}
