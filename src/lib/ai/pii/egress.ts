/**
 * THE EGRESS USE OF THE PII DETECTOR (Phase 1.3) — and the one place its
 * outage policy is decided.
 *
 * `redactForEgress` takes text bound for a model and answers what may leave.
 * No product path calls it yet: Phase 2 adds the tenant setting
 * (`aiPiiRedaction`) and wires this beside `guardEgress` for every engine, so
 * the tenant's mode arrives here as a parameter.
 *
 * The decision, in order (each step is a test in `pii-egress.test.ts`):
 *
 *   1. LOCAL route (`inflect-local`) → PASS, untouched. D-L1-1: LOCAL_ONLY is
 *      off; nothing on that route leaves the perimeter.
 *   2. Tenant mode OFF → PASS. The detector is not called.
 *   3. Deployment has no detector (ABSENT) → PASS. The second key is missing,
 *      so redaction is off for everyone (G9's "absent config constructs
 *      nothing"; Phase 2.1's "absent AI_PII_BASE_URL = OFF").
 *   4. Mode REDACT and the detector is UNMOUNTED or fails in any way →
 *      BLOCKED, `PII_DETECTOR_UNAVAILABLE`. Fail CLOSED: the alternative is
 *      sending the text unredacted to a tenant that asked for redaction.
 *   5. Mode FLAG and the detector fails → the text leaves unchanged, as FLAG
 *      always sends it, with the failure recorded. FLAG never changes what
 *      leaves, so blocking on a FLAG outage would be stricter than FLAG itself.
 *   6. Otherwise the text is analysed in EVERY D-L1-1 locale and the spans are
 *      unioned. The text's language is not a guess this function makes: a
 *      Bulgarian workspace's prompt carries English names and the reverse, and
 *      a span missed because the wrong locale was chosen is a leak.
 *
 * A BLOCKED or FLAG_UNAVAILABLE outcome is logged with the detector and the
 * reason — never the text.
 */
import { logger } from '@/lib/observability';

import { PII_LOCALES, redactionAppliesToRoute, type PiiEgressRoute, type PiiEntityType } from './scope';
import type { PiiDetectorResolution } from './mount';
import { EGRESS_REDACTION_POLICY } from './policy';
import { countByType, redact } from './redact';
import type { PiiAnalyzeOptions, PiiRedaction, PiiSpan } from './types';

/** The tenant's mode; Phase 2 stores it on `TenantSecuritySettings.aiPiiRedaction`. */
export type PiiRedactionMode = 'OFF' | 'FLAG' | 'REDACT';

export interface PiiEgressInput {
    readonly text: string;
    readonly route: PiiEgressRoute;
    readonly mode: PiiRedactionMode;
}

export type PiiCounts = Partial<Record<PiiEntityType, number>>;

export type PiiEgressOutcome =
    | { readonly outcome: 'PASS'; readonly reason: 'LOCAL_ROUTE' | 'REDACTION_OFF' | 'DETECTOR_ABSENT'; readonly text: string }
    | { readonly outcome: 'REDACTED'; readonly text: string; readonly redactions: readonly PiiRedaction[]; readonly counts: PiiCounts }
    | { readonly outcome: 'FLAGGED'; readonly text: string; readonly counts: PiiCounts }
    | { readonly outcome: 'FLAG_UNAVAILABLE'; readonly text: string; readonly detail: string }
    | { readonly outcome: 'BLOCKED'; readonly reason: 'PII_DETECTOR_UNAVAILABLE'; readonly detail: string };

async function analyzeEveryLocale(
    resolution: Extract<PiiDetectorResolution, { state: 'MOUNTED' }>,
    text: string,
    opts: PiiAnalyzeOptions,
): Promise<PiiSpan[]> {
    const spans: PiiSpan[] = [];
    for (const locale of PII_LOCALES) {
        spans.push(...(await resolution.detector.analyze(text, locale, opts)));
    }
    return spans;
}

function failureDetail(resolution: PiiDetectorResolution, err: unknown): string {
    if (resolution.state === 'UNMOUNTED') return `UNMOUNTED:${resolution.reason}`;
    const reason = (err as { reason?: unknown } | null)?.reason;
    return `UNREACHABLE:${typeof reason === 'string' ? reason : err instanceof Error ? err.name : 'UNKNOWN'}`;
}

export async function redactForEgress(
    input: PiiEgressInput,
    resolution: PiiDetectorResolution,
    opts: PiiAnalyzeOptions = {},
): Promise<PiiEgressOutcome> {
    if (!redactionAppliesToRoute(input.route)) return { outcome: 'PASS', reason: 'LOCAL_ROUTE', text: input.text };
    if (input.mode === 'OFF') return { outcome: 'PASS', reason: 'REDACTION_OFF', text: input.text };
    if (resolution.state === 'ABSENT') return { outcome: 'PASS', reason: 'DETECTOR_ABSENT', text: input.text };

    let analysed: { spans: PiiSpan[]; redacted: ReturnType<typeof redact> } | null = null;
    let failure: unknown = null;
    if (resolution.state === 'MOUNTED') {
        try {
            const spans = await analyzeEveryLocale(resolution, input.text, opts);
            // `redact` validates the spans too; a malformed one throws here and
            // is a detector failure like any other.
            analysed = { spans, redacted: redact(input.text, spans, EGRESS_REDACTION_POLICY) };
        } catch (err) {
            failure = err;
        }
    }

    if (analysed === null) {
        const detail = failureDetail(resolution, failure);
        if (input.mode === 'FLAG') {
            logger.warn('pii egress: detector unavailable, FLAG sends unchanged', { detail });
            return { outcome: 'FLAG_UNAVAILABLE', text: input.text, detail };
        }
        logger.warn('pii egress: detector unavailable, egress blocked', { detail });
        return { outcome: 'BLOCKED', reason: 'PII_DETECTOR_UNAVAILABLE', detail };
    }

    const counts = countByType(analysed.redacted.redactions);
    if (input.mode === 'FLAG') return { outcome: 'FLAGGED', text: input.text, counts };
    return { outcome: 'REDACTED', text: analysed.redacted.text, redactions: analysed.redacted.redactions, counts };
}
