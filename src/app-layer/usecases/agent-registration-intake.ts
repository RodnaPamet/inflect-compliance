/**
 * REGISTRATION INTAKE — a SHADOW_AGENT finding becomes a DRAFT register row
 * (#3669, step 2a of the agentic IAM roadmap; deploy 2 of the UNCLASSIFIED tier).
 *
 * A harness scan that finds an agent-shaped principal with no register row
 * raises a SHADOW_AGENT finding: no accountable owner, no risk tier, no grants
 * on record. This usecase is how a person holding `admin.agent_registry` takes
 * that finding into the register. In ONE transaction it creates
 *
 *   1. a PROVISIONAL `AiSystem` entry at `UNCLASSIFIED`, through
 *      `AiSystemRepository.createProvisional` — the only writer of that value
 *      (`tests/guards/ai-risk-tier-unclassified-writers.test.ts`). Decision 1
 *      of the roadmap keeps every agent's AI-system link required, and the
 *      column's MINIMAL default would claim a classification nobody made;
 *   2. the `RegisteredAgent`, DRAFT and UNSCORED, through the register's own
 *      write recipe (`insertRegisteredAgentInTx`), carrying the discovered
 *      agent's id as its intake claim.
 *
 * The agent cannot go into service until its entry is classified:
 * `activateRegisteredAgent` refuses `AI_SYSTEM_UNCLASSIFIED` first, and
 * `classifyAiSystemEntry` is the move out of the value.
 *
 * ── THE OWNER IS CONFIRMED BY A PERSON, NEVER TAKEN FROM A SUGGESTION ───────
 *
 * The request names `ownerUserId` and sets `confirmOwner: true`; without both
 * the intake refuses `OWNER_NOT_CONFIRMED`, whatever else the request carries.
 * The owner must be an ACTIVE member of this tenant (`OWNER_NOT_ACTIVE_MEMBER`
 * otherwise — a member of another tenant is not one of this tenant's). The
 * attribution skill's answer may ride along as `attribution`; it is parsed
 * through 1d's contract (`parseOwnershipAttribution`) and recorded as
 * provenance — the signals it rested on, and whether the confirmed owner is the
 * person it suggested (`lib/agentic/registration-intake.ts`). No line here reads
 * an owner out of it.
 *
 * Or `attribution` is `{ runId }` (#3728): the harness tab's dialog holds no
 * person reference, so it names the review run whose parsed answer the server
 * STORED (`DiscoveredAgentAttribution`), and this reads that row — the person
 * included, server-side — and records the same provenance with the run id. A
 * run that is not the one stored for this agent now refuses
 * `SUGGESTION_NOT_STORED`: the person kept a suggestion that has since been
 * replaced, and recording a different one in its name would be false.
 *
 * ── ONE DISCOVERED AGENT, AT MOST ONE REGISTER ROW ──────────────────────────
 *
 * Refused as `ALREADY_REGISTERED` when a scan has already linked the
 * discovered agent to a live register row, and as `ALREADY_REGISTERED_BY_INTAKE`
 * when this usecase has already registered it — a second request before the
 * next scan, or two requests racing. The first is read; the second is held by
 * a unique index on `RegisteredAgent(tenantId, intakeDiscoveredAgentId)`, so a
 * race that passes both reads still makes one row: the loser's insert fails and
 * its whole transaction, AI-system entry included, rolls back.
 *
 * ── WHAT THE INTAKE DOES NOT WRITE ──────────────────────────────────────────
 *
 * No `DiscoveredAgent` or `AgentHarnessScan*` row: the harness ingest is their
 * only writer (`tests/guards/agent-harness-single-write-seam.test.ts`). The
 * discovered agent is linked to its new register row by the NEXT SCAN that
 * reports it: by the row's id when the scan claims it, and otherwise by the
 * claim this usecase records (`intakeDiscoveredAgentId`), which the ingest's
 * planner reads as the register's own evidence (#3712). Until then the agent
 * still reads SHADOW on the harness tab.
 *
 * And no `Finding` write. The SHADOW_AGENT finding stays OPEN: a scan closes a
 * harness finding only on positive evidence, and the evidence here is a scan
 * that sees the agent in the register — which is exactly what resolves it (for
 * a link made from this usecase's claim alone, a COMPLETE scan). A finding
 * closed by the act it asked for would be closed by an assertion, not by an
 * observation. The intake writes an audit row ON the finding instead, so
 * the finding's own history says it was taken into the register, by whom, as
 * which agent.
 *
 * Audit rows are written LAST, one per entity: `logEvent` writes on its own
 * connection, so a row written before a step that then threw would narrate a
 * registration that rolled back.
 */
import { Prisma } from '@prisma/client';

import { assertAgentGovernanceWrite, meetsAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, forbidden, ValidationError } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { hashForLookup } from '@/lib/security/encryption';
import { logEvent } from '../events/audit';
import { AiSystemRepository } from '../repositories/AiSystemRepository';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import { RegistrationIntakeSchema, StoredSuggestionRefSchema } from '../schemas/agent-registry.schemas';
import { assertVendorInTenant, insertRegisteredAgentInTx } from './agent-registry';
import { readStoredSuggestion } from './agent-harness-attribution';
import { discoveredIdOfShadowFinding } from '@/lib/agentic/harness-findings';
import { parseOwnershipAttribution, type OwnershipAttribution } from '@/lib/agentic/iam-skill-outputs';
import {
    storedSuggestionProvenance,
    suggestionProvenance,
    type IntakeSuggestionProvenance,
    type RegistrationIntakeRefusal,
} from '@/lib/agentic/registration-intake';
import type { RequestContext } from '../types';

/** The HTTP status each named refusal answers with. */
const REFUSAL_STATUS: Record<RegistrationIntakeRefusal, 400 | 404 | 409> = {
    FINDING_NOT_FOUND: 404,
    NOT_A_SHADOW_AGENT_FINDING: 400,
    DISCOVERED_AGENT_NOT_FOUND: 404,
    ALREADY_REGISTERED: 409,
    ALREADY_REGISTERED_BY_INTAKE: 409,
    OWNER_NOT_CONFIRMED: 400,
    OWNER_NOT_ACTIVE_MEMBER: 400,
    SUGGESTION_INVALID: 400,
    SUGGESTION_FOR_ANOTHER_AGENT: 400,
    SUGGESTION_NOT_STORED: 409,
};

/**
 * A refusal carrying its reason as `details.reason` — the API response's
 * `error.details` — beside a sentence written for the person who asked.
 */
function refuse(
    reason: RegistrationIntakeRefusal,
    message: string,
    extra: Record<string, unknown> = {},
): AppError {
    const details = { reason, ...extra };
    const status = REFUSAL_STATUS[reason];
    if (status === 400) return new ValidationError(message, details);
    if (status === 409) return new ConflictError(message, details);
    return new AppError(message, 'NOT_FOUND', 404, true, details);
}

/**
 * May this caller run the intake? The SAME two checks `assertCanRunIntake`
 * makes, as a boolean, so the harness tab offers the Register action exactly
 * where the usecase would take it (#3712): the agent-governance floor — the
 * coarse write tier, or `canRead` with the register key — and the register key.
 */
export function canRunRegistrationIntake(ctx: RequestContext): boolean {
    return meetsAgentGovernanceWrite(ctx, 'agent_registry') && ctx.appPermissions?.admin?.agent_registry === true;
}

/**
 * `admin.agent_registry`, re-asserted beneath the route's literal
 * `requirePermission` so a second caller of this usecase cannot reach it with
 * `canWrite` alone — the same shape as retirement. The floor beneath it is the
 * agent-governance floor, not `assertCanWrite`.
 */
function assertCanRunIntake(ctx: RequestContext) {
    // The agent-governance floor (#3699): the coarse write tier OR the
    // register key, so an AI_ADMIN — the key on a READER tier — can run it.
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    if (!canRunRegistrationIntake(ctx)) {
        throw forbidden(
            'Registering a shadow agent requires permission to manage the agent register. ' +
                'It creates a register row and its AI-system entry.',
        );
    }
}

export interface RegistrationIntakeResult {
    agentId: string;
    aiSystemId: string;
    /** DRAFT, read back from the insert: registration never activates. */
    status: string;
    /** The stored tier of the provisional entry, read back from the insert. */
    aiActRiskTier: string;
    findingId: string;
    discoveredAgentId: string;
    discoveredId: string;
    ownerUserId: string;
    /** `null` when the request carried no attribution. */
    suggestion: IntakeSuggestionProvenance | null;
}

/** The discovered agent a finding names, resolved under RLS in this tenant. */
async function resolveShadow(db: PrismaTx, ctx: RequestContext, findingId: string) {
    const finding = await db.finding.findFirst({
        where: { id: findingId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, sourceKind: true, sourceRef: true, status: true },
    });
    // Same answer for absent and foreign, so a caller learns nothing about
    // another tenant's ids.
    if (!finding) throw refuse('FINDING_NOT_FOUND', 'Finding not found.');
    const discoveredId = discoveredIdOfShadowFinding(finding);
    if (discoveredId === null) {
        throw refuse(
            'NOT_A_SHADOW_AGENT_FINDING',
            'Only a SHADOW_AGENT finding raised by a harness scan can be registered from. This ' +
                'finding is not one.',
        );
    }
    const discovered = await db.discoveredAgent.findFirst({
        where: { tenantId: ctx.tenantId, discoveredId },
        select: {
            id: true,
            discoveredId: true,
            registeredAgent: { select: { id: true, deletedAt: true } },
        },
    });
    if (!discovered) {
        throw refuse(
            'DISCOVERED_AGENT_NOT_FOUND',
            'The agent this finding names is not among the agents the harness scans have found in ' +
                'this workspace.',
        );
    }
    return { finding, discovered };
}

export async function registerShadowAgent(
    ctx: RequestContext,
    input: unknown,
): Promise<RegistrationIntakeResult> {
    assertCanRunIntake(ctx);
    const parsed = RegistrationIntakeSchema.parse(input);

    // THE CONFIRMATION, before anything is read. A suggestion in the same
    // request does not stand in for it.
    const ownerUserId = parsed.ownerUserId;
    if (!ownerUserId || parsed.confirmOwner !== true) {
        throw refuse(
            'OWNER_NOT_CONFIRMED',
            'Name the accountable owner and confirm them. An owner suggested from the scan is ' +
                'only a suggestion: the register records the person you confirm.',
        );
    }

    let attribution: OwnershipAttribution | null = null;
    let storedRunId: string | null = null;
    const storedRef = parsed.attribution === undefined ? null : StoredSuggestionRefSchema.safeParse(parsed.attribution);
    if (storedRef?.success) {
        storedRunId = storedRef.data.runId;
    } else if (parsed.attribution !== undefined) {
        const verdict = parseOwnershipAttribution(parsed.attribution);
        if (!verdict.ok) {
            throw refuse(
                'SUGGESTION_INVALID',
                "The owner suggestion does not satisfy the attribution skill's output contract, " +
                    'so it cannot be recorded. Send it as produced, or leave it out.',
                { issues: verdict.issues.slice(0, 20) },
            );
        }
        attribution = verdict.value;
    }

    return runInTenantContext(ctx, async (db) => {
        const { finding, discovered } = await resolveShadow(db, ctx, parsed.findingId);

        if (discovered.registeredAgent && discovered.registeredAgent.deletedAt === null) {
            throw refuse(
                'ALREADY_REGISTERED',
                'A harness scan has already linked this agent to a register row, so it is not a ' +
                    'shadow agent any more.',
                { registeredAgentId: discovered.registeredAgent.id },
            );
        }
        const claimed = await RegisteredAgentRepository.findIntakeClaim(db, ctx, discovered.id);
        if (claimed) {
            throw refuse(
                'ALREADY_REGISTERED_BY_INTAKE',
                'This agent has already been registered from its shadow-agent finding. The finding ' +
                    'closes at the next complete harness scan that sees the agent.',
                { registeredAgentId: claimed.id },
            );
        }
        if (attribution && attribution.discoveredAgentId !== discovered.id) {
            throw refuse(
                'SUGGESTION_FOR_ANOTHER_AGENT',
                'The owner suggestion is about a different discovered agent from the one this ' +
                    'finding names.',
            );
        }
        // The STORED suggestion the request kept, read with the person it named
        // — which stays here, server-side, and is only ever compared.
        const stored = storedRunId === null ? null : await readStoredSuggestion(db, ctx, discovered.id);
        if (storedRunId !== null && stored?.runId !== storedRunId) {
            throw refuse(
                'SUGGESTION_NOT_STORED',
                'The owner suggestion you kept is no longer the one held for this agent: a newer ' +
                    'review replaced it, or it was never stored. Reopen the dialog to see the current one.',
            );
        }

        // The confirmed owner, from the membership row and nothing the caller
        // said about them. `User` is global, so a user of another tenant
        // satisfies the FK; only an ACTIVE membership HERE makes them an owner.
        const membership = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ownerUserId, status: 'ACTIVE' },
            select: { user: { select: { id: true, emailHash: true } } },
        });
        if (!membership) {
            throw refuse(
                'OWNER_NOT_ACTIVE_MEMBER',
                'The confirmed owner must be an active member of this workspace.',
            );
        }
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const confirmed = { userId: membership.user.id, emailHash: membership.user.emailHash ?? null };
        const suggestion = attribution
            ? suggestionProvenance(attribution, confirmed, hashForLookup)
            : stored
                ? storedSuggestionProvenance(stored, confirmed, hashForLookup)
                : null;

        const aiSystem = await AiSystemRepository.createProvisional(db, ctx, {
            name: parsed.name,
            // Free text: sanitised on write; encrypted at rest (Epic B manifest).
            purpose: parsed.purpose ? sanitizePlainText(parsed.purpose) : null,
            useContext: parsed.useContext ? sanitizePlainText(parsed.useContext) : null,
            provider: parsed.provider ? sanitizePlainText(parsed.provider) : null,
            deploymentRole: parsed.deploymentRole,
            ownerUserId,
        });

        let agent: { id: string; status: string; riskTier: string | null };
        try {
            agent = await insertRegisteredAgentInTx(db, ctx, {
                aiSystemId: aiSystem.id,
                name: parsed.name,
                description: parsed.description,
                autonomyLevel: parsed.autonomyLevel,
                dataAccessScope: parsed.dataAccessScope,
                reversibility: parsed.reversibility,
                provenance: parsed.provenance,
                modelRef: parsed.modelRef,
                ownerUserId,
                vendorId: parsed.vendorId,
                intakeDiscoveredAgentId: discovered.id,
            });
        } catch (err) {
            // The claim's unique index: another intake for this discovered agent
            // committed between the read above and this insert. The other
            // uniques on the row cannot collide — its AI-system entry and its id
            // are both new — so a P2002 here is that race and nothing else.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw refuse(
                    'ALREADY_REGISTERED_BY_INTAKE',
                    'This agent was registered from its shadow-agent finding by another request ' +
                        'at the same moment. Nothing was changed by this one.',
                );
            }
            throw err;
        }

        // ── Audit, last, one row per entity ─────────────────────────────
        await logEvent(db, ctx, {
            action: 'AI_SYSTEM_REGISTERED',
            entityType: 'AiSystem',
            entityId: aiSystem.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AiSystem',
                operation: 'create',
                summary:
                    `Registered provisional AI system "${parsed.name}" for a shadow agent, ` +
                    'not yet classified against the EU AI Act',
                after: {
                    riskTier: aiSystem.riskTier,
                    provisional: true,
                    obligationsLinked: 0,
                    registeredAgentId: agent.id,
                },
            },
        });
        await logEvent(db, ctx, {
            action: 'AGENT_REGISTERED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'intake',
                summary:
                    `Registered shadow agent ${discovered.discoveredId} as "${parsed.name}" — ` +
                    `autonomy ${parsed.autonomyLevel}, ${parsed.dataAccessScope}, ${parsed.reversibility}; ` +
                    'AI system not yet classified',
                sourceEntity: 'Finding',
                sourceId: finding.id,
                after: {
                    autonomyLevel: parsed.autonomyLevel,
                    dataAccessScope: parsed.dataAccessScope,
                    reversibility: parsed.reversibility,
                    provenance: parsed.provenance,
                    status: agent.status,
                    riskTier: agent.riskTier,
                    aiSystemId: aiSystem.id,
                    aiActRiskTier: aiSystem.riskTier,
                    discoveredAgentId: discovered.id,
                    discoveredId: discovered.discoveredId,
                    ownerUserId: membership.user.id,
                    ownerConfirmed: true,
                    // What the suggestion rested on, and whether the confirmed
                    // owner is the person it named — never the person's
                    // reference itself (`lib/agentic/registration-intake.ts`).
                    // Named field by field at the sink, so what reaches this
                    // plaintext row is legible to `no-raw-prompt-logging`.
                    ownerSuggestion: suggestion
                        ? {
                              status: suggestion.status,
                              grade: suggestion.grade,
                              unmatchedReason: suggestion.unmatchedReason,
                              signals: suggestion.signals,
                              confirmedOwnerIsSuggested: suggestion.confirmedOwnerIsSuggested,
                              // The review run a stored suggestion came from
                              // (#3728); null for an answer the request carried.
                              runId: suggestion.runId,
                          }
                        : 'NONE',
                },
            },
        });
        await logEvent(db, ctx, {
            action: 'AGENT_REGISTRATION_INTAKE',
            entityType: 'Finding',
            entityId: finding.id,
            detailsJson: {
                category: 'relationship',
                entityName: 'Finding',
                operation: 'intake',
                summary:
                    `Shadow agent ${discovered.discoveredId} registered in DRAFT as "${parsed.name}". ` +
                    'The finding stays open until a complete harness scan sees the agent in the register.',
                sourceEntity: 'Finding',
                sourceId: finding.id,
                targetEntity: 'RegisteredAgent',
                targetId: agent.id,
                relation: 'registered_from',
                after: { findingStatus: finding.status, discoveredAgentId: discovered.id },
            },
        });

        return {
            agentId: agent.id,
            aiSystemId: aiSystem.id,
            status: agent.status,
            aiActRiskTier: aiSystem.riskTier,
            findingId: finding.id,
            discoveredAgentId: discovered.id,
            discoveredId: discovered.discoveredId,
            ownerUserId,
            suggestion,
        };
    });
}
