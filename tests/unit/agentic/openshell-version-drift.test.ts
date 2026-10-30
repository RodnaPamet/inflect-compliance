/**
 * #4567: a gateway running a release we did not verify against is drift.
 *
 * The narrow half of 5.2's second anchor. The broad version — comparing a
 * recorded config digest against what the gateway reports — needs a gRPC
 * client (#4561) to call `GetGatewayConfig`. This needs nothing new: `/readyz`
 * already carries the version, measured in phase 0.1.
 *
 * EVERY VERSION IN THIS FILE IS DERIVED FROM THE PIN. No version literal
 * appears in the source, because a literal would be read as a claim — the
 * guard in `sandbox-runtime-channels-match-the-runtime` scans every file
 * mentioning OpenShell for a release newer than the pin and cannot tell a
 * test's control input from a production assertion. It reported this file on
 * its first draft. The second reason is the one that outlives the first: a
 * hardcoded "newer" version stops being newer the moment the pin passes it, so
 * the control would go quiet and need editing by whoever upgrades — the person
 * least likely to notice it had.
 *
 * @module unit/agentic/openshell-version-drift
 */

import {
    PINNED_GATEWAY_RELEASE,
    VERSION_DRIFT_REPORTABLE,
    classifyVersionDrift,
    isNewer,
    type VersionDriftOutcome,
} from '@/lib/agentic/openshell/pinned-release';

/** The pin's segments. */
const parts = (): number[] => PINNED_GATEWAY_RELEASE.split('.').map((s) => Number(s));

/** The pin with one segment shifted by `by`. Negative shifts produce an older release. */
const shift = (index: number, by: number): string => {
    const p = parts();
    p[index] += by;
    return p.join('.');
};

/**
 * A release strictly older than the pin, whatever the pin is. Decrementing the
 * patch is wrong when the patch is 0 — it would produce a negative segment, so
 * borrow from the minor the way subtraction does.
 */
const older = (): string => {
    const p = parts();
    if (p[2] > 0) return [p[0], p[1], p[2] - 1].join('.');
    if (p[1] > 0) return [p[0], p[1] - 1, 99].join('.');
    return [p[0] - 1, 99, 99].join('.');
};

describe('comparing a reported gateway version with the pin', () => {
    it('the pin is a three-segment release, and the one the guard holds its facts against', () => {
        // One constant: the guard imports THIS, so the two cannot disagree.
        // The shape matters because every fixture below is derived from it.
        expect(PINNED_GATEWAY_RELEASE).toMatch(/^\d+\.\d+\.\d+$/);
        expect(older()).not.toBe(PINNED_GATEWAY_RELEASE);
        expect(isNewer(PINNED_GATEWAY_RELEASE, older())).toBe(true);
    });

    it('the pinned release matches', () => {
        const f = classifyVersionDrift({ reported: PINNED_GATEWAY_RELEASE });
        expect(f.outcome).toBe('matches');
        expect(f.reported).toBe(PINNED_GATEWAY_RELEASE);
    });

    it('a NEWER gateway is `ahead` — the evidence is stale, not wrong', () => {
        /*
            Every phase-0.1 fact was verified against the pin: that unset
            enforcement means audit mode, that telemetry defaults on, that the
            OCSF log records no lifecycle decision. A newer gateway may have
            changed any of them, so what is stale is the RECORDED EVIDENCE —
            and 5.3's upgrade checklist is what resolves that, not a code fix.
        */
        const f = classifyVersionDrift({ reported: shift(1, 1) });
        expect(f.outcome).toBe('ahead');
        expect(f.reason).toContain('stale');
    });

    it('an OLDER gateway is `behind` — it may be ignoring our configuration', () => {
        // Measured on this deployment: the pre-pin images lack nine flags the
        // committed config passes, three of which it depends on. A gateway that
        // started anyway is silently ignoring configuration somebody wrote.
        const f = classifyVersionDrift({ reported: older() });
        expect(f.outcome).toBe('behind');
    });

    it('ahead and behind are SEPARATE outcomes, not one `mismatch`', () => {
        // Collapsing them loses the actionable half: one is answered by an
        // upgrade of THIS REPOSITORY's recorded facts, the other by an upgrade
        // of that host. A single "mismatch" sends the reader to find out which.
        const ahead = classifyVersionDrift({ reported: shift(2, 1) });
        const behind = classifyVersionDrift({ reported: older() });
        expect(ahead.outcome).not.toBe(behind.outcome);
        expect([ahead.outcome, behind.outcome].sort()).toEqual(['ahead', 'behind']);
    });

    it('no reported version is UNVERIFIABLE, never a match', () => {
        /*
            The collapse this refuses is the one `classifyPolicyDrift` already
            refuses for hashes: defaulting an unknown to the expected value
            turns "we could not ask" into "it is correct". Here that is the
            COMMON case, not the edge — the gateway is stopped most of the time
            by design (#4571), so an unreachable probe is the normal reading.
        */
        for (const reported of [null, '']) {
            const f = classifyVersionDrift({ reported });
            expect(f.outcome).toBe('unverifiable');
            expect(f.reported).toBeNull();
        }
    });

    it('an unparseable version is unverifiable, not a mismatch', () => {
        // A git sha, a build label or `dev` is neither older nor newer than
        // anything. Calling it drift would send somebody to upgrade a host
        // whose version we simply cannot read.
        for (const reported of ['dev', 'unknown', 'abc123', `${PINNED_GATEWAY_RELEASE}+gsha`]) {
            expect(classifyVersionDrift({ reported }).outcome).toBe('unverifiable');
        }
    });

    it('a version that parses EQUAL but is not byte-equal matches', () => {
        /*
            The regression this pins. `matches` was tested with `===` on the
            strings, and `behind` was the else of `ahead` — and `isNewer`
            returns false for "older" AND for "equal". So every one of these
            was reported as a gateway ignoring our configuration, which is a
            false alarm in the alarming direction.
        */
        const p = parts();
        for (const reported of [
            `v${PINNED_GATEWAY_RELEASE}`,
            ` ${PINNED_GATEWAY_RELEASE} `,
            [p[0], p[1], p[2]].join('.'),
        ]) {
            const f = classifyVersionDrift({ reported });
            expect(f.outcome).toBe('matches');
        }
    });

    it('a release CANDIDATE is not the release', () => {
        // Semver puts a prerelease strictly below the release it precedes, and
        // `parseInt` put it exactly equal: it stops at the first non-digit and
        // reports the digits it got, so the suffix vanished. A candidate build
        // is not the build phase 0.1's facts were verified against, so the
        // honest answer is that we cannot verify it — not that it matches.
        const f = classifyVersionDrift({ reported: `${PINNED_GATEWAY_RELEASE}-rc1` });
        expect(f.outcome).toBe('unverifiable');
        expect(isNewer(`${PINNED_GATEWAY_RELEASE}-rc1`, PINNED_GATEWAY_RELEASE)).toBeNull();
    });

    it('compares NUMERICALLY, not lexicographically', () => {
        // Shifting the patch into double digits produces a version that is
        // GREATER numerically and SMALLER as a string, which is the comparison
        // a naive `>` on strings gets wrong.
        const doubleDigit = shift(2, 10);
        expect(isNewer(doubleDigit, PINNED_GATEWAY_RELEASE)).toBe(true);
        expect(isNewer(PINNED_GATEWAY_RELEASE, doubleDigit)).toBe(false);
        // And the segments are weighed in order: a minor bump outranks any
        // patch, including a double-digit one.
        expect(isNewer(shift(1, 1), doubleDigit)).toBe(true);
        expect(isNewer(PINNED_GATEWAY_RELEASE, PINNED_GATEWAY_RELEASE)).toBe(false);
    });

    it('tolerates a v prefix and differing segment counts', () => {
        expect(isNewer(`v${shift(2, 1)}`, PINNED_GATEWAY_RELEASE)).toBe(true);
        expect(isNewer(shift(2, 1), `v${PINNED_GATEWAY_RELEASE}`)).toBe(true);
        // A two-segment minor bump is newer even with fewer segments present.
        const p = parts();
        expect(isNewer([p[0], p[1] + 1].join('.'), PINNED_GATEWAY_RELEASE)).toBe(true);
        // And a missing segment reads as zero, not as "unknown": the pin's own
        // major.minor is NOT newer than the pin.
        expect(isNewer([p[0], p[1]].join('.'), PINNED_GATEWAY_RELEASE)).toBe(false);
    });

    it('returns null rather than guessing on an unparseable input', () => {
        expect(isNewer('dev', PINNED_GATEWAY_RELEASE)).toBeNull();
        expect(isNewer(PINNED_GATEWAY_RELEASE, 'dev')).toBeNull();
    });

    it('only `matches` is silent — every other outcome is reportable', () => {
        const all: VersionDriftOutcome[] = ['matches', 'ahead', 'behind', 'unverifiable'];
        expect([...VERSION_DRIFT_REPORTABLE].sort()).toEqual(['ahead', 'behind', 'unverifiable']);
        expect(all.filter((o) => !VERSION_DRIFT_REPORTABLE.includes(o))).toEqual(['matches']);
    });

    it('every finding carries both sides, so it can be read without re-deriving', () => {
        // The contract `DriftFinding` already keeps for policy hashes: a
        // finding that names only the outcome cannot be audited later.
        for (const reported of [PINNED_GATEWAY_RELEASE, shift(1, 1), older(), 'dev', null]) {
            const f = classifyVersionDrift({ reported });
            expect(f.pinned).toBe(PINNED_GATEWAY_RELEASE);
            expect(f.reason.length).toBeGreaterThan(30);
            expect(Object.keys(f).sort()).toEqual(['outcome', 'pinned', 'reason', 'reported']);
        }
    });
});
