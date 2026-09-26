/**
 * THE GENERIC HIGH-ENTROPY EGRESS RULE, AND THE PATHS IT USED TO REFUSE.
 *
 * `egr.high_entropy_secret.token` looks for a long mixed-charset token. `/` is
 * in its character class because base64 uses it — which also made every REST
 * path a candidate, and a camelCase path carrying a digit satisfies every other
 * condition the rule asks for.
 *
 * Measured 2026-09-26 against Microsoft's Entra MCP server. The first external
 * tool call this product ever made came back with a suggested Graph query, and
 * the run parked AWAITING_APPROVAL on:
 *
 *     0/roleManagement/directory/roleAssignments
 *
 * from `GET: /v1.0/roleManagement/directory/roleAssignments`. An external tool
 * returns API paths as a matter of course, so this was not an edge case — it
 * was every run, halted for a human review with nothing to look at. The guard
 * never logs content, so the operator could not have seen what it meant.
 *
 * This file exists because the rule had NO tests of its own. Both directions
 * are asserted, because a fix to a false positive is only worth having if it
 * has not quietly become a false negative.
 */
import { EGRESS_RULES } from '@/app-layer/ai/guard/patterns';

const RULE = EGRESS_RULES.find((r) => r.id === 'egr.high_entropy_secret.token');

/** The exact string that refused the first real external tool call. */
const REFUSED = '0/roleManagement/directory/roleAssignments';

describe('egr.high_entropy_secret.token — the rule under test exists', () => {
    it('is present in EGRESS_RULES', () => {
        // Positive control: every `expect(fires(...))` below is vacuous if the
        // lookup silently returned undefined.
        expect(RULE).toBeDefined();
        expect(RULE?.severity).toBe('medium');
    });
});

const fires = (s: string): boolean => RULE!.test(s);

describe('a REST path is not a secret', () => {
    it('does not fire on the Graph path that refused the first external call', () => {
        expect(fires(REFUSED)).toBe(false);
    });

    it('does not fire on it in the sentence it actually arrived in', () => {
        expect(
            fires("GET: /v1.0/roleManagement/directory/roleAssignments?$filter=principalId eq 'x'"),
        ).toBe(false);
    });

    it.each([
        '0/directoryObjects/getMemberGroups/securityEnabledOnly',
        '0/identityGovernance/accessReviews/definitions',
        '2/deviceManagement/managedDevices/deviceCompliancePolicyStates',
    ])('does not fire on other versioned camelCase paths: %s', (path) => {
        expect(fires(path)).toBe(false);
    });
});

describe('but a secret that happens to contain a slash still fires', () => {
    it('fires on a base64 blob with one slash — the case a blanket exclusion would miss', () => {
        // This is why the fix is a DENSITY test and not "contains a slash".
        // `/` is 1 of base64's 64 characters, so a 40-char secret carries one
        // about half the time; splitting on it leaves ~26-char segments, under
        // the 32 threshold. Excluding those would blind the rule to a large
        // share of exactly what it is for.
        expect(fires('aB3xK9pQ7rT2vW5yZ8cE1gH4jL6nM0sU/dF9kR3tY7wA2bC5')).toBe(true);
    });

    it('fires on a slash-free high-entropy token', () => {
        expect(fires('aB3xK9pQ7rT2vW5yZ8cE1gH4jL6nM0sU4dF9kR3t')).toBe(true);
    });

    it('fires on a long token with two slashes spread thin', () => {
        // 2 slashes across 64 chars is 1 per 32 — below the path threshold, so
        // still treated as a blob.
        expect(fires('aB3xK9pQ7rT2vW5yZ8cE1gH4/jL6nM0sU4dF9kR3tY7wA2bC5/eG8hJ1kL4mN7pQ')).toBe(true);
    });
});

describe('the pre-existing conditions are unchanged', () => {
    it('still ignores a token with no uppercase', () => {
        expect(fires('ab3xk9pq7rt2vw5yz8ce1gh4jl6nm0su4df9kr3t')).toBe(false);
    });

    it('still ignores a token with no digit', () => {
        expect(fires('aBxxKzpQxrTxvWxyZxcExgHxjLxnMxsUxdFxkRxt')).toBe(false);
    });

    it('still ignores ordinary prose', () => {
        expect(fires('get user by user ID to check if account is enabled or disabled')).toBe(false);
    });

    it('still ignores a short token', () => {
        expect(fires('aB3xK9pQ7rT2vW5y')).toBe(false);
    });
});
