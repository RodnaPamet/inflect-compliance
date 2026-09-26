/**
 * The mode ladder for AGENT-DRIVEN WRITES TO AN EXTERNAL SYSTEM, per connection.
 *
 * Slice one of #2861, and deliberately the CONTROL rather than the capability.
 * There is no external write path in this build at all: every tool
 * `resolveExternalReadTools` hands the funnel is an `McpReadTool`. So nothing
 * here gates anything yet — which is the point. #2241's lesson, written into
 * `src/lib/identity/write-ladder.ts`, is what a rung costs when it arrives
 * after the authority it is supposed to govern and turns out to enforce
 * nothing. Landing the ladder first means the write path cannot be born
 * ungated: it has to ask, and the default answer is DISABLED.
 *
 * ── WHY FOUR RUNGS AND NOT THREE ────────────────────────────────────────────
 *
 * The identity ladder is DISABLED → DRY_RUN → AUTOMATIC. PROPOSE used to sit
 * between the last two and was deleted, so adding a propose rung back needs an
 * argument rather than a precedent.
 *
 * The argument is that #2241 removed a rung that ENFORCED NOTHING. Its own
 * words: seven days bought a move to a rung that refused every candidate, and
 * the move that actually granted unattended writes was free. PROPOSE_ONLY here
 * is the opposite shape. `AgentProposal` exists, `approveAgentProposal` is a
 * privileged human action, and it re-checks a `baseDigest` fingerprint at
 * approve time and refuses an approval whose fingerprint has moved. So a
 * connection at PROPOSE_ONLY genuinely cannot write unattended, and dwelling
 * there means watching real approvals — the observation the dwell is for.
 *
 * It is also a terminal rung, not a waypoint. A tenant that wants every
 * external write reviewed stops at PROPOSE_ONLY and is finished; the owner's
 * requirement was that a tenant CHOOSE between reviewed and unattended writes,
 * and stopping is how you choose the first.
 *
 * A sibling arrangement — DRY_RUN branching to either PROPOSE_ONLY or
 * AUTOMATIC — was considered and rejected. It reads as more flexible and is
 * strictly weaker: it lets a connection reach unattended external writes
 * without a single human approval ever having been exercised. Linear ordering
 * with a gated final step keeps the choice and keeps the evidence.
 *
 * ── THE INDEX IS THE ORDERING ───────────────────────────────────────────────
 *
 * As in the identity ladder, `LADDER` is a `const` tuple and the mode union is
 * DERIVED from it, so retiring a rung is a compile error at every site that
 * still names it rather than a value that quietly sorts to -1.
 */

/** The four rungs, weakest first. Index IS the ordering. */
export const LADDER = ['DISABLED', 'DRY_RUN', 'PROPOSE_ONLY', 'AUTOMATIC'] as const;

/** Every rung the application recognises. Derived — see LADDER. */
export type ExternalWriteMode = (typeof LADDER)[number];

/**
 * Rungs removed from the ladder that could still be sitting in a column, and
 * what each now reads as.
 *
 * Empty today, and kept rather than omitted. Postgres cannot drop an enum value
 * without recreating the type, and an `ALTER TYPE` during a rolling deploy makes
 * every still-running old container fail with SQLSTATE 42704 — the hazard the
 * identity ladder documents at length. So a retired rung will survive in the
 * database and must be translated on the way out, and the place that does the
 * translating should exist before it is needed rather than be invented under
 * pressure by whoever retires the first rung.
 */
export const RETIRED_MODES: Readonly<Record<string, ExternalWriteMode>> = {};

/** Days a connection must hold a rung before it may widen off it. */
export const MODE_MIN_DAYS = 7;

/**
 * Evidence a rung must have PRODUCED before it may be widened off.
 *
 * Elapsed time alone is the gap #2843 finding 31 closed on the identity dwell:
 * a week with nothing recorded is a path that never fired, not a quiet week.
 * The same is true here and for the same reason, so each widen that grants
 * authority asks the rung below it for proof of work.
 *
 *   DRY_RUN     → recorded intents. A dry run that recorded nothing means the
 *                 agent never reached the write seam, so there is no report to
 *                 have read and nothing was observed.
 *   PROPOSE_ONLY → approved proposals. This is the one that answers #2241
 *                 directly: the rung below AUTOMATIC must demonstrate that
 *                 humans actually reviewed external writes, not merely that
 *                 the connection sat at a rung where they could have.
 *
 * DISABLED produces nothing by construction and is not listed: widening off it
 * is gated by the one-rung rule and the dwell, which is all a rung that does
 * nothing can be asked for.
 */
export const MODE_MIN_EVIDENCE: Readonly<Partial<Record<ExternalWriteMode, number>>> = {
    DRY_RUN: 1,
    PROPOSE_ONLY: 1,
};

/** Narrowing membership test — the one place LADDER is widened to `string`. */
function isLadderRung(value: string): value is ExternalWriteMode {
    return (LADDER as readonly string[]).includes(value);
}

/**
 * Translate a mode as STORED into a rung this build understands.
 *
 * ═══ READ THE FAILURE DIRECTION BEFORE CHANGING THIS ═══
 *
 * `isAboveClamp` sorts an unrecognised mode to -1, which reads as NOT above any
 * clamp — that is, PERMITTED. Safe for a ceiling, catastrophic for a stored
 * authority: a row holding a value this build does not know would sail past
 * every comparison below and be treated as the widest thing the caller allows.
 *
 * So every read of a stored mode comes through here, at the read boundary,
 * BEFORE any ladder comparison, dwell calculation or dispatch decision
 * anywhere. Unknown fails CLOSED to DISABLED — including `null`/`undefined`,
 * because a connection with no mode recorded has been granted no authority, and
 * absence is a real "off" rather than a missing value to guess at.
 */
export function coerceStoredMode(stored: string | null | undefined): ExternalWriteMode {
    if (!stored) return 'DISABLED';
    if (isLadderRung(stored)) return stored;

    // `hasOwnProperty.call`, never `stored in RETIRED_MODES`: `in` walks the
    // prototype chain, so 'constructor', 'toString' and '__proto__' all "match"
    // and hand back an inherited Object.prototype member — a function returned
    // as a write mode. The identity ladder carries the same note; the table
    // being empty today is exactly why the guard has to be structural.
    const replacement = Object.prototype.hasOwnProperty.call(RETIRED_MODES, stored)
        ? RETIRED_MODES[stored]
        : undefined;

    // Re-checked against LADDER rather than trusted from the table's type.
    // RETIRED_MODES is hand-written and this function's whole contract is
    // "what comes out is a rung".
    return replacement !== undefined && isLadderRung(replacement) ? replacement : 'DISABLED';
}

/** Is `mode` wider than `clamp`? Unknown modes must be coerced FIRST. */
export function isAboveClamp(mode: ExternalWriteMode, clamp: ExternalWriteMode): boolean {
    return LADDER.indexOf(mode) > LADDER.indexOf(clamp);
}

/** Does this rung permit an outbound write to leave at all? */
export function permitsDispatch(mode: ExternalWriteMode): boolean {
    return mode === 'AUTOMATIC';
}

/** Does this rung record an intended write instead of sending one? */
export function recordsIntentOnly(mode: ExternalWriteMode): boolean {
    return mode === 'DRY_RUN';
}

/** Does this rung route a write to a human for approval? */
export function requiresHumanApproval(mode: ExternalWriteMode): boolean {
    return mode === 'PROPOSE_ONLY';
}

/** The current state of one connection's ladder, as stored. */
export interface ExternalWriteState {
    /** Already coerced — callers must not pass a raw column through. */
    readonly mode: ExternalWriteMode;
    /** When the connection entered `mode`. Null means no recorded entry. */
    readonly modeSince: Date | null;
    /**
     * What the CURRENT rung has produced since `modeSince` — dry-run intents at
     * DRY_RUN, approved proposals at PROPOSE_ONLY. `undefined` means the caller
     * could not count, which is not the same as zero and is reported as such.
     */
    readonly evidenceInWindow?: number;
}

/**
 * Why a move is refused, or `null` when it is permitted.
 *
 * A string rather than a boolean because every refusal here is shown to an
 * operator who is mid-decision, and "no" without a reason invites them to
 * conclude the gate is broken. The identity policy learned that the hard way
 * (#2843 finding 31): a refusal whose stated reason the operator can disprove
 * by looking at a report is worse than a vaguer one.
 */
export function refusalForMove(
    current: ExternalWriteState,
    next: ExternalWriteMode,
    now: Date,
): string | null {
    const from = LADDER.indexOf(current.mode);
    const to = LADDER.indexOf(next);

    // Narrowing is always permitted, and never gated. An operator revoking an
    // authority must never be told to wait — this is the direction that makes
    // the ladder safe to climb at all.
    if (to <= from) return null;

    if (to - from > 1) {
        return (
            `Cannot go from ${current.mode} to ${next} in one step. Widen one level at a time `
            + `(${LADDER.slice(from, to + 1).join(' → ')}), so each level is observed before `
            + 'the next is granted.'
        );
    }

    if (!current.modeSince) {
        return `${current.mode} has no recorded start. Re-select ${current.mode} to open the observation window.`;
    }

    // Evidence BEFORE elapsed days, so an operator who has waited the week with
    // nothing recorded is told the useful thing rather than sent away to wait
    // again — the ordering #2843 finding 31 settled on the identity gate.
    const required = MODE_MIN_EVIDENCE[current.mode];
    if (required !== undefined) {
        if (current.evidenceInWindow === undefined) {
            return (
                `Cannot confirm what ${current.mode} has recorded since the window opened, so the `
                + 'move cannot be granted. "We could not look" and "we looked and found nothing" '
                + 'are different answers and only one of them is evidence.'
            );
        }
        if (current.evidenceInWindow < required) {
            return (
                `${current.mode} has recorded ${current.evidenceInWindow} of the ${required} `
                + `required ${current.mode === 'PROPOSE_ONLY' ? 'approved proposals' : 'dry-run intents'} `
                + 'since the window opened. The window measures elapsed days, but a week with '
                + 'nothing recorded is a path that never fired rather than a quiet week.'
            );
        }
    }

    const days = (now.getTime() - current.modeSince.getTime()) / 86_400_000;
    if (days < MODE_MIN_DAYS) {
        const left = Math.ceil(MODE_MIN_DAYS - days);
        return (
            `${current.mode} has been held for ${Math.floor(days)} of the ${MODE_MIN_DAYS} required `
            + `days. ${left} to go, so there is time for what this rung records to be read before `
            + 'a wider one acts on it.'
        );
    }

    return null;
}
