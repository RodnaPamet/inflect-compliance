/**
 * WHAT THE GUARD SAYS ABOUT ONE PROPOSAL — three states, not three verdicts.
 *
 * `AgentGuardVerdict` has three values and this has three states, and they do
 * not line up. `guardVerdict` is `NOT NULL DEFAULT 'CLEAN'`, and the migration
 * that added it deliberately ran NO BACKFILL: "every existing row entered a
 * queue that had no guard, so CLEAN here means 'not refused', not 'scanned and
 * found clean'". So the column alone cannot tell a clean scan from no scan, and
 * a surface that reads it alone tells a reviewer a row was checked when nobody
 * checked it. `guardInputDigest` is the discriminator — the guard writes it on
 * every proposal it decides, and it is NULL for exactly the pre-guard rows.
 *
 * QUARANTINED maps to FLAGGED rather than to a fourth state. On the review list
 * it cannot arrive — `listAgentProposals` parses `?status=` against the
 * REVIEWABLE vocabulary and names that set in the query even with no filter —
 * but a COUNT over the whole table meets it, and the safe reading of "the guard
 * refused this" is the alarming one, not silence.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * It lived in `AgentProposalsClient.tsx` while one page was the only reader.
 * The governance pack now counts the same three states, and a `'use client'`
 * module cannot be the home of a rule a server read depends on: importing a
 * function across that boundary yields a client REFERENCE, not the function.
 * Moving it here is what makes the pack's counts a reuse rather than a second,
 * drifting copy of the rule.
 *
 * Pure data and one branch. No I/O, no crypto, no React — so both the browser
 * bundle and a server usecase can hold it.
 */
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';

export type ProposalGuardState = 'FLAGGED' | 'CLEAN' | 'UNSCANNED';

export function resolveProposalGuardState(row: {
    guardVerdict: AgentGuardVerdict;
    guardInputDigest: string | null;
}): ProposalGuardState {
    if (row.guardVerdict !== 'CLEAN') return 'FLAGGED';
    return row.guardInputDigest ? 'CLEAN' : 'UNSCANNED';
}

/**
 * The same rule as a `WHERE`, for the two states a database can count directly.
 *
 * A count cannot call `resolveProposalGuardState` per row without loading the
 * whole table, and a capped read would turn a metric into a floor. So the rule
 * is encoded a second time — and the two encodings live SIDE BY SIDE, in one
 * file, because the failure they exist to avoid is drifting apart in two.
 *
 * CLEAN is deliberately absent: it is the remainder, `total - flagged -
 * unscanned`, so the three counts are guaranteed to sum to the population
 * rather than being three independent queries that can disagree under a
 * concurrent write. `tests/integration/agentic-reports.test.ts` asserts these
 * fragments agree with the function above, row for row, over a fixture holding
 * all three states.
 *
 * Untyped as `Prisma.AgentProposalWhereInput` on purpose — that would make this
 * module import the Prisma client namespace and drag it into the browser bundle
 * that renders the proposal list. The shape is checked at the call site, where
 * Prisma types the `where` it is spread into.
 */
export const PROPOSAL_GUARD_STATE_WHERE = {
    /** The guard looked and refused: FLAGGED or QUARANTINED. */
    FLAGGED: { guardVerdict: { not: 'CLEAN' } },
    /** Verdict CLEAN with no digest — nobody scanned it. The pre-guard rows. */
    UNSCANNED: { guardVerdict: 'CLEAN', guardInputDigest: null },
} as const;
