/**
 * AI Guard — egress / DLP scanner.
 *
 * `scanEgress(payload)` detects secret / exfil material in OUTBOUND content:
 * text sent to the model provider, and agent-proposed outputs / tool-args
 * before they can be committed. It accepts either a string or an arbitrary
 * JSON-ish payload (object / array) — the payload is flattened to its string
 * leaves and each is scanned.
 *
 * Unlike the injection scanner it does NOT lower-case (secret shapes such as
 * `AKIA…` are case-sensitive); it applies only the confidentiality-preserving
 * folds — zero-width strip, whitespace collapse, and encoded-blob decode — so
 * a base64-wrapped key is still caught. It returns a verdict + rule ids only,
 * never the raw secret material.
 *
 * Verdict mapping:
 *   - malicious  — any `high`-severity egress rule fired (a real secret shape).
 *   - suspicious — only `medium`/`low` rules fired (generic high-entropy shape),
 *                  or part of the payload lay deeper than the scanner reads.
 *   - clean      — nothing fired, and the whole payload was read.
 *
 * ═══ KEYS, AND WHAT LIES TOO DEEP (#4206) ═══
 *
 * A payload's object KEYS are scanned as well as its values, because
 * `{"AKIA…": 1}` carries the key to whoever receives the object. Each distinct
 * key is scanned on its own, against the high-severity secret-shape rules
 * only (owner decision, 2026-10-25). The generic rules stay off keys, because
 * maps keyed by ids and hashes are ordinary in tool arguments. Keys are never
 * joined with the values or with each other, so field names cannot assemble
 * into a shape that no single key has.
 *
 * Content deeper than `EGRESS_MAX_SCAN_DEPTH` is not read, which bounds the
 * walk. It is reported as `egr.unscanned.depth` (medium, so suspicious) and
 * never passed as clean: before #4206, a secret nested one level deeper than
 * the limit came back `clean`.
 *
 * Pure + deterministic.
 */
import { EGRESS_RULES, type GuardSeverity } from './patterns';
import type { GuardVerdict, ScanResult } from './injection-scanner';

const SEVERITY_RANK: Record<GuardSeverity, number> = { low: 0, medium: 1, high: 2 };

/** How deep the scanner reads. The root is depth 0. */
export const EGRESS_MAX_SCAN_DEPTH = 12;

/** Reported when part of a payload lies deeper than the scanner reads. */
export const UNSCANNED_DEPTH_RULE_ID = 'egr.unscanned.depth';

/** The rules a key is held to: real secret shapes only (owner decision, 2026-10-25). */
const KEY_RULES = EGRESS_RULES.filter((rule) => rule.severity === 'high');

/**
 * Case-preserving fold for egress: strip zero-width chars, decode embedded
 * base64/hex blobs (append plaintext), collapse whitespace — but keep case.
 */
function foldForEgress(input: string): string {
    let out = input;
    // Append base64 decodings (mirrors normalize.ts but case-preserving).
    const b64 = /[A-Za-z0-9+/]{16,}={0,2}/g;
    const extra: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = b64.exec(input)) !== null) {
        const blob = m[0];
        if (blob.replace(/=+$/, '').length % 4 === 1) continue;
        try {
            const decoded = Buffer.from(blob, 'base64').toString('utf8');
            if (/^[\x09\x0a\x0d\x20-\x7e]{4,}$/.test(decoded)) extra.push(decoded);
        } catch {
            // ignore
        }
    }
    if (extra.length) out = `${out} ${extra.join(' ')}`;
    out = out.replace(
        new RegExp('[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]', 'g'),
        '',
    );
    out = out.replace(/[ \t]+/g, ' ');
    return out;
}

interface Collected {
    /** String leaves, scanned together against every rule. */
    readonly values: string[];
    /** Distinct object keys, each scanned alone against `KEY_RULES`. */
    readonly keys: Set<string>;
    /** Whether anything that could carry text lay below the depth limit. */
    unscanned: boolean;
}

/** Flatten a payload to its string leaves and its keys, to a bounded depth. */
function collect(value: unknown, out: Collected, depth = 0): void {
    if (depth > EGRESS_MAX_SCAN_DEPTH) {
        // Not read, so not vouched for. A number or a boolean cannot carry a
        // secret shape, and an empty container carries nothing.
        if (typeof value === 'string') out.unscanned = true;
        else if (Array.isArray(value)) out.unscanned ||= value.length > 0;
        else if (value && typeof value === 'object') out.unscanned ||= Object.keys(value).length > 0;
        return;
    }
    if (typeof value === 'string') {
        out.values.push(value);
    } else if (Array.isArray(value)) {
        for (const v of value) collect(v, out, depth + 1);
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            out.keys.add(k);
            collect(v, out, depth + 1);
        }
    }
}

export function scanEgress(payload: unknown): ScanResult {
    const collected: Collected = { values: [], keys: new Set(), unscanned: false };
    collect(payload, collected);

    // Rule id → severity, in the order found: values in table order, then a
    // rule only a key fired, then the depth report.
    const fired = new Map<string, GuardSeverity>();

    const combined = collected.values.length > 0 ? foldForEgress(collected.values.join('\n')) : '';
    if (combined) {
        for (const rule of EGRESS_RULES) {
            if (rule.test(combined)) fired.set(rule.id, rule.severity);
        }
    }
    for (const key of collected.keys) {
        const folded = foldForEgress(key);
        if (!folded) continue;
        for (const rule of KEY_RULES) {
            if (!fired.has(rule.id) && rule.test(folded)) fired.set(rule.id, rule.severity);
        }
    }
    if (collected.unscanned) fired.set(UNSCANNED_DEPTH_RULE_ID, 'medium');

    if (fired.size === 0) return { verdict: 'clean', ruleIds: [] };
    let maxSeverity: GuardSeverity = 'low';
    for (const severity of fired.values()) {
        if (SEVERITY_RANK[severity] > SEVERITY_RANK[maxSeverity]) maxSeverity = severity;
    }
    const verdict: GuardVerdict = maxSeverity === 'high' ? 'malicious' : 'suspicious';
    return { verdict, ruleIds: [...fired.keys()], maxSeverity };
}
