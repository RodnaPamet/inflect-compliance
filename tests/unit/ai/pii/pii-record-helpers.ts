/**
 * Builds a synthetic PII fixture set and records that answer it, for the
 * mount-gate tests. The texts name nobody: each positive case is a placeholder
 * word in a sentence, and the spans are offsets into it. Phase 0's generated
 * set is what `tests/fixtures/pii/fixture-set.json` will hold.
 */
import { PII_ENTITY_TYPES, PII_LOCALES } from '@/lib/ai/pii/entities';
import { PII_RECORD_SCHEMA_ID } from '@/lib/ai/pii/evaluation-record';
import { PII_FIXTURE_SET_SCHEMA_ID, PII_MIN_SUPPORT, PiiFixtureSetSchema, piiFixtureDigest } from '@/lib/ai/pii/fixture-set';

export const CONFIG_HASH = `sha256:${'a'.repeat(64)}`;
export const OTHER_CONFIG_HASH = `sha256:${'b'.repeat(64)}`;

type Span = { type: string; start: number; end: number };

export type FixtureCase = {
    caseId: string;
    locale: 'en' | 'bg';
    kind: 'positive' | 'negative' | 'near-miss' | 'mixed-script';
    text: string;
    expected: Span[];
};

export type RecordCase = Omit<FixtureCase, 'text'> & { predicted: Span[] };

export type RawFixtureSet = { schema: string; cases: FixtureCase[] };

/** A set every check passes: PII_MIN_SUPPORT spans per type per locale, all four kinds. */
export function fixtureSet(): RawFixtureSet {
    const cases: FixtureCase[] = [];
    for (const locale of PII_LOCALES) {
        for (const type of PII_ENTITY_TYPES) {
            for (let i = 0; i < PII_MIN_SUPPORT; i++) {
                cases.push({
                    caseId: `pos-${locale}-${type}-${i}`,
                    locale,
                    kind: 'positive',
                    text: `see placeholder now ${type.toLowerCase()} ${i}`,
                    expected: [{ type, start: 4, end: 15 }],
                });
            }
        }
    }
    cases.push({ caseId: 'neg-en', locale: 'en', kind: 'negative', text: 'nothing in this sentence', expected: [] });
    cases.push({ caseId: 'near-bg', locale: 'bg', kind: 'near-miss', text: 'фактура 0000000000', expected: [] });
    cases.push({
        caseId: 'mixed-bg',
        locale: 'bg',
        kind: 'mixed-script',
        text: 'Abcdefg и тест',
        expected: [{ type: 'PERSON', start: 0, end: 7 }],
    });
    return { schema: PII_FIXTURE_SET_SCHEMA_ID, cases };
}

export function digestOf(set: RawFixtureSet): string {
    return piiFixtureDigest(PiiFixtureSetSchema.parse(set));
}

/** A record answering `set` perfectly, made by the Presidio provider. */
export function passingRecord(
    set: RawFixtureSet = fixtureSet(),
    overrides: Record<string, unknown> = {},
): Record<string, unknown> & { cases: RecordCase[] } {
    const cases: RecordCase[] = set.cases.map((c) => ({
        caseId: c.caseId,
        locale: c.locale,
        kind: c.kind,
        expected: c.expected.map((s) => ({ ...s })),
        predicted: c.expected.map((s) => ({ ...s })),
    }));
    return {
        schema: PII_RECORD_SCHEMA_ID,
        detector: { name: 'presidio', revision: 'test-revision' },
        configHash: CONFIG_HASH,
        fixtureDigest: digestOf(set),
        scoreThreshold: 0.4,
        producedAt: '2026-11-11T00:00:00.000Z',
        cases,
        ...overrides,
    };
}

export function caseOf(rec: { cases: RecordCase[] }, caseId: string): RecordCase {
    const c = rec.cases.find((x) => x.caseId === caseId);
    if (!c) throw new Error(`fixture case ${caseId} missing`);
    return c;
}
