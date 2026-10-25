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
 *   - suspicious — only `medium`/`low` rules fired (generic high-entropy shape).
 *   - clean      — nothing fired.
 *
 * Pure + deterministic.
 */
import { EGRESS_RULES, type GuardSeverity } from './patterns';
import type { GuardVerdict, ScanResult } from './injection-scanner';

const SEVERITY_RANK: Record<GuardSeverity, number> = { low: 0, medium: 1, high: 2 };

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

/**
 * How deep the walk goes before it refuses to vouch for what is below (#4206).
 *
 * Was 12, and content past it was DROPPED — so a secret nested 13 levels deep
 * left through a `clean` verdict. Unscanned read as safe, which is the failure
 * this scanner exists to prevent.
 *
 * Raised to 64 rather than merely made fail-closed, on the owner's decision.
 * Measured first: across the 222 tests that exercise this guard, ZERO payloads
 * reach even depth 12, so 64 is unreachable by anything the product legitimately
 * produces — and a payload nesting 64 deep is itself evidence of something odd
 * rather than a shape to accommodate. That makes a false refusal implausible
 * instead of merely unmeasured, which is the difference between a limit nobody
 * has hit and a limit nobody can hit by accident.
 */
export const EGRESS_SCAN_MAX_DEPTH = 64;

/** The rule id a refusal for unreadable depth carries. */
export const EGRESS_UNSCANNED_DEPTH_RULE = 'egr.unscanned.depth_exceeded';

/** Strings gathered from a payload, and whether any of it went unread. */
interface Collected {
    readonly strings: string[];
    /** True when the walk stopped before the bottom — see the constant above. */
    truncated: boolean;
}

/**
 * Flatten a payload to its strings — KEYS INCLUDED.
 *
 * It read `Object.values` only, so a secret used as an object key was never
 * scanned: `{ <an AWS access-key shape>: 1 }` returned `clean`. A key is attacker-
 * controllable wherever the schema is open — an external MCP read tool's
 * arguments are `z.record(z.string(), z.unknown())` and are forwarded to a
 * third-party server — so the key half is not a theoretical hole. Scanning keys
 * changed no existing verdict: all 222 tests across this guard's 15 suites pass
 * with it.
 */
function collectStrings(value: unknown, c: Collected, depth = 0): void {
    if (depth > EGRESS_SCAN_MAX_DEPTH) {
        c.truncated = true;
        return;
    }
    if (typeof value === 'string') {
        c.strings.push(value);
    } else if (Array.isArray(value)) {
        for (const v of value) collectStrings(v, c, depth + 1);
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            c.strings.push(k);
            collectStrings(v, c, depth + 1);
        }
    }
}

export function scanEgress(payload: unknown): ScanResult {
    const collected: Collected = { strings: [], truncated: false };
    collectStrings(payload, collected);
    const leaves = collected.strings;

    // UNSCANNED IS NOT CLEAN. Both early returns below say `clean`, which is a
    // claim about content — so neither may be reached when some of the payload
    // was never read. Checked before them for exactly that reason.
    if (collected.truncated) return unscannable();

    if (leaves.length === 0) return { verdict: 'clean', ruleIds: [] };

    const combined = foldForEgress(leaves.join('\n'));
    if (!combined) return { verdict: 'clean', ruleIds: [] };

    const ruleIds: string[] = [];
    let maxRank = -1;
    let maxSeverity: GuardSeverity | undefined;

    for (const rule of EGRESS_RULES) {
        if (rule.test(combined)) {
            ruleIds.push(rule.id);
            if (SEVERITY_RANK[rule.severity] > maxRank) {
                maxRank = SEVERITY_RANK[rule.severity];
                maxSeverity = rule.severity;
            }
        }
    }

    if (ruleIds.length === 0) return { verdict: 'clean', ruleIds: [] };
    const verdict: GuardVerdict = maxSeverity === 'high' ? 'malicious' : 'suspicious';
    return { verdict, ruleIds, maxSeverity };
}

/**
 * The verdict for a payload this scanner could not read to the bottom.
 *
 * `malicious` because that is the vocabulary's only blocking value and the
 * owner's decision was to REFUSE — `suspicious` is treated as "proceed" by
 * several of this guard's sixteen callers, which would leave the hole open.
 *
 * It is not a claim that the content IS malicious, and the rule id is where the
 * truth lives: `egr.unscanned.depth_exceeded` says the scanner declined rather
 * than that it found something. Rule ids are already the field callers log and
 * operators filter on, and they carry no user content, so the distinction
 * survives into the record even though the verdict cannot express it.
 */
function unscannable(): ScanResult {
    return {
        verdict: 'malicious',
        ruleIds: [EGRESS_UNSCANNED_DEPTH_RULE],
        maxSeverity: 'high',
    };
}
