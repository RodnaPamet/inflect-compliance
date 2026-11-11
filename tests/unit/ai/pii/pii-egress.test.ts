/**
 * The egress use of the detector — the one place its outage policy lives.
 * Invariants:
 *
 *   - an outage BLOCKS egress when the tenant has redaction on (fail closed);
 *   - an unmounted detector blocks the same way: configured but unvouched;
 *   - a tenant with redaction off, a deployment with no detector, and the
 *     local route all pass untouched, and the detector is not called;
 *   - FLAG never changes what leaves, outage or not;
 *   - every D-L1-1 locale is analysed and the spans unioned.
 */
jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability';
import { redactForEgress, type PiiEgressInput } from '@/lib/ai/pii/egress';
import type { PiiDetectorResolution } from '@/lib/ai/pii/mount';
import { createStubPiiDetector } from '@/lib/ai/pii/stub-provider';
import { PiiDetectorError, type PiiDetector } from '@/lib/ai/pii/types';

const TEXT = 'Ask Zara Quillfeather (Добрина) about it.';
const RECORD = { detector: 'stub@1', configHash: `sha256:${'a'.repeat(64)}`, producedAt: '2026-11-11T00:00:00.000Z' };

function mounted(detector: PiiDetector): PiiDetectorResolution {
    return { state: 'MOUNTED', detector, record: RECORD };
}

/** A detector that knows TEXT in both locales: EN finds the Latin name, BG the Cyrillic one. */
const stub = createStubPiiDetector([
    { text: TEXT, locale: 'en', spans: [{ type: 'PERSON', start: 4, end: 21, score: 0.9 }] },
    { text: TEXT, locale: 'bg', spans: [{ type: 'PERSON', start: 23, end: 30, score: 0.9 }] },
]);

function countingDetector(inner: PiiDetector): { detector: PiiDetector; calls: () => number } {
    let n = 0;
    return {
        detector: {
            id: inner.id,
            analyze: (t, l, o) => {
                n += 1;
                return inner.analyze(t, l, o);
            },
        },
        calls: () => n,
    };
}

const down: PiiDetector = {
    id: 'presidio',
    analyze: async () => {
        throw new PiiDetectorError('EGRESS_REFUSED', 'presidio');
    },
};

const external = (mode: PiiEgressInput['mode']): PiiEgressInput => ({ text: TEXT, route: 'inflect-external', mode });

beforeEach(() => jest.clearAllMocks());

describe('fail closed: an outage blocks egress when redaction is on', () => {
    it('REDACT + unreachable detector → BLOCKED, and the text is not in the outcome or the log', async () => {
        const out = await redactForEgress(external('REDACT'), mounted(down));
        expect(out).toEqual({ outcome: 'BLOCKED', reason: 'PII_DETECTOR_UNAVAILABLE', detail: 'UNREACHABLE:EGRESS_REFUSED' });
        expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('Zara');
    });

    it('REDACT + a configured detector with no passing record → BLOCKED', async () => {
        const out = await redactForEgress(external('REDACT'), { state: 'UNMOUNTED', reason: 'NO_RECORD', detail: 'x' });
        expect(out).toEqual({ outcome: 'BLOCKED', reason: 'PII_DETECTOR_UNAVAILABLE', detail: 'UNMOUNTED:NO_RECORD' });
    });

    it('REDACT + a detector answering a malformed span → BLOCKED, never sent unredacted', async () => {
        const bad = createStubPiiDetector([
            { text: TEXT, locale: 'en', spans: [{ type: 'PERSON', start: 0, end: 999, score: 1 }] },
            { text: TEXT, locale: 'bg', spans: [] },
        ]);
        expect(await redactForEgress(external('REDACT'), mounted(bad))).toMatchObject({ outcome: 'BLOCKED' });
    });

    it('REDACT + a detector that fails in ONE locale → BLOCKED: a half-analysed text is not analysed', async () => {
        const enOnly = createStubPiiDetector([{ text: TEXT, locale: 'en', spans: [] }]);
        expect(await redactForEgress(external('REDACT'), mounted(enOnly))).toMatchObject({
            outcome: 'BLOCKED',
            detail: 'UNREACHABLE:STUB_UNKNOWN_TEXT',
        });
    });
});

describe('redaction on, detector up', () => {
    it('REDACT analyses every locale and redacts the union', async () => {
        const out = await redactForEgress(external('REDACT'), mounted(stub));
        expect(out).toEqual({
            outcome: 'REDACTED',
            text: 'Ask <PERSON_1> (<PERSON_2>) about it.',
            redactions: [
                { type: 'PERSON', action: 'REPLACE' },
                { type: 'PERSON', action: 'REPLACE' },
            ],
            counts: { PERSON: 2 },
        });
    });

    it('FLAG counts what it would redact and sends the text unchanged', async () => {
        expect(await redactForEgress(external('FLAG'), mounted(stub))).toEqual({
            outcome: 'FLAGGED',
            text: TEXT,
            counts: { PERSON: 2 },
        });
    });

    it('FLAG + outage sends unchanged and says so — FLAG never changes what leaves', async () => {
        expect(await redactForEgress(external('FLAG'), mounted(down))).toEqual({
            outcome: 'FLAG_UNAVAILABLE',
            text: TEXT,
            detail: 'UNREACHABLE:EGRESS_REFUSED',
        });
    });
});

describe('out of scope: untouched, and the detector is not called', () => {
    it.each<[string, PiiEgressInput, string]>([
        ['the local route, even with REDACT (D-L1-1: LOCAL_ONLY off)', { text: TEXT, route: 'inflect-local', mode: 'REDACT' }, 'LOCAL_ROUTE'],
        ['a tenant with redaction OFF', external('OFF'), 'REDACTION_OFF'],
    ])('%s', async (_label, input, reason) => {
        const c = countingDetector(down);
        expect(await redactForEgress(input, mounted(c.detector))).toEqual({ outcome: 'PASS', reason, text: TEXT });
        expect(c.calls()).toBe(0);
    });

    it('a deployment with no detector configured: the second key is missing, redaction is off for everyone', async () => {
        expect(await redactForEgress(external('REDACT'), { state: 'ABSENT' })).toEqual({
            outcome: 'PASS',
            reason: 'DETECTOR_ABSENT',
            text: TEXT,
        });
    });
});
