/**
 * A PII record's precision and recall are recomputed from its raw spans, and
 * the rule for what counts is the one that matters for leakage.
 *
 * Phase 0.4's format (`src/lib/ai/pii/evaluation-record.ts`).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    OVERREACH_CHARS,
    PiiFixtureCorpusSchema,
    piiCorpusDigest,
    scorePiiRecord,
    type PiiFixtureCorpus,
} from '@/lib/ai/pii/evaluation-record';
import { PII_ENTITY_TYPES } from '@/lib/ai/pii/scope';

import { PII_CORPUS_PATH } from '../fixtures/pii/generate';

const corpusText = fs.readFileSync(PII_CORPUS_PATH, 'utf8');
const corpus = PiiFixtureCorpusSchema.parse(JSON.parse(corpusText));

type Span = { type: string; start: number; end: number; score: number };

function recordWith(answer: (c: PiiFixtureCorpus['cases'][number]) => Span[], extra: Record<string, unknown> = {}) {
    return {
        schema: 'inflect-pii-record/1',
        corpusDigest: piiCorpusDigest(corpusText),
        detector: { name: 'presidio', version: 'test', configHash: `sha256:${'0'.repeat(64)}`, models: { en: 'en', bg: 'bg' } },
        ranAt: '2026-11-11T00:00:00.000Z',
        answers: corpus.cases.map((c) => ({ caseId: c.id, spans: answer(c) })),
        ...extra,
    };
}
const gold = (c: PiiFixtureCorpus['cases'][number]): Span[] => c.spans.map((s) => ({ ...s, score: 1 }));

function scored(record: unknown) {
    const result = scorePiiRecord(record, corpusText);
    if (!result.ok) throw new Error(`refused: ${result.refusal} ${result.detail}`);
    return result;
}

const firstPersonCase = corpus.cases.find((c) => c.kind === 'task' && c.spans.some((s) => s.type === 'PERSON' && c.text.slice(s.start, s.end).includes(' ')))!;
const personSpan = firstPersonCase.spans.find((s) => s.type === 'PERSON')!;
const personText = firstPersonCase.text.slice(personSpan.start, personSpan.end);

describe('PII evaluation record — what counts', () => {
    it('scores the ground truth itself as perfect, in both locales, on every kind', () => {
        const r = scored(recordWith(gold));
        for (const t of PII_ENTITY_TYPES) {
            for (const locale of ['en', 'bg'] as const) {
                expect([t, locale, r.perTypeByLocale[locale][t].precision, r.perTypeByLocale[locale][t].recall]).toEqual([t, locale, 1, 1]);
            }
        }
        for (const k of Object.values(r.perKind)) expect(k.passed).toBe(k.cases);
    });

    it('counts a name as missed when only part of it is covered: the rest leaks', () => {
        const familyStart = personSpan.start + personText.lastIndexOf(' ') + 1;
        const r = scored(
            recordWith((c) =>
                c.id === firstPersonCase.id
                    ? gold(c).map((s) => (s.type === 'PERSON' && s.start === personSpan.start ? { ...s, start: familyStart } : s))
                    : gold(c),
            ),
        );
        expect(r.perType.PERSON.recalled).toBe(r.perType.PERSON.support - 1);
        expect(r.perKind.task.passed).toBe(r.perKind.task.cases - 1);
    });

    it('counts a name as recalled when two predictions cover every letter of it and only the space is between', () => {
        const space = personSpan.start + personText.indexOf(' ');
        const r = scored(
            recordWith((c) =>
                c.id === firstPersonCase.id
                    ? [
                          ...gold(c).filter((s) => !(s.type === 'PERSON' && s.start === personSpan.start)),
                          { type: 'PERSON', start: personSpan.start, end: space, score: 0.9 },
                          { type: 'PERSON', start: space + 1, end: personSpan.end, score: 0.9 },
                      ]
                    : gold(c),
            ),
        );
        expect(r.perType.PERSON.recall).toBe(1);
    });

    it('counts a prediction of the wrong type as neither a recall nor a correct prediction', () => {
        const r = scored(recordWith((c) => (c.id === firstPersonCase.id ? gold(c).map((s) => (s.type === 'PERSON' ? { ...s, type: 'PHONE_NUMBER' } : s)) : gold(c))));
        expect(r.perType.PERSON.recalled).toBe(r.perType.PERSON.support - 1);
        expect(r.perType.PHONE_NUMBER.correct).toBe(r.perType.PHONE_NUMBER.predicted - 1);
    });

    it(`allows a prediction to over-reach its ground truth by ${OVERREACH_CHARS} characters and no more`, () => {
        const widen = (by: number) => (c: PiiFixtureCorpus['cases'][number]) =>
            c.id === firstPersonCase.id
                ? gold(c).map((s) => (s.type === 'PERSON' ? { ...s, start: Math.max(0, s.start - by) } : s))
                : gold(c);
        // The fixture puts the name after "Please contact " or similar, so there is room to widen.
        expect(personSpan.start).toBeGreaterThan(OVERREACH_CHARS);
        expect(scored(recordWith(widen(OVERREACH_CHARS))).perType.PERSON.precision).toBe(1);
        const over = scored(recordWith(widen(OVERREACH_CHARS + 1))).perType.PERSON;
        expect(over.correct).toBe(over.predicted - 1);
    });

    it('ignores types D-L1-1 put out of scope instead of counting them against the detector', () => {
        const withLocations = scored(
            recordWith((c) => [...gold(c), ...(c.text.length > 3 ? [{ type: 'LOCATION', start: 0, end: 3, score: 0.5 }] : [])]),
        );
        expect(withLocations).toEqual(scored(recordWith(gold)));
    });

    it('fails a refusal case that flags a near-miss, and lowers precision for it', () => {
        const refusal = corpus.cases.find((c) => c.kind === 'refusal' && /\d{10}/.test(c.text))!;
        const at = refusal.text.search(/\d{10}/);
        const r = scored(recordWith((c) => (c.id === refusal.id ? [{ type: 'BG_EGN', start: at, end: at + 10, score: 0.8 }] : gold(c))));
        expect(r.perKind.refusal.passed).toBe(r.perKind.refusal.cases - 1);
        expect(r.perType.BG_EGN.correct).toBe(r.perType.BG_EGN.predicted - 1);
    });

    it('reports no predictions as no precision, never as perfect precision', () => {
        const r = scored(recordWith(() => []));
        for (const t of PII_ENTITY_TYPES) {
            expect([t, r.perType[t].precision, r.perType[t].recall]).toEqual([t, null, 0]);
        }
        expect(r.perKind.task.passed).toBe(0);
    });
});

describe('PII evaluation record — refusals', () => {
    it('refuses a record that states its own rate', () => {
        expect(scorePiiRecord(recordWith(gold, { precision: { PERSON: 1 } }), corpusText)).toMatchObject({ ok: false, refusal: 'MALFORMED_RECORD' });
    });

    it('refuses a record made against a different corpus', () => {
        expect(scorePiiRecord(recordWith(gold, { corpusDigest: `sha256:${'f'.repeat(64)}` }), corpusText)).toMatchObject({ ok: false, refusal: 'CORPUS_MISMATCH' });
    });

    it('refuses a record with no BG model named', () => {
        const r = recordWith(gold);
        expect(scorePiiRecord({ ...r, detector: { ...r.detector, models: { en: 'en' } } }, corpusText)).toMatchObject({ ok: false, refusal: 'MALFORMED_RECORD' });
    });

    it('refuses an unanswered, an unknown and a duplicated case, and a span outside its text', () => {
        const r = recordWith(gold);
        expect(scorePiiRecord({ ...r, answers: r.answers.slice(1) }, corpusText)).toMatchObject({ refusal: 'UNANSWERED_CASE' });
        expect(scorePiiRecord({ ...r, answers: [...r.answers, { caseId: 'nope', spans: [] }] }, corpusText)).toMatchObject({ refusal: 'UNKNOWN_ANSWER' });
        expect(scorePiiRecord({ ...r, answers: [...r.answers, r.answers[0]] }, corpusText)).toMatchObject({ refusal: 'DUPLICATE_ANSWER' });
        const empty = corpus.cases.find((c) => c.text.length === 0)!;
        const outside = r.answers.map((a) => (a.caseId === empty.id ? { ...a, spans: [{ type: 'PERSON', start: 0, end: 1, score: 1 }] } : a));
        expect(scorePiiRecord({ ...r, answers: outside }, corpusText)).toMatchObject({ refusal: 'SPAN_OUT_OF_RANGE' });
    });
});

describe('PII fixture corpus schema', () => {
    const base = JSON.parse(corpusText) as PiiFixtureCorpus;
    const issues = (mutate: (c: PiiFixtureCorpus) => PiiFixtureCorpus) => {
        const r = PiiFixtureCorpusSchema.safeParse(mutate(structuredClone(base)));
        return r.success ? [] : r.error.issues.map((i) => i.message);
    };

    it('accepts the committed corpus', () => {
        expect(issues((c) => c)).toEqual([]);
    });

    it('requires every kind in every locale', () => {
        expect(issues((c) => ({ ...c, cases: c.cases.filter((x) => !(x.locale === 'bg' && x.kind === 'injection')) }))).toContain(
            'at least one bg injection case is required',
        );
    });

    it('requires every in-scope type as a task span in every locale', () => {
        expect(issues((c) => ({ ...c, cases: c.cases.filter((x) => !(x.locale === 'bg' && x.spans.some((s) => s.type === 'BG_EGN'))) }))).toContain(
            'at least one bg task span of BG_EGN is required',
        );
    });

    it('refuses ground truth in a case that says there is nothing to find', () => {
        const at = base.cases.findIndex((x) => x.kind === 'refusal');
        expect(
            issues((c) => {
                c.cases[at].spans = [{ type: 'PERSON', start: 0, end: 1 }];
                return c;
            }),
        ).toContain('a refusal case carries no span: there is nothing in it to find');
    });

    it('refuses a character outside the BMP, where JavaScript and Python offsets disagree', () => {
        expect(
            issues((c) => {
                c.cases[0].text = `\u{1F600}${c.cases[0].text}`;
                return c;
            }),
        ).toContain('text stays in the BMP so offsets agree with Python');
    });

    it('refuses overlapping spans and a span that starts on whitespace', () => {
        const two = base.cases.findIndex((x) => x.spans.length >= 2);
        expect(
            issues((c) => {
                c.cases[two].spans[1] = { ...c.cases[two].spans[1], start: c.cases[two].spans[0].start };
                return c;
            }),
        ).toContain('spans are sorted and do not overlap');
        expect(
            issues((c) => {
                const s = c.cases[two].spans[0];
                c.cases[two].spans[0] = { ...s, start: s.start - 1 };
                return c;
            }),
        ).toContain('a span does not start or end on whitespace');
    });
});

describe('committed PII evaluation records', () => {
    const recordsDir = path.join(__dirname, '..', '..', 'evals', 'pii', 'records');
    const presidioDir = path.join(__dirname, '..', '..', 'guards', 'presidio');
    const records = fs.readdirSync(recordsDir).filter((f) => f.endsWith('.json'));

    /**
     * `inflect_pii.config.config_hash()`, recomputed here: SHA-256 over
     * requirements.txt and every module of the package, each as
     * `<relative path>\0<bytes>\0`, modules sorted by name.
     */
    function detectorConfigHash(): string {
        const modules = fs
            .readdirSync(path.join(presidioDir, 'inflect_pii'))
            .filter((f) => f.endsWith('.py'))
            .sort()
            .map((f) => `inflect_pii/${f}`);
        const h = createHash('sha256');
        for (const f of ['requirements.txt', ...modules]) {
            h.update(Buffer.concat([Buffer.from(`${f}\0`, 'utf8'), fs.readFileSync(path.join(presidioDir, f)), Buffer.from('\0')]));
        }
        return `sha256:${h.digest('hex')}`;
    }

    it('each name the committed corpus and recompute without refusal', () => {
        expect(records.length).toBeGreaterThan(0);
        const refused = records
            .map((f) => [f, scorePiiRecord(JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')), corpusText)] as const)
            .filter(([, r]) => !r.ok);
        expect(refused).toEqual([]);
    });

    it('include one for the detector configuration as it stands, so a recogniser cannot change without a new record', () => {
        const hashes = records.map((f) => JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')).detector.configHash);
        expect(hashes).toContain(detectorConfigHash());
    });
});
