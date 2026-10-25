/**
 * The egress scanner reads object KEYS, and reports what lies too deep (#4206).
 *
 * Before #4206 the scanner read values only and stopped silently at depth 12,
 * so `{"AKIA…": 1}` and a secret nested 13 levels deep both came back `clean`.
 * They reached a third-party MCP server through every egress guard. Owner
 * decisions of 2026-10-25:
 *
 *   - a key is held to the high-severity secret-shape rules only, so a map
 *     keyed by ids or hashes stays clean;
 *   - content below the depth limit is `egr.unscanned.depth`, which makes the
 *     verdict suspicious rather than clean.
 *
 * Each refusal has a clean positive control beside it, so a scanner that
 * flagged everything would fail here too.
 */
import {
    EGRESS_MAX_SCAN_DEPTH,
    UNSCANNED_DEPTH_RULE_ID,
    scanEgress,
} from '@/app-layer/ai/guard/egress-scanner';
import { resolveEnforcement } from '@/app-layer/ai/guard/policy';

/** AWS's published example access key id. It authenticates nothing. */
const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret

/** `leaf` wrapped in `levels` objects, so it sits at depth `levels`. */
function nested(levels: number, leaf: unknown): unknown {
    let value = leaf;
    for (let i = 0; i < levels; i += 1) value = { level: value };
    return value;
}

describe('a secret used as an object key', () => {
    it('is found, as the secret shape it is', () => {
        const r = scanEgress({ [AWS_EXAMPLE_KEY]: 1 });
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toEqual(['egr.api_key.aws_access_key']);
    });

    it('is found however deep the key sits, up to the limit', () => {
        const r = scanEgress(nested(EGRESS_MAX_SCAN_DEPTH, { [AWS_EXAMPLE_KEY]: true }));
        // The key's object is at the limit and read. Its value, a boolean below
        // the limit, carries no text, so nothing is reported as unscanned.
        expect(r).toMatchObject({ verdict: 'malicious', ruleIds: ['egr.api_key.aws_access_key'] });
    });

    it('is reported once when the same secret is a key and a value', () => {
        const r = scanEgress({ [AWS_EXAMPLE_KEY]: AWS_EXAMPLE_KEY });
        expect(r.ruleIds).toEqual(['egr.api_key.aws_access_key']);
    });

    it('positive control: keys that are ids or hashes stay clean', () => {
        const byUuid = { '3f2b8c1e-9a4d-4e6f-b7a2-1c5d8e9f0a3b': { status: 'open' } };
        const byHexHash = { e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855: 'empty-file' };
        expect(scanEgress(byUuid).verdict).toBe('clean');
        expect(scanEgress(byHexHash).verdict).toBe('clean');
    });

    it('positive control: a key the generic rule WOULD flag as a value stays clean as a key', () => {
        // The base64url SHA-256 of the empty input, a public constant: the kind
        // of key a content-addressed map uses. As a value it trips the generic
        // high-entropy rule, so this proves that rule is not applied to keys.
        const contentAddress = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
        expect(scanEgress({ digest: contentAddress }).ruleIds).toEqual(['egr.high_entropy_secret.token']);
        expect(scanEgress({ [contentAddress]: { size: 0 } }).verdict).toBe('clean');
    });

    it('positive control: field names never assemble into a shape no single key has', () => {
        // The seed-phrase rule wants the word "mnemonic" and a run of short
        // lowercase words. Twelve ordinary field names, one of them
        // `mnemonic`, would satisfy it if the keys were joined into one text.
        const fields = ['mnemonic', 'name', 'email', 'status', 'owner', 'title', 'notes', 'level', 'scope', 'state', 'kind', 'label'];
        const record = Object.fromEntries(fields.map((f) => [f, 1]));
        expect(scanEgress(record).verdict).toBe('clean');
    });
});

describe('content deeper than the scanner reads', () => {
    it('a secret one level past the limit is reported, never passed as clean', () => {
        const r = scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, AWS_EXAMPLE_KEY));
        expect(r.verdict).toBe('suspicious');
        expect(r.ruleIds).toEqual([UNSCANNED_DEPTH_RULE_ID]);
    });

    it('the same secret AT the limit is read and found, so the limit is where the scanner stops', () => {
        const r = scanEgress(nested(EGRESS_MAX_SCAN_DEPTH, AWS_EXAMPLE_KEY));
        expect(r).toMatchObject({ verdict: 'malicious', ruleIds: ['egr.api_key.aws_access_key'] });
    });

    it('a 13-level nesting, the depth #4206 names, is not clean', () => {
        expect(EGRESS_MAX_SCAN_DEPTH).toBe(12);
        expect(scanEgress(nested(13, 'anything at all')).verdict).toBe('suspicious');
    });

    it('a secret found above the limit still decides the verdict', () => {
        const r = scanEgress({ shallow: AWS_EXAMPLE_KEY, deep: nested(EGRESS_MAX_SCAN_DEPTH, 'x') });
        expect(r.verdict).toBe('malicious');
        expect(r.ruleIds).toEqual(['egr.api_key.aws_access_key', UNSCANNED_DEPTH_RULE_ID]);
    });

    it('positive control: nothing that can carry text below the limit stays clean', () => {
        expect(scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, 42)).verdict).toBe('clean');
        expect(scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, true)).verdict).toBe('clean');
        expect(scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, null)).verdict).toBe('clean');
        expect(scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, {})).verdict).toBe('clean');
        expect(scanEgress(nested(EGRESS_MAX_SCAN_DEPTH + 1, [])).verdict).toBe('clean');
    });

    it('positive control: an ordinary shallow payload stays clean', () => {
        expect(scanEgress({ query: 'list open risks', filters: { status: ['OPEN'], limit: 25 } }).verdict).toBe('clean');
    });
});

describe('what an egress guard does with an unscanned payload', () => {
    // The scanner's verdict is enforced by `resolveEnforcement`. Suspicious is
    // `flag`, which every egress caller refuses or holds for review.
    it('is held for review under balanced and strict', () => {
        expect(resolveEnforcement('balanced', 'suspicious', 'egress')).toBe('flag');
        expect(resolveEnforcement('strict', 'suspicious', 'egress')).toBe('flag');
    });

    it('is recorded only under audit, which enforces no verdict at all', () => {
        expect(resolveEnforcement('audit', 'suspicious', 'egress')).toBe('allow');
        expect(resolveEnforcement('audit', 'malicious', 'egress')).toBe('allow');
    });
});
