/**
 * The identity write ladder, and the one question everybody asks of it.
 *
 * WHY THIS IS ITS OWN MODULE. The order lived in two places — a private `LADDER`
 * in `usecases/identity-write-policy.ts` and a verbatim copy in
 * `WriteLadderClient.tsx` — and the leaver pass used NEITHER, testing
 * `mode !== LEAVER_MAX_MODE` instead. Those three agree only while the clamp is
 * the second rung, which it was, so nothing ever disagreed.
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
 */

/** The four rungs, weakest first. Index IS the ordering. */
export type IdentityWriteMode = 'DISABLED' | 'DRY_RUN' | 'PROPOSE' | 'AUTOMATIC';

export const LADDER: readonly IdentityWriteMode[] = [
    'DISABLED',
    'DRY_RUN',
    'PROPOSE',
    'AUTOMATIC',
];

/**
 * Is `mode` further along the ladder than `clamp`?
 *
 * ORDINAL, never `!==`. The distinction is invisible while the clamp sits at the
 * second rung and total once it moves: `DRY_RUN !== AUTOMATIC` is true, but
 * DRY_RUN is BELOW automatic and must be allowed to run.
 *
 * An unknown mode sorts to -1 and therefore reads as not-above. That direction
 * is deliberate but not sufficient on its own — the caller still has to reject
 * a mode it does not recognise, which `describeRefusal` does at the write and
 * the pass does by handling `DISABLED` explicitly before asking this.
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
 * accepted a joiner climb to AUTOMATIC in three PUTs and seven days while the
 * warning underneath it said the subsystem does not exist.
 *
 * `joiner` is false because nothing reads `identityJoinerMode`: there is no
 * joiner job, no directory writer with a create verb, and no consumer of the
 * value other than the policy usecase that stores and reports it.
 *
 * When the joiner ships, flip this to `true` in ONE place and both the refusal
 * and the operator-facing `honoured` block move together.
 */
export const DIRECTION_IMPLEMENTED: Readonly<Record<IdentityDirection, boolean>> = {
    leaver: true,
    joiner: false,
};
