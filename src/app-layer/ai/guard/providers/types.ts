/**
 * AI Guard — the `GuardProvider` seam (NeMo Guardrails roadmap, Phase 1.1).
 *
 * A provider answers one question about one piece of content: what verdict
 * does it earn, and which of the provider's rules fired. It answers nothing
 * else. It holds no permission check, no usecase call, no Prisma call and no
 * tenant mode: the mode, the enforcement action, the audit row and the
 * `GuardOutcome` are all decided ONCE, above the providers, in `../index.ts`,
 * exactly as they were before the seam existed. That keeps every provider a
 * pure verdict source, and it is what lets `compose.ts` combine them by
 * verdict alone.
 *
 * `scan` never makes a model call and never "answers" the content — a guard
 * that produced text would be a second model route whose residency nobody
 * chose (G1).
 */
import type { GuardVerdict, ScanResult } from '../injection-scanner';
import type { GuardDirection } from '../policy';

/** Which side of the boundary the content is crossing. Same values as `GuardDirection`. */
export type GuardScanKind = GuardDirection;

/**
 * What a provider may know about the call. Deliberately NOT the
 * `RequestContext`: a provider has no business reading a role, a permission
 * or the tenant's guard mode, and a narrow type is how that stays true.
 */
export interface GuardProviderContext {
    readonly requestId: string;
    readonly tenantId: string;
}

export interface GuardProvider {
    /** Stable, lower-case id. Recorded in `GuardOutcome.decidedBy` and used to namespace rule ids. */
    readonly id: string;
    /**
     * Scan the content. `input` content is tenant text on its way into a
     * model; `egress` content is an arbitrary JSON-ish payload on its way out.
     *
     * A provider SHOULD NOT throw — it should return its own unavailable
     * verdict — but `compose.ts` treats a throw, a rejected promise or a
     * malformed result as the provider being unavailable, so one that does
     * throw fails closed rather than open.
     */
    scan(kind: GuardScanKind, content: unknown, ctx: GuardProviderContext): Promise<ScanResult>;
}

/** The verdict vocabulary, in severity order. Shared by compose and its tests. */
export const GUARD_VERDICTS: readonly GuardVerdict[] = ['clean', 'suspicious', 'malicious'];
