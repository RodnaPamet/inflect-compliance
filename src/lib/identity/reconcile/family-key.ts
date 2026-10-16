/**
 * The family name a record can be BLOCKED by — one rule, both sides (#3612).
 *
 * ═══ THE DEFECT THIS EXISTS TO CLOSE ═══
 *
 * The family-name blocker indexed the roster with `nameParts` (conventions.ts)
 * and looked accounts up with `normaliseName` (normalise.ts). Those are
 * different rules:
 *
 *     normaliseName('User 4 Example').family    = 'Example'
 *     nameParts({ fullName: 'User 4 Example' }) = null
 *
 * So an account offered the key `Example` and the index did not contain it,
 * because the employee whose name is byte-identical had been excluded by a
 * rule the lookup side does not apply. Measured on the first production
 * reconcile: four accounts at zero candidates, one of them with an employee
 * whose display name matched exactly.
 *
 * ═══ WHY `nameParts` IS RIGHT TO BE STRICT, AND WRONG HERE ═══
 *
 * It exists for CONVENTION GENERATION — deriving the username a template like
 * `{first}.{last}` expects. There, guessing which of three tokens is the
 * family name produces a wrong expected username and therefore a wrong link,
 * so refusing is correct, and its "Exactly two. Not 'at least two', not 'first
 * and last of N'." is correct with it.
 *
 * Blocking is not generation. A blocker PROPOSES candidates that scorers then
 * judge and vetoes can kill; proposing one too many costs a comparison, which
 * the engine's budget already bounds. Applying generation's strictness to
 * blocking spends precision where it buys nothing and loses recall where it
 * costs everything — and it did so asymmetrically, on one side of one
 * comparison.
 *
 * `nameParts` is deliberately untouched. Two questions, two functions.
 *
 * @module identity/reconcile/family-key
 */
import { baseClean } from './normalise';

/** What this needs of a record. Structurally satisfied by `RosterEmployee`. */
export interface FamilyKeyRecord {
    readonly familyName?: string | null;
    readonly fullName?: string | null;
}

/**
 * The family name to index by, or `null` when none can be established.
 *
 * Order matters: an explicit `familyName` is a statement by the source system
 * and beats anything derived from a display string. The fallback takes the LAST
 * token, which is the same choice `normaliseName` makes on the account side —
 * that sameness is the whole point of this function.
 *
 * `null` for a single token: a one-word name has no family part to separate,
 * and indexing `Cher` as a family name would collide every one-word record in
 * a roster into one bucket.
 */
export function familyKeyOf(record: FamilyKeyRecord): string | null {
    const explicit = baseClean(record.familyName ?? '');
    if (explicit) return explicit;

    const full = baseClean(record.fullName ?? '');
    if (!full) return null;
    const tokens = full.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    return tokens[tokens.length - 1];
}
