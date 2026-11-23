/**
 * Recovery-priority derivation for Business Impact Analyses.
 *
 * "What comes back first?" — the core BIA output. This is a TRANSPARENT,
 * documented ordering, NOT a black-box score (same discipline as the
 * scanner-coverage work: no opaque continuity index).
 *
 * The recovery sequence orders processes by, in strict precedence:
 *   1. Criticality  — CRITICAL → HIGH → MEDIUM → LOW.
 *   2. MTPD (asc)   — the tightest "max tolerable period of disruption"
 *                     first; a process that becomes existential in 2h
 *                     must recover before one with a 24h tolerance.
 *                     Missing MTPD sorts last (unknown urgency).
 *   3. RTO (asc)    — where criticality + MTPD tie, the shorter recovery
 *                     objective leads.
 *   4. id           — stable deterministic tiebreak.
 *
 * The rank is the 1-based position in that order. Every rank carries a
 * plain-language rationale naming the exact inputs that placed it there,
 * so an auditor can reconstruct the sequence by hand.
 *
 * Pure function — no DB, no ctx — so the ordering is exhaustively
 * unit-testable.
 */

export type Criticality = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Criticality → weight. Higher recovers first. Unknown → 0 (sorts last). */
export const CRITICALITY_RANK: Record<string, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
};

export interface RecoveryCandidate {
    id: string;
    criticality: string;
    mtpdHours: number | null;
    rtoHours: number | null;
}

export interface RecoveryRanking {
    id: string;
    rank: number;
    /**
     * The English sentence, for the API and exports. The BIA detail page does
     * NOT render it: it composes the same sentence from the BIA's own inputs
     * through `audits.biaDetail.recoveryRationale`, so it reads in the
     * viewer's language.
     */
    rationale: string;
}

function crit(c: string): number {
    return CRITICALITY_RANK[(c ?? '').toUpperCase()] ?? 0;
}

/**
 * Rank a set of BIAs into a recovery sequence. Returns one ranking per
 * input, ordered by the documented precedence (rank 1 = recovers first).
 */
export function deriveRecoveryPriority(candidates: RecoveryCandidate[]): RecoveryRanking[] {
    const sorted = [...candidates].sort((a, b) => {
        const c = crit(b.criticality) - crit(a.criticality);
        if (c !== 0) return c;
        const am = a.mtpdHours ?? Number.POSITIVE_INFINITY;
        const bm = b.mtpdHours ?? Number.POSITIVE_INFINITY;
        if (am !== bm) return am - bm;
        const ar = a.rtoHours ?? Number.POSITIVE_INFINITY;
        const br = b.rtoHours ?? Number.POSITIVE_INFINITY;
        if (ar !== br) return ar - br;
        return a.id.localeCompare(b.id);
    });

    return sorted.map((cand, i) => {
        const parts = [`${(cand.criticality ?? 'unset').toUpperCase()} criticality`];
        parts.push(cand.mtpdHours != null ? `MTPD ${cand.mtpdHours}h` : 'no MTPD set');
        if (cand.rtoHours != null) parts.push(`RTO ${cand.rtoHours}h`);
        return {
            id: cand.id,
            rank: i + 1,
            rationale: `${parts.join(' · ')} → recovery #${i + 1}`,
        };
    });
}

/** Convenience: the rank for a single BIA within a set (or null if absent). */
export function rankFor(id: string, rankings: RecoveryRanking[]): RecoveryRanking | null {
    return rankings.find((r) => r.id === id) ?? null;
}
