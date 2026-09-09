/**
 * Inside the jwt callback's throttled block, the session-revocation check must
 * run BEFORE the membership-claims refresh.
 *
 * The two are coupled through one field. The revocation check compares
 * `currentUser.sessionVersion > token.sessionVersion`; the refresh calls
 * `applyMembershipClaims`, which assigns `token.sessionVersion = dbUser.sessionVersion`.
 * Run the refresh first and the comparison is against a value that was just
 * overwritten with the database's own — so it can never be greater, and EVERY
 * revocation becomes a silent no-op. A revoked session would keep working until
 * its cookie expired.
 *
 * This is a structural guard, which is the weaker kind, and it is used here
 * because the stronger kind is unavailable: the ordering lives inside the
 * NextAuth `jwt` callback, which has framework-internal dependencies (cookies,
 * edge-runtime context) that make invoking it in Jest impractical — the reason
 * `tests/integration/multi-tenant-jwt.test.ts` states for testing the query
 * shape rather than the callback. The behaviour of the refresh itself IS
 * covered behaviourally, in `tests/integration/jwt-claims-refresh.test.ts`.
 *
 * Comments are stripped before matching. Without that this guard would pass on
 * the prose above it — the failure mode where a check is satisfied by a file's
 * own explanation of the check.
 */
import * as fs from 'fs';
import * as path from 'path';

const AUTH_PATH = path.resolve(__dirname, '../../src/auth.ts');

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('jwt callback — revocation precedes the claims refresh', () => {
    const source = stripComments(fs.readFileSync(AUTH_PATH, 'utf8'));

    /**
     * Everything from the start of the throttled block onwards.
     *
     * Scoping to this slice is load-bearing, and the first version of this
     * guard did not do it: `src/auth.ts` contains an EARLIER
     * `error: 'SessionRevoked'` return (the Epic C.3 session-tracker check),
     * so a whole-file `indexOf` found that one and compared it against the
     * refresh. Swapping the two lines this guard exists to order left it
     * green — it was measuring a revocation check it does not name, in a
     * block it does not describe. Verified by re-running the swap against
     * the slice below, which does fail.
     */
    const throttleIdx = source.indexOf('SESSION_CHECK_INTERVAL');
    const block = throttleIdx === -1 ? '' : source.slice(throttleIdx);

    it('the throttled block exists and contains both operations', () => {
        // Positive companion: an ordering assertion over two absent things
        // passes vacuously, and "never ran" looks identical to "ran and found
        // nothing wrong".
        expect(throttleIdx).toBeGreaterThan(-1);
        expect(block).toContain("error: 'SessionRevoked'");
        expect(block).toMatch(/await\s+applyMembershipClaims\(token\)/);
    });

    it('the revocation return sits before the refresh call, within that block', () => {
        const revokeIdx = block.indexOf("error: 'SessionRevoked'");
        const refreshIdx = block.indexOf('applyMembershipClaims(token)');
        expect(revokeIdx).toBeGreaterThan(-1);
        expect(refreshIdx).toBeGreaterThan(-1);
        expect(revokeIdx).toBeLessThan(refreshIdx);
    });

    it('the refresh is inside the throttle, not on every authenticated request', () => {
        // A refresh hoisted out of the throttle would issue a database read on
        // every authenticated request — the cost the 5-minute interval bounds.
        // If it were hoisted above the block, it would not appear in the slice.
        expect(block).toContain('applyMembershipClaims(token)');
        const before = throttleIdx === -1 ? source : source.slice(0, throttleIdx);
        // `\(token` and not `\(` alone, nor `\(token\)` exactly. Three
        // near-misses, each of which produced a wrong number before this
        // settled: `\(` also matches the function's own DEFINITION (which
        // wraps its params, so it never matches `\(token`), while
        // `\(token\)` misses the sign-in call's second argument,
        // `applyMembershipClaims(token, user.id)`.
        const callsBefore = (before.match(/applyMembershipClaims\(token/g) ?? []).length;
        // Exactly two legitimate earlier calls: the sign-in path and the
        // update-trigger path. A third means one was hoisted out of the throttle.
        expect(callsBefore).toBe(2);
    });
});
