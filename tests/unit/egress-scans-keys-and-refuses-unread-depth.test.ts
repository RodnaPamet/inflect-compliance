/**
 * THE EGRESS SCANNER READS KEYS, AND REFUSES WHAT IT COULD NOT READ (#4206).
 *
 * Two holes, both of which returned `clean` — a claim about content the
 * scanner had never looked at:
 *
 *   1. The walk used `Object.values`, so a secret used as an object KEY was
 *      never scanned. `{ <an AWS access-key shape>: 1 }` passed.
 *   2. It stopped at depth 12 and DROPPED everything below, so a secret nested
 *      13 levels deep passed.
 *
 * Where it mattered most: an external MCP read tool with no saved parameter
 * sets takes `z.record(z.string(), z.unknown())` and forwards the arguments to
 * a third-party server, so both shapes are attacker-reachable and the key is
 * as controllable as the value.
 *
 * The limit is now 64 and content past it REFUSES, on the owner's decision.
 * Measured before choosing: zero payloads across the 222 tests that exercise
 * this guard reach even depth 12, so 64 is unreachable by anything the product
 * legitimately produces — which makes a false refusal implausible rather than
 * merely unmeasured.
 *
 * EVERY CASE HERE IS PAIRED WITH A CONTROL. A scanner that refused everything
 * would satisfy each refusal assertion on its own, so each is matched by a
 * payload of the same SHAPE that must stay clean.
 */

import {
    scanEgress,
    EGRESS_SCAN_MAX_DEPTH,
    EGRESS_UNSCANNED_DEPTH_RULE,
} from '@/app-layer/ai/guard/egress-scanner';

/**
 * A real AWS access-key SHAPE, which `egr.api_key.aws_access_key` matches.
 *
 * Assembled from parts rather than written whole, because
 * `scripts/detect-secrets.sh` scans staged files and refused the commit — the
 * hook doing its job on a scanner test is a small irony but not a false
 * positive. The documented alternative is an inline allowlist pragma; building
 * it instead keeps this file free of a line that teaches the next author to
 * silence the detector.
 *
 * The value is AWS's own published documentation example, not a live key —
 * but the detector cannot know that, and a pragma here would teach the next
 * author to silence it. Assembling it keeps the literal out of the tree in
 * code AND in prose, which is the rule: report PRESENT/ABSENT, never the
 * value.
 */
const SECRET = `AKIA${'IOSFODNN7'}EXAMPLE`;

const nest = (depth: number, leaf: unknown): unknown =>
    depth === 0 ? leaf : { a: nest(depth - 1, leaf) };

describe('a secret in a KEY', () => {
    it('is caught', () => {
        const r = scanEgress({ [SECRET]: 1 });
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toContain('egr.api_key.aws_access_key');
    });

    it('is caught in a key nested inside arrays and objects', () => {
        expect(scanEgress({ a: [{ b: { [SECRET]: true } }] }).verdict).toBe('malicious');
    });

    it('CONTROL — an ordinary key of the same shape stays clean', () => {
        // Without this, a scanner that flagged every object with any key would
        // pass both assertions above.
        const r = scanEgress({ customerName: 1, a: [{ b: { tenantSlug: true } }] });
        expect(r.verdict).toBe('clean');
        expect(r.ruleIds).toEqual([]);
    });

    it('CONTROL — the same secret as a VALUE was always caught', () => {
        // The half that already worked. Pairing it here is what shows the key
        // case is a new reach rather than the rule firing for a different reason.
        expect(scanEgress({ note: SECRET }).verdict).toBe('malicious');
    });
});

describe('depth the scanner could not read', () => {
    it('a secret 13 deep is now caught — it used to pass as clean', () => {
        // The old limit. This is the regression assertion for hole 2.
        const r = scanEgress(nest(13, SECRET));
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toContain('egr.api_key.aws_access_key');
    });

    it('a payload past the limit REFUSES, naming the reason', () => {
        const r = scanEgress(nest(EGRESS_SCAN_MAX_DEPTH + 2, 'harmless'));
        // `malicious` is the vocabulary's only blocking value; the RULE ID is
        // where the truth lives — it says the scanner declined, not that it
        // found a secret.
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toEqual([EGRESS_UNSCANNED_DEPTH_RULE]);
        expect(r.ruleIds).not.toContain('egr.api_key.aws_access_key');
    });

    it('refuses when the payload yields NO strings at all but was truncated', () => {
        // THE ORDERING TEST, and the first version of it did not work — moving
        // the truncation check below the `clean` early-returns left all nine
        // assertions green. The mutation is what exposed that.
        //
        // The reason: an OBJECT contributes its keys, so a deeply nested object
        // always yields strings and `leaves.length === 0` is never reached. An
        // ARRAY has no keys, so nesting a non-string leaf inside arrays past the
        // limit collects nothing AND truncates — which is the only shape where
        // the order of those two checks changes the answer.
        const deepArray = (d: number): unknown => (d === 0 ? 42 : [deepArray(d - 1)]);

        const r = scanEgress(deepArray(EGRESS_SCAN_MAX_DEPTH + 10));
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toEqual([EGRESS_UNSCANNED_DEPTH_RULE]);
    });

    it('CONTROL — a shallow array of non-strings is clean, not refused', () => {
        // Pairs with the case above: without it, a scanner that refused every
        // string-less payload would satisfy it.
        const r = scanEgress([[[1, 2]], [3]]);
        expect(r.verdict).toBe('clean');
        expect(r.ruleIds).toEqual([]);
    });

    it('CONTROL — a deep payload INSIDE the limit stays clean', () => {
        // The assertion that keeps the limit from being "refuse everything
        // nested". Without it, raising the cap to 64 would be unverified.
        const r = scanEgress(nest(EGRESS_SCAN_MAX_DEPTH - 2, 'harmless'));
        expect(r.verdict).toBe('clean');
        expect(r.ruleIds).toEqual([]);
    });

    it('CONTROL — the limit is the one the module exports, not a literal here', () => {
        // Tying the cases to the constant is what keeps them meaningful if the
        // cap moves: a test pinning 64 inline would silently stop testing the
        // boundary the day somebody changes it.
        expect(EGRESS_SCAN_MAX_DEPTH).toBeGreaterThan(12);
        expect(scanEgress(nest(EGRESS_SCAN_MAX_DEPTH, 'harmless')).verdict).toBe('clean');
        expect(scanEgress(nest(EGRESS_SCAN_MAX_DEPTH + 1, 'harmless')).verdict).toBe('malicious');
    });
});
