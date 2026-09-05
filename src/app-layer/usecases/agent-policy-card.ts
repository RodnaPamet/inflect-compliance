/**
 * The agent POLICY CARD — usecase. Creating one, and widening or narrowing it.
 *
 * ## What a card is for
 *
 * 1/10 registered the agent, 2/10 bounded its credential, 3/10 scored it. All
 * three produce RECORDS, and a record does not stop anything. A policy card is
 * the same governance written so that a machine reads it at the tool boundary
 * before the tool runs — permitted tools, a data rung, an autonomy rung, a
 * per-run and a per-day action budget, which refusals to escalate on, and how
 * many humans must sign what the agent proposes.
 *
 * ## Three refusals, and why each is here rather than at the boundary
 *
 *   • UNSCORED AGENT. `defaultPolicyCardForRiskTier` already says what a card
 *     opens at for an unassessed agent — nothing, on every axis — and its
 *     `assessmentRequired` flag exists precisely so this usecase can refuse to
 *     save it. A card full of zeroes is indistinguishable, in the register, from
 *     a card somebody deliberately narrowed, and the operator's next question
 *     ("why is this agent refusing everything?") has a different answer in each
 *     case. Refusing the save keeps the two apart.
 *
 *   • A DECLARATION THE BOUNDARY WOULD REFUSE ON EVERY CALL. A card permitting
 *     `propose_risks` while capping autonomy at 1, or permitting a tool that
 *     reads tenant data while capping the data rung at metadata, is a
 *     configuration error that sits in the register looking deliberate. Same
 *     shape as `assertGrantWithinTier` in the tool-exposure usecase and
 *     `assertRaiseWithinTier` in the register: the error arrives where the
 *     operator is asking for the thing, not six hours later in an audit row.
 *
 *   • A WIDENING OF MORE THAN ONE RUNG. `checkLadderStep` — see `policy-card.ts`
 *     for why the shape is the identity write ladder's and why narrowing is
 *     never restricted.
 *
 * ## Why there is no update-in-place
 *
 * Every edit APPENDS a version and moves the head. The version table refuses
 * UPDATE at two levels (no `app_user` privilege, plus a trigger), because the
 * next prompt pins the version in force onto every `WorkflowRun` and
 * `AgentProposal` — and a pinned version that can still be edited reconstructs
 * today's rules wearing last quarter's number, which is worse evidence than
 * none.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, notFound } from '@/lib/errors/types';
import {
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    ceilingForRiskTier,
} from '@/lib/agentic/autonomy-ceiling';
import {
    DATA_SCOPE_LADDER,
    checkLadderStep,
    isActionCap,
    narrowApprovalRung,
    narrowEscalationTriggers,
    type AgentPolicyCardValue,
} from '@/lib/agentic/policy-card';
import { seedPolicyCardValue } from '@/lib/agentic/policy-card-evaluation';
import { isKnownMcpTool, mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { baseDataScopeForTool } from '@/lib/mcp/tool-data-scope';
import type { PrismaTx } from '@/lib/db-context';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import {
    AgentPolicyCardRepository,
    type VersionInput,
} from '../repositories/AgentPolicyCardRepository';
import { RegisteredAgentToolRepository } from '../repositories/RegisteredAgentToolRepository';
import { PolicyCardUpdateSchema } from '../schemas/agent-policy-card.schemas';
import type { RequestContext } from '../types';

/**
 * Resolve the agent inside the tenant transaction.
 *
 * The composite FK makes a cross-tenant card unrepresentable, but Postgres runs
 * FK checks as the table owner and so bypasses row security: the constraint
 * would be satisfied by another tenant's agent id. Resolved here instead — the
 * same fix `grantAgentTool` and `createApiKey` both needed.
 */
async function assertAgentCardable(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true, riskTier: true, dataAccessScope: true },
    });
    // Same shape whether absent or foreign, so a caller learns nothing about
    // another tenant's id space.
    if (!agent) throw notFound('Registered agent not found');
    return agent;
}

/** The card, the version in force, and the whole version history. */
export async function getAgentPolicyCard(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await assertAgentCardable(db, ctx, agentId);
        const card = await AgentPolicyCardRepository.findForAgent(db, ctx, agentId);
        if (!card) {
            return {
                agentId,
                card: null,
                /**
                 * What creating one would produce, so the surface offering the
                 * button can show the answer rather than a blank form. Derived
                 * from the same function that would write it — never a second
                 * preview that can disagree with the real thing.
                 */
                wouldSeed: seedPolicyCardValue({
                    riskTier: agent.riskTier,
                    dataAccessScope: agent.dataAccessScope,
                    grantedTools: (
                        await RegisteredAgentToolRepository.listForAgent(db, ctx, agentId)
                    ).map((t) => t.toolName),
                }),
                assessmentRequired: agent.riskTier === null,
            };
        }

        const inForce = await AgentPolicyCardRepository.findVersion(
            db,
            ctx,
            card.id,
            card.currentVersion,
        );
        return {
            agentId,
            card: { ...card, inForce },
            versions: await AgentPolicyCardRepository.listVersions(db, ctx, card.id),
            assessmentRequired: false,
        };
    });
}

/**
 * Create the card, seeded from what is already true.
 *
 * The seed writes down the agent's CURRENT grants, the register's own
 * data-access declaration and the tier's autonomy cap and budgets — so creating
 * a card changes nothing about what the agent may do. It only pins it. A card
 * seeded empty would take a working agent dark the moment its governance
 * artefact was created, which is the one failure mode that would teach operators
 * not to create one.
 */
export async function createAgentPolicyCard(ctx: RequestContext, agentId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await assertAgentCardable(db, ctx, agentId);
        if (agent.riskTier === null) {
            throw badRequest(
                'This agent has not been risk-assessed, so there is nothing to seed a ' +
                    'policy card from: its autonomy cap, its action budgets and its ' +
                    'approval rung all come from the assessed tier. Complete the agent ' +
                    'risk assessment first — a card of zeroes would be indistinguishable ' +
                    'from one somebody deliberately narrowed.',
            );
        }

        const existing = await AgentPolicyCardRepository.findForAgent(db, ctx, agentId);
        if (existing) {
            throw conflict('This agent already has a policy card. Edit it instead.');
        }

        const granted = await RegisteredAgentToolRepository.listForAgent(db, ctx, agentId);
        const value = seedPolicyCardValue({
            riskTier: agent.riskTier,
            dataAccessScope: agent.dataAccessScope,
            grantedTools: granted.map((t) => t.toolName),
        });

        const card = await AgentPolicyCardRepository.createWithFirstVersion(
            db,
            ctx,
            agentId,
            { ...toVersionInput(value), seededFromTier: agent.riskTier },
        );

        await logEvent(db, ctx, {
            action: 'AGENT_POLICY_CARD_CREATED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'AgentPolicyCard',
                operation: 'create',
                summary: `Created policy card v1 for agent ${agentId}, seeded from tier ${agent.riskTier}`,
                after: { version: 1, seededFromTier: agent.riskTier, ...value },
            },
        });

        return { agentId, cardId: card.id, version: 1, value };
    });
}

/**
 * Edit the card — one rung of widening, any amount of narrowing.
 *
 * `expectedVersion` is the version the caller composed against. The pointer move
 * is conditional on it, so two operators editing concurrently cannot both write
 * against the same base — which would let the second one ladder past the
 * one-rung rule by comparing against a version that had already moved.
 */
export async function updateAgentPolicyCard(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
) {
    assertCanWrite(ctx);
    const { expectedVersion, card: next } = PolicyCardUpdateSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const agent = await assertAgentCardable(db, ctx, agentId);
        const card = await AgentPolicyCardRepository.findForAgent(db, ctx, agentId);
        if (!card) throw notFound('This agent has no policy card');

        const inForce = await AgentPolicyCardRepository.findVersion(
            db,
            ctx,
            card.id,
            card.currentVersion,
        );
        if (!inForce) {
            // The head names a version that is not there. Refusing the WRITE is
            // the same direction the boundary takes for the READ: a policy that
            // cannot be read is not a policy that can be safely replaced, since
            // the ladder has nothing to measure the step against.
            throw conflict(
                'This card\'s current version could not be read, so an edit cannot be ' +
                    'measured against it. Nothing was changed.',
            );
        }
        if (expectedVersion !== card.currentVersion) {
            throw conflict(
                `This card is at version ${card.currentVersion}; your edit was composed ` +
                    `against version ${expectedVersion}. Reload it and reapply your change ` +
                    '— re-basing an edit automatically would let two operators each widen ' +
                    'by one rung and land two rungs apart from where either looked.',
            );
        }

        assertDeclarationsExercisable(next, agent.riskTier);

        const step = checkLadderStep(fromRow(inForce), next);
        if (step) throw badRequest(step.message);

        const written = await AgentPolicyCardRepository.appendVersion(
            db,
            ctx,
            card.id,
            card.currentVersion,
            toVersionInput(next),
        );
        if (written === 0) {
            throw conflict(
                'This card changed while your edit was in flight. Reload it and reapply ' +
                    'your change.',
            );
        }

        await logEvent(db, ctx, {
            action: 'AGENT_POLICY_CARD_UPDATED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'AgentPolicyCard',
                operation: 'update',
                summary: `Policy card for agent ${agentId} moved to version ${written}`,
                before: { version: card.currentVersion, ...fromRow(inForce) },
                after: { version: written, ...next },
            },
        });

        return { agentId, cardId: card.id, version: written, value: next };
    });
}

// ─── Declarations the boundary would refuse on every call ───────────

/**
 * Refuse a card that permits a tool it also forbids.
 *
 * Two ways to write one, and both look deliberate in the register:
 *
 *   • a tool whose autonomy rung is above the card's cap — `propose_risks`
 *     needs rung 2, and a card capped at 1 refuses it forever;
 *   • a tool whose BASE data rung is above the card's ceiling — a card capped at
 *     `READ_METADATA` can never call `list_risks`, however it is called. The
 *     tool's MAXIMUM reach is deliberately not the test: a ceiling below that is
 *     the useful case, where the tool works and its wider arguments are refused.
 *
 * The tier's own cap is checked too, because a card cannot widen past it: a
 * card naming autonomy 4 on a CRITICAL agent is a promise the tool boundary
 * breaks on the first call, and the operator should be told by the thing they
 * are editing rather than by an audit row.
 */
function assertDeclarationsExercisable(
    card: AgentPolicyCardValue,
    riskTier: Parameters<typeof ceilingForRiskTier>[0],
): void {
    for (const tool of card.permittedTools) {
        if (!isKnownMcpTool(tool)) {
            throw badRequest(
                `"${tool}" is not an MCP tool this build offers. A card may name only ` +
                    'tools from the live catalogue.',
            );
        }
    }

    const tierCap = ceilingForRiskTier(riskTier);
    if (card.maxAutonomyLevel > tierCap) {
        throw badRequest(
            `This card caps autonomy at ${card.maxAutonomyLevel}, and this agent's ` +
                `assessed risk tier (${riskTier ?? 'UNSCORED'}) caps it at ${tierCap}. The ` +
                'card can only narrow what the assessment already decided — re-assess the ' +
                'agent if it needs to reach further.',
        );
    }

    const ceiling = DATA_SCOPE_LADDER.indexOf(card.maxDataScope);
    for (const tool of card.permittedTools) {
        const required = AUTONOMY_REQUIRED_BY_CAPABILITY[mcpToolCapabilityClass(tool)];
        if (required > card.maxAutonomyLevel) {
            throw badRequest(
                `"${tool}" needs autonomy ${required} and this card caps it at ` +
                    `${card.maxAutonomyLevel}. Permitting it would write a declaration the ` +
                    'tool boundary refuses on every call.',
            );
        }
        // The tool's BASE rung, not its maximum. A ceiling below the maximum is
        // the useful case — the tool works and its more-reaching ARGUMENTS are
        // refused — and only a ceiling below the base makes the tool
        // unreachable however it is called.
        const floor = baseDataScopeForTool(tool);
        if (DATA_SCOPE_LADDER.indexOf(floor) > ceiling) {
            throw badRequest(
                `"${tool}" reaches ${floor} on every call and this card stops at ` +
                    `${card.maxDataScope}. Permitting it would write a declaration the tool ` +
                    'boundary refuses on every call.',
            );
        }
    }
}

// ─── Row ⇄ value ────────────────────────────────────────────────────

function toVersionInput(value: AgentPolicyCardValue): VersionInput {
    return {
        permittedTools: [...value.permittedTools],
        maxDataScope: value.maxDataScope,
        maxAutonomyLevel: value.maxAutonomyLevel,
        maxActionsPerRun: value.maxActionsPerRun,
        maxActionsPerDay: value.maxActionsPerDay,
        escalationTriggers: [...value.escalationTriggers],
        approvalRung: value.approvalRung,
    };
}

/**
 * The stored row as a card value. The two String columns are narrowed the same
 * way `policy-card-store.ts` narrows them, and deliberately so: an editor and
 * the boundary that enforces the edit must not disagree about what a row means.
 */
function fromRow(row: {
    permittedTools: string[];
    maxDataScope: AgentPolicyCardValue['maxDataScope'];
    maxAutonomyLevel: number;
    maxActionsPerRun: number;
    maxActionsPerDay: number;
    escalationTriggers: string[];
    approvalRung: string;
}): AgentPolicyCardValue {
    return {
        permittedTools: row.permittedTools,
        maxDataScope: row.maxDataScope,
        maxAutonomyLevel: row.maxAutonomyLevel,
        // A budget that is not a rung reads as ZERO, exactly as it does at the
        // boundary. The ladder step is then measured from a floor rather than
        // from a number nothing can rank — which would report every edit as a
        // widening of the whole ladder and refuse them all, including the
        // narrowing that would have fixed the row.
        maxActionsPerRun: isActionCap(row.maxActionsPerRun) ? row.maxActionsPerRun : 0,
        maxActionsPerDay: isActionCap(row.maxActionsPerDay) ? row.maxActionsPerDay : 0,
        escalationTriggers: narrowEscalationTriggers(row.escalationTriggers),
        approvalRung: narrowApprovalRung(row.approvalRung),
    };
}
