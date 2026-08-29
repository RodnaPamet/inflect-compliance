/**
 * Drift sentinel for count-based ratchets.
 *
 * THE FAILURE CLASS THIS CLOSES
 * ─────────────────────────────
 * A count ratchet ("no more than N occurrences of X") only ever asserts
 * `live <= baseline`. That check is silent about the OTHER direction: when
 * the tree improves and nobody lowers the baseline, the gap between the two
 * becomes headroom a future regression can spend without turning CI red.
 * The ratchet keeps passing the whole time, so nothing surfaces the drift —
 * `tests/guardrails/raw-color-ratchet.test.ts` sat at a baseline of 95
 * against a live count of 51, i.e. 44 raw colours could have been added to
 * `src/app` with a green build.
 *
 * A sentinel makes the drift itself a failure: if the baseline sits further
 * than `allowance` ABOVE the live count, the ratchet is reported as needing
 * re-seating. Slack can no longer accumulate unobserved.
 *
 * `allowance` is deliberately non-zero — a ratchet seated to the exact count
 * would turn every incidental one-line improvement into a required edit of
 * the guard. It is the tolerance for in-flight work, not headroom for
 * regressions: pick the smallest number that keeps ordinary PRs quiet.
 *
 * CALIBRATING `allowance`, and it is not a matter of taste: it must be
 * STRICTLY SMALLER than the drift the sentinel is being introduced to
 * correct. Otherwise the sentinel is tuned to sleep through a repeat of the
 * exact failure that motivated it — which is not hypothetical. Two of the
 * four guards adopting this helper were first drafted with an allowance
 * equal to or wider than their own drift (epic52 at 3 against a drift of 3;
 * border-tone-budget already shipped a bespoke sentinel at 10 and let a
 * drift of 3 accumulate under it). Both stayed green when the pre-fix
 * baselines were replayed through them. Re-run that replay whenever you add
 * a sentinel: restore the old baseline, confirm the sentinel FAILS, restore
 * the new one. A sentinel that never fired is indistinguishable from one
 * that cannot.
 *
 * Modelled on the sentinel in `tests/guardrails/no-explicit-any-ratchet.test.ts`,
 * extracted here so the several ratchets that need it share one implementation
 * (and one place to prove that implementation is live).
 */

export interface RatchetSlackInput {
    /** Name of the constant to edit, e.g. `BASELINE` — quoted in the failure. */
    readonly constantName: string;
    /** The declared ceiling. */
    readonly baseline: number;
    /** What the tree actually contains right now. */
    readonly count: number;
    /** How far above the live count the baseline may sit before this fires. */
    readonly allowance: number;
    /** Optional extra line explaining what the ratchet counts. */
    readonly what?: string;
}

/**
 * Returns an actionable failure message when the baseline has drifted too far
 * above the live count, or `null` when the ratchet is seated acceptably.
 *
 * Returns `null` when `count > baseline` as well: that is a genuine regression
 * and belongs to the ratchet's own `count <= baseline` assertion, which
 * produces a far more useful message (it can list the offending sites). The
 * sentinel speaks only about unspent slack.
 */
export function ratchetSlackFailure(input: RatchetSlackInput): string | null {
    const { constantName, baseline, count, allowance, what } = input;
    const slack = baseline - count;
    if (slack <= allowance) return null;

    return [
        `Ratchet has unspent slack — lower ${constantName} to the live count.`,
        ``,
        ...(what ? [`  counting      : ${what}`, ``] : []),
        `  live count    : ${count}`,
        `  ${constantName.padEnd(13)} : ${baseline}`,
        `  slack         : ${slack}  (tolerated: ${allowance})`,
        ``,
        `A baseline that sits above the live count is headroom a future`,
        `regression can spend with a green build. The tree improved and the`,
        `guard was not re-seated — set ${constantName} to ${count} in the same`,
        `diff that made the improvement.`,
    ].join('\n');
}

/** Throwing form of {@link ratchetSlackFailure}. */
export function assertRatchetSlack(input: RatchetSlackInput): void {
    const failure = ratchetSlackFailure(input);
    if (failure !== null) throw new Error(failure);
}
