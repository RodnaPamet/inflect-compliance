/**
 * Measuring a detector against a fixture corpus (Phase 1 test 6), through the
 * Presidio HTTP provider and the real in-deployment dial, with the network
 * mocked where the dial reaches it (`undici`, `node:dns`) until the service
 * exists. Invariants:
 *
 *   - the seam reproduces the COMMITTED Phase 0 record's figures through HTTP:
 *     a server replaying that record's answers yields a record that scores
 *     exactly as the committed one does;
 *   - a record produced through the provider is one the mount check accepts and
 *     the mount gate mounts;
 *   - a missed span measured over HTTP shows up as a recomputed shortfall;
 *   - a record made by replaying the corpus through the stub names the stub,
 *     and the mount gate refuses it.
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
    PII_SCORE_THRESHOLD,
    PiiFixtureCorpusSchema,
    scorePiiRecord,
    type PiiEvaluationRecord,
} from '@/lib/ai/pii/evaluation-record';
import { measurePiiDetector } from '@/lib/ai/pii/measure';
import { PII_CORPUS_FILE, PII_RECORDS_DIR, resolvePiiDetector } from '@/lib/ai/pii/mount';
import { createPresidioDetector } from '@/lib/ai/pii/presidio-provider';
import { isPiiEntityType, type PiiLocale } from '@/lib/ai/pii/scope';
import { createStubPiiDetector } from '@/lib/ai/pii/stub-provider';

import { CONFIG_HASH, corpusText, taskId } from './pii-record-helpers';

const BASE = 'http://presidio:3000';
const META = { version: 'image-digest-test', configHash: CONFIG_HASH, models: { en: 'en-model', bg: 'bg-model' }, ranAt: '2026-11-12T00:00:00.000Z' };
const REPO = path.resolve(__dirname, '../../../..');

type WireSpan = { type: string; start: number; end: number; score: number };

/**
 * A fake Presidio answering each (locale, text) with `answers`, in Presidio's
 * wire shape. The corpora stay in the BMP, so code-point offsets equal UTF-16.
 */
function fakePresidio(answers: Map<string, WireSpan[]>) {
    return async (_url: string, init: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init.body)) as { text: string; language: string; score_threshold: number };
        expect(body.score_threshold).toBe(PII_SCORE_THRESHOLD);
        const spans = answers.get(`${body.language}\u0000${body.text}`);
        if (!spans) return new Response('unknown text', { status: 400 });
        const wire = spans.map((s) => ({ entity_type: s.type, start: s.start, end: s.end, score: s.score }));
        return new Response(JSON.stringify(wire), { status: 200, headers: { 'content-type': 'application/json' } });
    };
}

/** The corpus's own ground truth as answers, less the cases in `drop`. */
function goldAnswers(text: string, drop: ReadonlySet<string> = new Set()): Map<string, WireSpan[]> {
    const c = PiiFixtureCorpusSchema.parse(JSON.parse(text));
    return new Map(c.cases.map((x) => [`${x.locale}\u0000${x.text}`, drop.has(x.id) ? [] : x.spans.map((s) => ({ ...s, score: 0.9 }))]));
}

const presidio = () => createPresidioDetector({ baseUrl: BASE, scoreThreshold: PII_SCORE_THRESHOLD });

const made: string[] = [];
afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function rootWith(record: unknown, text: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-measure-'));
    made.push(root);
    fs.mkdirSync(path.join(root, PII_RECORDS_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, PII_RECORDS_DIR, 'r.json'), JSON.stringify(record));
    fs.mkdirSync(path.dirname(path.join(root, PII_CORPUS_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, PII_CORPUS_FILE), text);
    return root;
}

beforeEach(() => {
    mockFetch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '172.18.0.20', family: 4 }]);
});

describe('measuring through the seam', () => {
    it('reproduces the committed Phase 0 record through HTTP: the same answers score the same', async () => {
        const committedCorpus = fs.readFileSync(path.join(REPO, PII_CORPUS_FILE), 'utf8');
        const committed = JSON.parse(fs.readFileSync(path.join(REPO, PII_RECORDS_DIR, 'e6ff3ad0d4d33dba.json'), 'utf8')) as PiiEvaluationRecord;
        const cases = PiiFixtureCorpusSchema.parse(JSON.parse(committedCorpus)).cases;
        const byId = new Map(committed.answers.map((a) => [a.caseId, a.spans]));
        // The server answers each text with what the analyzer answered in Phase 0.
        mockFetch.mockImplementation(fakePresidio(new Map(cases.map((c) => [`${c.locale}\u0000${c.text}`, byId.get(c.id) ?? []]))));

        const record = await measurePiiDetector(presidio(), committedCorpus, { ...META, configHash: committed.detector.configHash });
        const viaSeam = scorePiiRecord(record, committedCorpus);
        const original = scorePiiRecord(committed, committedCorpus);
        expect(viaSeam.ok).toBe(true);
        expect(viaSeam).toEqual(original);
        // Out-of-scope types never cross the seam (Phase 0's analyzer loads none).
        expect(record.answers.flatMap((a) => a.spans).every((s) => isPiiEntityType(s.type))).toBe(true);
    });

    it('a record measured through the Presidio HTTP provider passes the check and mounts', async () => {
        const text = corpusText();
        mockFetch.mockImplementation(fakePresidio(goldAnswers(text)));
        const record = await measurePiiDetector(presidio(), text, META);

        expect(record.detector).toEqual({ name: 'presidio', version: META.version, configHash: CONFIG_HASH, models: META.models });
        expect(checkPiiEvaluationRecord(record, text).ok).toBe(true);
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root: rootWith(record, text) })).toMatchObject({ state: 'MOUNTED' });
    });

    it('spans the service missed are recomputed as a shortfall', async () => {
        const text = corpusText();
        mockFetch.mockImplementation(fakePresidio(goldAnswers(text, new Set([taskId('bg', 'PHONE_NUMBER', 0), taskId('bg', 'PHONE_NUMBER', 1)]))));
        const record = await measurePiiDetector(presidio(), text, META);
        expect(checkPiiEvaluationRecord(record, text)).toEqual({ ok: false, reason: 'BELOW_FLOOR', detail: 'PHONE_NUMBER/bg recall 18/20' });
    });

    it('a replay through the stub names the stub, and the mount gate refuses it', async () => {
        const text = corpusText();
        const c = PiiFixtureCorpusSchema.parse(JSON.parse(text));
        const stub = createStubPiiDetector(
            c.cases.map((x) => ({ text: x.text, locale: x.locale as PiiLocale, spans: x.spans.map((s) => ({ ...s, score: 1 })) })),
        );
        const record = await measurePiiDetector(stub, text, META);
        expect(record.detector.name).toBe('stub');
        // The rates are perfect by construction — which is exactly why it must not mount.
        expect(checkPiiEvaluationRecord(record, text).ok).toBe(true);
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root: rootWith(record, text) })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'DETECTOR_MISMATCH',
        });
    });
});
