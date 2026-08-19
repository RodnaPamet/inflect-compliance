/**
 * Blast-radius refusal for identity writes.
 *
 * ═══ WHAT THIS PROTECTS AGAINST, AND WHY IT IS NOT ALREADY COVERED ═══
 *
 * `identity-sync` is already careful about wrongful mass-deprovisioning: a
 * partial enumeration never drives the reconcile, a truncated one fails the
 * run outright, and `recordIdentityDeprovisioned` exists so a spike is
 * alertable.
 *
 * All of that guards an OBSERVATION. Today "deprovisioned" means one column on
 * `ConnectedIdentityAccount` in our own database — nothing reaches the
 * customer's directory. A wrong answer is a wrong row, and a wrong row is
 * fixable by re-running the sync.
 *
 * JML is what changes the consequence. The leaver path turns that same
 * observation into a real `accountEnabled: false` against Entra or a
 * `userAccountControl` write against a domain controller. A wrong answer is
 * then a person locked out of their job, and for a large enough batch it is
 * every person at once.
 *
 * A metric cannot stop that. `recordIdentityDeprovisioned` fires AFTER the
 * write and tells a human to come look; by then the accounts are disabled. So
 * this module is the enforcement half: it runs BEFORE any write and can refuse
 * the batch.
 *
 * ═══ WHY THE WHOLE RUN IS REFUSED, NOT TRIMMED TO THE CAP ═══
 *
 * The tempting alternative is to disable up to the cap and defer the rest.
 * That is worse, for a reason that matters more than it first appears.
 *
 * The cap is not a rate limit. It is an anomaly detector: it fires when the
 * batch is big enough that the most likely explanation is a broken input, not
 * a real wave of departures. If the roster feed says 400 of 500 people left,
 * the correct response is "this feed is wrong", not "disable 20 of them and
 * ask again tomorrow". Trimming performs part of a probably-wrong action AND
 * hides the anomaly behind a number that looks deliberate.
 *
 * Refusing the batch keeps the system in the state it was in, which is the
 * only state known to be correct.
 *
 * ═══ WHY TWO CAPS AND A FLOOR ═══
 *
 * Neither cap alone works across tenant sizes:
 *
 *   absolute only   — a 5,000-person tenant legitimately offboards more in one
 *                     run than a 30-person one ever will. A cap low enough to
 *                     protect the small tenant blocks the large one's normal
 *                     Monday.
 *   percentage only — in a 3-person tenant one departure is 33%. A percentage
 *                     low enough to be meaningful at scale refuses every real
 *                     event at the bottom end.
 *
 * So: refuse if the batch exceeds the absolute cap, OR if it exceeds the
 * percentage AND is larger than a small-tenant floor. The floor is what stops
 * the percentage rule from firing on a tenant where one person leaving is
 * always a double-digit share.
 *
 * @module usecases/identity-write-breaker
 */

/**
 * Never disable more than this many accounts in one run, at any tenant size.
 *
 * Chosen as "more than a plausible single-day offboarding wave at any tenant we
 * serve, and far less than a directory". A real reduction-in-force larger than
 * this is exactly the event that should involve a human, not an automated run.
 */
export const MAX_DISABLES_PER_RUN = 50;

/** Refuse a batch larger than this share of the known population. */
export const MAX_DISABLE_SHARE = 0.1;

/**
 * Below this batch size the share rule does not apply.
 *
 * In a very small tenant a single departure is a large percentage and always
 * will be. Without this floor the share rule would refuse every genuine leaver
 * event at the bottom end, and a rail that refuses correct input is a rail
 * operators switch off.
 */
export const SHARE_RULE_FLOOR = 5;

export interface BreakerInput {
    /** How many accounts this run proposes to disable. */
    readonly proposed: number;
    /**
     * Accounts known in the directory for this provider.
     *
     * MUST come from a confirmed-complete enumeration. A partial population
     * inflates the computed share and would refuse correct batches; worse, a
     * population of 0 with a non-zero batch means we know nothing about the
     * directory and must not be writing to it at all.
     */
    readonly population: number;
}

export type BreakerDecision =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: string };

/**
 * Decide whether a batch of disables may proceed.
 *
 * Pure and synchronous on purpose: this is the kind of rule that has to be
 * readable in one screen and testable without a database, because the cost of
 * a subtle bug in it is measured in locked-out employees.
 */
export function checkDisableBlastRadius(input: BreakerInput): BreakerDecision {
    const { proposed, population } = input;

    // Nothing to do is always allowed — and must be, or a no-op run would
    // surface as a refusal and train operators to ignore refusals.
    if (proposed <= 0) return { allowed: true };

    // A batch with no known population is not a small batch, it is an unknown
    // one. Refuse rather than divide by zero or treat unknown as safe.
    if (population <= 0) {
        return {
            allowed: false,
            reason:
                `Refusing to disable ${proposed} account(s): the directory population is unknown ` +
                `(${population}). A blast-radius check cannot be evaluated without a confirmed-complete ` +
                `enumeration, and an unknown denominator is not the same as a safe one.`,
        };
    }

    if (proposed > MAX_DISABLES_PER_RUN) {
        return {
            allowed: false,
            reason:
                `Refusing to disable ${proposed} account(s) in one run: the per-run cap is ` +
                `${MAX_DISABLES_PER_RUN}. A batch this size is more likely a bad directory or roster ` +
                `feed than a real departure wave, so the whole run is held for a human rather than ` +
                `partly applied.`,
        };
    }

    const share = proposed / population;
    if (proposed > SHARE_RULE_FLOOR && share > MAX_DISABLE_SHARE) {
        const pct = (share * 100).toFixed(1);
        return {
            allowed: false,
            reason:
                `Refusing to disable ${proposed} of ${population} account(s) (${pct}%): the per-run share ` +
                `cap is ${(MAX_DISABLE_SHARE * 100).toFixed(0)}%. A batch this large relative to the ` +
                `directory is more likely a bad feed than a real departure wave, so the whole run is held ` +
                `for a human rather than partly applied.`,
        };
    }

    return { allowed: true };
}
