import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * THE EU AI ACT RECORD, READ BACK.
 *
 * ── WHY THIS READ EXISTS ────────────────────────────────────────────────────
 *
 * `AiDecisionLog` has been written since the risk assessor shipped — one row
 * per model call (Art 12) with `humanOutcome` stamped when a person decides
 * (Art 14). Nothing has ever read it back except the evidence emitter, which
 * aggregates. So the rows an assessor would ask for existed and could not be
 * shown, which is the gap this closes.
 *
 * ── LIVE, BOUNDED, NO SNAPSHOT ──────────────────────────────────────────────
 *
 * Read per visit, exactly as `/agents/reports` does and for the same stated
 * reason: a governance surface that needed its own table would be a second
 * copy of the record, and two copies can disagree about what a tenant ran.
 *
 * The bound is a `take`, not a page cursor. This is a review surface, not an
 * export — the export path is the governance pack — and the newest window is
 * what a reviewer opens it for. `[tenantId, createdAt]` already indexes it.
 */

/** How many rows the surface shows. The index makes this the cheap direction. */
export const AI_DECISION_PAGE_SIZE = 100;

export interface AiDecisionRow {
    id: string;
    feature: string;
    provider: string;
    model: string | null;
    /**
     * The join key to everything else that was guarded from the same content.
     * `AgentProposal.guardInputDigest` carries the same value, which is how a
     * proposal and its decision row find each other without either storing the
     * content that produced them.
     */
    inputDigest: string;
    outputSummary: string | null;
    guardVerdict: string | null;
    humanOutcome: string;
    tokensIn: number | null;
    tokensOut: number | null;
    latencyMs: number | null;
    createdAt: string;
}

/**
 * The tenant's decision rows, newest first.
 *
 * Tenant scope comes from RLS via `runInTenantContext`, not from a `where`
 * clause this function writes — the same posture every other agentic read
 * takes, so a missing filter here cannot be the thing that leaks a row.
 */
export async function listAiDecisions(
    ctx: RequestContext,
    opts: { digest?: string } = {},
): Promise<AiDecisionRow[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.aiDecisionLog.findMany({
            // A digest narrows to "every decision taken over THIS content",
            // which is what a link from a guarded step or proposal needs to
            // land on. Absent, the surface shows the newest window.
            where: opts.digest ? { inputDigest: opts.digest } : undefined,
            orderBy: { createdAt: 'desc' },
            take: AI_DECISION_PAGE_SIZE,
            select: {
                id: true,
                feature: true,
                provider: true,
                model: true,
                inputDigest: true,
                outputSummary: true,
                guardVerdict: true,
                humanOutcome: true,
                tokensIn: true,
                tokensOut: true,
                latencyMs: true,
                createdAt: true,
            },
        }),
    );

    return rows.map((r) => ({
        ...r,
        // Serialised at the seam rather than at the component boundary: a
        // `Date` does not survive the server->client hop, and every other
        // agentic payload in this tree converts here for the same reason.
        createdAt: r.createdAt.toISOString(),
    }));
}
