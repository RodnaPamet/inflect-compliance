/**
 * Coverage wave E — `src/app-layer/ai/compliance-posture/parse.ts`.
 *
 * The defensive LLM-response parser. Every branch matters here because
 * this module is the blast door between an unconstrained model response
 * and the posture UI: fences, surrounding prose, missing fields, wrong
 * types, and junk advice entries all have to degrade predictably rather
 * than throw or leak a malformed result.
 *
 * The deterministic back-fill (`derivePostureScore` / `scoreToPostureLabel`
 * from `stub-provider`) is exercised for real rather than mocked — it is
 * pure, and asserting against the real derivation is what proves the
 * back-fill path is wired to the same maths the fallback uses.
 */
import { parsePostureJson } from '@/app-layer/ai/compliance-posture/parse';
import {
    derivePostureScore,
    scoreToPostureLabel,
} from '@/app-layer/ai/compliance-posture/stub-provider';
import type { PostureSummaryInput } from '@/app-layer/ai/compliance-posture/types';

const META = { provider: 'anthropic', model: 'claude-test' };

function makeInput(over: Partial<PostureSummaryInput> = {}): PostureSummaryInput {
    return {
        controls: {
            applicable: 100,
            implemented: 70,
            inProgress: 20,
            notStarted: 10,
            coveragePercent: 70,
        },
        frameworks: [],
        risks: { total: 4, critical: 0, high: 0, medium: 2, low: 2 },
        evidence: { overdue: 0, dueSoon: 1, current: 9 },
        findings: { open: 2 },
        tasks: { open: 5, overdue: 0 },
        policies: { total: 10, overdueReview: 0 },
        vendors: { overdueReview: 0 },
        maturityAverage: null,
        ...over,
    };
}

describe('parsePostureJson — JSON extraction', () => {
    it('parses a bare JSON object', () => {
        const res = parsePostureJson(
            JSON.stringify({ summaryText: 'All good.', maturityScore: 72 }),
            makeInput(),
            META,
        );
        expect(res.summaryText).toBe('All good.');
        expect(res.maturityScore).toBe(72);
    });

    it('strips a ```json fence', () => {
        const text = '```json\n{"summaryText":"Fenced."}\n```';
        expect(parsePostureJson(text, makeInput(), META).summaryText).toBe(
            'Fenced.',
        );
    });

    it('strips a bare ``` fence', () => {
        const text = '```\n{"summaryText":"Bare fence."}\n```';
        expect(parsePostureJson(text, makeInput(), META).summaryText).toBe(
            'Bare fence.',
        );
    });

    it('recovers an object embedded in surrounding prose', () => {
        const text =
            'Sure! Here is the analysis you asked for:\n' +
            '{"summaryText":"Embedded."}\n' +
            'Let me know if you need more.';
        expect(parsePostureJson(text, makeInput(), META).summaryText).toBe(
            'Embedded.',
        );
    });

    it('throws when there is no parseable JSON object at all', () => {
        expect(() =>
            parsePostureJson('I cannot help with that.', makeInput(), META),
        ).toThrow('No parseable JSON object in model response');
    });

    it('throws when braces are present but the content is not valid JSON', () => {
        expect(() =>
            parsePostureJson('prose { not: valid json } more', makeInput(), META),
        ).toThrow();
    });
});

describe('parsePostureJson — field back-fill', () => {
    it('back-fills maturityScore from the deterministic derivation when absent', () => {
        const input = makeInput();
        const res = parsePostureJson(
            JSON.stringify({ summaryText: 'No score supplied.' }),
            input,
            META,
        );
        expect(res.maturityScore).toBe(derivePostureScore(input));
    });

    it.each([
        ['a string', '"88"'],
        ['null', 'null'],
        ['NaN-producing', '"not a number"'],
    ])('back-fills maturityScore when it is %s', (_label, rawJson) => {
        const input = makeInput();
        const res = parsePostureJson(
            `{"summaryText":"x","maturityScore":${rawJson}}`,
            input,
            META,
        );
        expect(res.maturityScore).toBe(derivePostureScore(input));
    });

    it('rounds a fractional maturityScore', () => {
        const res = parsePostureJson(
            '{"summaryText":"x","maturityScore":71.6}',
            makeInput(),
            META,
        );
        expect(res.maturityScore).toBe(72);
    });

    it('accepts a valid postureLabel verbatim', () => {
        const res = parsePostureJson(
            '{"summaryText":"x","maturityScore":10,"postureLabel":"STRONG"}',
            makeInput(),
            META,
        );
        // Honoured even though the score would derive AT_RISK — the model's
        // label wins when it is one of the four known bands.
        expect(res.postureLabel).toBe('STRONG');
    });

    it('derives the postureLabel from the score when the label is unknown', () => {
        const res = parsePostureJson(
            '{"summaryText":"x","maturityScore":85,"postureLabel":"EXCELLENT"}',
            makeInput(),
            META,
        );
        expect(res.postureLabel).toBe(scoreToPostureLabel(85));
        expect(res.postureLabel).toBe('STRONG');
    });

    it('derives the postureLabel when it is absent or not a string', () => {
        expect(
            parsePostureJson(
                '{"summaryText":"x","maturityScore":45}',
                makeInput(),
                META,
            ).postureLabel,
        ).toBe('DEVELOPING');
        expect(
            parsePostureJson(
                '{"summaryText":"x","maturityScore":45,"postureLabel":7}',
                makeInput(),
                META,
            ).postureLabel,
        ).toBe('DEVELOPING');
    });

    it('defaults summaryText to empty when it is not a string', () => {
        const res = parsePostureJson(
            '{"summaryText":42,"advice":[{"title":"Do a thing"}]}',
            makeInput(),
            META,
        );
        expect(res.summaryText).toBe('');
    });
});

describe('parsePostureJson — advice coercion', () => {
    it('keeps well-formed advice items and defaults the detail', () => {
        const res = parsePostureJson(
            JSON.stringify({
                summaryText: 'x',
                advice: [
                    { title: 'Close criticals', detail: 'Do it', priority: 'high' },
                    { title: 'No detail supplied' },
                ],
            }),
            makeInput(),
            META,
        );
        expect(res.advice).toEqual([
            { title: 'Close criticals', detail: 'Do it', priority: 'high' },
            { title: 'No detail supplied', detail: '', priority: 'medium' },
        ]);
    });

    it.each(['high', 'medium', 'low'])('preserves the %s priority', (priority) => {
        const res = parsePostureJson(
            JSON.stringify({
                summaryText: 'x',
                advice: [{ title: 't', priority }],
            }),
            makeInput(),
            META,
        );
        expect(res.advice[0].priority).toBe(priority);
    });

    it('falls back to medium for an unrecognised priority', () => {
        const res = parsePostureJson(
            JSON.stringify({
                summaryText: 'x',
                advice: [{ title: 't', priority: 'URGENT' }],
            }),
            makeInput(),
            META,
        );
        expect(res.advice[0].priority).toBe('medium');
    });

    it('drops entries with no usable title, and non-object entries', () => {
        const res = parsePostureJson(
            JSON.stringify({
                summaryText: 'x',
                advice: [
                    { title: '' },
                    { title: 123 },
                    null,
                    'a string',
                    { detail: 'orphan detail' },
                    { title: 'kept' },
                ],
            }),
            makeInput(),
            META,
        );
        expect(res.advice).toEqual([
            { title: 'kept', detail: '', priority: 'medium' },
        ]);
    });

    it('yields an empty advice list when advice is not an array', () => {
        const res = parsePostureJson(
            '{"summaryText":"x","advice":{"title":"not an array"}}',
            makeInput(),
            META,
        );
        expect(res.advice).toEqual([]);
    });
});

describe('parsePostureJson — unusable responses', () => {
    it('throws when both summaryText and advice are missing', () => {
        expect(() =>
            parsePostureJson('{"maturityScore":70}', makeInput(), META),
        ).toThrow('Model response missing both summaryText and advice');
    });

    it('throws when summaryText is empty and every advice item was dropped', () => {
        expect(() =>
            parsePostureJson(
                '{"summaryText":"","advice":[{"title":""}]}',
                makeInput(),
                META,
            ),
        ).toThrow('Model response missing both summaryText and advice');
    });

    it('accepts advice-only responses (no narrative)', () => {
        const res = parsePostureJson(
            '{"summaryText":"","advice":[{"title":"Only advice"}]}',
            makeInput(),
            META,
        );
        expect(res.summaryText).toBe('');
        expect(res.advice).toHaveLength(1);
    });
});

describe('parsePostureJson — provenance', () => {
    it('stamps the provider/model and marks the result as non-fallback', () => {
        const res = parsePostureJson(
            '{"summaryText":"x"}',
            makeInput(),
            { provider: 'openrouter', model: 'some/model' },
        );
        expect(res.provider).toBe('openrouter');
        expect(res.model).toBe('some/model');
        expect(res.isFallback).toBe(false);
    });
});
