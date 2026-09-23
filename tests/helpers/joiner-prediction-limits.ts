/**
 * The joiner plan's `predictionLimits`, written out a SECOND time, as the two
 * joiner suites' expectation of them.
 *
 * ═══ WHY A GOLDEN COPY AND NOT A REGEX ═══
 *
 * #2687 acceptance 3 asks that a plan record `predictionLimits` VERBATIM, so an
 * artefact cannot be read as promising more than the run checked. "Verbatim" is
 * only checkable against a fixed text, and the assertions that stood here
 * before were keyed on a TOPIC word rather than on the claim:
 * `/HRIS write-back/i` is satisfied by a sentence saying the opposite of what
 * the limit says. That was measured rather than assumed — rewriting limit 1
 * from "has never been attempted" to "is covered by this plan" left every test
 * in the joiner population green, including the two named for this criterion.
 * The same hole let the RECORDING reorder the array, because every assertion on
 * the persisted side was a `.some(...)`.
 *
 * So the four sentences live here, once, and the two suites assert against them
 * from the two ends of the seam:
 *
 *   · `tests/unit/identity-joiner-pass.test.ts` — the PLANNER produces exactly
 *     these, in this order, on a clean plan and on every refusal, with the UTC
 *     caveat APPENDED only when no tenant timezone is stored;
 *   · `tests/unit/identity-joiner-run.test.ts`  — the ARTEFACT carries exactly
 *     these, in this order, on a refused row and on a clean one alike.
 *
 * Composed, those two are the criterion: what the planner said is what the row
 * says, character for character.
 *
 * ═══ WHY THIS IS NOT IMPORTED FROM THE SOURCE ═══
 *
 * `predictionLimits` in `identity-joiner-pass.ts` is a module-private function,
 * and exporting it to assert against would make both assertions tautologies —
 * a reworded limit would agree with itself. The point is an independently
 * written copy that a source edit must DISAGREE with. Changing a limit
 * therefore costs a diff here too, and that is the intended price: these
 * sentences are the whole of what stops "would create N accounts" being read as
 * a promise, and softening one should be something a reviewer sees.
 */

/** Present on every plan, in this order, whatever the tenant's configuration. */
export const JOINER_STANDING_PREDICTION_LIMITS: readonly string[] = [
    'The HRIS write-back is Phase 2 and has never been attempted. A planned creation says ' +
        'nothing about whether the new address could be written back to the HRIS — which is ' +
        'the step whose failure leaves an orphaned account nobody can match to a person.',
    'The collision read covers the stored `email` column only (for Entra that is ' +
        '`mail || userPrincipalName`). Create-time uniqueness is enforced on ' +
        '`userPrincipalName`, `mailNickname` and `proxyAddresses`, and on Active Directory ' +
        'most often on `sAMAccountName`, which this product persists nowhere. A plan that ' +
        'found no conflict is NOT a statement that the address is available.',
    'No reservation is persisted. Two runs therefore cannot be compared, so a derived ' +
        'identity that DRIFTS between runs (a renamed employee, a changed domain) is not ' +
        'detectable yet — the reservation that would detect it needs the pre-hire model ' +
        'decision 2 puts outside Employee.',
];

/**
 * Decision 9's caveat — present ONLY while no timezone is stored for the tenant,
 * which is the state of every tenant today because nothing writes that column.
 * It must disappear the day one is stored, which is why it is separate here.
 */
export const JOINER_UTC_WINDOW_PREDICTION_LIMIT =
    'The start-date window was computed in UTC. Decision 9 fires dispatch on the ' +
    "tenant's own timezone, and no timezone is stored for this tenant — so a person " +
    'whose local start date falls either side of midnight UTC can be planned a day ' +
    'early or a day late.';

/**
 * What a plan carries today, for every tenant: the three standing limits plus
 * the UTC caveat, in that order. This is what the IO layer reads, because
 * `readJoinerEntitlementConfig` returns `timeZone: null` unconditionally.
 */
export const JOINER_PREDICTION_LIMITS_NO_TIMEZONE: readonly string[] = [
    ...JOINER_STANDING_PREDICTION_LIMITS,
    JOINER_UTC_WINDOW_PREDICTION_LIMIT,
];
