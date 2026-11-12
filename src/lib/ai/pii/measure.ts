/**
 * Produce an evaluation record by asking a detector about every case of the
 * committed fixture set (Phase 0.4 / Phase 1 test 6).
 *
 * The record names the detector it asked (`detector.id`), so a record made by
 * replaying the fixtures through the stub says `stub` and the mount gate
 * refuses it for the Presidio provider (`DETECTOR_MISMATCH`): a stub answers a
 * fixture perfectly by construction and measures nothing.
 *
 * The expected spans are copied from the set, never from the detector; the
 * predictions are the detector's answer, unchanged. A detector failure
 * propagates: a record with a case left unanswered is not a record.
 */
import { checkPiiFixtureSet } from './fixture-set';
import { PII_RECORD_SCHEMA_ID, type PiiEvaluationRecord } from './evaluation-record';
import type { PiiDetector } from './types';

export interface MeasurePiiDetectorMeta {
    readonly revision: string;
    readonly configHash: string;
    readonly scoreThreshold: number;
    readonly producedAt: string;
}

export async function measurePiiDetector(
    detector: PiiDetector,
    rawFixtureSet: unknown,
    meta: MeasurePiiDetectorMeta,
): Promise<PiiEvaluationRecord> {
    const fixtures = checkPiiFixtureSet(rawFixtureSet);
    if (!fixtures.ok) throw new Error(`fixture set refused: ${fixtures.reason}: ${fixtures.detail}`);

    const cases: PiiEvaluationRecord['cases'] = [];
    // One at a time, in set order: a measurement is not a load test.
    for (const f of fixtures.set.cases) {
        const spans = await detector.analyze(f.text, f.locale);
        cases.push({
            caseId: f.caseId,
            locale: f.locale,
            kind: f.kind,
            expected: f.expected,
            predicted: spans.map((s) => ({ type: s.type, start: s.start, end: s.end })),
        });
    }
    return {
        schema: PII_RECORD_SCHEMA_ID,
        detector: { name: detector.id, revision: meta.revision },
        configHash: meta.configHash,
        fixtureDigest: fixtures.digest,
        scoreThreshold: meta.scoreThreshold,
        producedAt: meta.producedAt,
        cases,
    };
}
