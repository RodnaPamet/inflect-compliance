/**
 * The OpenShell release this build was verified against — #4567.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS CONSTANT HAD TO EXIST BEFORE THE DRIFT CHECK COULD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The pin was recorded in exactly two places and neither was reachable from
 * runtime code: `PINNED_RELEASE` in
 * `tests/guards/sandbox-runtime-channels-match-the-runtime.test.ts`, and prose
 * in eight `src/` docblocks. So nothing in the product could answer "is the
 * gateway running the release we verified against" — there was no expected
 * value to compare a reported one with.
 *
 * This is that value, and the guard now imports it rather than declaring its
 * own. Two pins that can disagree are worse than one: each looks authoritative
 * alone, and the disagreement is visible only to somebody comparing them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE PIN MEANS, WHICH IS NARROWER THAN "THE VERSION WE SUPPORT"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every phase-0.1 fact was verified against THIS release: that unset
 * `enforcement` means audit mode, that Landlock `best_effort` is the default,
 * that telemetry is on, that the OCSF log records no lifecycle decision. The
 * 0.1.5 → 0.1.6 upgrade re-verified all seven rather than carrying them over,
 * and the load-bearing check was that the flag surface was identical 33/33.
 *
 * So a gateway running a DIFFERENT release is not merely a version mismatch —
 * it is a gateway about which this product's recorded facts may be false. That
 * is why the drift outcomes below separate ahead from behind instead of
 * reporting "mismatch".
 *
 * @module lib/agentic/openshell/pinned-release
 */

/** The verified release. Moved only by 5.3's upgrade checklist. */
export const PINNED_GATEWAY_RELEASE = '0.1.6';

export type VersionDriftOutcome =
    /** The gateway reports the pinned release. Nothing to report. */
    | 'matches'
    /**
     * The gateway is NEWER than the pin. Every recorded fact was verified
     * against an older release, so the evidence is stale rather than wrong —
     * and 5.3's checklist is what resolves it, not a code change.
     */
    | 'ahead'
    /**
     * The gateway is OLDER than the pin. The committed configuration may set
     * flags this binary does not have: the 0.0.91 images lack nine of them, and
     * three are ones this deployment depends on. A gateway that started anyway
     * is ignoring configuration somebody wrote deliberately.
     */
    | 'behind'
    /**
     * No version was reported — unreachable, or answered without one. Reported
     * rather than assumed matching, because a check that could not read the
     * version has not found it correct.
     */
    | 'unverifiable';

export interface VersionDriftFinding {
    readonly outcome: VersionDriftOutcome;
    /** What the gateway said, or null when it said nothing. */
    readonly reported: string | null;
    readonly pinned: string;
    readonly reason: string;
}

/*
    Numeric comparison per segment, NOT lexicographic — a double-digit patch is
    greater numerically and smaller as a string, which is the comparison a plain
    `>` on strings gets wrong.

    Deliberately stated without example version numbers: this repository has a
    guard that fails when any file claims a release newer than the pin, and an
    illustrative "x.y.10 is newer than x.y.9" in a comment is indistinguishable
    from such a claim to a text scan. It caught exactly that in the first draft
    of this file.
*/
function parts(v: string): number[] {
    /*
        STRICTLY numeric segments, because `parseInt` is not. `parseInt('6+gsha')`
        returns 6 — it stops at the first non-digit and reports what it got — so
        a build-metadata or release-candidate suffix silently parsed to the
        release it is attached to. That made `0.1.6-rc1` compare EQUAL to the
        release, and semver says a prerelease is strictly lower; a candidate
        build is not the build our facts were verified against.

        A segment with anything but digits is NaN here, which `isNewer` turns
        into `null` and the classifier reports as `unverifiable`. That is the
        conservative direction: we decline to say which way it differs rather
        than naming a direction we cannot support.
    */
    return v
        .trim()
        .replace(/^v/, '')
        .split('.')
        .map((n) => (/^\d+$/.test(n) ? Number.parseInt(n, 10) : Number.NaN));
}

/** Is `a` strictly newer than `b`? Returns null when either is unparseable. */
export function isNewer(a: string, b: string): boolean | null {
    const pa = parts(a);
    const pb = parts(b);
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
    if (pa.length === 0 || pb.length === 0) return null;
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

/**
 * Classify a reported gateway version against the pin.
 *
 * `reported` is what `/readyz` carried — the only observed version in this
 * product. It must never be defaulted to the pin: that would turn "we could not
 * ask" into "it matches", which is the collapse `classifyPolicyDrift` already
 * refuses for policy hashes.
 */
export function classifyVersionDrift(input: {
    readonly reported: string | null;
    readonly pinned?: string;
}): VersionDriftFinding {
    const pinned = input.pinned ?? PINNED_GATEWAY_RELEASE;
    const reported = input.reported;

    if (reported === null || reported.length === 0) {
        return {
            outcome: 'unverifiable',
            reported: null,
            pinned,
            reason:
                'no version was reported — the gateway was unreachable, or answered without one. '
                + 'Not treated as matching: a check that could not read the version has not found it correct.',
        };
    }

    const newer = isNewer(reported, pinned);
    const older = isNewer(pinned, reported);
    // One test, not two: both calls parse the SAME pair of strings, so `older`
    // is null exactly when `newer` is. Testing both read as defence and was
    // really an unreachable branch — it survived a mutation that deleted it,
    // which is how it was found.
    if (newer === null) {
        return {
            outcome: 'unverifiable',
            reported,
            pinned,
            reason:
                `the reported version ${reported} could not be compared with the pin ${pinned}. `
                + 'An unparseable version is not a mismatch and not a match.',
        };
    }

    /*
        THREE outcomes from two comparisons, never a fall-through. `behind` was
        the `else` of `ahead` in the first draft, and `isNewer` returns false
        for BOTH "older" and "equal" — so every version that parsed equal to
        the pin without being byte-equal to it (`v` prefix, a trailing space,
        a repeated-zero segment) was reported as a gateway ignoring our
        configuration. A false alarm in the alarming direction is worse than
        the noise it was meant to avoid, and the equality test that let it
        through was a STRING comparison standing in for a numeric one.
    */
    if (!newer && !older) {
        return {
            outcome: 'matches',
            reported,
            pinned,
            reason: `the gateway reports ${reported}, the pinned release`,
        };
    }

    return newer
        ? {
              outcome: 'ahead',
              reported,
              pinned,
              reason:
                  `the gateway reports ${reported}, newer than the pinned ${pinned}. Every phase-0.1 `
                  + 'fact was verified against the pin, so the recorded evidence is stale rather than '
                  + "wrong — 5.3's upgrade checklist is what resolves this, not a code change.",
          }
        : {
              outcome: 'behind',
              reported,
              pinned,
              reason:
                  `the gateway reports ${reported}, older than the pinned ${pinned}. The committed `
                  + 'configuration may set flags this binary does not have, and a gateway that started '
                  + 'anyway is ignoring configuration somebody wrote deliberately.',
          };
}

/** Outcomes a reviewer should see. `matches` is the only silent one. */
export const VERSION_DRIFT_REPORTABLE: readonly VersionDriftOutcome[] = [
    'ahead',
    'behind',
    'unverifiable',
];
