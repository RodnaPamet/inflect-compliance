/**
 * The audit narrative's output contract (#3749) — `src/lib/agentic/audit-narrative.ts`.
 *
 *   1. AN ANSWER IS READ ONLY THROUGH THE SCHEMA. Prose is not a narrative; a
 *      block that claims to be one must parse; two different blocks are
 *      ambiguous; the issues name paths, never the model's text.
 *   2. A NARRATIVE STATES NOTHING THE WORKPAPER DOES NOT RECORD. Its
 *      conclusion, the conclusion words and codes in its text, and the codes
 *      it lists are each held to the stored record, and one failure refuses
 *      the whole answer.
 */
import {
    MAX_NARRATIVE_CHARS,
    MAX_NARRATIVES_PER_ANSWER,
    checkNarrativesAgainstRecord,
    readNarrativeFromAnswer,
    type AuditNarrativeAnswer,
    type WorkpaperRecordFacts,
} from '@/lib/agentic/audit-narrative';
import { MAX_ANSWER_CHARS } from '@/lib/agentic/review-attribution';
import { summaryCapFor } from '@/app-layer/ai/decision-log';

const PERIOD = '2027-03';

const failing: WorkpaperRecordFacts = {
    id: 'wp_fail',
    periodLabel: PERIOD,
    conclusion: 'FAIL',
    conclusionBasis: 'EXCEPTIONS_FOUND',
    exceptionCodes: ['LEAVER_DISABLED_LATE'],
    outcomeCodes: ['LEAVER_DISABLED_LATE', 'DISABLE_TIME_UNKNOWN'],
};
const passing: WorkpaperRecordFacts = {
    id: 'wp_pass',
    periodLabel: PERIOD,
    conclusion: 'PASS',
    conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
    exceptionCodes: [],
    outcomeCodes: [],
};
const RECORDS = [failing, passing];

const narrative = (over: Partial<AuditNarrativeAnswer['narratives'][number]> = {}) => ({
    workpaperId: 'wp_fail',
    conclusion: 'FAIL' as const,
    exceptionCodes: ['LEAVER_DISABLED_LATE'],
    text: 'Two of four leavers were sampled. emp_2 was disabled after the 24-hour window (LEAVER_DISABLED_LATE), so the workpaper records FAIL.',
    ...over,
});
const answer = (narratives: unknown[] = [narrative()], over: Record<string, unknown> = {}) => ({
    periodLabel: PERIOD,
    narratives,
    ...over,
});
const fenced = (value: unknown) => `Here is the narrative.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

function parsed(value: unknown): AuditNarrativeAnswer {
    const reading = readNarrativeFromAnswer(fenced(value));
    if (!reading.ok) throw new Error(`${reading.reason}: ${reading.issues.join('; ')}`);
    return reading.answer;
}

describe('reading an answer', () => {
    it('reads a fenced block and a bare object alike', () => {
        expect(readNarrativeFromAnswer(fenced(answer()))).toMatchObject({ ok: true });
        expect(readNarrativeFromAnswer(JSON.stringify(answer()))).toMatchObject({ ok: true });
    });

    it('prose alone, or a block that is not a narrative, offers no narrative', () => {
        expect(readNarrativeFromAnswer('The period looks clean.')).toEqual({ ok: false, reason: 'NO_NARRATIVE_IN_ANSWER', issues: [] });
        expect(readNarrativeFromAnswer(fenced({ status: 'SUGGESTED' }))).toMatchObject({ reason: 'NO_NARRATIVE_IN_ANSWER' });
    });

    it('a block that claims to be the narrative and does not parse refuses the answer, by path and code only', () => {
        const marker = 'model-text-marker-77';
        const reading = readNarrativeFromAnswer(fenced(answer([narrative({ conclusion: marker as never })])));
        expect(reading).toMatchObject({ ok: false, reason: 'ANSWER_INVALID' });
        expect(JSON.stringify(reading)).not.toContain(marker);
    });

    it.each([
        ['an unknown member', answer([narrative()], { extra: 1 })],
        ['an empty list', answer([])],
        ['a malformed period', answer([narrative()], { periodLabel: '2027-13' })],
        ['an over-long narrative', answer([narrative({ text: 'x'.repeat(MAX_NARRATIVE_CHARS + 1) })])],
        ['a lowercase code', answer([narrative({ exceptionCodes: ['late'] })])],
        ['too many narratives', answer(Array.from({ length: MAX_NARRATIVES_PER_ANSWER + 1 }, (_, i) => narrative({ workpaperId: `wp_${i}` })))],
    ])('refuses %s', (_label, value) => {
        expect(readNarrativeFromAnswer(fenced(value))).toMatchObject({ ok: false, reason: 'ANSWER_INVALID' });
    });

    it('two different narrative blocks are ambiguous; a repeat of the same block is one answer', () => {
        const a = fenced(answer());
        const b = fenced(answer([narrative({ text: 'A different account that still records FAIL.' })]));
        expect(readNarrativeFromAnswer(`${a}\n${b}`)).toMatchObject({ reason: 'ANSWER_AMBIGUOUS' });
        expect(readNarrativeFromAnswer(`${a}\n${a}`)).toMatchObject({ ok: true });
    });

    it('an answer longer than any decision log holds is refused unread', () => {
        expect(readNarrativeFromAnswer('x'.repeat(MAX_ANSWER_CHARS + 1))).toMatchObject({ reason: 'ANSWER_TOO_LONG' });
    });

    it(`${MAX_NARRATIVES_PER_ANSWER} narratives at the text bound fit what the decision log keeps of a run's answer`, () => {
        // The capture reads the answer back from the Art 12 summary; a block
        // cut by that bound would not parse, so the bound must hold the most
        // the schema admits.
        const most = answer(
            Array.from({ length: MAX_NARRATIVES_PER_ANSWER }, (_, i) =>
                narrative({ workpaperId: `c${'x'.repeat(24)}${i}`, text: 'y'.repeat(MAX_NARRATIVE_CHARS), exceptionCodes: ['LEAVER_DISABLED_LATE'] }),
            ),
        );
        expect(JSON.stringify(most).length + '```json\n\n```'.length).toBeLessThanOrEqual(
            summaryCapFor('agentic-run:audit-narrative'),
        );
    });
});

describe('holding a narrative to the record', () => {
    const check = (value: unknown, records: readonly WorkpaperRecordFacts[] = RECORDS) =>
        checkNarrativesAgainstRecord(parsed(value), PERIOD, records);

    it('accepts narratives that state only what each workpaper records', () => {
        const ok = check(
            answer([
                narrative(),
                narrative({
                    workpaperId: 'wp_pass',
                    conclusion: 'PASS',
                    exceptionCodes: [],
                    text: 'The one sampled joiner had an approval recorded before access; ALL_SAMPLED_UNITS_PASSED, so PASS.',
                }),
            ]),
        );
        expect(ok).toMatchObject({ ok: true });
    });

    it('a code an untestable unit carries may be cited, though no exception carries it', () => {
        const text = 'emp_3 had no recorded disable time (DISABLE_TIME_UNKNOWN); emp_2 was LEAVER_DISABLED_LATE. FAIL.';
        expect(check(answer([narrative({ text })]))).toMatchObject({ ok: true });
    });

    it.each([
        ['a conclusion the workpaper does not record', answer([narrative({ conclusion: 'PASS', exceptionCodes: [] })]), 'CONCLUSION_MISMATCH'],
        ['text that names another conclusion', answer([narrative({ text: 'Despite one late disable, the procedure PASSED.' })]), 'TEXT_STATES_ANOTHER_CONCLUSION'],
        ['an exception code the workpaper does not record', answer([narrative({ exceptionCodes: ['LEAVER_ACCOUNT_ACTIVE'] })]), 'UNRECORDED_EXCEPTION_CODE'],
        ['a failing workpaper with none of its exceptions named', answer([narrative({ exceptionCodes: [] })]), 'EXCEPTIONS_UNNAMED'],
        ['a code in the text the workpaper does not record', answer([narrative({ text: 'emp_2 was LEAVER_ACCOUNT_ACTIVE, so FAIL.' })]), 'TEXT_CITES_UNRECORDED_CODE'],
        ['an e-mail address in the text', answer([narrative({ text: 'emp_2 (jane.doe@example.com) was disabled late: FAIL.' })]), 'TEXT_NAMES_AN_ADDRESS'],
        ['a workpaper that is not one of the period’s', answer([narrative({ workpaperId: 'wp_elsewhere' })]), 'UNKNOWN_WORKPAPER'],
        ['one workpaper narrated twice', answer([narrative(), narrative()]), 'DUPLICATE_WORKPAPER'],
    ])('refuses %s', (_label, value, reason) => {
        expect(check(value)).toMatchObject({ ok: false, reason });
    });

    it('one bad narrative refuses the whole answer, good ones included', () => {
        const mixed = answer([
            narrative({ workpaperId: 'wp_pass', conclusion: 'PASS', exceptionCodes: [], text: 'All sampled units passed: PASS.' }),
            narrative({ conclusion: 'PASS', exceptionCodes: [] }),
        ]);
        expect(check(mixed)).toEqual({ ok: false, reason: 'CONCLUSION_MISMATCH', workpaperId: 'wp_fail' });
    });

    it('a block about another period is refused, and a workpaper of another period is not one of this one’s', () => {
        expect(check(answer([narrative()], { periodLabel: '2027-04' }))).toMatchObject({ reason: 'PERIOD_MISMATCH' });
        const elsewhere = { ...failing, periodLabel: '2027-04' };
        expect(check(answer([narrative()]), [elsewhere, passing])).toMatchObject({ reason: 'UNKNOWN_WORKPAPER' });
    });

    it('a workpaper whose stored record no longer re-validates cannot be narrated', () => {
        expect(check(answer([narrative()]), [{ ...failing, exceptionCodes: null }, passing])).toMatchObject({
            reason: 'WORKPAPER_UNREADABLE',
        });
        expect(check(answer([narrative()]), [{ ...failing, outcomeCodes: null }, passing])).toMatchObject({
            reason: 'WORKPAPER_UNREADABLE',
        });
    });

    it('lowercase prose is not a conclusion word', () => {
        const text = 'One leaver passed the first attribute and failed the window: LEAVER_DISABLED_LATE, FAIL.';
        expect(check(answer([narrative({ text })]))).toMatchObject({ ok: true });
    });
});
