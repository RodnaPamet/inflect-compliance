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
 * The `automationKey` suffix each direction's pass writes on its
 * `IntegrationExecution` row.
 *
 * HERE rather than beside the passes that write them, because the dwell gate
 * in `identity-write-policy` has to COUNT those rows (#2843 finding 31) and
 * both pass modules import that gate. Reading the suffix from either of them
 * would close a cycle; copying the string into the gate would be a second
 * source of truth for a value whose whole job is matching rows written
 * elsewhere.
 *
 * The passes re-export these under their original names, so every existing
 * call site is unchanged.
 */
export const PASS_AUTOMATION_SUFFIX: Readonly<Record<IdentityDirection, string>> = {
    leaver: '.leaver_pass',
    joiner: '.joiner_pass',
};

/**
 * Which directions have a RUNTIME behind them — not which are settable.
 *
 * This is the single source for the answer. It was previously spelled once, as a
 * literal `implemented: false` inside the admin route's `honoured` block, purely
 * so the UI could print a warning; the write path never asked. So the ladder
 * accepted a joiner climb all the way to AUTOMATIC — a PUT per rung, and seven
 * days — while the warning underneath it said the subsystem does not exist.
 *
 * ═══ THE MAXMODE HALF OF THE TRAP IS CLOSED (#2638). THE FLAG IS NOT. ═══
 *
 * This docblock used to end by saying `honoured.joiner.maxMode` was a hardcoded
 * `'DISABLED' as const` in `identity-write-policy/route.ts`, so flipping the flag
 * alone would leave the gate refusing nothing while the route still reported a
 * DISABLED ceiling — `isAboveClamp` true for every rung above off, the client
 * rendering the aboveClamp banner, and nothing clamping anything. That literal is
 * GONE: the route imports `JOINER_MAX_MODE` from `usecases/identity-joiner-pass`,
 * exactly as it imports `LEAVER_MAX_MODE`, so the reported ceiling and the
 * enforced ceiling are one value and cannot drift. Whoever flips the flag no
 * longer has to remember a second edit.
 *
 * `joiner` is nevertheless still FALSE, and the reason changed with it. It is no
 * longer "nothing reads `identityJoinerMode`" — `planJoinerPass` reads it at its
 * own gate 1. It is that a plan it produces cannot be acted on yet. This list
 * held TWO reasons; #2687 closed the first, and the second alone is enough:
 *
 *   • NO TRIGGER — MOSTLY CLOSED BY #2687. This used to read "there is no joiner
 *     job, no schedule and no run route". TWO of those three now exist:
 *     `identity-joiner-pass` and its `identity-joiner-dispatch` fan-out in
 *     `jobs/identity-joiner.ts`, and the 04:30 UTC entry in `jobs/schedules.ts`.
 *     The OWNER-only run route is NOT in this diff: it ships in the route half of
 *     #2687, split out because two new API routes push the CI Build over the
 *     runner's memory ceiling (#2698) and the engine should not wait on that.
 *     So a joiner pass fires on schedule today and cannot yet be fired off it.
 *     Owner decision 9 of 2026-09-19 — dispatch
 *     on the TENANT's timezone — is not satisfied and is not pretended to be:
 *     `dispatchJobId` floors on UTC buckets and `schedules.ts` records why a
 *     zoned cron breaks that, so the fan-out is deliberately UTC and the zoned
 *     dispatch remains owed. That is a scheduling refinement, though, not the
 *     absence of a runtime, and it is no longer what holds this flag down.
 *   • NO ENTITLEMENT MAP — STILL HELD, and this paragraph used to say
 *     otherwise. #2713 gave the map a SCHEMA and a READER: the rules live in
 *     `IdentityDepartmentGroupRule`, one row per department→security-group
 *     rule because the planner consumes a LIST that wants per-rule provenance,
 *     and the SINGULAR fallback sits on `TenantSecuritySettings` as
 *     `identityDefaultGroupId` + `identityDefaultGroupName` where it inherits
 *     the OWNER gate.
 *
 *     WHAT #2713 DID NOT GIVE THE MAP WAS A WRITER, and #2839 did.
 *     `identity-entitlement-map` creates, replaces and removes rules and sets
 *     the singular fallback, each write OWNER-gated and audited as `access`
 *     rather than configuration — a department→group rule decides what a
 *     future joiner is granted. So a tenant can now configure either half, and
 *     the refusal IS one an operator can clear.
 *
 *     THE HISTORY IS KEPT BECAUSE IT IS THE POINT. From #2713 until #2839 this
 *     paragraph said exactly that sentence while no writer existed — no
 *     usecase created a rule, and `updateTenantSecurityConfig`'s patch type
 *     listed neither default-group field — so every plan refused
 *     `NO_DEPARTMENT_MAP` and `wouldCreate` was structurally 0. The sentence
 *     was specific enough to be believed and to stop a reader checking.
 *
 *     `tests/guards/entitlement-map-claims-match-its-write-path.test.ts` pins
 *     the CONJUNCTION rather than either half, and it earned that on the day
 *     the writer landed: it went red pointing at these paragraphs, which is
 *     the coupling that was missing the first time round.
 *
 *     `wouldCreate` is still 0, but for the OTHER reason now — the create verb
 *     is unwired and `JOINER_MAX_MODE` is DRY_RUN. This condition no longer
 *     holds the flag down on its own.
 *
 * SO THE TRIGGER LANDING IS NOT THE CONDITION FOR FLIPPING THIS. That is what
 * this paragraph used to say — "when the trigger lands, this flips in the same
 * diff" — and #2687 is precisely the diff that would have been read as
 * permission. It is not, because the rule stated below is a conjunction and only
 * one half moved. Flipping `joiner` to `true` while every plan refuses
 * `NO_DEPARTMENT_MAP` would reproduce the very thing this comment was written
 * about, one layer along: the widen control would enable, the ladder would accept
 * the climb, and the tenant would sit at DRY_RUN watching a nightly pass refuse —
 * an artefact per day, none of them a provisioning decision. `implemented` means
 * a RUNTIME reads this setting AND an operator can see what it did; a run whose
 * every outcome is "I could not look up your groups" fails the second half while
 * looking like it satisfies the first. This flips when the map has somewhere to
 * live, in the diff that gives it one.
 */
export const DIRECTION_IMPLEMENTED: Readonly<Record<IdentityDirection, boolean>> = {
    leaver: true,
    joiner: false,
};
