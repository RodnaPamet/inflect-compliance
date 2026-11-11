/**
 * The `PiiDetector` seam (docs/ai-architecture/presidio.md, Phase 1.2).
 *
 * A detector ANALYSES: text in, spans out. It never redacts — redaction is the
 * pure `redact()` in `./redact.ts`, applied with the D-L1-1 policy in
 * `./policy.ts`, so every detector (the Presidio service, the fixture stub,
 * anything later) is redacted by the same function.
 *
 * Offsets are JavaScript string offsets (UTF-16 code units), whatever the
 * detector's own convention. Presidio is Python and counts code points; its
 * provider converts before a span leaves it (`codePointSpanToUtf16`), because a
 * code-point offset applied to a JS string lands one unit early per astral
 * character before it — and an early end is an unredacted tail.
 */
import type { PiiEntityType, PiiLocale } from './entities';

export interface PiiSpan {
    readonly type: PiiEntityType;
    /** Inclusive, UTF-16 code units. */
    readonly start: number;
    /** Exclusive, UTF-16 code units. */
    readonly end: number;
    /** The detector's confidence, 0..1. */
    readonly score: number;
}

export interface PiiAnalyzeOptions {
    /** Aborts the call; the caller's deadline, not the detector's. */
    readonly signal?: AbortSignal;
}

export interface PiiDetector {
    /** Names the detector in logs and refusals; never derived from a tenant value. */
    readonly id: string;
    /**
     * Spans of the D-L1-1 types found in `text`, read as `locale`.
     *
     * THROWS `PiiDetectorError` on any failure. It never returns `[]` for "I
     * could not tell": an empty list is a claim that the text holds no PII, and
     * the egress use sends whatever that claim lets through.
     */
    analyze(text: string, locale: PiiLocale, opts?: PiiAnalyzeOptions): Promise<readonly PiiSpan[]>;
}

/** Why a detector could not answer. Never carries the analysed text. */
export type PiiDetectorFailure =
    | 'SCHEME_REFUSED'
    | 'EGRESS_REFUSED'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'TOO_LARGE'
    | 'TEXT_TOO_LARGE'
    | 'MALFORMED_RESPONSE'
    | 'SPAN_OUT_OF_RANGE'
    | 'STUB_UNKNOWN_TEXT';

export class PiiDetectorError extends Error {
    constructor(
        readonly reason: PiiDetectorFailure,
        readonly detectorId: string,
    ) {
        // The message names the reason and the detector, and nothing the text
        // contained: a failure is logged, and the text is exactly what must not be.
        super(`PII detector ${detectorId} failed: ${reason}`);
        this.name = 'PiiDetectorError';
    }
}

/** What `redact()` does to a span of one type. */
export type PiiRedactionAction = 'REPLACE' | 'MASK';

export type PiiRedactionPolicy = Readonly<Record<PiiEntityType, PiiRedactionAction>>;

export interface PiiRedaction {
    readonly type: PiiEntityType;
    readonly action: PiiRedactionAction;
}

export interface PiiRedactionResult {
    readonly text: string;
    /** One entry per redacted span (after overlapping spans are merged), in text order. */
    readonly redactions: readonly PiiRedaction[];
}
