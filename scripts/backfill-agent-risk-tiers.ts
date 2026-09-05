/**
 * Agentic 3/10 — score the agents that were ACTIVE before the tier became
 * load-bearing.
 *
 * ## Why this script exists
 *
 * `RegisteredAgent.riskTier IS NULL` means UNSCORED, and from 3/10 onward an
 * unscored agent is refused every MCP tool: `riskTierCeilingFor` resolves it to
 * `DENY_CEILING`, which is below rung 0. That is the control working. It is
 * also, on the deploy that turns it on, a behaviour change for every agent that
 * is ALREADY `ACTIVE` and has never been assessed — and taking a customer's
 * running integrations dark without a route out is not a control, it is an
 * outage with a rationale.
 *
 * There are three routes out and this is the bulk one:
 *
 *   1. FORWARD — `activateRegisteredAgent` now refuses an unscored agent, so
 *      nothing new can enter the ACTIVE-and-unscored state.
 *   2. SELF-SERVICE — `/admin/agents/:id/risk-assessment` + `…/complete` is
 *      reachable at any time, and completing a run is the honest fix: an
 *      operator answers the questions and the agent gets the tier it earns.
 *   3. THIS SCRIPT — for an estate too large to walk by hand, it scores every
 *      ACTIVE unscored agent PROVISIONALLY, from the axes the operator already
 *      declared, with every question left unanswered.
 *
 * ## A provisional score is the STRICTEST tier that agent can hold
 *
 * It runs the real `completeAgentRiskAssessment`. No second copy of the scorer
 * exists anywhere, and none is wanted: a SQL transcription of the bands and
 * floors would be a second opinion that drifts on the first weight change.
 *
 * The scorer counts an unanswered question as NO, so a run with nothing
 * answered carries the full `MAX_ANSWER_POINTS`. The arithmetic that follows
 * from that is the point of the whole approach: 12 answer points alone already
 * exceed the LOW band, so **a provisional score can never come out LOW**, and
 * LOW is the only tier that leaves autonomy uncapped. Nobody can use this script
 * to buy an agent its full ladder — filling in the questionnaire is the only
 * route to rung 6, which is what makes the questionnaire worth filling in.
 *
 * What it does buy is a floor rather than a cliff: a narrow, reversible,
 * read-only agent lands at MODERATE (cap 3, which reaches every tool class the
 * catalogue defines today) and keeps working, while an unattended agent with
 * write or egress access lands at HIGH or CRITICAL and is bounded to PROPOSE or
 * READ until a human assesses it. The dangerous agents are the ones the deploy
 * constrains, which is the correct direction for a control nobody has yet
 * applied by hand.
 *
 * ## What it leaves behind
 *
 * A real `AgentRiskAssessment` run — COMPLETED, with the basis frozen and the
 * breakdown recorded — so the tier has evidence rather than appearing from
 * nowhere. `scoreBreakdownJson.unansweredQuestions` equals
 * `applicableQuestions` on every row this writes, which is how a reader tells a
 * provisional run from a real one without a column that would have to be
 * migrated in. The audit trail carries the usual hash-chained
 * `AGENT_RISK_SCORED` row per agent, attributed to the tenant's oldest ACTIVE
 * OWNER — the same actor the 1/10 register backfill picked, for the same
 * reason: there is no signed-in user, and inventing one would put a person's id
 * on an act they did not perform.
 *
 * DRAFT, SUSPENDED and RETIRED agents are deliberately NOT touched. None of
 * them can pass the registration gate, so none of them is affected by the
 * deploy; scoring them would be inventing judgements nobody needs, and it would
 * put a tier on the 1/10 legacy placeholders, which exist precisely to look
 * unassessed.
 *
 * ## Usage
 *   npx tsx scripts/backfill-agent-risk-tiers.ts            # dry-run (default)
 *   npx tsx scripts/backfill-agent-risk-tiers.ts --execute  # score them
 *   npx tsx scripts/backfill-agent-risk-tiers.ts --tenant=<id> --execute
 */
import type { Role } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { getPermissionsForRole } from '@/lib/permissions';
import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import type { RequestContext } from '@/app-layer/types';

interface Options {
    execute: boolean;
    tenantId: string | null;
    limit: number;
}

function parseArgs(argv: readonly string[]): Options {
    const tenantArg = argv.find((a) => a.startsWith('--tenant='));
    const limitArg = argv.find((a) => a.startsWith('--limit='));
    return {
        execute: argv.includes('--execute'),
        tenantId: tenantArg ? tenantArg.slice('--tenant='.length) : null,
        limit: limitArg ? Number(limitArg.slice('--limit='.length)) : 500,
    };
}

/**
 * The actor. The tenant's oldest ACTIVE OWNER, chosen by the same ordering the
 * 1/10 register backfill used so the two backfills attribute their rows to the
 * same person for the same tenant.
 *
 * `actorType: 'JOB'` because no human asked for this: the audit trail must not
 * claim a person scored twenty agents in one second. `role: 'OWNER'` is what
 * satisfies `assertCanWrite`, and it is the truth about the user whose id is on
 * the row.
 */
async function contextForTenant(tenantId: string): Promise<RequestContext | null> {
    const owner = await prisma.tenantMembership.findFirst({
        where: { tenantId, role: 'OWNER', status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { userId: true },
    });
    if (!owner) return null;

    const role: Role = 'OWNER';
    return {
        requestId: `backfill-agent-risk-tiers-${tenantId}`,
        userId: owner.userId,
        actorType: 'JOB',
        tenantId,
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

export async function run(argv: readonly string[]): Promise<number> {
    const options = parseArgs(argv);

    const candidates = await prisma.registeredAgent.findMany({
        where: {
            status: 'ACTIVE',
            riskTier: null,
            deletedAt: null,
            ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        },
        select: { id: true, tenantId: true, name: true, autonomyLevel: true },
        orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
        take: options.limit,
    });

    console.info(
        `[backfill-agent-risk-tiers] ${candidates.length} ACTIVE unscored agent(s)` +
            `${options.tenantId ? ` in tenant ${options.tenantId}` : ''}` +
            `${options.execute ? '' : ' (dry-run — pass --execute to score them)'}`,
    );

    if (!options.execute) {
        for (const a of candidates) {
            console.info(`  would score ${a.id} (${a.name}) — tenant ${a.tenantId}`);
        }
        return 0;
    }

    const contexts = new Map<string, RequestContext | null>();
    let scored = 0;
    let skipped = 0;
    let failed = 0;

    for (const agent of candidates) {
        if (!contexts.has(agent.tenantId)) {
            contexts.set(agent.tenantId, await contextForTenant(agent.tenantId));
        }
        const ctx = contexts.get(agent.tenantId) ?? null;
        if (!ctx) {
            // Same skip the 1/10 backfill takes, and for the same reason: with
            // no ACTIVE OWNER there is nobody to attribute the judgement to.
            skipped += 1;
            console.warn(
                `  skipped ${agent.id} — tenant ${agent.tenantId} has no ACTIVE OWNER to attribute the score to`,
            );
            continue;
        }

        try {
            // Per-agent isolation: one agent whose row moved under us must not
            // abort the estate.
            const result = await completeAgentRiskAssessment(ctx, agent.id);
            scored += 1;
            console.info(
                `  scored ${agent.id} (${agent.name}) → ${result.tier} ` +
                    `[score ${result.score}, band ${result.band}]`,
            );
        } catch (err) {
            failed += 1;
            console.error(
                `  FAILED ${agent.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    console.info(
        `[backfill-agent-risk-tiers] scored=${scored} skipped=${skipped} failed=${failed}`,
    );
    return failed > 0 ? 1 : 0;
}

if (require.main === module) {
    run(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[backfill-agent-risk-tiers] fatal', err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
