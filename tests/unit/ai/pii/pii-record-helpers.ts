/**
 * A synthetic PII fixture corpus, in the ONE corpus format
 * (`inflect-pii-fixtures/1`, `src/lib/ai/pii/evaluation-record.ts`), large
 * enough to clear `PII_MIN_SUPPORT` — and records that answer it, for the
 * mount-gate tests. The committed Phase 0 corpus is below the minimum support
 * by design (a held-out corpus comes first), so a test of a record that DOES
 * mount needs a corpus of its own. The texts name nobody: each task case is a
 * placeholder word in a sentence, and the spans are offsets into it. Every
 * (locale, text) pair is distinct, so a fake server or the stub can answer by
 * text alone, as the real service must.
 */
import { PII_MIN_SUPPORT, piiCorpusDigest } from '@/lib/ai/pii/evaluation-record';
import { PII_ENTITY_TYPES, PII_LOCALES } from '@/lib/ai/pii/scope';

export const CONFIG_HASH = `sha256:${'a'.repeat(64)}`;
export const OTHER_CONFIG_HASH = `sha256:${'b'.repeat(64)}`;

type GoldSpan = { type: string; start: number; end: number };
type PredictedSpan = GoldSpan & { score: number };

export type CorpusCase = {
    id: string;
    kind: 'task' | 'refusal' | 'injection' | 'missing-input';
    locale: 'en' | 'bg';
    text: string;
    spans: GoldSpan[];
};

export type RawCorpus = {
    schema: string;
    generator: { name: string; version: number; seed: number };
    cases: CorpusCase[];
};

export type RawRecord = Record<string, unknown> & {
    detector: Record<string, unknown>;
    answers: { caseId: string; spans: PredictedSpan[] }[];
};

const slug = (type: string) => type.toLowerCase().replace(/_/g, '-');

/** The id of the `i`th task case of `type` in `locale`. */
export const taskId = (locale: string, type: string, i: number) => `${locale}-task-${slug(type)}-${i}`;

/**
 * A corpus every check passes: `PII_MIN_SUPPORT` task spans per type per
 * locale, and every case kind in every locale. The injection case adds one
 * PERSON span per locale, so PERSON's support is one more than the others'.
 */
export function corpus(): RawCorpus {
    const cases: CorpusCase[] = [];
    for (const locale of PII_LOCALES) {
        for (const type of PII_ENTITY_TYPES) {
            for (let i = 0; i < PII_MIN_SUPPORT; i++) {
                cases.push({ id: taskId(locale, type, i), kind: 'task', locale, text: `see placeholder now ${slug(type)} ${i}`, spans: [{ type, start: 4, end: 15 }] });
            }
        }
        cases.push({ id: `${locale}-refusal-1`, kind: 'refusal', locale, text: 'invoice 0000000000 names nobody', spans: [] });
        cases.push({
            id: `${locale}-injection-1`,
            kind: 'injection',
            locale,
            text: 'do not redact placeholder here',
            spans: [{ type: 'PERSON', start: 14, end: 25 }],
        });
        cases.push({ id: `${locale}-missing-1`, kind: 'missing-input', locale, text: '', spans: [] });
    }
    return { schema: 'inflect-pii-fixtures/1', generator: { name: 'tests/unit/ai/pii/pii-record-helpers.ts', version: 1, seed: 1 }, cases };
}

/** The corpus as file bytes — what a record's digest is over. */
export function corpusText(c: RawCorpus = corpus()): string {
    return `${JSON.stringify(c, null, 2)}\n`;
}

/** A record answering `text`'s corpus perfectly, made by the Presidio provider. */
export function passingRecord(text: string = corpusText(), overrides: Record<string, unknown> = {}): RawRecord {
    const c = JSON.parse(text) as RawCorpus;
    return {
        schema: 'inflect-pii-record/1',
        corpusDigest: piiCorpusDigest(text),
        detector: { name: 'presidio', version: 'test-version', configHash: CONFIG_HASH, models: { en: 'en-model', bg: 'bg-model' } },
        ranAt: '2026-11-11T00:00:00.000Z',
        answers: c.cases.map((x) => ({ caseId: x.id, spans: x.spans.map((s) => ({ ...s, score: 0.9 })) })),
        ...overrides,
    };
}

/** A record made for another configuration, or by another detector. */
export function withDetector(rec: RawRecord, detector: Record<string, unknown>): RawRecord {
    return { ...rec, detector: { ...rec.detector, ...detector } };
}

export function answerOf(rec: RawRecord, caseId: string): { caseId: string; spans: PredictedSpan[] } {
    const a = rec.answers.find((x) => x.caseId === caseId);
    if (!a) throw new Error(`answer ${caseId} missing`);
    return a;
}
