/**
 * The mount gate: the Presidio detector is constructed only when a committed
 * record, made by the Presidio provider, answers the committed fixture set for
 * the deployed configuration, and its RECOMPUTED rates clear the floors.
 * Invariants:
 *
 *   - unset base URL constructs nothing (ABSENT);
 *   - a configured detector without a passing record is UNMOUNTED, by name;
 *   - the ground truth is the committed SET, never the record's own copy: a
 *     record that answered another set, or edits its spans, is SET_MISMATCH;
 *   - support is counted on the set, and a thin set is refused;
 *   - recall is strict (a partial cover is a miss);
 *   - the newest record for the configuration decides by instant, never an
 *     older pass, and a malformed record for it refuses rather than sorting
 *     itself out of the way;
 *   - a record made by another detector (the stub) never mounts Presidio;
 *   - the committed records directory holds no record today, so a configured
 *     deployment stays unmounted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkPiiEvaluationRecord, computePiiRates } from '@/lib/ai/pii/evaluation-record';
import { checkPiiFixtureSet, PII_MIN_SUPPORT } from '@/lib/ai/pii/fixture-set';
import { PII_FIXTURE_SET_FILE, PII_RECORDS_DIR, resolvePiiDetector } from '@/lib/ai/pii/mount';

import { caseOf, CONFIG_HASH, digestOf, fixtureSet, OTHER_CONFIG_HASH, passingRecord, type RawFixtureSet } from './pii-record-helpers';

const BASE = 'https://pii.internal.test';

const made: string[] = [];
afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** A working directory holding `records` under evals/pii/records and, unless null, the fixture set. */
function rootWith(records: Record<string, unknown>, set: RawFixtureSet | null = fixtureSet()): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-root-'));
    made.push(root);
    const dir = path.join(root, PII_RECORDS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(records)) {
        fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (set) {
        fs.mkdirSync(path.dirname(path.join(root, PII_FIXTURE_SET_FILE)), { recursive: true });
        fs.writeFileSync(path.join(root, PII_FIXTURE_SET_FILE), JSON.stringify(set));
    }
    return root;
}

const resolveIn = (root: string) => resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root });

describe('the fixture set holds the ground truth and the support', () => {
    it('the generated set passes', () => {
        expect(checkPiiFixtureSet(fixtureSet()).ok).toBe(true);
    });

    it(`a type with fewer than ${PII_MIN_SUPPORT} spans in a locale is refused — never "1 of 1"`, () => {
        const set = fixtureSet();
        set.cases = set.cases.filter((c) => c.caseId !== 'pos-bg-EGN-0');
        expect(checkPiiFixtureSet(set)).toMatchObject({ ok: false, reason: 'SET_LOW_SUPPORT', detail: expect.stringContaining('EGN/bg 19') });
    });

    it('a missing case kind is refused', () => {
        const set = fixtureSet();
        set.cases = set.cases.filter((c) => c.kind !== 'near-miss');
        expect(checkPiiFixtureSet(set)).toMatchObject({ ok: false, reason: 'SET_MISSING_KIND' });
    });

    it('a span past its text is refused', () => {
        const set = fixtureSet();
        set.cases[0].expected = [{ type: 'PERSON', start: 4, end: 999 }];
        expect(checkPiiFixtureSet(set)).toMatchObject({ ok: false, reason: 'SET_SPAN_OUT_OF_RANGE' });
    });

    it('a negative case that expects spans is malformed', () => {
        const set = fixtureSet();
        const neg = set.cases.find((c) => c.kind === 'negative');
        if (!neg) throw new Error('fixture case missing');
        neg.expected = [{ type: 'PERSON', start: 0, end: 3 }];
        expect(checkPiiFixtureSet(set)).toMatchObject({ ok: false, reason: 'SET_MALFORMED' });
    });

    it('a duplicate case id is refused', () => {
        const set = fixtureSet();
        set.cases.push({ ...set.cases[0] });
        expect(checkPiiFixtureSet(set)).toMatchObject({ ok: false, reason: 'SET_DUPLICATE_CASE' });
    });
});

describe('a record is checked against the committed set, never against itself', () => {
    it('a record answering the set passes', () => {
        expect(checkPiiEvaluationRecord(passingRecord(), fixtureSet()).ok).toBe(true);
    });

    it('a record that answered an earlier set is SET_MISMATCH, even with its own digest re-stamped', () => {
        const earlier = fixtureSet();
        const committed = fixtureSet();
        committed.cases.push({ caseId: 'mixed-bg-hard', locale: 'bg', kind: 'mixed-script', text: 'Hijklmn и тест', expected: [{ type: 'PERSON', start: 0, end: 7 }] });
        const old = passingRecord(earlier);
        expect(checkPiiEvaluationRecord(old, committed)).toMatchObject({ ok: false, reason: 'SET_MISMATCH' });
        // Re-stamping the digest does not help: the case is still unanswered.
        expect(checkPiiEvaluationRecord({ ...old, fixtureDigest: digestOf(committed) }, committed)).toMatchObject({
            ok: false,
            reason: 'SET_MISMATCH',
        });
    });

    it('an arbitrary sha256-shaped digest is SET_MISMATCH', () => {
        expect(checkPiiEvaluationRecord(passingRecord(fixtureSet(), { fixtureDigest: `sha256:${'c'.repeat(64)}` }), fixtureSet())).toMatchObject({
            ok: false,
            reason: 'SET_MISMATCH',
        });
    });

    it('a record that rewrites a case\'s expected spans to match its predictions is SET_MISMATCH', () => {
        const rec = passingRecord();
        const c = caseOf(rec, 'pos-bg-EGN-0');
        c.expected = [];
        c.predicted = [];
        expect(checkPiiEvaluationRecord(rec, fixtureSet())).toMatchObject({ ok: false, reason: 'SET_MISMATCH', detail: expect.stringContaining('pos-bg-EGN-0') });
    });

    it('a duplicated answer is SET_MISMATCH', () => {
        const rec = passingRecord();
        rec.cases.push({ ...rec.cases[0] });
        expect(checkPiiEvaluationRecord(rec, fixtureSet())).toMatchObject({ ok: false, reason: 'SET_MISMATCH' });
    });

    it('a prediction past the text is refused', () => {
        const rec = passingRecord();
        caseOf(rec, 'neg-en').predicted = [{ type: 'PERSON', start: 0, end: 500 }];
        expect(checkPiiEvaluationRecord(rec, fixtureSet())).toMatchObject({ ok: false, reason: 'PREDICTED_OUT_OF_RANGE' });
    });

    it('an invalid set refuses every record', () => {
        const set = fixtureSet();
        set.cases = set.cases.filter((c) => c.kind !== 'negative');
        expect(checkPiiEvaluationRecord(passingRecord(set), set)).toMatchObject({ ok: false, reason: 'SET_MISSING_KIND' });
    });

    it('a record carrying its own rates is malformed: a stored figure is never read', () => {
        expect(checkPiiEvaluationRecord(passingRecord(fixtureSet(), { precision: { PERSON: 1 } }), fixtureSet())).toMatchObject({
            ok: false,
            reason: 'MALFORMED',
        });
    });
});

describe('the rates are recomputed from raw answers', () => {
    const span = (type: 'PHONE' | 'EGN', start: number, end: number) => ({ type, start, end });

    it('a partial cover of an expected span is a miss — the uncovered characters would leave', () => {
        const rates = computePiiRates([{ locale: 'bg', expected: [span('EGN', 4, 14)], predicted: [span('EGN', 4, 13)] }]);
        expect(rates.bg.EGN).toEqual({ support: 1, recalled: 0, predicted: 1, precise: 1 });
    });

    it('a cover stitched from several same-type spans is a hit; a gap or another type is not', () => {
        const recalled = (predicted: ReturnType<typeof span>[]) =>
            computePiiRates([{ locale: 'en', expected: [span('PHONE', 4, 14)], predicted }]).en.PHONE.recalled;
        expect(recalled([span('PHONE', 4, 9), span('PHONE', 9, 14)])).toBe(1);
        expect(recalled([span('PHONE', 4, 6), span('PHONE', 8, 14)])).toBe(0);
        expect(recalled([span('EGN', 4, 14)])).toBe(0);
    });

    it('two misses in one type and locale fall below the recall floor', () => {
        const rec = passingRecord();
        caseOf(rec, 'pos-en-IBAN-0').predicted = [];
        expect(checkPiiEvaluationRecord(rec, fixtureSet()).ok).toBe(true); // 19/20 = 0.95
        caseOf(rec, 'pos-en-IBAN-1').predicted = [];
        expect(checkPiiEvaluationRecord(rec, fixtureSet())).toMatchObject({ ok: false, reason: 'BELOW_FLOOR', detail: 'IBAN/en recall 18/20' });
    });

    it('false positives on a negative case count against precision', () => {
        const rec = passingRecord();
        const fp = Array.from({ length: 6 }, (_, i) => ({ type: 'PERSON', start: i, end: i + 1 }));
        caseOf(rec, 'neg-en').predicted = fp;
        // en/PERSON: 20 precise of 26 predicted.
        expect(checkPiiEvaluationRecord(rec, fixtureSet())).toMatchObject({ ok: false, reason: 'BELOW_FLOOR', detail: 'PERSON/en precision 20/26' });
    });
});

describe('resolvePiiDetector', () => {
    it('no base URL constructs nothing', () => {
        expect(resolvePiiDetector({ baseUrl: undefined, configHash: CONFIG_HASH })).toEqual({ state: 'ABSENT' });
    });

    it.each([
        ['no config hash', 'NO_CONFIG_HASH', { baseUrl: BASE, configHash: undefined }],
        ['http base URL', 'BASE_URL_NOT_HTTPS', { baseUrl: 'http://presidio:3000', configHash: CONFIG_HASH }],
    ])('%s → UNMOUNTED(%s)', (_label, reason, opts) => {
        expect(resolvePiiDetector({ ...opts, root: rootWith({ 'r.json': passingRecord() }) })).toMatchObject({ state: 'UNMOUNTED', reason });
    });

    it('no record for the deployed configuration is UNMOUNTED(NO_RECORD)', () => {
        expect(resolveIn(rootWith({ 'r.json': passingRecord(fixtureSet(), { configHash: OTHER_CONFIG_HASH }) }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_RECORD',
        });
    });

    it('a record with no committed fixture set beside it is UNMOUNTED(NO_FIXTURE_SET)', () => {
        expect(resolveIn(rootWith({ 'r.json': passingRecord() }, null))).toMatchObject({ state: 'UNMOUNTED', reason: 'NO_FIXTURE_SET' });
    });

    it('a record that answered another set does not mount', () => {
        const committed = fixtureSet();
        committed.cases.pop();
        committed.cases.push({ caseId: 'mixed-bg-2', locale: 'bg', kind: 'mixed-script', text: 'Opqrstu и тест', expected: [{ type: 'PERSON', start: 0, end: 7 }] });
        expect(resolveIn(rootWith({ 'r.json': passingRecord() }, committed))).toMatchObject({ state: 'UNMOUNTED', reason: 'SET_MISMATCH' });
    });

    it('an unreadable record file refuses the mount rather than being skipped', () => {
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': '{not json' }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'RECORDS_UNREADABLE',
        });
    });

    it('the newest record for the configuration decides; an older pass does not stand in', () => {
        const failing = passingRecord(fixtureSet(), { producedAt: '2026-11-12T00:00:00.000Z' });
        caseOf(failing, 'pos-en-IBAN-0').predicted = [];
        caseOf(failing, 'pos-en-IBAN-1').predicted = [];
        expect(resolveIn(rootWith({ 'old.json': passingRecord(), 'new.json': failing }))).toMatchObject({ state: 'UNMOUNTED', reason: 'BELOW_FLOOR' });
    });

    it('newest is the instant, not the string: a fractional second is later than the whole one', () => {
        const older = passingRecord(fixtureSet(), { producedAt: '2026-11-12T00:00:00Z' });
        const newer = passingRecord(fixtureSet(), { producedAt: '2026-11-12T00:00:00.500Z' });
        caseOf(newer, 'pos-en-IBAN-0').predicted = [];
        caseOf(newer, 'pos-en-IBAN-1').predicted = [];
        // File names put the newer one first, so neither name nor string order rescues it.
        expect(resolveIn(rootWith({ 'a.json': newer, 'z.json': older }))).toMatchObject({ state: 'UNMOUNTED', reason: 'BELOW_FLOOR' });
    });

    it('a malformed record for the configuration refuses the mount — it cannot sort itself out of the way', () => {
        const noDate = passingRecord();
        delete noDate.producedAt;
        expect(resolveIn(rootWith({ 'a-old.json': passingRecord(), 'z-new.json': noDate }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'MALFORMED',
            detail: expect.stringContaining('z-new.json'),
        });
    });

    it('a record naming no configuration cannot be ruled out, so it refuses too', () => {
        const unnamed = passingRecord();
        delete unnamed.configHash;
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': unnamed }))).toMatchObject({ state: 'UNMOUNTED', reason: 'MALFORMED' });
    });

    it('a malformed record for ANOTHER configuration is not this deployment\'s concern', () => {
        const other = passingRecord(fixtureSet(), { configHash: OTHER_CONFIG_HASH });
        delete other.producedAt;
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': other }))).toMatchObject({ state: 'MOUNTED' });
    });

    it('a record made by the stub never mounts the Presidio provider', () => {
        const stubRecord = passingRecord(fixtureSet(), { detector: { name: 'stub', revision: '1' } });
        expect(resolveIn(rootWith({ 'r.json': stubRecord }))).toMatchObject({ state: 'UNMOUNTED', reason: 'DETECTOR_MISMATCH' });
    });

    it('a passing record mounts a detector that asks for the record threshold', async () => {
        const bodies: unknown[] = [];
        const res = resolvePiiDetector({
            baseUrl: BASE,
            configHash: CONFIG_HASH,
            root: rootWith({ 'r.json': passingRecord() }),
            fetchImpl: async (_url, init) => {
                bodies.push(JSON.parse(String(init.body)));
                return new Response('[]', { status: 200 });
            },
        });
        if (res.state !== 'MOUNTED') throw new Error(`expected MOUNTED, got ${JSON.stringify(res)}`);
        expect(res.record).toEqual({
            detector: 'presidio@test-revision',
            configHash: CONFIG_HASH,
            producedAt: '2026-11-11T00:00:00.000Z',
        });
        await res.detector.analyze('hello', 'en');
        expect(bodies).toEqual([expect.objectContaining({ score_threshold: 0.4 })]);
    });

    it('the committed tree mounts nothing today', () => {
        // Run from the repository root, as the app is. Phase 0 commits the set
        // and the first record; until then a configured deployment must stay
        // unmounted.
        const res = resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH });
        expect(res).toMatchObject({ state: 'UNMOUNTED', reason: 'NO_RECORD' });
    });
});
