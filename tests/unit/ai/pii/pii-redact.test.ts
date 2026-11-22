/**
 * `redact()` — the one redaction function. Its properties, each stated as the
 * invariant it holds:
 *
 *   - text outside every span is never changed (property test over seeded
 *     random spans, both actions);
 *   - overlapping spans redact their UNION — no tail of either survives;
 *   - a span is widened to whole characters, never trimmed, and a malformed
 *     span is refused rather than clamped;
 *   - Presidio's code-point offsets land on the right UTF-16 units.
 */
import {
    codePointSpanToUtf16,
    countByType,
    mergeSpans,
    PiiSpanOutOfRangeError,
    redact,
} from '@/lib/ai/pii/redact';
import { EGRESS_REDACTION_POLICY, uniformPolicy } from '@/lib/ai/pii/policy';
import { PII_ENTITY_TYPES, type PiiEntityType } from '@/lib/ai/pii/scope';
import type { PiiSpan } from '@/lib/ai/pii/types';

/** Synthetic texts only: generated names, no real person. */
const TEXTS = [
    'Contact Zara Quillfeather at zq@example.test or +359 88 000 1111.',
    'Служителят Добрина Ялъмова, ЕГН 0000000000, IBAN BG00TEST00000000000000.',
    'Mixed: Добрина and Zara met 😀 twice 😀 in Plovdiv.',
    '',
    'x',
];

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function randomSpans(text: string, rand: () => number, n: number): PiiSpan[] {
    const spans: PiiSpan[] = [];
    if (text.length === 0) return spans;
    for (let i = 0; i < n; i++) {
        const a = Math.floor(rand() * text.length);
        const b = a + 1 + Math.floor(rand() * Math.min(8, text.length - a));
        const type = PII_ENTITY_TYPES[Math.floor(rand() * PII_ENTITY_TYPES.length)] as PiiEntityType;
        spans.push({ type, start: a, end: Math.min(b, text.length), score: rand() });
    }
    return spans;
}

describe('redact never changes text outside a span', () => {
    it('MASK: every code unit outside the merged spans is identical, every one inside is masked', () => {
        const rand = rng(20261111);
        for (let round = 0; round < 400; round++) {
            const text = TEXTS[round % TEXTS.length];
            const spans = randomSpans(text, rand, 1 + Math.floor(rand() * 5));
            const merged = mergeSpans(text, spans);
            const out = redact(text, spans, uniformPolicy('MASK')).text;
            expect(out.length).toBe(text.length);
            const wrong: number[] = [];
            for (let i = 0; i < text.length; i++) {
                const inside = merged.some((m) => i >= m.start && i < m.end);
                if (inside ? out[i] !== '*' : out[i] !== text[i]) wrong.push(i);
            }
            expect({ round, wrong }).toEqual({ round, wrong: [] });
        }
    });

    it('REPLACE: the output is exactly the gaps between merged spans with one placeholder between each', () => {
        const rand = rng(7);
        for (let round = 0; round < 400; round++) {
            const text = TEXTS[round % TEXTS.length];
            const spans = randomSpans(text, rand, 1 + Math.floor(rand() * 5));
            const merged = mergeSpans(text, spans);
            const out = redact(text, spans, EGRESS_REDACTION_POLICY).text;
            let rest = out;
            let cursor = 0;
            for (const m of merged) {
                const gap = text.slice(cursor, m.start);
                expect(rest.slice(0, gap.length)).toBe(gap);
                rest = rest.slice(gap.length);
                const ph = /^<(PERSON|EMAIL_ADDRESS|PHONE_NUMBER|IBAN_CODE|BG_EGN)_\d+>/.exec(rest);
                expect(ph?.[1]).toBe(m.type);
                rest = rest.slice(ph ? ph[0].length : 0);
                cursor = m.end;
            }
            expect(rest).toBe(text.slice(cursor));
        }
    });

    it('the merged spans cover every character of every input span', () => {
        // The property the MASK check leans on: if merging dropped part of a
        // span, "outside the merged spans" would include detected PII.
        const rand = rng(99);
        for (let round = 0; round < 400; round++) {
            const text = TEXTS[round % TEXTS.length];
            const spans = randomSpans(text, rand, 1 + Math.floor(rand() * 6));
            const merged = mergeSpans(text, spans);
            for (const sp of spans) {
                for (let i = sp.start; i < sp.end; i++) {
                    expect(merged.some((m) => i >= m.start && i < m.end)).toBe(true);
                }
            }
        }
    });
});

describe('overlapping spans redact their union', () => {
    it('no character of either overlapping detection survives', () => {
        const text = 'Zara Quillfeather-Smythe';
        const out = redact(
            text,
            [
                { type: 'PERSON', start: 0, end: 17, score: 0.6 },
                { type: 'PERSON', start: 5, end: 24, score: 0.9 },
            ],
            EGRESS_REDACTION_POLICY,
        );
        expect(out.text).toBe('<PERSON_1>');
        expect(out.redactions).toEqual([{ type: 'PERSON', action: 'REPLACE' }]);
    });

    it('the higher-scoring type names the merged span, independent of return order', () => {
        const text = 'call 0888000111 now';
        const a: PiiSpan = { type: 'BG_EGN', start: 5, end: 15, score: 0.4 };
        const b: PiiSpan = { type: 'PHONE_NUMBER', start: 5, end: 15, score: 0.8 };
        expect(redact(text, [a, b], EGRESS_REDACTION_POLICY).text).toBe('call <PHONE_NUMBER_1> now');
        expect(redact(text, [b, a], EGRESS_REDACTION_POLICY).text).toBe('call <PHONE_NUMBER_1> now');
    });
});

describe('placeholders', () => {
    it('number per type by distinct value, so the same person is the same placeholder', () => {
        const text = 'Zara met Ivo; Zara left.';
        const out = redact(
            text,
            [
                { type: 'PERSON', start: 0, end: 4, score: 1 },
                { type: 'PERSON', start: 9, end: 12, score: 1 },
                { type: 'PERSON', start: 14, end: 18, score: 1 },
            ],
            EGRESS_REDACTION_POLICY,
        );
        expect(out.text).toBe('<PERSON_1> met <PERSON_2>; <PERSON_1> left.');
        expect(countByType(out.redactions)).toEqual({ PERSON: 3 });
    });
});

describe('spans are widened, never trimmed, and a malformed span is refused', () => {
    it('a span splitting a surrogate pair is widened to the whole character', () => {
        const text = 'a😀b';
        // [1,2) is the high surrogate alone.
        const out = redact(text, [{ type: 'PERSON', start: 1, end: 2, score: 1 }], uniformPolicy('MASK')).text;
        expect(out).toBe('a**b');
    });

    it.each([
        ['negative start', { start: -1, end: 2 }],
        ['past the end', { start: 0, end: 99 }],
        ['reversed', { start: 3, end: 1 }],
        ['empty', { start: 2, end: 2 }],
        ['fractional', { start: 0.5, end: 2 }],
    ])('%s throws instead of clamping', (_label, range) => {
        expect(() => redact('hello', [{ type: 'PERSON', score: 1, ...range }], EGRESS_REDACTION_POLICY)).toThrow(
            PiiSpanOutOfRangeError,
        );
    });
});

describe("Presidio's code-point offsets land on the right UTF-16 units", () => {
    it('an astral character before the span shifts the span by one unit', () => {
        const text = '😀 Zara';
        // Code points: 😀=0, ' '=1, Z=2 … a=5 → [2,6) in code points.
        expect(codePointSpanToUtf16(text, 2, 6)).toEqual([3, 7]);
        expect(text.slice(3, 7)).toBe('Zara');
    });

    it('Cyrillic (BMP) offsets are unchanged', () => {
        expect(codePointSpanToUtf16('ЕГН Добрина', 4, 11)).toEqual([4, 11]);
    });

    it('a span past the text is refused, not clamped', () => {
        expect(codePointSpanToUtf16('abc', 1, 4)).toBeNull();
        expect(codePointSpanToUtf16('abc', 2, 2)).toBeNull();
    });
});
