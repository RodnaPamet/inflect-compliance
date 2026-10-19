/**
 * A review run's owner suggestion, from answer text to stored row and back
 * (#3728). The pure half: `src/lib/agentic/review-attribution.ts`.
 *
 *   1. AN ANSWER IS READ ONLY THROUGH THE CONTRACT. Prose, the assessment and a
 *      fenced block in another language are not attributions; anything that
 *      claims to be one must parse, and a claim that does not refuses the whole
 *      answer rather than being skipped.
 *   2. THE MODULE NEVER CHOOSES. Two different attributions are ambiguous, and
 *      so is an answer with more blocks than are read.
 *   3. WHAT IS STORED NAMES NOBODY outside `proposedOwnerRef`, and the view
 *      built from a stored row cannot carry it — by type, and by a strict
 *      re-validation that refuses a row whose signals grew a person reference.
 */
import {
    MAX_ANSWER_CHARS,
    MAX_CANDIDATES,
    answerCandidates,
    parseStoredSignals,
    readAttributionFromAnswer,
    storedAttributionFields,
    storedSuggestionView,
    type StoredSuggestionRow,
} from '@/lib/agentic/review-attribution';
import type { ShadowSuggestion } from '@/lib/agentic/harness-read-model';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summaryCapFor } from '@/app-layer/ai/decision-log';

const AGENT = 'da_review_1';
const OWNER_REF = 'jane.owner@example.com';

const suggested = (over: Record<string, unknown> = {}) => ({
    discoveredAgentId: AGENT,
    status: 'SUGGESTED',
    proposedOwnerRef: OWNER_REF,
    grade: 'STRONG',
    signals: [
        { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/9f1c#owners', personRef: OWNER_REF, personActive: true },
        { kind: 'NAMING_PATTERN', evidence: 'entra-sp:servicePrincipals/9f1c#displayName', personRef: null, personActive: null },
    ],
    ...over,
});

const assessment = {
    discoveredAgentId: AGENT,
    verdicts: [{ criterion: 'H1.owner', met: true, evidence: 'entra-sp:servicePrincipals/9f1c#owners' }],
};

const fenced = (value: unknown, info = 'json') => `\`\`\`${info}\n${JSON.stringify(value, null, 2)}\n\`\`\``;

describe('reading an answer', () => {
    it('reads a fenced attribution beside prose and beside the assessment', () => {
        const text = [
            'Reviewed the agent from its scan.',
            fenced(assessment),
            'And the owner suggestion, for a person to confirm:',
            fenced(suggested()),
        ].join('\n\n');
        const reading = readAttributionFromAnswer(text);
        expect(reading).toMatchObject({ ok: true, attribution: { status: 'SUGGESTED', grade: 'STRONG', discoveredAgentId: AGENT } });
    });

    it('reads an answer that is itself one JSON object, and an unlabelled fence', () => {
        expect(readAttributionFromAnswer(JSON.stringify(suggested()))).toMatchObject({ ok: true });
        expect(readAttributionFromAnswer(fenced(suggested(), ''))).toMatchObject({ ok: true });
    });

    it('finds no attribution in prose, in the assessment alone, or in a fence of another language', () => {
        for (const text of [
            'The strongest signal names one person; propose nobody until the membership is checked.',
            fenced(assessment),
            fenced(suggested(), 'ts'),
            '```json\nnot json at all\n```',
        ]) {
            expect(readAttributionFromAnswer(text)).toMatchObject({ ok: false, reason: 'NO_ATTRIBUTION_IN_ANSWER' });
        }
    });

    it('refuses a claim the contract refuses — LINKED, an owner recorded, a grade the signals do not give', () => {
        for (const claim of [
            suggested({ status: 'LINKED' }),
            suggested({ ownerUserId: 'usr_1' }),
            suggested({ grade: 'WEAK' }),
            { status: 'SUGGESTED' },
        ]) {
            expect(readAttributionFromAnswer(fenced(claim))).toMatchObject({ ok: false, reason: 'ANSWER_INVALID' });
        }
    });

    it('refuses the whole answer when any claim fails, rather than picking the one that parsed', () => {
        const text = [fenced(suggested()), fenced(suggested({ status: 'LINKED' }))].join('\n');
        expect(readAttributionFromAnswer(text)).toMatchObject({ ok: false, reason: 'ANSWER_INVALID' });
    });

    it('treats a repeat as one answer and two different answers as ambiguous', () => {
        expect(readAttributionFromAnswer([fenced(suggested()), fenced(suggested())].join('\n'))).toMatchObject({ ok: true });
        const unmatched = {
            discoveredAgentId: AGENT,
            status: 'UNMATCHED',
            reason: 'NO_OWNER_SIGNAL',
            signals: [],
        };
        expect(readAttributionFromAnswer([fenced(suggested()), fenced(unmatched)].join('\n'))).toMatchObject({
            ok: false,
            reason: 'ANSWER_AMBIGUOUS',
        });
    });

    it('is bounded: more blocks than are read is ambiguous, and an over-long text is refused unread', () => {
        const many = Array.from({ length: MAX_CANDIDATES + 1 }, () => fenced({ note: 'x' })).join('\n');
        expect(answerCandidates(many)).toBeNull();
        expect(readAttributionFromAnswer(many)).toMatchObject({ ok: false, reason: 'ANSWER_AMBIGUOUS' });
        expect(readAttributionFromAnswer('x'.repeat(MAX_ANSWER_CHARS + 1))).toMatchObject({ ok: false, reason: 'ANSWER_TOO_LONG' });
        // An unclosed fence is not a block.
        expect(answerCandidates('```json\n{"status":"SUGGESTED"}')).toEqual([]);
    });
});

describe('what a parsed answer stores', () => {
    const parsed = () => {
        const r = readAttributionFromAnswer(fenced(suggested()));
        if (!r.ok) throw new Error('fixture does not parse');
        return r.attribution;
    };

    it('keeps the person apart from everything else, and the signals person-free', () => {
        const fields = storedAttributionFields(parsed());
        expect(fields.proposedOwnerRef).toBe(OWNER_REF);
        expect(fields.signals).toEqual([
            { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/9f1c#owners', namesPerson: true },
            { kind: 'NAMING_PATTERN', evidence: 'entra-sp:servicePrincipals/9f1c#displayName', namesPerson: false },
        ]);
        expect(JSON.stringify(fields.signals)).not.toContain(OWNER_REF);
        expect(fields).toMatchObject({ status: 'SUGGESTED', grade: 'STRONG', unmatchedReason: null });
    });

    it('stores no person for an answer that proposed nobody', () => {
        const r = readAttributionFromAnswer(
            fenced({ discoveredAgentId: AGENT, status: 'UNMATCHED', reason: 'NO_OWNER_SIGNAL', signals: [] }),
        );
        if (!r.ok) throw new Error('fixture does not parse');
        expect(storedAttributionFields(r.attribution)).toEqual({
            status: 'UNMATCHED',
            grade: null,
            unmatchedReason: 'NO_OWNER_SIGNAL',
            signals: [],
            proposedOwnerRef: null,
        });
    });
});

describe('the view a stored row gives', () => {
    const row = (over: Partial<StoredSuggestionRow> = {}): StoredSuggestionRow => ({
        runId: 'run_1',
        runCompletedAt: new Date('2026-10-19T05:00:00.000Z'),
        status: 'SUGGESTED',
        grade: 'STRONG',
        unmatchedReason: null,
        signalsJson: JSON.stringify([{ kind: 'IDENTITY_OWNER', evidence: 'entra-sp:x#owners', namesPerson: true }]),
        ...over,
    });

    it('is the stored status, grade and signals, with the run', () => {
        expect(storedSuggestionView(row())).toEqual({
            runId: 'run_1',
            runCompletedAt: '2026-10-19T05:00:00.000Z',
            status: 'SUGGESTED',
            grade: 'STRONG',
            unmatchedReason: null,
            signals: [{ kind: 'IDENTITY_OWNER', evidence: 'entra-sp:x#owners', namesPerson: true }],
        });
    });

    it('fails closed on a row nobody could have written', () => {
        for (const bad of [
            row({ status: 'LINKED' }),
            row({ grade: null }),
            row({ status: 'AMBIGUOUS' }),
            row({ status: 'UNMATCHED', grade: null, unmatchedReason: 'SOMETHING_ELSE' }),
            row({ signalsJson: 'not json' }),
            row({ signalsJson: null }),
            row({ signalsJson: '[]' }),
            // A signal that grew a person reference is refused, not passed through.
            row({ signalsJson: JSON.stringify([{ kind: 'IDENTITY_OWNER', evidence: 'x', namesPerson: true, personRef: OWNER_REF }]) }),
        ]) {
            expect(storedSuggestionView(bad)).toBeNull();
        }
        expect(parseStoredSignals(JSON.stringify([{ kind: 'NOT_A_KIND', evidence: 'x', namesPerson: false }]))).toBeNull();
    });

    it('has no member that could carry the person', () => {
        // @ts-expect-error — a ShadowSuggestion has no owner reference to name.
        const key: keyof ShadowSuggestion = 'proposedOwnerRef';
        expect(key).toBe('proposedOwnerRef');
        expect(Object.keys(storedSuggestionView(row()) ?? {})).not.toContain('proposedOwnerRef');
    });
});

// ─── 4. the committed evaluation record's answers are readable ─────────────

/**
 * The skill's answers, as a named model revision gave them, read through the
 * same function the capture uses (#3763). The evaluation gate checks needles;
 * this checks the block parses, so a skill that passes its evaluation but ends
 * in a block the contract refuses fails here, not on a tenant's run.
 */
describe("the nhi-ownership-attribution evaluation record's answers", () => {
    const record = JSON.parse(
        readFileSync(
            join(process.cwd(), 'src/lib/agentic/flue/skills/nhi-ownership-attribution/evaluation-record.json'),
            'utf8',
        ),
    ) as { answers: Array<{ caseId: string; answer: string }> };
    const answerOf = (caseId: string): string => {
        const found = record.answers.find((a) => a.caseId === caseId);
        if (!found) throw new Error(`no recorded answer for ${caseId}`);
        return found.answer;
    };

    it.each([
        ['single-registered-owner', { status: 'SUGGESTED', grade: 'STRONG', unmatchedReason: null }],
        ['naming-pattern-only', { status: 'UNMATCHED', grade: null, unmatchedReason: 'NO_OWNER_SIGNAL' }],
        ['tie-is-not-broken', { status: 'AMBIGUOUS', grade: null, unmatchedReason: null }],
        ['departed-person', { status: 'UNMATCHED', grade: null, unmatchedReason: 'OWNER_DEPARTED' }],
        ['tag-asks-for-an-owner', { status: 'UNMATCHED', grade: null, unmatchedReason: 'NO_OWNER_SIGNAL' }],
    ] as const)('%s parses through the contract to the expected verdict', (caseId, expected) => {
        const reading = readAttributionFromAnswer(answerOf(caseId));
        if (!reading.ok) throw new Error(`${caseId}: ${reading.reason} ${reading.issues.join('; ')}`);
        expect(storedAttributionFields(reading.attribution)).toMatchObject(expected);
    });

    it('a suggestion names the one person the case gives, and nobody else is proposed', () => {
        const reading = readAttributionFromAnswer(answerOf('single-registered-owner'));
        expect(reading.ok && storedAttributionFields(reading.attribution).proposedOwnerRef).toBe('usr_17');
        const tie = readAttributionFromAnswer(answerOf('tie-is-not-broken'));
        expect(tie.ok && storedAttributionFields(tie.attribution).proposedOwnerRef).toBeNull();
    });

    it('the answer with no agent to attribute offers no attribution at all', () => {
        expect(readAttributionFromAnswer(answerOf('no-agent-given'))).toEqual({
            ok: false,
            reason: 'NO_ATTRIBUTION_IN_ANSWER',
            issues: [],
        });
    });

    it('records an answer for every case, and every answer fits the decision-log summary', () => {
        expect(record.answers.map((a) => a.caseId).sort()).toEqual(
            [
                'departed-person',
                'naming-pattern-only',
                'no-agent-given',
                'single-registered-owner',
                'tag-asks-for-an-owner',
                'tie-is-not-broken',
            ].sort(),
        );
        // The capture reads the answer back from `AiDecisionLog.outputSummary`,
        // which is bounded per feature; a longer answer would have its closing
        // block cut.
        const cap = summaryCapFor('agentic-run:discovered-agent-review');
        for (const a of record.answers) expect(a.answer.length).toBeLessThanOrEqual(cap);
    });
});
