/**
 * The deterministic, fixture-driven detector (Phase 1.2) — for tests and for
 * reproducing a record's answers without the service.
 *
 * It answers ONLY the (text, locale) pairs it was given, with exactly the spans
 * it was given, and THROWS `STUB_UNKNOWN_TEXT` for anything else. It never
 * answers `[]` for text it does not know: that would be a claim that the text
 * holds no PII, which is the claim the egress use acts on.
 *
 * It is never mounted by configuration — `./mount.ts` builds only the Presidio
 * provider — so it cannot stand in for a detector in a deployment.
 */
import type { PiiLocale } from './entities';
import { PiiDetectorError, type PiiDetector, type PiiSpan } from './types';

export interface StubAnswer {
    readonly text: string;
    readonly locale: PiiLocale;
    readonly spans: readonly PiiSpan[];
}

export const STUB_DETECTOR_ID = 'stub';

export function createStubPiiDetector(answers: readonly StubAnswer[]): PiiDetector {
    const table = new Map<string, readonly PiiSpan[]>();
    for (const a of answers) table.set(`${a.locale}\u0000${a.text}`, a.spans);
    return {
        id: STUB_DETECTOR_ID,
        async analyze(text, locale) {
            const spans = table.get(`${locale}\u0000${text}`);
            if (spans === undefined) throw new PiiDetectorError('STUB_UNKNOWN_TEXT', STUB_DETECTOR_ID);
            return spans;
        },
    };
}
