/**
 * Spending authority on the register — the ONLY writer of
 * `AgentSpendingAuthority` (docs/ai-architecture/mastercard-agent-pay.md
 * Phase 1; owner decisions D-L1-8 and D-L1-9, 2026-11-11).
 *
 * An agent that can spend money holds the most consequential privilege an agent
 * can hold, and the register is where a privilege belongs. So the envelope the
 * cardholder consented to is DECLARED here, REVIEWED by a second person,
 * NARROWED or WITHDRAWN by one, and marked SUSPENDED_REQUESTED by an AGENT-scope
 * kill or an orphan containment. It is a declaration to review, never a grant
 * Inflect enforces at payment time: the issuer enforces the token's limits.
 *
 * ## Rules, each held twice
 *
 *   * **Four eyes.** Declaring or widening puts the row at DECLARED, stamped
 *     with the declarer and the agent's owner at that moment. Only a PERSON
 *     reviews it — never an API key, an agent or a job — and never the declarer
 *     or the owner (then or now). The CHECK
 *     `AgentSpendingAuthority_not_self_reviewed` refuses the same for any
 *     writer, and the lifecycle trigger refuses an in-place change to a
 *     REVIEWED envelope that is not a narrowing.
 *   * **The review approves what the reviewer read.** The review's write is a
 *     compare-and-swap on the whole declaration — status, stamps and every
 *     envelope field as read — so a re-declaration committed while the review
 *     waited on the row lock makes it write nothing and refuse
 *     `DECLARATION_CHANGED`. The agent lock is FOR SHARE and does not
 *     serialise two writers of one envelope; the row's own lock and the
 *     re-evaluated predicate do.
 *   * **No payment credential, ever (D-L1-8).** Every free-text value — the
 *     two identifiers and each merchant domain — is refused here when it
 *     carries a 13-digit run, and the identifiers also when they carry a
 *     credential shape (`looksLikeSecret`, the harness contract's own check).
 *     The CHECKs `AgentSpendingAuthority_identifiers_carry_no_card_number` and
 *     `AgentSpendingAuthority_merchant_domains_carry_no_card_number` refuse
 *     the digit run below. The card-number shape inside `looksLikeSecret` is
 *     Phase 0's, not this file's.
 *   * **Activation.** `readUnreviewedSpendingAuthority` is what
 *     `assertActivatable` asks (`SPENDING_AUTHORITY_UNREVIEWED`); the trigger
 *     `registered_agent_spending_authority_reviewed` refuses the same move for
 *     any writer. "Unreviewed" is DECLARED, AND a SUSPENDED_REQUESTED envelope
 *     that was never reviewed: a kill moves an unreviewed envelope out of
 *     DECLARED without anybody reviewing it, and lifting the kill must not
 *     leave a one-person route into service. A declaration on an agent that is
 *     ALREADY ACTIVE is a HIGH finding, not a suspension: the agentic IAM rule
 *     that a later break is a finding, never a refusal of an act two people may
 *     have agreed. The finding closes when the envelope is reviewed or
 *     withdrawn — the two acts that end unreviewed authority.
 *   * **The kill reaches it.** `requestSpendingSuspensionInTx` runs inside an
 *     AGENT-scope kill's transaction, and `openSpendingSuspensionTasks` opens a
 *     task for a person to suspend the token at its requestor once that
 *     transaction commits, because Inflect cannot (Phase 4 is conditional).
 *     Lifting the kill does not reverse it: a person re-declares, and a second
 *     person reviews; or withdraws it.
 *
 * Every write is audited; no audit row carries the token reference, which is
 * an identifier at a third party and the audit trail streams to the tenant's
 * SIEM.
 */
import type { AgentSpendingAuthority, AgentSpendingRail } from '@prisma/client';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, ValidationError } from '@/lib/errors/types';
import { looksLikeSecret } from '@/lib/agentic/harness-contract-rules';
import {
    carriesCardNumberShape,
    isUnrestrictedScope,
    SPENDING_AUTHORITY_UNREVIEWED,
    SPENDING_AUTHORITY_WIDENED_FINDING_SEVERITY,
    SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND,
    SPENDING_RAILS,
    SpendingEnvelopeSchema,
    wideningsOf,
    type SpendingAuthorityRefusal,
    type SpendingEnvelopeInput,
} from '@/lib/agentic/spending-authority';
import { mayReadAgentInventory } from '@/lib/permissions';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import { assertCanRead } from '../policies/common';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import { FindingRepository } from '../repositories/FindingRepository';
import { logEvent } from '../events/audit';
import { buildTenantSystemJobContext } from '../context-system';
import { createTask } from './task';
import type { RequestContext } from '../types';

const REFUSAL_STATUS: Record<SpendingAuthorityRefusal, 400 | 403 | 404 | 409> = {
    AGENT_NOT_FOUND: 404,
    AGENT_RETIRED: 409,
    ENVELOPE_NOT_FOUND: 404,
    IDENTIFIER_CARRIES_CARD_NUMBER: 400,
    IDENTIFIER_CARRIES_CREDENTIAL: 400,
    CONSENTER_NOT_A_MEMBER: 400,
    NOT_A_NARROWING: 409,
    NOT_DECLARED: 409,
    NOT_CHANGEABLE: 409,
    DECLARATION_CHANGED: 409,
    REVIEWER_NOT_A_PERSON: 403,
    REVIEWER_IS_DECLARER: 403,
    REVIEWER_IS_OWNER: 403,
    ALREADY_WITHDRAWN: 409,
};

/** A refusal carrying its reason as `details.reason`, beside a sentence for the person who asked. */
function refuse(reason: SpendingAuthorityRefusal, message: string, extra: Record<string, unknown> = {}): AppError {
    const details = { reason, ...extra };
    const status = REFUSAL_STATUS[reason];
    if (status === 400) return new ValidationError(message, details);
    if (status === 409) return new ConflictError(message, details);
    if (status === 403) return new AppError(message, 'FORBIDDEN', 403, true, details);
    return new AppError(message, 'NOT_FOUND', 404, true, details);
}

/** How a row is reported: amounts as decimal strings, since JSON has no bigint. */
export interface SpendingAuthorityView {
    id: string;
    agentId: string;
    rail: AgentSpendingRail;
    status: AgentSpendingAuthority['status'];
    perTransactionLimitMinor: string;
    periodBudgetMinor: string;
    budgetPeriod: AgentSpendingAuthority['budgetPeriod'];
    currency: string;
    merchantDomains: string[];
    merchantCategoryCodes: string[];
    merchantScopeUnrestricted: boolean;
    expiresAt: string;
    consentedByUserId: string;
    tokenRequestor: string;
    tokenReference: string;
    declaredByUserId: string;
    declaredAt: string;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
    suspensionRequestedAt: string | null;
    withdrawnAt: string | null;
}

function toView(r: AgentSpendingAuthority): SpendingAuthorityView {
    return {
        id: r.id,
        agentId: r.agentId,
        rail: r.rail,
        status: r.status,
        perTransactionLimitMinor: r.perTransactionLimitMinor.toString(),
        periodBudgetMinor: r.periodBudgetMinor.toString(),
        budgetPeriod: r.budgetPeriod,
        currency: r.currency,
        merchantDomains: r.merchantDomains,
        merchantCategoryCodes: r.merchantCategoryCodes,
        merchantScopeUnrestricted: isUnrestrictedScope(r),
        expiresAt: r.expiresAt.toISOString(),
        consentedByUserId: r.consentedByUserId,
        tokenRequestor: r.tokenRequestor,
        tokenReference: r.tokenReference,
        declaredByUserId: r.declaredByUserId,
        declaredAt: r.declaredAt.toISOString(),
        reviewedByUserId: r.reviewedByUserId,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        suspensionRequestedAt: r.suspensionRequestedAt?.toISOString() ?? null,
        withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    };
}

/*
 * Audit rows name every field at the sink (`local/no-raw-prompt-logging`): the
 * envelope is written out field by field rather than spread from a helper, so
 * the names reaching the hash-chained trail are in this source. No audit row
 * carries the token reference (an identifier at a third party, and the trail
 * streams to the SIEM); merchant scope goes as counts, amounts as strings.
 */

/**
 * D-L1-8: no free-text value may carry a card number, and neither identifier a
 * credential. The merchant domains are free text too — a host label may be all
 * digits — so each is held to the same digit-run rule as the identifiers.
 */
function assertIdentifiersCarryNoCredential(e: SpendingEnvelopeInput): void {
    const freeText: ReadonlyArray<{ field: string; value: string }> = [
        { field: 'tokenRequestor', value: e.tokenRequestor },
        { field: 'tokenReference', value: e.tokenReference },
        ...e.merchantDomains.map((value) => ({ field: 'merchantDomains', value })),
    ];
    for (const { field, value } of freeText) {
        if (carriesCardNumberShape(value)) {
            throw refuse(
                'IDENTIFIER_CARRIES_CARD_NUMBER',
                'That value looks like a card number. Inflect never stores a card number or a token ' +
                    'value; record the agent platform by name, its own reference for the token, and ' +
                    'merchants by their host name.',
                { field },
            );
        }
    }
    for (const field of ['tokenRequestor', 'tokenReference'] as const) {
        if (looksLikeSecret(e[field])) {
            throw refuse(
                'IDENTIFIER_CARRIES_CREDENTIAL',
                'That value looks like a credential. Inflect never stores a payment credential; ' +
                    'record a reference, not the secret.',
                { field },
            );
        }
    }
}

function parseEnvelope(input: unknown): SpendingEnvelopeInput {
    const parsed = SpendingEnvelopeSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid spending authority', parsed.error.issues);
    assertIdentifiersCarryNoCredential(parsed.data);
    return parsed.data;
}

function parseRail(rail: unknown): AgentSpendingRail {
    if (typeof rail !== 'string' || !(SPENDING_RAILS as readonly string[]).includes(rail)) {
        throw new ValidationError('Unknown payment rail', { reason: 'ENVELOPE_NOT_FOUND' });
    }
    return rail as AgentSpendingRail;
}

/** Lock the agent row FOR SHARE, so activation and retirement wait for this write. */
async function lockAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const agent = await RegisteredAgentRepository.lockLifecycleStateForShare(db, ctx, agentId);
    if (!agent) throw refuse('AGENT_NOT_FOUND', 'Registered agent not found');
    if (agent.status === 'RETIRED') {
        throw refuse('AGENT_RETIRED', 'A retired agent holds no authority, so no spending authority can be declared for it.');
    }
    return agent;
}

async function assertConsenterIsMember(db: PrismaTx, ctx: RequestContext, userId: string): Promise<void> {
    const membership = await db.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!membership) {
        throw refuse(
            'CONSENTER_NOT_A_MEMBER',
            'The person who consented to the envelope must be an active member of this workspace.',
        );
    }
}

async function findRow(db: PrismaTx, ctx: RequestContext, agentId: string, rail: AgentSpendingRail) {
    return db.agentSpendingAuthority.findUnique({
        where: { tenantId_agentId_rail: { tenantId: ctx.tenantId, agentId, rail } },
    });
}

/** The widened-on-active finding's key: one per agent and rail. */
const widenedFindingRef = (agentId: string, rail: AgentSpendingRail) => `${agentId}:${rail}`;

/**
 * The HIGH finding a declaration on an ACTIVE agent raises (1.3): the agent is
 * in service with an envelope nobody else has reviewed. Opened, or reopened if
 * a previous one was closed, keyed `<agentId>:<rail>`. Closed by
 * `closeWidenedOnActiveFinding` when the envelope is reviewed or withdrawn.
 */
async function raiseWidenedOnActiveFinding(
    db: PrismaTx,
    ctx: RequestContext,
    agent: { id: string; name: string },
    widening: { rail: AgentSpendingRail; fields: readonly string[] },
): Promise<string> {
    const rail = widening.rail;
    const prior = await db.finding.findFirst({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND,
            sourceRef: widenedFindingRef(agent.id, rail),
            deletedAt: null,
        },
        select: { id: true, status: true },
    });
    if (prior && prior.status !== 'CLOSED') return prior.id;
    if (prior) {
        await db.finding.updateMany({
            where: { id: prior.id, tenantId: ctx.tenantId },
            data: {
                status: 'OPEN',
                verificationNotes: sanitizePlainText('Reopened: the spending authority was declared or widened again'),
            },
        });
        await logEvent(db, ctx, {
            action: 'SPENDING_AUTHORITY_FINDING_REOPENED',
            entityType: 'Finding',
            entityId: prior.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                fromStatus: 'CLOSED',
                toStatus: 'OPEN',
                reason: 'declared on an active agent',
            },
        });
        return prior.id;
    }
    const created = await FindingRepository.create(db, ctx, {
        severity: SPENDING_AUTHORITY_WIDENED_FINDING_SEVERITY,
        type: 'NONCONFORMITY',
        title: sanitizePlainText(`Unreviewed spending authority on active agent "${agent.name}" (${rail})`),
        description: sanitizePlainText(
            `The spending authority of the active agent "${agent.name}" on the ${rail} rail was declared ` +
                `or widened (${widening.fields.join(', ') || 'a new declaration'}) and nobody else has reviewed ` +
                'it yet. The agent stays in service; a second person, neither the declarer nor the ' +
                "agent's owner, reviews the envelope, or it is withdrawn. Either closes this finding.",
        ),
        status: 'OPEN',
        sourceKind: SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND,
        sourceRef: widenedFindingRef(agent.id, rail),
    });
    await logEvent(db, ctx, {
        action: 'SPENDING_AUTHORITY_FINDING_RAISED',
        entityType: 'Finding',
        entityId: created.id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'Finding',
            operation: 'created',
            after: {
                sourceRef: created.sourceRef,
                severity: created.severity,
                widenedFields: [...widening.fields],
            },
        },
    });
    return created.id;
}

/**
 * Close the open widened-on-active finding for one envelope, if any. Called by
 * the two acts that END unreviewed authority: a second person's review, and a
 * withdrawal. A narrowing does not close it (a narrowed DECLARED envelope is
 * still unreviewed), and neither does a kill: a SUSPENDED_REQUESTED envelope
 * that was never reviewed is still unreviewed authority until a person
 * suspends the token, and it is withdrawn or re-declared and reviewed.
 */
async function closeWidenedOnActiveFinding(
    db: PrismaTx,
    ctx: RequestContext,
    envelope: { agentId: string; rail: AgentSpendingRail },
    note: string,
): Promise<number> {
    const closed = await db.finding.updateMany({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND,
            sourceRef: widenedFindingRef(envelope.agentId, envelope.rail),
            status: { not: 'CLOSED' },
            deletedAt: null,
        },
        data: { status: 'CLOSED', verificationNotes: sanitizePlainText(note) },
    });
    return closed.count;
}

/**
 * DECLARE an envelope, or WIDEN / re-declare one: the result is always
 * DECLARED, stamped with this caller and the agent's current owner, and
 * reviewed by a second person before it counts.
 *
 * A change that is only a narrowing is better made with
 * `narrowAgentSpendingAuthority`, which keeps a review; declaring it here asks
 * for a review it does not need, which is wasteful but never unsafe.
 */
export async function declareAgentSpendingAuthority(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
): Promise<{ authority: SpendingAuthorityView; widenedFields: string[]; findingId: string | null }> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const e = parseEnvelope(input);

    return runInTenantContext(ctx, async (db) => {
        const agent = await lockAgent(db, ctx, agentId);
        await assertConsenterIsMember(db, ctx, e.consentedByUserId);
        const prior = await findRow(db, ctx, agentId, e.rail);
        const now = new Date();
        const envelope = {
            perTransactionLimitMinor: BigInt(e.perTransactionLimitMinor),
            periodBudgetMinor: BigInt(e.periodBudgetMinor),
            budgetPeriod: e.budgetPeriod,
            currency: e.currency,
            merchantDomains: [...new Set(e.merchantDomains)],
            merchantCategoryCodes: [...new Set(e.merchantCategoryCodes)],
            expiresAt: e.expiresAt,
            consentedByUserId: e.consentedByUserId,
            tokenRequestor: e.tokenRequestor,
            tokenReference: e.tokenReference,
        };
        const declaration = {
            status: 'DECLARED' as const,
            declaredByUserId: ctx.userId,
            declaredAt: now,
            ownerUserIdAtDeclaration: agent.ownerUserId,
            reviewedByUserId: null,
            reviewedAt: null,
            suspensionRequestedAt: null,
            suspensionKillSwitchId: null,
            withdrawnAt: null,
            withdrawnByUserId: null,
        };

        // What this declaration adds over the envelope that was in force. A
        // first declaration, or one over a withdrawn envelope, adds everything.
        const widenedFields =
            prior && prior.status !== 'WITHDRAWN' ? wideningsOf(prior, envelope) : ['newDeclaration'];

        const row = prior
            ? await db.agentSpendingAuthority.update({
                  where: { id: prior.id },
                  data: { ...envelope, ...declaration },
              })
            : await db.agentSpendingAuthority.create({
                  data: { tenantId: ctx.tenantId, agentId, rail: e.rail, ...envelope, ...declaration },
              });

        const widening = { rail: e.rail, fields: widenedFields };
        await logEvent(db, ctx, {
            action: prior ? 'SPENDING_AUTHORITY_REDECLARED' : 'SPENDING_AUTHORITY_DECLARED',
            entityType: 'AgentSpendingAuthority',
            entityId: row.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AgentSpendingAuthority',
                operation: prior ? 'update' : 'create',
                summary: `Spending authority DECLARED on ${row.rail} for agent ${row.agentId}; awaiting a second person's review`,
                before: prior
                    ? {
                          status: prior.status,
                          rail: prior.rail,
                          perTransactionLimitMinor: prior.perTransactionLimitMinor.toString(),
                          periodBudgetMinor: prior.periodBudgetMinor.toString(),
                          budgetPeriod: prior.budgetPeriod,
                          currency: prior.currency,
                          merchantDomainCount: prior.merchantDomains.length,
                          merchantCategoryCodeCount: prior.merchantCategoryCodes.length,
                          expiresAt: prior.expiresAt.toISOString(),
                          consentedByUserId: prior.consentedByUserId,
                      }
                    : undefined,
                after: {
                    status: row.status,
                    agentId: row.agentId,
                    widenedFields: [...widening.fields],
                    rail: row.rail,
                    perTransactionLimitMinor: row.perTransactionLimitMinor.toString(),
                    periodBudgetMinor: row.periodBudgetMinor.toString(),
                    budgetPeriod: row.budgetPeriod,
                    currency: row.currency,
                    merchantDomainCount: row.merchantDomains.length,
                    merchantCategoryCodeCount: row.merchantCategoryCodes.length,
                    expiresAt: row.expiresAt.toISOString(),
                    consentedByUserId: row.consentedByUserId,
                },
            },
        });

        const findingId = agent.status === 'ACTIVE' ? await raiseWidenedOnActiveFinding(db, ctx, agent, widening) : null;

        return { authority: toView(row), widenedFields, findingId };
    });
}

/**
 * NARROW an envelope, by one person. Refused (`NOT_A_NARROWING`, naming the
 * fields) when any field would widen: that is a declaration. Keeps the status:
 * a REVIEWED envelope narrowed is still covered by the review it had.
 */
export async function narrowAgentSpendingAuthority(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
): Promise<SpendingAuthorityView> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const e = parseEnvelope(input);

    return runInTenantContext(ctx, async (db) => {
        await lockAgent(db, ctx, agentId);
        const prior = await findRow(db, ctx, agentId, e.rail);
        if (!prior) throw refuse('ENVELOPE_NOT_FOUND', 'This agent has no spending authority on that rail.');
        if (prior.status !== 'DECLARED' && prior.status !== 'REVIEWED') {
            throw refuse(
                'NOT_CHANGEABLE',
                'A suspended or withdrawn envelope is not narrowed; declare it again, and a second person reviews it.',
                { status: prior.status },
            );
        }
        const after = {
            perTransactionLimitMinor: BigInt(e.perTransactionLimitMinor),
            periodBudgetMinor: BigInt(e.periodBudgetMinor),
            budgetPeriod: e.budgetPeriod,
            currency: e.currency,
            merchantDomains: [...new Set(e.merchantDomains)],
            merchantCategoryCodes: [...new Set(e.merchantCategoryCodes)],
            expiresAt: e.expiresAt,
            consentedByUserId: e.consentedByUserId,
            tokenRequestor: e.tokenRequestor,
            tokenReference: e.tokenReference,
        };
        const widened = wideningsOf(prior, after);
        if (widened.length > 0) {
            throw refuse(
                'NOT_A_NARROWING',
                'That change widens the envelope, so it is a new declaration a second person reviews.',
                { widenedFields: widened },
            );
        }
        const row = await db.agentSpendingAuthority.update({ where: { id: prior.id }, data: after });
        await logEvent(db, ctx, {
            action: 'SPENDING_AUTHORITY_NARROWED',
            entityType: 'AgentSpendingAuthority',
            entityId: row.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AgentSpendingAuthority',
                operation: 'update',
                summary: `Spending authority NARROWED on ${row.rail} for agent ${row.agentId}`,
                before: {
                    status: prior.status,
                    rail: prior.rail,
                    perTransactionLimitMinor: prior.perTransactionLimitMinor.toString(),
                    periodBudgetMinor: prior.periodBudgetMinor.toString(),
                    budgetPeriod: prior.budgetPeriod,
                    currency: prior.currency,
                    merchantDomainCount: prior.merchantDomains.length,
                    merchantCategoryCodeCount: prior.merchantCategoryCodes.length,
                    expiresAt: prior.expiresAt.toISOString(),
                    consentedByUserId: prior.consentedByUserId,
                },
                after: {
                    status: row.status,
                    rail: row.rail,
                    perTransactionLimitMinor: row.perTransactionLimitMinor.toString(),
                    periodBudgetMinor: row.periodBudgetMinor.toString(),
                    budgetPeriod: row.budgetPeriod,
                    currency: row.currency,
                    merchantDomainCount: row.merchantDomains.length,
                    merchantCategoryCodeCount: row.merchantCategoryCodes.length,
                    expiresAt: row.expiresAt.toISOString(),
                    consentedByUserId: row.consentedByUserId,
                },
            },
        });
        return toView(row);
    });
}

/**
 * REVIEW a declared envelope: the second pair of eyes. A person, never an API
 * key, agent or job; never the declarer; never the agent's owner, at
 * declaration or now. Names the declaration it read (`declaredAt`), so a
 * reviewer never approves an envelope re-declared while they were reading.
 * Closes the open widened-on-active finding for the envelope, if any.
 */
export async function reviewAgentSpendingAuthority(
    ctx: RequestContext,
    agentId: string,
    railInput: unknown,
    input: { declaredAt: string },
): Promise<SpendingAuthorityView> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const rail = parseRail(railInput);
    if (ctx.apiKeyId || ctx.agentId || ctx.actorType === 'JOB') {
        throw refuse(
            'REVIEWER_NOT_A_PERSON',
            'A spending authority is reviewed by a signed-in person, never by an API key, an agent or a job.',
        );
    }

    return runInTenantContext(ctx, async (db) => {
        const agent = await lockAgent(db, ctx, agentId);
        const prior = await findRow(db, ctx, agentId, rail);
        if (!prior) throw refuse('ENVELOPE_NOT_FOUND', 'This agent has no spending authority on that rail.');
        if (prior.status !== 'DECLARED') {
            throw refuse('NOT_DECLARED', 'Only a declared envelope awaits review.', { status: prior.status });
        }
        if (prior.declaredAt.toISOString() !== new Date(input.declaredAt).toISOString()) {
            throw refuse(
                'DECLARATION_CHANGED',
                'The envelope was declared again while you were reading it; read it again before reviewing.',
            );
        }
        if (prior.declaredByUserId === ctx.userId) {
            throw refuse('REVIEWER_IS_DECLARER', 'The person who declared a spending authority cannot review it.');
        }
        if (prior.ownerUserIdAtDeclaration === ctx.userId || agent.ownerUserId === ctx.userId) {
            throw refuse('REVIEWER_IS_OWNER', "The agent's owner cannot review its spending authority.");
        }
        // COMPARE-AND-SWAP on everything the reviewer read. The agent lock is
        // FOR SHARE, which a concurrent re-declaration also takes, so it does
        // not serialise the two. A re-declaration that committed while this
        // UPDATE waited on the envelope's row lock is re-evaluated against
        // this predicate under READ COMMITTED, matches nothing, and the review
        // writes nothing: a reviewer never approves an envelope they did not
        // read, even one re-declared within the same millisecond.
        const swapped = await db.agentSpendingAuthority.updateMany({
            where: {
                id: prior.id,
                tenantId: ctx.tenantId,
                status: 'DECLARED',
                declaredAt: prior.declaredAt,
                declaredByUserId: prior.declaredByUserId,
                ownerUserIdAtDeclaration: prior.ownerUserIdAtDeclaration,
                perTransactionLimitMinor: prior.perTransactionLimitMinor,
                periodBudgetMinor: prior.periodBudgetMinor,
                budgetPeriod: prior.budgetPeriod,
                currency: prior.currency,
                merchantDomains: { equals: prior.merchantDomains },
                merchantCategoryCodes: { equals: prior.merchantCategoryCodes },
                expiresAt: prior.expiresAt,
                consentedByUserId: prior.consentedByUserId,
                tokenRequestor: prior.tokenRequestor,
                tokenReference: prior.tokenReference,
            },
            data: { status: 'REVIEWED', reviewedByUserId: ctx.userId, reviewedAt: new Date() },
        });
        if (swapped.count !== 1) {
            throw refuse(
                'DECLARATION_CHANGED',
                'The envelope was declared again while you were reviewing it; read it again before reviewing.',
            );
        }
        const row = await db.agentSpendingAuthority.findUniqueOrThrow({ where: { id: prior.id } });
        await logEvent(db, ctx, {
            action: 'SPENDING_AUTHORITY_REVIEWED',
            entityType: 'AgentSpendingAuthority',
            entityId: row.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'AgentSpendingAuthority',
                fromStatus: 'DECLARED',
                toStatus: 'REVIEWED',
                reason: `reviewed by a second person; declared by ${prior.declaredByUserId}`,
            },
        });
        await closeWidenedOnActiveFinding(db, ctx, row, 'Closed: a second person reviewed the declared envelope');
        return toView(row);
    });
}

/** WITHDRAW an envelope, by one person: taking authority away is never the move to refuse. */
export async function withdrawAgentSpendingAuthority(
    ctx: RequestContext,
    agentId: string,
    railInput: unknown,
): Promise<SpendingAuthorityView> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const rail = parseRail(railInput);
    return runInTenantContext(ctx, async (db) => {
        // Not `lockAgent`: a retired agent's envelope may still be withdrawn.
        await RegisteredAgentRepository.lockLifecycleStateForShare(db, ctx, agentId);
        const prior = await findRow(db, ctx, agentId, rail);
        if (!prior) throw refuse('ENVELOPE_NOT_FOUND', 'This agent has no spending authority on that rail.');
        if (prior.status === 'WITHDRAWN') throw refuse('ALREADY_WITHDRAWN', 'This envelope is already withdrawn.');
        const row = await db.agentSpendingAuthority.update({
            where: { id: prior.id },
            data: { status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawnByUserId: ctx.userId },
        });
        await logEvent(db, ctx, {
            action: 'SPENDING_AUTHORITY_WITHDRAWN',
            entityType: 'AgentSpendingAuthority',
            entityId: row.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'AgentSpendingAuthority',
                fromStatus: prior.status,
                toStatus: 'WITHDRAWN',
                reason: 'withdrawn on the register',
            },
        });
        // Withdrawal ends the authority, reviewed or not, so it ends the
        // finding about unreviewed authority too.
        await closeWidenedOnActiveFinding(db, ctx, row, 'Closed: the spending authority was withdrawn');
        return toView(row);
    });
}

/** Read an agent's envelopes, under the register's read gate. */
export async function listAgentSpendingAuthorities(ctx: RequestContext, agentId: string): Promise<SpendingAuthorityView[]> {
    assertCanRead(ctx);
    if (!mayReadAgentInventory(ctx.appPermissions?.admin)) {
        throw new AppError('You do not have permission to view the agent register.', 'FORBIDDEN', 403, true);
    }
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.agentSpendingAuthority.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            orderBy: { rail: 'asc' },
            take: SPENDING_RAILS.length,
        });
        return rows.map(toView);
    });
}

// ─── Read by the activation precondition ─────────────────────────────

/**
 * The rails on which `agentId` holds UNREVIEWED spending authority. What
 * `assertActivatable` asks before a move to ACTIVE, and what the trigger
 * `registered_agent_spending_authority_reviewed` asks for any writer.
 *
 * Unreviewed is DECLARED, and also SUSPENDED_REQUESTED with no review stamp:
 * an AGENT-scope kill moves a DECLARED envelope out of DECLARED without anybody
 * reviewing it, and lifting the kill reverses nothing, so reading DECLARED
 * alone would let one person declare, kill, lift and activate. Such an
 * envelope is withdrawn, or re-declared and reviewed, before the agent goes
 * into service. A SUSPENDED_REQUESTED envelope that WAS reviewed does not
 * hold activation: two people agreed to it, and its suspension is the kill's.
 */
export async function readUnreviewedSpendingAuthority(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
): Promise<AgentSpendingRail[]> {
    const rows = await db.agentSpendingAuthority.findMany({
        where: {
            tenantId: ctx.tenantId,
            agentId,
            OR: [{ status: 'DECLARED' }, { status: 'SUSPENDED_REQUESTED', reviewedAt: null }],
        },
        select: { rail: true },
        orderBy: { rail: 'asc' },
        take: SPENDING_RAILS.length,
    });
    return rows.map((r) => r.rail);
}

export { SPENDING_AUTHORITY_UNREVIEWED };

// ─── Reached by the kill switch and the orphan containment (1.5) ─────

/** One envelope a kill asked to be suspended, as the follow-up task needs it. */
export interface SpendingSuspensionRequest {
    id: string;
    rail: AgentSpendingRail;
    tokenRequestor: string;
    tokenReference: string;
}

/**
 * Inside an AGENT-scope kill's transaction: every DECLARED or REVIEWED envelope
 * of the agent moves to SUSPENDED_REQUESTED, naming the kill. Returns what
 * moved, for `openSpendingSuspensionTasks` to act on after commit. A WITHDRAWN
 * or already-suspended envelope is left alone.
 */
export async function requestSpendingSuspensionInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    kill: { id: string },
): Promise<SpendingSuspensionRequest[]> {
    const killSwitchId = kill.id;
    const rows = await db.agentSpendingAuthority.findMany({
        where: { tenantId: ctx.tenantId, agentId, status: { in: ['DECLARED', 'REVIEWED'] } },
        select: { id: true, rail: true, status: true, tokenRequestor: true, tokenReference: true },
        orderBy: { rail: 'asc' },
        take: SPENDING_RAILS.length,
    });
    if (rows.length === 0) return [];
    const now = new Date();
    for (const r of rows) {
        await db.agentSpendingAuthority.updateMany({
            where: { id: r.id, tenantId: ctx.tenantId, status: r.status },
            data: { status: 'SUSPENDED_REQUESTED', suspensionRequestedAt: now, suspensionKillSwitchId: killSwitchId },
        });
        await logEvent(db, ctx, {
            action: 'SPENDING_AUTHORITY_SUSPENSION_REQUESTED',
            entityType: 'AgentSpendingAuthority',
            entityId: r.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'AgentSpendingAuthority',
                fromStatus: r.status,
                toStatus: 'SUSPENDED_REQUESTED',
                reason: `agent kill switch ${kill.id} engaged`,
            },
        });
    }
    return rows.map((r) => ({ id: r.id, rail: r.rail, tokenRequestor: r.tokenRequestor, tokenReference: r.tokenReference }));
}

export type SpendingSuspensionTaskOutcome =
    | { status: 'OPENED'; authorityId: string; taskId: string }
    | { status: 'FAILED'; authorityId: string; error: string };

/**
 * After the kill commits: one task per envelope asking a person to suspend the
 * token at its requestor, naming the requestor and the reference, because
 * Inflect cannot suspend it itself (Phase 4 is conditional on API access).
 * Written as the tenant's SYSTEM user (#4400) — the consequence is the
 * system's, not whoever pulled the switch — and assigned to the agent's owner.
 * Best effort and never throws: a stop control must not fail because a
 * follow-up task could not be written; each failure is returned and logged.
 */
export async function openSpendingSuspensionTasks(
    ctx: RequestContext,
    agent: { id: string; name: string; ownerUserId: string | null },
    requests: readonly SpendingSuspensionRequest[],
    killSwitchId: string,
): Promise<SpendingSuspensionTaskOutcome[]> {
    if (requests.length === 0) return [];
    const out: SpendingSuspensionTaskOutcome[] = [];
    for (const req of requests) {
        try {
            const taskCtx = await buildTenantSystemJobContext({
                tenantId: ctx.tenantId,
                job: 'agent-spending-suspension',
                tenantSlug: ctx.tenantSlug,
                requestId: ctx.requestId,
            });
            const open = (assigneeUserId: string | null) => createTask(taskCtx, {
                source: 'INTEGRATION',
                type: 'TASK',
                title: `Suspend the payment token of agent "${agent.name}" at ${req.tokenRequestor}`,
                description:
                    `The registered agent "${agent.name}" was stopped by its kill switch, and it holds a ` +
                    `declared spending authority on the ${req.rail} rail. Inflect cannot suspend the token ` +
                    `itself. Ask ${req.tokenRequestor}, the agent platform that holds it, to suspend the token ` +
                    `with reference ${req.tokenReference}. Lifting the kill switch does not restore the ` +
                    'spending authority: it is declared again on the register and reviewed by a second person.',
                priority: 'P1',
                assigneeUserId,
                metadataJson: {
                    kind: 'AGENT_SPENDING_SUSPENSION',
                    agentId: agent.id,
                    spendingAuthorityId: req.id,
                    rail: req.rail,
                    killSwitchId,
                },
            });
            // Assigned to the owner; an owner who can no longer be assigned
            // (an orphan containment's departed owner) leaves the task
            // unassigned rather than unopened.
            const task = await open(agent.ownerUserId).catch(() => open(null));
            out.push({ status: 'OPENED', authorityId: req.id, taskId: task.id });
        } catch (err) {
            const failed = {
                status: 'FAILED' as const,
                authorityId: req.id,
                error: err instanceof Error ? err.message : 'non-Error thrown',
            };
            logger.warn('spending authority: failed to open the suspension task', {
                requestId: ctx.requestId,
                tenantId: ctx.tenantId,
                spendingAuthorityId: failed.authorityId,
                error: failed.error,
            });
            out.push(failed);
        }
    }
    return out;
}
