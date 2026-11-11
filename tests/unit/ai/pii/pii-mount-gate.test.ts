/**
 * The mount gate: the Presidio detector is constructed only when a committed
 * record answers the deployed configuration and its RECOMPUTED rates clear the
 * floors. Invariants:
 *
 *   - unset base URL constructs nothing (ABSENT);
 *   - a configured detector without a passing record is UNMOUNTED, by name;
 *   - recall is strict (a partial cover is a miss) and zero support is never
 *     a pass;
 *   - the newest record for the configuration decides, never an older pass;
 *   - the committed records directory holds no record today, so a configured
 *     deployment stays unmounted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkPiiEvaluationRecord, computePiiRates, PiiEvaluationRecordSchema } from '@/lib/ai/pii/evaluation-record';
import { resolvePiiDetector } from '@/lib/ai/pii/mount';

import { CONFIG_HASH, OTHER_CONFIG_HASH, passingRecord } from './pii-record-helpers';

const BASE = 'https://pii.internal.test';

const made: string[] = [];
afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function dirWith(records: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-records-'));
    made.push(dir);
    for (const [name, value] of Object.entries(records)) {
        fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    }
    return dir;
}

describe('the record check recomputes from raw answers', () => {
    it('a passing record passes', () => {
        expect(checkPiiEvaluationRecord(passingRecord()).ok).toBe(true);
    });

    it('a partial cover of an expected span is a miss — the uncovered characters would leave', () => {
        const rec = PiiEvaluationRecordSchema.parse(passingRecord());
        const c = rec.cases.find((x) => x.caseId === 'pos-bg-EGN');
        if (!c) throw new Error('fixture case missing');
        c.predicted = [{ type: 'EGN', start: 4, end: 13 }];
        expect(computePiiRates(rec).bg.EGN).toEqual({ support: 1, recalled: 0, predicted: 1, precise: 1 });
    });

    it('a cover stitched from several same-type spans is a hit; a cover by another type is not', () => {
        const rec = PiiEvaluationRecordSchema.parse(passingRecord());
        const c = rec.cases.find((x) => x.caseId === 'pos-en-PHONE');
        if (!c) throw new Error('fixture case missing');
        c.predicted = [
            { type: 'PHONE', start: 4, end: 9 },
            { type: 'PHONE', start: 9, end: 14 },
        ];
        expect(computePiiRates(rec).en.PHONE.recalled).toBe(1);
        // Two same-type spans with a gap between them leave the gap uncovered.
        c.predicted = [
            { type: 'PHONE', start: 4, end: 6 },
            { type: 'PHONE', start: 8, end: 14 },
        ];
        expect(computePiiRates(rec).en.PHONE.recalled).toBe(0);
        c.predicted = [{ type: 'EGN', start: 4, end: 14 }];
        expect(computePiiRates(rec).en.PHONE.recalled).toBe(0);
    });

    it('a type with no support in a locale is refused, never a vacuous 100 %', () => {
        const rec = passingRecord();
        rec.cases = rec.cases.filter((c) => c.caseId !== 'pos-bg-EGN');
        expect(checkPiiEvaluationRecord(rec)).toMatchObject({ ok: false, reason: 'NO_SUPPORT', detail: 'EGN/bg' });
    });

    it('a missing case kind is refused', () => {
        const rec = passingRecord();
        rec.cases = rec.cases.filter((c) => c.kind !== 'near-miss');
        expect(checkPiiEvaluationRecord(rec)).toMatchObject({ ok: false, reason: 'MISSING_KIND' });
    });

    it('false positives on negative cases count against precision', () => {
        const rec = passingRecord();
        const neg = rec.cases.find((c) => c.kind === 'negative');
        if (!neg) throw new Error('fixture case missing');
        neg.predicted = [
            { type: 'PERSON', start: 0, end: 3 },
            { type: 'PERSON', start: 5, end: 8 },
        ];
        // en/PERSON: 1 precise of 3 predicted.
        expect(checkPiiEvaluationRecord(rec)).toMatchObject({ ok: false, reason: 'BELOW_FLOOR', detail: 'PERSON/en precision 1/3' });
    });

    it('a negative case that expects spans is malformed', () => {
        const rec = passingRecord();
        const neg = rec.cases.find((c) => c.kind === 'negative');
        if (!neg) throw new Error('fixture case missing');
        neg.expected = [{ type: 'PERSON', start: 0, end: 3 }];
        expect(checkPiiEvaluationRecord(rec)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    });

    it('a record carrying its own rates is malformed: a stored figure is never read', () => {
        expect(checkPiiEvaluationRecord(passingRecord({ precision: { PERSON: 1 } }))).toMatchObject({ ok: false, reason: 'MALFORMED' });
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
        expect(resolvePiiDetector({ ...opts, recordsDir: dirWith({ 'r.json': passingRecord() }) })).toMatchObject({
            state: 'UNMOUNTED',
            reason,
        });
    });

    it('no record for the deployed configuration is UNMOUNTED(NO_RECORD)', () => {
        const dir = dirWith({ 'r.json': passingRecord({ configHash: OTHER_CONFIG_HASH }) });
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, recordsDir: dir })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_RECORD',
        });
    });

    it('an unreadable record file refuses the mount rather than being skipped', () => {
        const dir = dirWith({ 'a.json': passingRecord(), 'b.json': '{not json' });
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, recordsDir: dir })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'RECORDS_UNREADABLE',
        });
    });

    it('the newest record for the configuration decides; an older pass does not stand in', () => {
        const failing = passingRecord({ producedAt: '2026-11-12T00:00:00.000Z' });
        failing.cases = failing.cases.filter((c) => c.caseId !== 'pos-en-IBAN');
        const dir = dirWith({ 'old.json': passingRecord(), 'new.json': failing });
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, recordsDir: dir })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'NO_SUPPORT',
        });
    });

    it('a passing record mounts a detector that asks for the record threshold', async () => {
        const bodies: unknown[] = [];
        const res = resolvePiiDetector({
            baseUrl: BASE,
            configHash: CONFIG_HASH,
            recordsDir: dirWith({ 'r.json': passingRecord() }),
            fetchImpl: async (_url, init) => {
                bodies.push(JSON.parse(String(init.body)));
                return new Response('[]', { status: 200 });
            },
        });
        if (res.state !== 'MOUNTED') throw new Error(`expected MOUNTED, got ${JSON.stringify(res)}`);
        expect(res.record).toEqual({
            detector: 'presidio-analyzer@test-revision',
            configHash: CONFIG_HASH,
            producedAt: '2026-11-11T00:00:00.000Z',
        });
        await res.detector.analyze('hello', 'en');
        expect(bodies).toEqual([expect.objectContaining({ score_threshold: 0.4 })]);
    });

    it('the committed records directory mounts nothing today', () => {
        // Run from the repository root, as the app is. Phase 0 commits the first
        // record; until then a configured deployment must stay unmounted.
        const res = resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH });
        expect(res).toMatchObject({ state: 'UNMOUNTED', reason: 'NO_RECORD' });
    });
});
