import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { assertCanRead } from '../policies/common';
import { assertMayReadOversightSurface } from './agent-oversight-settings';

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
 * The page reads ONE PAST the bound (#4896), so it can say when older rows
 * exist rather than show a window as if it were the whole log.
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
    /**
     * The run a run's row — or a run's outside tool call — came from (#4896),
     * so the page can link where it is reviewed. Derived from `sessionRef`,
     * which is NEVER surfaced itself: on other features it is a session key
     * that can carry text (a composed request's template label).
     */
    runId: string | null;
    /** The registered agent the call spoke for, or `null`. */
    agentId: string | null;
}

/**
 * What the page narrows by (#4896). `REVIEWED` is any human verdict; the
 * other two are the stored values.
 */
export type AiDecisionOutcomeFilter = 'PENDING' | 'REVIEWED' | 'AUTONOMOUS';

/**
 * What KIND of call a row records, as the page groups them (#4896). A run's
 * rows carry the workflow in the feature (`agentic-run:<key>`), so "every
 * agent run" is a prefix, not one value.
 */
export const AI_DECISION_KINDS = ['assistant', 'run', 'tool', 'proposal', 'automatic', 'risk', 'matching'] as const;
export type AiDecisionKind = (typeof AI_DECISION_KINDS)[number];

const KIND_WHERE: Readonly<Record<AiDecisionKind, unknown>> = {
    assistant: { feature: 'assistant' },
    run: { feature: { startsWith: 'agentic-run:' } },
    tool: { feature: 'agentic-tool:external' },
    proposal: { feature: 'agent-proposal' },
    automatic: { feature: 'external-write-automatic' },
    risk: { feature: 'risk-suggestions' },
    matching: { feature: 'legacy-identity-match' },
};

export interface AiDecisionQuery {
    digest?: string;
    outcome?: AiDecisionOutcomeFilter;
    kind?: AiDecisionKind;
    agentId?: string;
}

const OUTCOME_WHERE: Readonly<Record<AiDecisionOutcomeFilter, unknown>> = {
    PENDING: { humanOutcome: 'PENDING' },
    REVIEWED: { humanOutcome: { in: ['ACCEPTED', 'EDITED', 'REJECTED'] } },
    AUTONOMOUS: { humanOutcome: 'AUTONOMOUS' },
};

/** The narrowing, or `undefined` for none — never an always-set `where`. */
function whereFor(opts: AiDecisionQuery) {
    const where = {
        ...(opts.digest ? { inputDigest: opts.digest } : {}),
        ...(opts.outcome ? (OUTCOME_WHERE[opts.outcome] as object) : {}),
        ...(opts.kind ? (KIND_WHERE[opts.kind] as object) : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
    };
    return Object.keys(where).length > 0 ? where : undefined;
}

/** Is this row written by a run, so that its `sessionRef` is the run's id? */
function isRunRow(feature: string): boolean {
    return feature.startsWith('agentic-run:') || feature === 'agentic-tool:external';
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
    opts: AiDecisionQuery = {},
): Promise<AiDecisionRow[]> {
    return (await readAiDecisions(ctx, opts, AI_DECISION_PAGE_SIZE)).slice(0, AI_DECISION_PAGE_SIZE);
}

/**
 * The page's read (#4896): the newest window, whether older rows exist, and
 * the names the rows point at — the agent each spoke for, the connection an
 * external tool call went to — so the page shows names rather than ids.
 */
export interface AiDecisionPage {
    rows: AiDecisionRow[];
    /** The bound, when more rows match than are shown; else `null`. */
    capped: number | null;
    agentNames: Record<string, string>;
    connectionNames: Record<string, string>;
}

export async function readAiDecisionPage(ctx: RequestContext, opts: AiDecisionQuery = {}): Promise<AiDecisionPage> {
    const read = await readAiDecisions(ctx, opts, AI_DECISION_PAGE_SIZE + 1);
    const rows = read.slice(0, AI_DECISION_PAGE_SIZE);
    const agentIds = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
    const connectionIds = [
        ...new Set(
            rows.flatMap((r) => {
                if (!r.provider.startsWith('mcp:')) return [];
                const id = r.provider.slice('mcp:'.length);
                return id ? [id] : [];
            }),
        ),
    ];
    const [agents, connections] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            agentIds.length
                ? db.registeredAgent.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                      select: { id: true, name: true },
                      take: agentIds.length,
                  })
                : Promise.resolve([] as { id: string; name: string }[]),
            connectionIds.length
                ? db.integrationConnection.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: connectionIds } },
                      select: { id: true, name: true },
                      take: connectionIds.length,
                  })
                : Promise.resolve([] as { id: string; name: string }[]),
        ]),
    );
    return {
        rows,
        capped: read.length > AI_DECISION_PAGE_SIZE ? AI_DECISION_PAGE_SIZE : null,
        agentNames: Object.fromEntries(agents.map((a) => [a.id, a.name])),
        connectionNames: Object.fromEntries(connections.map((c) => [c.id, c.name])),
    };
}

async function readAiDecisions(ctx: RequestContext, opts: AiDecisionQuery, take: number): Promise<AiDecisionRow[]> {
    // The register key, or the inventory view key while an owner lets Auditors
    // read the log (`agent-oversight-settings.ts`, #4896).
    assertCanRead(ctx);
    await assertMayReadOversightSurface(ctx, 'decisions');
    const rows = await runInTenantContext(ctx, (db) =>
        db.aiDecisionLog.findMany({
            // A digest narrows to "every decision taken over THIS content",
            // which is what a link from a guarded step or proposal needs to
            // land on. The outcome, feature and agent narrow the same way
            // (#4896). Absent, the surface shows the newest window.
            where: whereFor(opts),
            orderBy: { createdAt: 'desc' },
            take,
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
                sessionRef: true,
                agentId: true,
            },
        }),
    );

    return rows.map(({ sessionRef, ...r }) => ({
        ...r,
        runId: isRunRow(r.feature) ? sessionRef : null,
        // Serialised at the seam rather than at the component boundary: a
        // `Date` does not survive the server->client hop, and every other
        // agentic payload in this tree converts here for the same reason.
        createdAt: r.createdAt.toISOString(),
    }));
}
