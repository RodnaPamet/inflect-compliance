/**
 * The mount gate: the Presidio detector is constructed only when a committed
 * record, made by the Presidio provider, answers the committed fixture corpus
 * for the deployed configuration, and its RECOMPUTED rates and support clear
 * the floors. Invariants:
 *
 *   - unset base URL constructs nothing (ABSENT);
 *   - a configured detector without a passing record is UNMOUNTED, by name;
 *   - the base URL must be an in-deployment address (G6 as amended): a public
 *     literal is refused before any record is read; a Compose hostname over
 *     http is the normal case;
 *   - the ground truth is the committed CORPUS, named by the digest of its
 *     bytes: a record that answered another corpus is CORPUS_MISMATCH;
 *   - support is counted per type per locale on the corpus, and a thin one is
 *     refused before the floors are asked;
 *   - the newest record for the configuration decides by instant, never an
 *     older pass, and a malformed record for it refuses rather than sorting
 *     itself out of the way;
 *   - a record made by another detector (the stub) never mounts Presidio;
 *   - the committed record does not mount: its corpus is below the minimum
 *     support, so a configured deployment stays unmounted today.
 *
 * What counts as a recall or a correct prediction is Phase 0's rule, tested in
 * `tests/unit/pii-evaluation-record.test.ts`; this file tests what the gate
 * does with the figures.
 */
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
jest.mock('undici', () => ({
    Agent: class {},
    fetch: (url: string, init: RequestInit) => mockFetch(url, init),
}));
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    checkPiiEvaluationRecord,
    PII_MIN_SUPPORT,
    PII_PRECISION_FLOOR,
    PII_RECALL_FLOOR,
    PII_SCORE_THRESHOLD,
} from '@/lib/ai/pii/evaluation-record';
import { PII_CORPUS_FILE, PII_RECORDS_DIR, resolvePiiDetector } from '@/lib/ai/pii/mount';

import {
    answerOf,
    CONFIG_HASH,
    corpus,
    corpusText,
    OTHER_CONFIG_HASH,
    passingRecord,
    taskId,
    withDetector,
} from './pii-record-helpers';

const BASE = 'http://presidio:3000';
const REPO = path.resolve(__dirname, '../../../..');
const COMMITTED_CORPUS = fs.readFileSync(path.join(REPO, PII_CORPUS_FILE), 'utf8');
const COMMITTED_RECORD = JSON.parse(fs.readFileSync(path.join(REPO, PII_RECORDS_DIR, 'e6ff3ad0d4d33dba.json'), 'utf8')) as {
    detector: { configHash: string };
};

const made: string[] = [];
afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** A working directory holding `records` under evals/pii/records and, unless null, the corpus. */
function rootWith(records: Record<string, unknown>, text: string | null = corpusText()): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-root-'));
    made.push(root);
    const dir = path.join(root, PII_RECORDS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(records)) {
        fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (text !== null) {
        fs.mkdirSync(path.dirname(path.join(root, PII_CORPUS_FILE)), { recursive: true });
        fs.writeFileSync(path.join(root, PII_CORPUS_FILE), text);
    }
    return root;
}

const resolveIn = (root: string) => resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root });

/** A record over a corpus with one `type`/`locale` task case removed. */
function thinned(locale: string, type: string) {
    const c = corpus();
    c.cases = c.cases.filter((x) => x.id !== taskId(locale, type, 0));
    const text = corpusText(c);
    return { text, record: passingRecord(text) };
}

beforeEach(() => {
    mockFetch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '172.18.0.20', family: 4 }]);
});

describe('the mount condition is recomputed from the one record format', () => {
    it('a record answering the corpus perfectly passes, with the floors as proposed', () => {
        expect([PII_RECALL_FLOOR, PII_PRECISION_FLOOR, PII_MIN_SUPPORT]).toEqual([0.95, 0.8, 20]);
        expect(checkPiiEvaluationRecord(passingRecord(), corpusText())).toMatchObject({ ok: true });
    });

    it(`a type with fewer than ${PII_MIN_SUPPORT} ground-truth spans in a locale is refused — never "1 of 1"`, () => {
        const { text, record } = thinned('bg', 'BG_EGN');
        expect(checkPiiEvaluationRecord(record, text)).toEqual({ ok: false, reason: 'LOW_SUPPORT', detail: 'below 20: BG_EGN/bg 19' });
    });

    it('support is asked before the floors: a thin corpus is not judged on a rate it cannot carry', () => {
        const { text, record } = thinned('en', 'IBAN_CODE');
        answerOf(record, taskId('en', 'IBAN_CODE', 1)).spans = [];
        answerOf(record, taskId('en', 'IBAN_CODE', 2)).spans = [];
        expect(checkPiiEvaluationRecord(record, text)).toMatchObject({ ok: false, reason: 'LOW_SUPPORT' });
    });

    it('two misses in one type and locale fall below the recall floor; one does not', () => {
        const rec = passingRecord();
        answerOf(rec, taskId('en', 'IBAN_CODE', 0)).spans = [];
        expect(checkPiiEvaluationRecord(rec, corpusText()).ok).toBe(true); // 19/20 = 0.95
        answerOf(rec, taskId('en', 'IBAN_CODE', 1)).spans = [];
        expect(checkPiiEvaluationRecord(rec, corpusText())).toEqual({ ok: false, reason: 'BELOW_FLOOR', detail: 'IBAN_CODE/en recall 18/20' });
    });

    it('false positives on a refusal case count against precision, and every shortfall is named', () => {
        const rec = passingRecord();
        answerOf(rec, 'en-refusal-1').spans = Array.from({ length: 6 }, (_, i) => ({ type: 'PERSON', start: i, end: i + 1, score: 0.5 }));
        answerOf(rec, taskId('bg', 'PHONE_NUMBER', 0)).spans = [];
        answerOf(rec, taskId('bg', 'PHONE_NUMBER', 1)).spans = [];
        // en/PERSON: 21 correct of 27 predicted.
        expect(checkPiiEvaluationRecord(rec, corpusText())).toEqual({
            ok: false,
            reason: 'BELOW_FLOOR',
            detail: 'PERSON/en precision 21/27, PHONE_NUMBER/bg recall 18/20',
        });
    });

    it('a record that answered an earlier corpus is CORPUS_MISMATCH, even with its digest re-stamped', () => {
        const earlier = corpusText();
        const c = corpus();
        c.cases.push({ id: 'bg-task-hard-1', kind: 'task', locale: 'bg', text: 'Hijklmn и тест', spans: [{ type: 'PERSON', start: 0, end: 7 }] });
        const committed = corpusText(c);
        const old = passingRecord(earlier);
        expect(checkPiiEvaluationRecord(old, committed)).toMatchObject({ ok: false, reason: 'CORPUS_MISMATCH' });
        // Re-stamping the digest does not help: the new case is unanswered.
        expect(checkPiiEvaluationRecord({ ...old, corpusDigest: passingRecord(committed).corpusDigest }, committed)).toMatchObject({
            ok: false,
            reason: 'UNANSWERED_CASE',
        });
    });

    it('a record carrying its own rates is malformed: a stored figure is never read', () => {
        expect(checkPiiEvaluationRecord(passingRecord(corpusText(), { recall: { PERSON: 1 } }), corpusText())).toMatchObject({
            ok: false,
            reason: 'MALFORMED_RECORD',
        });
    });

    it('records are produced at the threshold the mounted provider asks for', () => {
        // A provider asking for a higher threshold than its record was measured
        // at would answer less than the record vouches for.
        const evaluate = fs.readFileSync(path.join(REPO, 'guards', 'presidio', 'evaluate.py'), 'utf8');
        const declared = /^SCORE_THRESHOLD = ([0-9.]+)$/m.exec(evaluate);
        expect({
            declared: declared ? Number(declared[1]) : null,
            passedToAnalyze: evaluate.split('score_threshold=SCORE_THRESHOLD').length - 1,
        }).toEqual({ declared: PII_SCORE_THRESHOLD, passedToAnalyze: 1 });
    });

    it('the committed Phase 0 record does not mount: its corpus is below the minimum support', () => {
        expect(checkPiiEvaluationRecord(COMMITTED_RECORD, COMMITTED_CORPUS)).toEqual({
            ok: false,
            reason: 'LOW_SUPPORT',
            detail:
                'below 20: EMAIL_ADDRESS/en 9, PHONE_NUMBER/en 8, IBAN_CODE/en 6, BG_EGN/en 7, ' +
                'EMAIL_ADDRESS/bg 8, PHONE_NUMBER/bg 10, IBAN_CODE/bg 5, BG_EGN/bg 7',
        });
    });
});

describe('resolvePiiDetector', () => {
    it('no base URL constructs nothing', () => {
        expect(resolvePiiDetector({ baseUrl: undefined, configHash: CONFIG_HASH })).toEqual({ state: 'ABSENT' });
    });

    it('a base URL with no config hash is UNMOUNTED(NO_CONFIG_HASH)', () => {
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: undefined, root: rootWith({ 'r.json': passingRecord() }) })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_CONFIG_HASH',
        });
    });

    it.each(['https://203.0.113.5', 'http://169.254.169.254', 'http://metadata.google.internal', 'ftp://presidio', 'http://u:p@presidio', 'not a url'])(
        '%s is not an in-deployment address → UNMOUNTED(BASE_URL_OUTSIDE_DEPLOYMENT)',
        (baseUrl) => {
            expect(resolvePiiDetector({ baseUrl, configHash: CONFIG_HASH, root: rootWith({ 'r.json': passingRecord() }) })).toMatchObject({
                state: 'UNMOUNTED',
                reason: 'BASE_URL_OUTSIDE_DEPLOYMENT',
            });
        },
    );

    it('no record for the deployed configuration is UNMOUNTED(NO_RECORD)', () => {
        expect(resolveIn(rootWith({ 'r.json': withDetector(passingRecord(), { configHash: OTHER_CONFIG_HASH }) }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_RECORD',
        });
    });

    it('a record with no committed corpus beside it is UNMOUNTED(NO_CORPUS)', () => {
        expect(resolveIn(rootWith({ 'r.json': passingRecord() }, null))).toMatchObject({ state: 'UNMOUNTED', reason: 'NO_CORPUS' });
    });

    it('a record that answered another corpus does not mount', () => {
        const c = corpus();
        c.cases.push({ id: 'bg-task-hard-2', kind: 'task', locale: 'bg', text: 'Opqrstu и тест', spans: [{ type: 'PERSON', start: 0, end: 7 }] });
        expect(resolveIn(rootWith({ 'r.json': passingRecord() }, corpusText(c)))).toMatchObject({ state: 'UNMOUNTED', reason: 'CORPUS_MISMATCH' });
    });

    it('an unreadable record file refuses the mount rather than being skipped', () => {
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': '{not json' }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'RECORDS_UNREADABLE',
        });
    });

    it('the newest record for the configuration decides; an older pass does not stand in', () => {
        const failing = passingRecord(corpusText(), { ranAt: '2026-11-12T00:00:00.000Z' });
        answerOf(failing, taskId('en', 'IBAN_CODE', 0)).spans = [];
        answerOf(failing, taskId('en', 'IBAN_CODE', 1)).spans = [];
        expect(resolveIn(rootWith({ 'old.json': passingRecord(), 'new.json': failing }))).toMatchObject({ state: 'UNMOUNTED', reason: 'BELOW_FLOOR' });
    });

    it('newest is the instant, not the string: a fractional second is later than the whole one', () => {
        const older = passingRecord(corpusText(), { ranAt: '2026-11-12T00:00:00Z' });
        const newer = passingRecord(corpusText(), { ranAt: '2026-11-12T00:00:00.500Z' });
        answerOf(newer, taskId('en', 'IBAN_CODE', 0)).spans = [];
        answerOf(newer, taskId('en', 'IBAN_CODE', 1)).spans = [];
        // File names put the newer one first, so neither name nor string order rescues it.
        expect(resolveIn(rootWith({ 'a.json': newer, 'z.json': older }))).toMatchObject({ state: 'UNMOUNTED', reason: 'BELOW_FLOOR' });
    });

    it('a malformed record for the configuration refuses the mount — it cannot sort itself out of the way', () => {
        const noDate = passingRecord();
        delete noDate.ranAt;
        expect(resolveIn(rootWith({ 'a-old.json': passingRecord(), 'z-new.json': noDate }))).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'MALFORMED_RECORD',
            detail: expect.stringContaining('z-new.json'),
        });
    });

    it('a record naming no configuration cannot be ruled out, so it refuses too', () => {
        const unnamed = passingRecord();
        delete unnamed.detector.configHash;
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': unnamed }))).toMatchObject({ state: 'UNMOUNTED', reason: 'MALFORMED_RECORD' });
    });

    it("a malformed record for ANOTHER configuration is not this deployment's concern", () => {
        const other = withDetector(passingRecord(), { configHash: OTHER_CONFIG_HASH });
        delete other.ranAt;
        expect(resolveIn(rootWith({ 'a.json': passingRecord(), 'b.json': other }))).toMatchObject({ state: 'MOUNTED' });
    });

    it('a record made by the stub never mounts the Presidio provider', () => {
        const stubRecord = withDetector(passingRecord(), { name: 'stub' });
        expect(resolveIn(rootWith({ 'r.json': stubRecord }))).toMatchObject({ state: 'UNMOUNTED', reason: 'DETECTOR_MISMATCH' });
    });

    it('a passing record mounts a detector that dials inside the deployment at the record threshold', async () => {
        const bodies: unknown[] = [];
        mockFetch.mockImplementation(async (_url, init) => {
            bodies.push(JSON.parse(String(init.body)));
            return new Response('[]', { status: 200 });
        });
        const res = resolveIn(rootWith({ 'r.json': passingRecord() }));
        if (res.state !== 'MOUNTED') throw new Error(`expected MOUNTED, got ${JSON.stringify(res)}`);
        expect(res.record).toEqual({ detector: 'presidio@test-version', configHash: CONFIG_HASH, ranAt: '2026-11-11T00:00:00.000Z' });
        await res.detector.analyze('hello', 'en');
        expect(mockLookup).toHaveBeenCalledWith('presidio', expect.anything());
        expect(bodies).toEqual([expect.objectContaining({ score_threshold: PII_SCORE_THRESHOLD })]);
    });

    it('the committed tree mounts nothing today: no record for an unknown configuration …', () => {
        // Run from the repository root, as the app is.
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root: REPO })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_RECORD',
        });
    });

    it('… and Phase 0’s record, for its own configuration, falls short of the minimum support', () => {
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: COMMITTED_RECORD.detector.configHash, root: REPO })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'LOW_SUPPORT',
        });
    });
});
