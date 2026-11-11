/**
 * `redact(text, spans, policy)` — the ONE redaction function (Phase 1.2).
 *
 * Pure: no detector, no I/O. Three properties, each held by
 * `tests/unit/ai/pii/pii-redact.test.ts`:
 *
 *   1. **Text outside every span is never changed.** The output is the input's
 *      gaps, in order, with a replacement between each — nothing else is
 *      rewritten, trimmed or normalised.
 *   2. **Overlapping spans are merged to their UNION before anything is
 *      replaced.** Replacing two overlapping spans one after the other would
 *      either double-replace or leave the overlap's tail behind; the union is
 *      the only reading in which no part of either detection survives.
 *   3. **A span is only ever WIDENED, never trimmed.** A span whose edge splits
 *      a surrogate pair is widened to the whole character, and a malformed
 *      span (negative, reversed, past the end) is refused rather than clamped:
 *      clamping a detector's mistake into range would redact somewhere else
 *      than where it pointed.
 *
 * Placeholders are numbered per type by DISTINCT value in order of first
 * appearance, so the same person named twice is `<PERSON_1>` twice — the model
 * can still follow who did what without ever seeing who.
 */
import { PII_ENTITY_TYPES, type PiiEntityType } from './entities';
import type { PiiRedaction, PiiRedactionPolicy, PiiRedactionResult, PiiSpan } from './types';

export class PiiSpanOutOfRangeError extends Error {
    constructor() {
        super('PII span outside the analysed text');
        this.name = 'PiiSpanOutOfRangeError';
    }
}

interface MergedSpan {
    readonly type: PiiEntityType;
    readonly start: number;
    readonly end: number;
}

const TYPE_ORDER: ReadonlyMap<PiiEntityType, number> = new Map(PII_ENTITY_TYPES.map((t, i) => [t, i] as const));

function isHigh(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

/** Widen a span so neither edge splits a surrogate pair. */
function widenToCharacters(text: string, start: number, end: number): [number, number] {
    let s = start;
    let e = end;
    if (s > 0 && isLow(text.charCodeAt(s)) && isHigh(text.charCodeAt(s - 1))) s -= 1;
    if (e < text.length && isLow(text.charCodeAt(e)) && isHigh(text.charCodeAt(e - 1))) e += 1;
    return [s, e];
}

/**
 * Validate, widen and merge. Exported for the property test and for a caller
 * that needs the coverage without the rewrite (a future FLAG count).
 *
 * The merged span's type is the highest-scoring contributor's; a tie goes to
 * the earlier type in `PII_ENTITY_TYPES`, so the result never depends on the
 * order a detector happened to return spans in.
 */
export function mergeSpans(text: string, spans: readonly PiiSpan[]): MergedSpan[] {
    const widened = spans.map((sp) => {
        if (
            !Number.isInteger(sp.start) ||
            !Number.isInteger(sp.end) ||
            sp.start < 0 ||
            sp.end > text.length ||
            sp.start >= sp.end
        ) {
            throw new PiiSpanOutOfRangeError();
        }
        const [start, end] = widenToCharacters(text, sp.start, sp.end);
        return { type: sp.type, start, end, score: sp.score };
    });
    widened.sort((a, b) => a.start - b.start || b.end - a.end);

    const out: MergedSpan[] = [];
    let cur: { type: PiiEntityType; start: number; end: number; score: number } | null = null;
    for (const sp of widened) {
        if (cur && sp.start < cur.end) {
            const better: boolean =
                sp.score > cur.score ||
                (sp.score === cur.score && (TYPE_ORDER.get(sp.type) ?? 0) < (TYPE_ORDER.get(cur.type) ?? 0));
            cur = {
                type: better ? sp.type : cur.type,
                score: Math.max(sp.score, cur.score),
                start: cur.start,
                end: Math.max(cur.end, sp.end),
            };
            continue;
        }
        if (cur) out.push({ type: cur.type, start: cur.start, end: cur.end });
        cur = { ...sp };
    }
    if (cur) out.push({ type: cur.type, start: cur.start, end: cur.end });
    return out;
}

export function redact(text: string, spans: readonly PiiSpan[], policy: PiiRedactionPolicy): PiiRedactionResult {
    const merged = mergeSpans(text, spans);
    const numbering = new Map<PiiEntityType, Map<string, number>>();
    const redactions: PiiRedaction[] = [];
    let out = '';
    let cursor = 0;
    for (const sp of merged) {
        out += text.slice(cursor, sp.start);
        const value = text.slice(sp.start, sp.end);
        const action = policy[sp.type];
        if (action === 'MASK') {
            out += '*'.repeat(value.length);
        } else {
            let seen = numbering.get(sp.type);
            if (!seen) {
                seen = new Map();
                numbering.set(sp.type, seen);
            }
            let n = seen.get(value);
            if (n === undefined) {
                n = seen.size + 1;
                seen.set(value, n);
            }
            out += `<${sp.type}_${n}>`;
        }
        redactions.push({ type: sp.type, action });
        cursor = sp.end;
    }
    out += text.slice(cursor);
    return { text: out, redactions };
}

/** Redactions counted by type — what a decision-log row and a metric carry (Phase 2.2). */
export function countByType(redactions: readonly PiiRedaction[]): Partial<Record<PiiEntityType, number>> {
    const counts: Partial<Record<PiiEntityType, number>> = {};
    for (const r of redactions) counts[r.type] = (counts[r.type] ?? 0) + 1;
    return counts;
}

/**
 * Convert a code-point span (Presidio's Python offsets) to UTF-16 offsets.
 * Returns null when the span does not fit the text's code points.
 */
export function codePointSpanToUtf16(text: string, start: number, end: number): [number, number] | null {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) return null;
    let cp = 0;
    let unit = 0;
    let startUnit: number | null = start === 0 ? 0 : null;
    while (unit < text.length && cp < end) {
        const code = text.codePointAt(unit) ?? 0;
        unit += code > 0xffff ? 2 : 1;
        cp += 1;
        if (cp === start) startUnit = unit;
    }
    if (cp !== end || startUnit === null) return null;
    return [startUnit, unit];
}
