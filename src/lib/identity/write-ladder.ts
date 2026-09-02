/**
 * The identity write ladder, and the one question everybody asks of it.
 *
 * WHY THIS IS ITS OWN MODULE. The order lived in two places — a private `LADDER`
 * in `usecases/identity-write-policy.ts` and a verbatim copy in
 * `WriteLadderClient.tsx` — and the leaver pass used NEITHER, testing
 * `mode !== LEAVER_MAX_MODE` instead. Those three agree only while the clamp is
 * the second rung, which it was, so nothing ever disagreed. (A FOURTH copy was
 * found later, in the admin route's GET, and removed with the PROPOSE rung.)
 *
 * Raising the clamp is exactly the change that breaks that coincidence: with a
 * clamp of `AUTOMATIC`, a tenant at `DRY_RUN` fails an inequality test and is
 * refused `MODE_ABOVE_CLAMP` — a refusal that records no execution row, so the
 * dry run would stop dead and the passes page would go blank with nothing
 * saying why.
 *
 * The module carries no server imports on purpose: the admin client needs the
 * same answer, and importing a value from a usecase would pull prisma and the
 * tenant-context helpers into a browser bundle.
 *
 * ═══ WHY PROPOSE IS GONE (issue #2241) ═══
 *
 * The ladder was DISABLED → DRY_RUN → PROPOSE → AUTOMATIC. PROPOSE meant "a
 * human approves each disable", and that approval queue was never built, so
 * `identity-disable-account` refused every candidate at that rung. Widening from
 * DRY_RUN to PROPOSE therefore took a tenant from a useful dry-run report to
 * nothing: the rung above yielded strictly less than the rung below.
 *
 * That would be merely useless. What made it harmful is the dwell: the seven-day
 * observation window in `describeRefusal` is gated on `current.mode ===
 * 'DRY_RUN'`, and nothing gated PROPOSE → AUTOMATIC. Combined with the
 * widen-one-rung rule, PROPOSE was MANDATORY on the way to AUTOMATIC and was the
 * ONLY ungated transition on the ladder — so it was not a safety step, it was
 * the safety BYPASS. The real climb was "seven days at DRY_RUN, then two PUTs".
 *
 * Deleting the rung makes DRY_RUN → AUTOMATIC a single step, which the dwell
 * that already exists now gates. No new gate was added; the thing that let
 * callers step around the old one was removed.
 */

/**
 * The three rungs, weakest first. Index IS the ordering.
 *
 * A `const` tuple rather than `readonly IdentityWriteMode[]` so the mode union
 * is DERIVED from it below. That is what makes a retired rung a compile error at
 * every site that still names it, instead of a value that quietly sorts to -1.
 */
export const LADDER = ['DISABLED', 'DRY_RUN', 'AUTOMATIC'] as const;

/** Every rung the application recognises. Derived — see LADDER. */
export type IdentityWriteMode = (typeof LADDER)[number];

/**
 * Rungs that were removed from the ladder but can still be SITTING IN A COLUMN,
 * and what each one now reads as.
 *
 * The `IdentityWriteMode` enum in `prisma/schema/enums.prisma` still carries
 * `PROPOSE`, deliberately: Postgres cannot drop an enum value without recreating
 * the type, and an `ALTER TYPE` during a rolling deploy makes every still-running
 * old container fail with SQLSTATE 42704 (the lesson this repo already wrote
 * down for the Task enums). A harmless unreachable enum value costs nothing; the
 * migration costs a deploy hazard. So the value survives in the database and is
 * translated on the way out.
 *
 * PROPOSE reads as DRY_RUN — the rung BELOW it — for two reasons. It is a
 * narrowing, and narrowing is always permitted. And DRY_RUN is what PROPOSE was
 * failing to be: a tenant at PROPOSE was already getting no directory writes,
 * and now gets the dry-run report it was silently denied. A tenant coerced this
 * way carries a null `dryRunSince` (the write path nulls it on every move out of
 * DRY_RUN), so it cannot widen until it re-selects DRY_RUN and spends the seven
 * days — which is the correct answer, not a side effect.
 */
export const RETIRED_MODES: Readonly<Record<string, IdentityWriteMode>> = {
    PROPOSE: 'DRY_RUN',
};

/**
 * Translate a mode as STORED into a rung this build understands.
 *
 * ═══ THIS IS THE DANGEROUS FUNCTION. READ THE FAILURE DIRECTION. ═══
 *
 * `isAboveClamp` sorts an unrecognised mode to -1, which reads as NOT above the
 * clamp — i.e. PERMITTED TO RUN. That is the safe direction for a ceiling and
 * the unsafe one for a retired rung: the moment PROPOSE left `LADDER` it became
 * an unknown mode, so a tenant stored at PROPOSE would have sailed through the
 * clamp check, missed the `mode === 'DRY_RUN'` arm in the writer factory, been
 * handed a LIVE directory writer, and — with the PROPOSE refusal in
 * `identity-disable-account` deleted in the same change — written to the
 * customer's directory unattended.
 *
 * So every read of a stored mode goes through here, at the read boundary
 * (`getIdentityWritePolicy`), BEFORE any ladder comparison, clamp check or dwell
 * calculation anywhere. Nobody is stored at PROPOSE in production today; this is
 * the defence that keeps it that way if somebody is.
 *
 * Anything else unrecognised — a value from a newer build, a hand-edited row —
 * fails CLOSED to DISABLED rather than to DRY_RUN. A retired rung has a known
 * predecessor to fall back to; an unknown one does not, and guessing at the
 * authority a tenant meant to grant is the one thing this module must never do.
 * `null`/`undefined` (no settings row at all) is the same answer for the same
 * reason: absence is a real "off", not a missing value.
 */
export function coerceStoredMode(stored: string | null | undefined): IdentityWriteMode {
    if (!stored) return 'DISABLED';
    if (isLadderRung(stored)) return stored;

    // `hasOwnProperty.call`, NEVER `stored in RETIRED_MODES`. `in` walks the
    // prototype chain, so 'constructor', 'toString' and '__proto__' all "match"
    // and the lookup hands back an inherited Object.prototype member — a
    // FUNCTION returned as an identity write mode, from a table that only ever
    // held one string. It would not be a live write (nothing off the ladder
    // reaches one) but it would be a junk value in a log line, a badge and an
    // audit row, and the shape is one keystroke from worse.
    const replacement = Object.prototype.hasOwnProperty.call(RETIRED_MODES, stored)
        ? RETIRED_MODES[stored]
        : undefined;

    // Re-checked against LADDER rather than trusted from the table's type.
    // RETIRED_MODES is hand-written, and this is the function whose whole
    // contract is "what comes out is a rung" — a contract worth holding
    // structurally rather than by review.
    return replacement !== undefined && isLadderRung(replacement) ? replacement : 'DISABLED';
}

/** Narrowing membership test — the one place LADDER is widened to `string`. */
function isLadderRung(value: string): value is IdentityWriteMode {
    return (LADDER as readonly string[]).includes(value);
}

/**
 * Is `mode` further along the ladder than `clamp`?
 *
 * ORDINAL, never `!==`. The distinction is invisible while the clamp sits at the
 * second rung and total once it moves: `DRY_RUN !== AUTOMATIC` is true, but
 * DRY_RUN is BELOW automatic and must be allowed to run.
 *
 * An unknown mode sorts to -1 and therefore reads as not-above — permissive, and
 * NOT something this function can fix: a ceiling that cannot recognise a value
 * cannot rank it. The caller must never hand it one. Every stored mode is
 * normalised by `coerceStoredMode` at the read boundary, the pass handles
 * `DISABLED` explicitly before asking, and `describeRefusal` rejects an
 * unrecognised mode at the write.
 */
export function isAboveClamp(mode: IdentityWriteMode, clamp: IdentityWriteMode): boolean {
    return LADDER.indexOf(mode) > LADDER.indexOf(clamp);
}

/** The two directions the ladder is configured for, independently. */
export type IdentityDirection = 'leaver' | 'joiner';

/**
 * Which directions have a RUNTIME behind them — not which are settable.
 *
 * This is the single source for the answer. It was previously spelled once, as a
 * literal `implemented: false` inside the admin route's `honoured` block, purely
 * so the UI could print a warning; the write path never asked. So the ladder
 * accepted a joiner climb all the way to AUTOMATIC — a PUT per rung, and seven
 * days — while the warning underneath it said the subsystem does not exist.
 *
 * `joiner` is false because nothing reads `identityJoinerMode`: there is no
 * joiner job, no directory writer with a create verb, and no consumer of the
 * value other than the policy usecase that stores and reports it.
 *
 * When the joiner ships, flipping this to `true` moves the refusal in
 * `describeRefusal` and the `honoured.<dir>.implemented` flag together — but
 * NOT `honoured.joiner.maxMode`, which is a hardcoded `'DISABLED' as const` in
 * `identity-write-policy/route.ts`. Flip the flag alone and the gate stops
 * refusing while the route still reports a DISABLED ceiling, so `isAboveClamp`
 * is true for every rung above off and the client shows the aboveClamp banner
 * while nothing clamps anything — back to settable-and-inert with a differently
 * worded notice. Give the joiner a real `JOINER_MAX_MODE` beside
 * `LEAVER_MAX_MODE` at that point; it is deliberately not created now, because
 * a clamp constant with no pass reading it is a fourth thing to keep in sync.
 */
export const DIRECTION_IMPLEMENTED: Readonly<Record<IdentityDirection, boolean>> = {
    leaver: true,
    joiner: false,
};
