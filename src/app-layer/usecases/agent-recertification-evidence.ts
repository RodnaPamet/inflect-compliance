/**
 * Agent recertification (step 3a, #3674) — the evidence a reviewer pack is
 * built from, READ ONLY.
 *
 * This is the usecase behind the `get_agent_recertification_evidence` MCP read
 * tool, which is the one READ step of the `agent-recertification-pack`
 * workflow. Every section of a pack comes from here, and everything here is a
 * read of a stored row: `tests/guards/agent-recertification-single-write-seam.test.ts`
 * fails if this file ever calls a write delegate or raw SQL. The pack is
 * evidence; a pack that could change what it describes would not be.
 *
 * The sections, and the table each reads:
 *
 *   grants with grantor and date             RegisteredAgentTool
 *   granted tools called in the window       AgentBehaviourWindow (tool names per hour)
 *   proposals and outcomes per grant         AgentProposal, by the kind a propose tool queues
 *   card versions since the last campaign    AgentPolicyCardVersion, after the agent's
 *                                            last CLOSED AGENT campaign
 *   time-bounded grants, expired on time?    ExternalWriteJournal (`GRANT_EXPIRY_ARGS` tools),
 *                                            per agent, capped and flagged (#5317)
 *   guard flags                              AgentProposal.guardVerdict
 *   breaker trips                            AgentCircuitBreaker
 *   kill engagements                         AgentKillSwitch
 *   harness level and drift                  DiscoveredAgent + AgentHarnessScanItem
 *
 * The window is the 90 days before the campaign was CREATED — not before the
 * read — so every page of one campaign, read at any time, reads the same
 * window, and the pack describes the population the campaign froze.
 *
 * Narrowed like the subjects it describes: the campaign's reviewer, or a holder
 * of `admin.agent_registry` (`mayReadAgentSubjects`). Every role holds
 * `access_reviews.view`, and a pack is register data.
 *
 * ── The auditor is not the auditee (roadmap rule 8) ──────────────────────
 *
 * When the caller IS a registered agent (`ctx.agentId`, which a pack run
 * carries), its own subject is never read: excluded from the population the
 * pages cover, and refused by name when asked for (`SELF_PACK_REFUSED`). So an
 * agent cannot prepare the pack it is reviewed by however it is driven — the
 * campaign's orchestration routes that one pack to the cross-preparer, or to a
 * person when it names none, and this is the half that holds for any caller of
 * the read tool.
 *
 * `onlyAgentId` narrows the read to one subject: the run for the preparer's
 * own pack — the cross-preparer's, or the person's — reads exactly that one.
 *
 * @module app-layer/usecases/agent-recertification-evidence
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { mayReadAgentSubjects } from '@/lib/access-review/scope';
import {
    PACK_PAGE_SIZE,
    PROPOSAL_KIND_BY_PROPOSE_TOOL,
    observationWindow,
    type RecertificationEvidence,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';
import { GRANT_EXPIRY_ARGS } from './external-write-reconcile';
import { assertCanRead } from '../policies/common';
import type { RequestContext } from '../types';

/** Grants read per agent before the read is called truncated (the catalogue is a handful). */
const GRANTS_PER_AGENT = 200;
/** Card versions read per agent since its last campaign. */
const CARD_VERSIONS_PER_AGENT = 50;
/**
 * Time-bounded grants read per AGENT before its section is called truncated
 * (#5317). Per agent, so one agent issuing daily JIT grants cannot take the
 * rows of every other agent on its page; and 25, so a page of
 * `PACK_PAGE_SIZE` agents reads at most the 500 rows the old per-page read
 * did, and the run's context budget is unchanged.
 */
export const TIME_BOUNDED_PER_AGENT = 25;
/** Kill engagements read per page of agents. */
const KILLS_PER_PAGE = 500;
/** Harness items read per discovered agent (only the latest two are used). */
const HARNESS_ITEMS_PER_AGENT = 10;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function levelRank(level: string | null): number {
    return level && /^H[0-5]$/.test(level) ? Number(level.slice(1)) : -1;
}

/** Does the far end's stored end date say the grant had ended, and was that verified? */
function timeBoundedState(row: {
    argumentsJson: string;
    advertisedToolName: string;
    expiryVerifiedAt: Date | null;
    expiryRaisedAt: Date | null;
}, windowEnd: Date): { endsAt: string | null; state: string; expiredOnTime: boolean | null } {
    let endsAt: Date | null = null;
    const field = GRANT_EXPIRY_ARGS.get(row.advertisedToolName);
    try {
        const args = JSON.parse(row.argumentsJson) as Record<string, unknown>;
        const raw = field ? args[field] : undefined;
        const parsed = typeof raw === 'string' ? new Date(raw) : null;
        endsAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    } catch {
        endsAt = null;
    }
    // Raised first: a grant the sweep found still live past its end is the
    // answer "no" whatever else is stamped on it.
    if (row.expiryRaisedAt) return { endsAt: iso(endsAt), state: 'OUTLIVED_WINDOW', expiredOnTime: false };
    if (row.expiryVerifiedAt) return { endsAt: iso(endsAt), state: 'EXPIRED_VERIFIED', expiredOnTime: true };
    if (!endsAt) return { endsAt: null, state: 'END_UNREADABLE', expiredOnTime: null };
    return endsAt.getTime() > windowEnd.getTime()
        ? { endsAt: iso(endsAt), state: 'RUNNING', expiredOnTime: null }
        : { endsAt: iso(endsAt), state: 'AWAITING_VERIFICATION', expiredOnTime: null };
}

export async function readAgentRecertificationEvidence(
    ctx: RequestContext,
    accessReviewId: string,
    page = 0,
    onlyAgentId: string | null = null,
): Promise<RecertificationEvidence> {
    assertCanRead(ctx);
    if (!Number.isInteger(page) || page < 0) throw badRequest('page must be a non-negative integer');
    if (ctx.agentId && onlyAgentId === ctx.agentId) {
        throw forbidden('SELF_PACK_REFUSED: a registered agent may not read the evidence for its own reviewer pack');
    }

    return runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, scope: true, reviewerUserId: true, createdAt: true },
        });
        if (!review) throw notFound('Access review not found');
        if (review.scope !== 'AGENT') throw badRequest('NOT_AN_AGENT_CAMPAIGN: only an AGENT campaign has reviewer packs');
        if (!mayReadAgentSubjects({
            userId: ctx.userId,
            reviewerUserId: review.reviewerUserId,
            holdsAgentRegistry: ctx.appPermissions?.admin?.agent_registry === true,
        })) {
            throw forbidden('A reviewer pack is readable by the campaign’s reviewer and by holders of admin.agent_registry');
        }

        const window = observationWindow(review.createdAt);

        // The population this read covers: one subject, or every subject but
        // the calling agent's own.
        const scope = {
            tenantId: ctx.tenantId,
            accessReviewId,
            ...(onlyAgentId
                ? { subjectAgentId: onlyAgentId }
                : ctx.agentId
                    ? { NOT: { subjectAgentId: ctx.agentId } }
                    : {}),
        };
        const total = await db.accessReviewConnectedDecision.count({ where: scope });
        const subjects = await db.accessReviewConnectedDecision.findMany({
            where: scope,
            select: { id: true, subjectAgentId: true },
            orderBy: [{ subjectRef: 'asc' }, { id: 'asc' }],
            skip: page * PACK_PAGE_SIZE,
            take: PACK_PAGE_SIZE,
        });
        const rows = subjects.filter((s): s is { id: string; subjectAgentId: string } => typeof s.subjectAgentId === 'string');
        const agentIds = [...new Set(rows.map((s) => s.subjectAgentId))];

        if (agentIds.length === 0) {
            return {
                accessReviewId, page, pageSize: PACK_PAGE_SIZE, total,
                window: { start: window.start.toISOString(), end: window.end.toISOString() },
                subjects: [],
            };
        }

        // ── Grants ───────────────────────────────────────────────────────
        const grants = await db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId: { in: agentIds } },
            select: { id: true, agentId: true, toolName: true, grantedByUserId: true, createdAt: true },
            orderBy: [{ agentId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            take: agentIds.length * GRANTS_PER_AGENT + 1,
        });
        const grantsTruncatedOverall = grants.length > agentIds.length * GRANTS_PER_AGENT;

        // ── Observed use, one bounded read per grant ─────────────────────
        //
        // ONE row per (agent, tool), and only whether a window inside the
        // observation window names the tool: `take: 1` on the index prefix
        // (tenantId, agentId, windowStart). A single read across every agent
        // would need the whole window's rows to answer per tool, which the
        // behaviour-window read bound refuses, and a capped one would turn
        // "not read" into "not called" — the one wrong answer that deletes a
        // grant somebody needs.
        const lastCalledByGrant = new Map<string, Date | null>();
        for (const g of grants) { // guardrail-allow: n+1 — one take:1 indexed read per grant, bounded by PACK_PAGE_SIZE × GRANTS_PER_AGENT
            const hit = await db.agentBehaviourWindow.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId: g.agentId,
                    windowStart: { gte: window.start, lt: window.end },
                    toolNames: { has: g.toolName },
                },
                select: { windowStart: true },
                orderBy: { windowStart: 'desc' },
                take: 1,
            });
            lastCalledByGrant.set(g.id, hit[0]?.windowStart ?? null);
        }

        // ── Proposals and guard flags ────────────────────────────────────
        const proposalCounts = await db.agentProposal.groupBy({
            by: ['agentId', 'kind', 'status'],
            where: {
                tenantId: ctx.tenantId,
                agentId: { in: agentIds },
                createdAt: { gte: window.start, lt: window.end },
            },
            _count: { _all: true },
        });
        const guardCounts = await db.agentProposal.groupBy({
            by: ['agentId', 'guardVerdict'],
            where: {
                tenantId: ctx.tenantId,
                agentId: { in: agentIds },
                createdAt: { gte: window.start, lt: window.end },
                guardVerdict: { not: 'CLEAN' },
            },
            _count: { _all: true },
        });

        // ── The agent's last closed AGENT campaign, for "card versions since" ──
        const priorDecisions = await db.accessReviewConnectedDecision.findMany({
            where: {
                tenantId: ctx.tenantId,
                subjectAgentId: { in: agentIds },
                accessReviewId: { not: accessReviewId },
                accessReview: { scope: 'AGENT', status: 'CLOSED', closedAt: { lt: window.end } },
            },
            select: { subjectAgentId: true, accessReview: { select: { closedAt: true } } },
            take: agentIds.length * 50,
        });
        const lastCampaignClosedAt = new Map<string, Date>();
        for (const d of priorDecisions) {
            const at = d.accessReview.closedAt;
            if (!d.subjectAgentId || !at) continue;
            const prev = lastCampaignClosedAt.get(d.subjectAgentId);
            if (!prev || at > prev) lastCampaignClosedAt.set(d.subjectAgentId, at);
        }

        const cards = await db.agentPolicyCard.findMany({
            where: { tenantId: ctx.tenantId, agentId: { in: agentIds } },
            select: {
                agentId: true,
                currentVersion: true,
                versions: {
                    select: {
                        version: true, createdAt: true, createdByUserId: true, approvalRung: true,
                        maxAutonomyLevel: true, maxDataScope: true, permittedTools: true,
                    },
                    // The NEWEST, so a long-lived card's recent history is what
                    // is read; re-sorted ascending below.
                    orderBy: { version: 'desc' },
                    take: CARD_VERSIONS_PER_AGENT,
                },
            },
            take: agentIds.length,
        });
        const cardByAgent = new Map(cards.map((c) => [c.agentId, c]));

        // ── Time-bounded grants ──────────────────────────────────────────
        //
        // One read PER AGENT, capped, read one past the cap so truncation is a
        // fact the pack states (`timeBoundedTruncated`) rather than one nobody
        // can observe. It was one 500-row read over all history for the whole
        // page, newest first and unflagged (#5317): a single busy agent filled
        // it, every other agent on the page was filed with an empty list, and
        // the busy agent's oldest rows were dropped with nothing to say so.
        //
        // Bounded to the grants still relevant to the window: made in it, or
        // made before it and not verified gone before it began — plus every
        // grant the sweep RAISED, whenever. A raise is a control that failed
        // on this agent's record; it is rare, and it is the row a reviewer
        // must see.
        //
        // Read in the order the cap should spend itself: raised (OUTLIVED_WINDOW)
        // first, then grants not yet verified gone (undetermined), then the
        // verified ones newest first. So when the cap bites it drops the
        // oldest grants that ended on time, never an outlived one before
        // them. The section is re-sorted newest first below, as it always was.
        const timeBoundedByAgent = new Map<string, {
            rows: Array<{
                id: string; advertisedToolName: string; connectionName: string;
                argumentsJson: string; attemptedAt: Date; expiryVerifiedAt: Date | null; expiryRaisedAt: Date | null;
            }>;
            truncated: boolean;
        }>();
        for (const agentId of agentIds) { // guardrail-allow: n+1 — one capped read per agent, bounded by PACK_PAGE_SIZE; a shared read is what let one agent starve the rest (#5317)
            const read = await db.externalWriteJournal.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId,
                    advertisedToolName: { in: [...GRANT_EXPIRY_ARGS.keys()] },
                    outcome: 'APPLIED',
                    attemptedAt: { lt: window.end },
                    OR: [
                        { attemptedAt: { gte: window.start } },
                        { expiryVerifiedAt: null },
                        { expiryVerifiedAt: { gte: window.start } },
                        { expiryRaisedAt: { not: null } },
                    ],
                },
                select: {
                    id: true, advertisedToolName: true, connectionName: true,
                    argumentsJson: true, attemptedAt: true, expiryVerifiedAt: true, expiryRaisedAt: true,
                },
                orderBy: [
                    { expiryRaisedAt: { sort: 'desc', nulls: 'last' } },
                    { expiryVerifiedAt: { sort: 'desc', nulls: 'first' } },
                    { attemptedAt: 'desc' },
                    { id: 'asc' },
                ],
                take: TIME_BOUNDED_PER_AGENT + 1,
            });
            const kept = read.slice(0, TIME_BOUNDED_PER_AGENT).sort((x, y) =>
                y.attemptedAt.getTime() - x.attemptedAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
            timeBoundedByAgent.set(agentId, { rows: kept, truncated: read.length > TIME_BOUNDED_PER_AGENT });
        }

        // ── Breakers and kills ───────────────────────────────────────────
        const breakers = await db.agentCircuitBreaker.findMany({
            where: { tenantId: ctx.tenantId, agentId: { in: agentIds } },
            select: { agentId: true, state: true, trippedAt: true, trippedSignals: true, closedAt: true },
            take: agentIds.length,
        });
        const breakerByAgent = new Map(breakers.map((b) => [b.agentId, b]));

        const kills = await db.agentKillSwitch.findMany({
            where: {
                tenantId: ctx.tenantId,
                agentId: { in: agentIds },
                engagedAt: { lt: window.end },
                OR: [{ liftedAt: null }, { liftedAt: { gte: window.start } }],
            },
            select: { agentId: true, engagedAt: true, liftedAt: true, engagedByUserId: true, liftedByUserId: true },
            orderBy: [{ engagedAt: 'asc' }],
            take: KILLS_PER_PAGE,
        });

        // ── Harness level and drift ──────────────────────────────────────
        const discovered = await db.discoveredAgent.findMany({
            where: { tenantId: ctx.tenantId, registeredAgentId: { in: agentIds } },
            select: { id: true, registeredAgentId: true, lastLevel: true, lastSeenAt: true },
            take: agentIds.length * 5,
        });
        const discoveredIds = discovered.map((d) => d.id);
        const items = discoveredIds.length
            ? await db.agentHarnessScanItem.findMany({
                where: { tenantId: ctx.tenantId, discoveredAgentId: { in: discoveredIds } },
                select: { discoveredAgentId: true, level: true, scan: { select: { asOf: true } } },
                orderBy: [{ scan: { asOf: 'desc' } }, { id: 'asc' }],
                take: discoveredIds.length * HARNESS_ITEMS_PER_AGENT,
            })
            : [];

        // ── Assemble, in memory ──────────────────────────────────────────
        const out: SubjectEvidence[] = rows.map((s) => {
            const agentId = s.subjectAgentId;
            const own = grants.filter((g) => g.agentId === agentId);
            const kindsGranted = new Set(
                own.map((g) => PROPOSAL_KIND_BY_PROPOSE_TOOL[g.toolName]).filter((k): k is string => Boolean(k)),
            );
            const countsFor = (kind: string): Record<string, number> => {
                const c: Record<string, number> = {};
                for (const p of proposalCounts) {
                    if (p.agentId === agentId && p.kind === kind) c[p.status] = (c[p.status] ?? 0) + p._count._all;
                }
                return c;
            };
            const otherProposals: Record<string, Record<string, number>> = {};
            for (const p of proposalCounts) {
                if (p.agentId !== agentId || kindsGranted.has(p.kind)) continue;
                otherProposals[p.kind] = { ...(otherProposals[p.kind] ?? {}), [p.status]: (otherProposals[p.kind]?.[p.status] ?? 0) + p._count._all };
            }
            const guardFlags: Record<string, number> = {};
            for (const g of guardCounts) {
                if (g.agentId === agentId) guardFlags[g.guardVerdict] = (guardFlags[g.guardVerdict] ?? 0) + g._count._all;
            }

            const since = lastCampaignClosedAt.get(agentId) ?? null;
            const card = cardByAgent.get(agentId);
            const versions = [...(card?.versions ?? [])]
                .filter((v) => (since ? v.createdAt > since : true) && v.createdAt < window.end)
                .sort((a, b) => a.version - b.version)
                .map((v) => ({
                    version: v.version,
                    createdAt: v.createdAt.toISOString(),
                    createdByUserId: v.createdByUserId,
                    approvalRung: v.approvalRung,
                    maxAutonomyLevel: v.maxAutonomyLevel,
                    maxDataScope: v.maxDataScope,
                    permittedToolCount: v.permittedTools.length,
                }));

            const breaker = breakerByAgent.get(agentId);
            const mine = discovered
                .filter((d) => d.registeredAgentId === agentId)
                .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
            const latestItems = items
                .filter((i) => mine.some((d) => d.id === i.discoveredAgentId))
                .sort((a, b) => b.scan.asOf.getTime() - a.scan.asOf.getTime());
            const level = latestItems[0]?.level ?? mine[0]?.lastLevel ?? null;
            const previousLevel = latestItems[1]?.level ?? null;
            const drift = mine.length === 0
                ? 'NOT_SCANNED'
                : previousLevel === null
                    ? 'FIRST_SCAN'
                    : levelRank(level) > levelRank(previousLevel)
                        ? 'UP'
                        : levelRank(level) < levelRank(previousLevel) ? 'DOWN' : 'SAME';

            return {
                decisionId: s.id,
                agentId,
                grants: own.map((g) => {
                    const lastCalledAt = lastCalledByGrant.get(g.id) ?? null;
                    const kind = PROPOSAL_KIND_BY_PROPOSE_TOOL[g.toolName];
                    return {
                        grantId: g.id,
                        toolName: g.toolName,
                        grantedByUserId: g.grantedByUserId,
                        grantedAt: g.createdAt.toISOString(),
                        lastCalledAt: iso(lastCalledAt),
                        heldForWholeWindow: g.createdAt.getTime() <= window.start.getTime(),
                        proposals: kind ? countsFor(kind) : null,
                    };
                }),
                // Per agent: this agent's own list hit the cap, or the read as a
                // whole did and this agent's share cannot be vouched for.
                grantsTruncated: own.length >= GRANTS_PER_AGENT || grantsTruncatedOverall,
                otherProposals,
                cardVersions: { since: iso(since), currentVersion: card?.currentVersion ?? null, versions },
                timeBoundedGrants: (timeBoundedByAgent.get(agentId)?.rows ?? [])
                    .map((t) => ({
                        journalId: t.id,
                        toolName: t.advertisedToolName,
                        connectionName: t.connectionName,
                        grantedAt: t.attemptedAt.toISOString(),
                        ...timeBoundedState(t, window.end),
                    })),
                // This agent's own read hit its cap: the list above is its
                // outlived and undetermined grants, then the newest that ended
                // on time — not all of them.
                timeBoundedTruncated: timeBoundedByAgent.get(agentId)?.truncated ?? false,
                guardFlags,
                breaker: breaker
                    ? {
                        state: breaker.state,
                        trippedAt: iso(breaker.trippedAt),
                        trippedInWindow: Boolean(breaker.trippedAt
                            && breaker.trippedAt >= window.start && breaker.trippedAt < window.end),
                        trippedSignals: [...breaker.trippedSignals],
                        closedAt: iso(breaker.closedAt),
                    }
                    : null,
                killEngagements: kills
                    .filter((k) => k.agentId === agentId)
                    .map((k) => ({
                        engagedAt: k.engagedAt.toISOString(),
                        liftedAt: iso(k.liftedAt),
                        engagedByUserId: k.engagedByUserId,
                        liftedByUserId: k.liftedByUserId,
                    })),
                harness: { level, previousLevel, drift, lastSeenAt: iso(mine[0]?.lastSeenAt) },
            };
        });

        return {
            accessReviewId,
            page,
            pageSize: PACK_PAGE_SIZE,
            total,
            window: { start: window.start.toISOString(), end: window.end.toISOString() },
            subjects: out,
        };
    });
}
