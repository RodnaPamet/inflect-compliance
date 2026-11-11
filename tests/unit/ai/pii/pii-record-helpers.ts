/**
 * Builds synthetic PII evaluation records for the mount-gate tests. Not a
 * fixture set: the spans are offsets into texts the record does not carry, and
 * no case names anybody. Phase 0's generated set under tests/fixtures/pii/ is
 * what a committed record answers.
 */
import { PII_ENTITY_TYPES, PII_LOCALES } from '@/lib/ai/pii/entities';
import { PII_RECORD_SCHEMA_ID } from '@/lib/ai/pii/evaluation-record';

export const CONFIG_HASH = `sha256:${'a'.repeat(64)}`;
export const OTHER_CONFIG_HASH = `sha256:${'b'.repeat(64)}`;

type Case = {
    caseId: string;
    locale: 'en' | 'bg';
    kind: 'positive' | 'negative' | 'near-miss' | 'mixed-script';
    expected: { type: string; start: number; end: number }[];
    predicted: { type: string; start: number; end: number }[];
};

/** A record every check passes: each type in each locale recalled exactly, all four kinds present. */
export function passingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> & { cases: Case[] } {
    const cases: Case[] = [];
    for (const locale of PII_LOCALES) {
        for (const type of PII_ENTITY_TYPES) {
            const span = { type, start: 4, end: 14 };
            cases.push({ caseId: `pos-${locale}-${type}`, locale, kind: 'positive', expected: [span], predicted: [span] });
        }
    }
    cases.push({ caseId: 'neg-en', locale: 'en', kind: 'negative', expected: [], predicted: [] });
    cases.push({ caseId: 'near-bg', locale: 'bg', kind: 'near-miss', expected: [], predicted: [] });
    const mixed = { type: 'PERSON', start: 0, end: 7 };
    cases.push({ caseId: 'mixed-bg', locale: 'bg', kind: 'mixed-script', expected: [mixed], predicted: [mixed] });
    return {
        schema: PII_RECORD_SCHEMA_ID,
        detector: { name: 'presidio-analyzer', revision: 'test-revision' },
        configHash: CONFIG_HASH,
        fixtureDigest: `sha256:${'c'.repeat(64)}`,
        scoreThreshold: 0.4,
        producedAt: '2026-11-11T00:00:00.000Z',
        cases,
        ...overrides,
    };
}
