/**
 * Step 4b: revalidating confirmed aliases at every run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DEPARTURE IS NOT A REASON TO SUSPEND, AND THAT IS THE WHOLE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A `LegacyIdentityAlias` is the only thing that can make an account `LINKED` on
 * its own, because it records a decision a person made. Revalidation exists to
 * withdraw that decision when the facts it rested on have changed.
 *
 * The tempting rule — "the employee left, so stop trusting the alias" — is
 * exactly backwards, and it fails in the direction that grants access:
 *
 *   - WITH the alias, the account resolves to a terminated employee, and the
 *     recertification run reports it as a leaver with access.
 *   - WITHOUT it, the account resolves to nothing in particular. It lands in the
 *     review queue as `UNMATCHED`, indistinguishable from the shared mailboxes
 *     and service accounts nobody has got round to classifying, and the one fact
 *     that made it urgent — that it belongs to somebody who has gone — is the
 *     fact that was just deleted.
 *
 * So a departure STRENGTHENS the case for keeping the alias. Suspension is for
 * aliases that have become doubtful about WHO the account belongs to, which is a
 * different question from whether that person still works here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR TRIGGERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each is a reason to doubt the IDENTITY, not the employment:
 *
 * `ACCOUNT_RECREATED` — the account was deleted and remade. Same login, new
 *   account, potentially a new human behind it. The reviewer confirmed the old
 *   one. Detected as `account.createdAt > alias.confirmedAt`, which can only
 *   happen that way round: the confirmer was looking at a snapshot in which the
 *   account already existed, so its creation cannot postdate their decision
 *   unless it was created again. No stored baseline is needed, and therefore
 *   none can drift.
 *
 * `ACCOUNT_POSTDATES_EMPLOYMENT_END` — the account's lifetime no longer fits the
 *   employment window: it was created after the employee's end date. That is the
 *   same comparison the engine vetoes on as `ACCOUNT_POSTDATES_END_DATE`, asked
 *   again later, because an end date can be BACKDATED after a confirmation and
 *   nothing re-examines the alias when it is.
 *
 * `HR_RECORD_REKEYED` — the employee's record is terminated AND has a re-keyed
 *   successor. The person is still here under a new row, so the alias points at a
 *   record the leaver process has finished with. Determined by the engine's own
 *   {@link makeRekeyLookup}, never by a local re-implementation: this is the
 *   discriminator that separates a re-key (suspend) from a departure (keep), and
 *   two definitions of it would eventually disagree.
 *
 * `HR_RECORD_VANISHED` — the employee id is no longer on the roster at all. Note
 *   that this is NOT a departure: a departure leaves a `TERMINATED` row, which is
 *   a record saying the person has gone. A vanished row says nothing, and an
 *   alias pointing into a hole cannot be revalidated at all.
 *
 * The last two are one keystroke apart in behaviour and opposite in effect, which
 * is why they are separate named reasons with separate tests rather than one
 * "roster problem" branch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT TRIGGER ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An account created BEFORE the employee's start date. It does not fit the
 * employment window either, and it is still routine: a contractor converted to
 * staff, an account issued ahead of a start date, a re-used login. Making it a
 * trigger would suspend a large, mostly-correct population on a signal that is
 * usually explained, and every one of those suspensions sends a real alias back
 * to a human queue. The engine does not veto on it; neither does this.
 *
 * `EXTERNAL` aliases expiring is also not here. The classification cannot be
 * created yet — that is the review-queue half of Step 4b — and a column nothing
 * writes is a check nothing exercises.
 *
 * @module lib/identity/reconcile/alias-revalidation
 */

import { isoDay, makeRekeyLookup, type CanonicalAccount, type RosterEmployee } from './engine';

/**
 * Why an alias stopped being trustworthy. A closed set: the write path stores
 * the code, so a free-text reason would make "how often does recreation happen"
 * unanswerable.
 */
export type SuspensionReason =
    | 'ACCOUNT_RECREATED'
    | 'ACCOUNT_POSTDATES_EMPLOYMENT_END'
    | 'HR_RECORD_REKEYED'
    | 'HR_RECORD_VANISHED';

export const SUSPENSION_REASONS: readonly SuspensionReason[] = [
    'ACCOUNT_RECREATED',
    'ACCOUNT_POSTDATES_EMPLOYMENT_END',
    'HR_RECORD_REKEYED',
    'HR_RECORD_VANISHED',
];

/** An active alias, as revalidation needs to see it. */
export interface AliasUnderReview {
    readonly accountKey: string;
    readonly employeeId: string;
    /** ISO. The baseline for {@link SuspensionReason} `ACCOUNT_RECREATED`. */
    readonly confirmedAt: string;
}

export interface AliasVerdict {
    readonly accountKey: string;
    readonly employeeId: string;
    /**
     * `null` means keep. Named this way round because keeping is the default and
     * the interesting value is the reason — a boolean `suspend` plus a nullable
     * reason would admit the two-field contradiction of a suspension with no
     * cause.
     */
    readonly reason: SuspensionReason | null;
    /** Human-readable evidence for the audit row. Never a cell value. */
    readonly detail: string | null;
}

export interface RevalidationInput {
    readonly aliases: readonly AliasUnderReview[];
    readonly accounts: readonly CanonicalAccount[];
    readonly roster: readonly RosterEmployee[];
}

export interface RevalidationResult {
    /** Every alias, in input order, with its verdict. */
    readonly verdicts: readonly AliasVerdict[];
    /** Just the suspensions, for the writer. */
    readonly suspensions: readonly AliasVerdict[];
    /** The aliases that survive, in the engine's own input shape. */
    readonly surviving: readonly { readonly accountKey: string; readonly employeeId: string }[];
}

/**
 * Revalidate every active alias against this run's facts.
 *
 * Pure: no clock, no database. The one piece of "now" that matters is already on
 * the data — an alias's `confirmedAt` and an account's `createdAt` are both
 * recorded instants, so a verdict that depended on the wall clock would be a
 * verdict that changed on re-run without anything changing.
 *
 * Returns the surviving aliases as well as the suspensions, because the caller
 * must feed the engine the SURVIVORS rather than everything it read. Suspending a
 * row and then handing the engine the pre-suspension list would resolve the
 * account as `CONFIRMED_ALIAS` on the very run that decided the alias was not
 * trustworthy.
 */
export function revalidateAliases(input: RevalidationInput): RevalidationResult {
    const byKey = new Map(input.accounts.map((a) => [a.accountKey, a]));
    const byId = new Map(input.roster.map((e) => [e.id, e]));
    const rekeyOf = makeRekeyLookup(input.roster);

    const verdicts: AliasVerdict[] = [];

    for (const alias of input.aliases) {
        verdicts.push(judge(alias, byKey.get(alias.accountKey), byId.get(alias.employeeId), rekeyOf));
    }

    return {
        verdicts,
        suspensions: verdicts.filter((v) => v.reason !== null),
        surviving: verdicts
            .filter((v) => v.reason === null)
            .map((v) => ({ accountKey: v.accountKey, employeeId: v.employeeId })),
    };
}

function judge(
    alias: AliasUnderReview,
    account: CanonicalAccount | undefined,
    employee: RosterEmployee | undefined,
    rekeyOf: (e: RosterEmployee) => RosterEmployee | null
): AliasVerdict {
    const keep = (): AliasVerdict => ({
        accountKey: alias.accountKey,
        employeeId: alias.employeeId,
        reason: null,
        detail: null,
    });
    const suspend = (reason: SuspensionReason, detail: string): AliasVerdict => ({
        accountKey: alias.accountKey,
        employeeId: alias.employeeId,
        reason,
        detail,
    });

    // The HR record first: a vanished record makes every other check
    // unanswerable rather than false, and reporting the answerable-but-secondary
    // reason would send a reviewer looking at the account when the problem is the
    // roster.
    if (!employee) {
        return suspend('HR_RECORD_VANISHED', `employee ${alias.employeeId} is not on the roster`);
    }

    // A re-key BEFORE the departure check, because a re-keyed record is also a
    // terminated one. Order matters: asking "did they leave?" first would
    // classify every re-key as a departure and keep the alias pointing at the
    // dead row.
    if (employee.status === 'TERMINATED') {
        const successor = rekeyOf(employee);
        if (successor) {
            return suspend(
                'HR_RECORD_REKEYED',
                `employee ${employee.id} is terminated and re-keyed to ${successor.id}`
            );
        }
        // Terminated with no successor: a departure. KEEP — see the module
        // docblock. This is the branch that must never become a suspension, and
        // it is deliberately the only place a TERMINATED record falls through.
    }

    // An account the snapshot no longer carries. Not a suspension: the alias is
    // still the right answer about an account that is simply absent this cycle,
    // and the population gate is what decides whether absence means deleted or
    // means the pull was partial. Suspending here would discard a correct
    // decision on the strength of a snapshot that may not have covered it.
    if (!account) return keep();

    const created = isoDay(account.createdAt);

    if (created) {
        const confirmed = isoDay(alias.confirmedAt);
        if (confirmed && created > confirmed) {
            return suspend(
                'ACCOUNT_RECREATED',
                `account created ${created} postdates the confirmation of ${confirmed}`
            );
        }

        const ended = isoDay(employee.endDate);
        if (ended && created > ended) {
            return suspend(
                'ACCOUNT_POSTDATES_EMPLOYMENT_END',
                `account created ${created} postdates employment end ${ended}`
            );
        }
    }

    return keep();
}
