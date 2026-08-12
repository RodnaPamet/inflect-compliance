/**
 * DSAR workflow state machine — pure, dependency-free.
 *
 * Mirrors the shape of `task-status.ts`: a transition graph plus a pure
 * checker returning `null` on success and a discriminated error otherwise, so
 * the wording stays identical across every caller.
 *
 * ─────────────────────────────────────────────────────────────────────
 *   RECEIVED    → VERIFIED | REJECTED | CANCELED
 *   VERIFIED    → IN_PROGRESS | REJECTED | CANCELED
 *   IN_PROGRESS → COMPLETED | REJECTED
 *   COMPLETED   → (terminal)
 *   REJECTED    → (terminal)
 *   CANCELED    → (terminal)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Two things this graph encodes deliberately:
 *
 *   • CANCELED is a distinct terminal state, NOT a REJECTED variant.
 *     "The subject withdrew the request" and "we refused the request" are
 *     different facts to a regulator, and a register that conflates them
 *     answers the wrong question under audit.
 *
 *   • CANCELED is unreachable from IN_PROGRESS. Once fulfilment has begun,
 *     the honest terminal states are COMPLETED (we did it) or REJECTED (we
 *     could not). Retro-cancelling work already performed would misrepresent
 *     what happened.
 *
 * NOTE — actor awareness. `docs/dsar.md` describes VERIFIED → IN_PROGRESS as
 * job-driven. In the manual-fulfilment queue it is admin-driven, and the two
 * will coexist if the automated pipeline (docs/dsar.md Stage 2/3) ever lands.
 * `checkDsarTransition` therefore takes an explicit `actor` so the graph can
 * diverge per-driver without retrofitting later — today both actors share the
 * same edges, and `actor` is recorded rather than restricting.
 *
 * @module app-layer/domain/dsar-status
 */
import type { DataSubjectRequestStatus } from '@prisma/client';

export type DsarStatus = DataSubjectRequestStatus;

/** Who is driving the transition. See the actor-awareness note above. */
export type DsarTransitionActor = 'admin' | 'job';

export const DSAR_TRANSITIONS: Record<DsarStatus, ReadonlySet<DsarStatus>> = {
    RECEIVED: new Set(['VERIFIED', 'REJECTED', 'CANCELED'] as DsarStatus[]),
    VERIFIED: new Set(['IN_PROGRESS', 'REJECTED', 'CANCELED'] as DsarStatus[]),
    IN_PROGRESS: new Set(['COMPLETED', 'REJECTED'] as DsarStatus[]),
    COMPLETED: new Set([] as DsarStatus[]),
    REJECTED: new Set([] as DsarStatus[]),
    CANCELED: new Set([] as DsarStatus[]),
};

/** Terminal states — no transitions out. */
export const DSAR_TERMINAL_STATUSES: ReadonlySet<DsarStatus> = new Set([
    'COMPLETED',
    'REJECTED',
    'CANCELED',
] as DsarStatus[]);

export type DsarTransitionError =
    | { kind: 'unknown_from'; from: string }
    | { kind: 'unknown_to'; to: string }
    | { kind: 'no_op'; status: string }
    | { kind: 'terminal'; from: string }
    | { kind: 'illegal'; from: string; to: string };

/**
 * Pure transition check. Returns `null` when the move is legal.
 *
 * `actor` is accepted for forward-compatibility with the automated pipeline
 * (see the module note) — it does not currently restrict any edge.
 */
export function checkDsarTransition(
    from: string,
    to: string,
    _actor: DsarTransitionActor = 'admin',
): DsarTransitionError | null {
    if (!(from in DSAR_TRANSITIONS)) return { kind: 'unknown_from', from };
    if (!(to in DSAR_TRANSITIONS)) return { kind: 'unknown_to', to };
    if (from === to) return { kind: 'no_op', status: from };
    if (DSAR_TERMINAL_STATUSES.has(from as DsarStatus)) {
        return { kind: 'terminal', from };
    }
    if (!DSAR_TRANSITIONS[from as DsarStatus].has(to as DsarStatus)) {
        return { kind: 'illegal', from, to };
    }
    return null;
}

/** Render a transition error into a message suitable for `badRequest()`. */
export function formatDsarTransitionError(err: DsarTransitionError): string {
    switch (err.kind) {
        case 'unknown_from':
            return `Unknown current status "${err.from}"; cannot validate transition.`;
        case 'unknown_to':
            return `Unknown target status "${err.to}".`;
        case 'no_op':
            return `Request is already ${err.status}.`;
        case 'terminal':
            return `${err.from} is a terminal state; the request cannot be reopened.`;
        case 'illegal':
            return `Cannot move a request from ${err.from} to ${err.to}.`;
    }
}

/**
 * Whether a status change requires a recorded reason.
 *
 * REJECTED must carry one of the DSAR_REJECTION_REASONS — "we refused this"
 * is not a defensible register entry without the why.
 */
export function requiresReason(to: DsarStatus): boolean {
    return to === 'REJECTED';
}
