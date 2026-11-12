/**
 * Produce an evaluation record by asking a `PiiDetector` about every case of
 * the committed fixture corpus (Phase 1 test 6) — the TypeScript twin of
 * `guards/presidio/evaluate.py`, in the one record format
 * (`./evaluation-record.ts`).
 *
 * The record names the detector it asked (`detector.id`), so a record made by
 * replaying the corpus through the stub says `stub` and the mount gate refuses
 * it for the Presidio provider (`DETECTOR_MISMATCH`): a stub answers a fixture
 * perfectly by construction and measures nothing.
 *
 * The answers are the detector's spans, unchanged; the ground truth stays in
 * the corpus, which the record names by digest and never copies. A detector
 * failure propagates: a record with a case left unanswered is not a record.
 */
import { piiCorpusDigest, PiiFixtureCorpusSchema, type PiiEvaluationRecord } from './evaluation-record';
import type { PiiDetector } from './types';

export interface MeasurePiiDetectorMeta {
    /** The detector build answered (the analyzer version, or the image digest). */
    readonly version: string;
    /** The recogniser configuration answered, as the deployment names it in `AI_PII_CONFIG_HASH`. */
    readonly configHash: string;
    /** The NER model per locale. */
    readonly models: { readonly en: string; readonly bg: string };
    readonly ranAt: string;
}

/** `corpusText` is the corpus file's exact bytes: the record's digest is over them. */
export async function measurePiiDetector(
    detector: PiiDetector,
    corpusText: string,
    meta: MeasurePiiDetectorMeta,
): Promise<PiiEvaluationRecord> {
    const corpus = PiiFixtureCorpusSchema.parse(JSON.parse(corpusText));

    const answers: PiiEvaluationRecord['answers'] = [];
    // One at a time, in corpus order: a measurement is not a load test.
    for (const c of corpus.cases) {
        const spans = await detector.analyze(c.text, c.locale);
        answers.push({ caseId: c.id, spans: spans.map((s) => ({ type: s.type, start: s.start, end: s.end, score: s.score })) });
    }
    return {
        schema: 'inflect-pii-record/1',
        corpusDigest: piiCorpusDigest(corpusText),
        detector: {
            name: detector.id,
            version: meta.version,
            configHash: meta.configHash,
            models: { en: meta.models.en, bg: meta.models.bg },
        },
        ranAt: meta.ranAt,
        answers,
    };
}
