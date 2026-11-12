/**
 * Measuring a detector against the committed set (Phase 1 test 6, over the
 * provider's test seam until the service exists). Invariants:
 *
 *   - a record produced THROUGH the Presidio HTTP provider is one the record
 *     check accepts and the mount gate mounts: the seam reproduces the set's
 *     answers, offsets converted, over HTTP;
 *   - a missed span measured over HTTP shows up as a recomputed shortfall;
 *   - a record made by replaying the set through the stub names the stub, and
 *     the mount gate refuses it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PRESIDIO_ENTITY_NAME, type PiiEntityType, type PiiLocale } from '@/lib/ai/pii/entities';
import { checkPiiEvaluationRecord } from '@/lib/ai/pii/evaluation-record';
import { measurePiiDetector } from '@/lib/ai/pii/measure';
import { PII_FIXTURE_SET_FILE, PII_RECORDS_DIR, resolvePiiDetector } from '@/lib/ai/pii/mount';
import { createPresidioDetector } from '@/lib/ai/pii/presidio-provider';
import { createStubPiiDetector } from '@/lib/ai/pii/stub-provider';

import { CONFIG_HASH, fixtureSet, type RawFixtureSet } from './pii-record-helpers';

const BASE = 'https://pii.internal.test';
const META = { revision: 'image-digest-test', configHash: CONFIG_HASH, scoreThreshold: 0.4, producedAt: '2026-11-12T00:00:00.000Z' };

/** A fake Presidio that answers each fixture text with its expected spans, as Presidio would (code points). */
function fakePresidio(set: RawFixtureSet, drop: ReadonlySet<string> = new Set()) {
    const answers = new Map(set.cases.map((c) => [`${c.locale}\u0000${c.text}`, drop.has(c.caseId) ? [] : c.expected]));
    return async (_url: string, init: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init.body)) as { text: string; language: string };
        const spans = answers.get(`${body.language}\u0000${body.text}`);
        if (!spans) return new Response('unknown text', { status: 400 });
        const wire = spans.map((s) => ({ entity_type: PRESIDIO_ENTITY_NAME[s.type as PiiEntityType], start: s.start, end: s.end, score: 0.9 }));
        return new Response(JSON.stringify(wire), { status: 200, headers: { 'content-type': 'application/json' } });
    };
}

const made: string[] = [];
afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function rootWith(record: unknown, set: RawFixtureSet): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-measure-'));
    made.push(root);
    fs.mkdirSync(path.join(root, PII_RECORDS_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, PII_RECORDS_DIR, 'r.json'), JSON.stringify(record));
    fs.mkdirSync(path.dirname(path.join(root, PII_FIXTURE_SET_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, PII_FIXTURE_SET_FILE), JSON.stringify(set));
    return root;
}

describe('measuring through the seam', () => {
    it('a record measured through the Presidio HTTP provider passes the check and mounts', async () => {
        const set = fixtureSet();
        const detector = createPresidioDetector({ baseUrl: BASE, scoreThreshold: META.scoreThreshold, fetchImpl: fakePresidio(set) });
        const record = await measurePiiDetector(detector, set, META);

        expect(record.detector).toEqual({ name: 'presidio', revision: META.revision });
        expect(checkPiiEvaluationRecord(record, set).ok).toBe(true);
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root: rootWith(record, set) })).toMatchObject({ state: 'MOUNTED' });
    });

    it('spans the service missed are recomputed as a shortfall', async () => {
        const set = fixtureSet();
        const missed = new Set(['pos-bg-PHONE-0', 'pos-bg-PHONE-1']);
        const detector = createPresidioDetector({ baseUrl: BASE, scoreThreshold: META.scoreThreshold, fetchImpl: fakePresidio(set, missed) });
        const record = await measurePiiDetector(detector, set, META);
        expect(checkPiiEvaluationRecord(record, set)).toMatchObject({ ok: false, reason: 'BELOW_FLOOR', detail: 'PHONE/bg recall 18/20' });
    });

    it('a replay through the stub names the stub, and the mount gate refuses it', async () => {
        const set = fixtureSet();
        const stub = createStubPiiDetector(
            set.cases.map((c) => ({
                text: c.text,
                locale: c.locale as PiiLocale,
                spans: c.expected.map((s) => ({ type: s.type as PiiEntityType, start: s.start, end: s.end, score: 1 })),
            })),
        );
        const record = await measurePiiDetector(stub, set, META);
        // The rates are perfect by construction — which is exactly why it must not mount.
        expect(checkPiiEvaluationRecord(record, set).ok).toBe(true);
        expect(resolvePiiDetector({ baseUrl: BASE, configHash: CONFIG_HASH, root: rootWith(record, set) })).toMatchObject({
            state: 'UNMOUNTED',
            reason: 'DETECTOR_MISMATCH',
        });
    });
});
