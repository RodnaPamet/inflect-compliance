/**
 * Agent proposal queue — the propose-not-commit core (Epic MCP Phase 3).
 *
 * An external agent (via the MCP server, `mcp:propose` scope) can PROPOSE a
 * risk/control/policy/finding. The proposal lands here as PENDING; a human
 * reviews it and, on approval, THE REAL create-usecase runs — never the agent.
 * This is the load-bearing safety property of the MCP effort: a hallucinating
 * or prompt-injected agent cannot create a live compliance record.
 *
 * Boundary controls (AISVS C9/C10):
 *   - propose: validate the content against the SAME Zod create-schema the REST
 *     route uses (reject malformed at the boundary, never queue it) + sanitise
 *     all proposed free text (Epic D) before it enters the queue;
 *   - approve: a privileged HUMAN action (requires write permission) that runs
 *     the real `createRisk`/`createControl`/`createPolicy`/`createFinding`
 *     usecase — inheriting its own validation, sanitisation, cache
 *     invalidation, and creation audit event — then records the human+agent
 *     dual attribution.
 */
import { z } from 'zod';
import { SuggestionItemStatus } from '@prisma/client';

import { parseEnumListFilter } from '@/app-layer/domain/list-filter';

import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, notFound } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { guardUntrustedInput, guardEgress, assertGuardAllowed } from '@/app-layer/ai/guard';
import {
    CreateRiskSchema,
    CreateControlSchema,
    CreatePolicySchema,
    CreateFindingSchema,
} from '@/lib/schemas';
import { createRisk } from '@/app-layer/usecases/risk';
import { createControl } from '@/app-layer/usecases/control/mutations';
import { createPolicy } from '@/app-layer/usecases/policy';
import { createFinding } from '@/app-layer/usecases/finding';
import type { RequestContext } from '@/app-layer/types';

export type AgentProposalKind = 'RISK' | 'CONTROL' | 'POLICY' | 'FINDING';

/** The create-schema each proposal kind validates against at the boundary. */
const SCHEMA_BY_KIND = {
    RISK: CreateRiskSchema,
    CONTROL: CreateControlSchema,
    POLICY: CreatePolicySchema,
    FINDING: CreateFindingSchema,
} as const;

/** Recursively sanitise every string in a validated payload (Epic D boundary). */
function sanitizeDeep(value: unknown): unknown {
    if (typeof value === 'string') return sanitizePlainText(value);
    if (Array.isArray(value)) return value.map(sanitizeDeep);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
        return out;
    }
    return value;
}

export interface ProposeInput {
    kind: AgentProposalKind;
    payload: unknown;
    rationale?: string | null;
    proposedBySessionRef?: string | null;
}

export interface ProposalResult {
    id: string;
    kind: AgentProposalKind;
    status: string;
}

/**
 * Create a PENDING proposal from an agent. Validates the payload against the
 * kind's create-schema, sanitises all free text, and writes ONE AgentProposal
 * row. Does NOT create the real entity. Attributed to the API key.
 */
export async function createAgentProposal(
    ctx: RequestContext,
    input: ProposeInput,
): Promise<ProposalResult> {
    const schema = SCHEMA_BY_KIND[input.kind];
    if (!schema) throw badRequest(`Unknown proposal kind: ${input.kind}`);

    // 1. Validate against the SAME create-schema the REST route uses.
    const parsed = schema.safeParse(input.payload);
    if (!parsed.success) {
        throw badRequest(`Proposed ${input.kind} is invalid: ${parsed.error.message}`);
    }

    // 2. Sanitise ALL proposed free text at the boundary (Epic D).
    const sanitized = sanitizeDeep(parsed.data);
    const rationale = input.rationale ? sanitizePlainText(input.rationale) : null;

    // 2b. AI Guard — external-agent output is the highest-risk untrusted
    // content entering IC. Scan the proposed content for prompt-injection and
    // for secret / exfil material. A strict-mode malicious verdict or a secret
    // leak is blocked; a flag forces the (already-required) human review. The
    // proposal is propose-not-commit regardless, so nothing is ever committed
    // straight from the agent.
    const proposedText = [rationale ?? '', JSON.stringify(sanitized)].join('\n');
    assertGuardAllowed(
        await guardUntrustedInput(ctx, proposedText, { source: `agent-proposal:${input.kind}` }),
    );
    assertGuardAllowed(
        await guardEgress(ctx, { payload: sanitized, rationale }, {
            source: `agent-proposal:${input.kind}:egress`,
        }),
    );

    // 3. Persist the PENDING proposal (RLS-scoped). NOT the real entity.
    const proposal = await runInTenantContext(ctx, (db) =>
        db.agentProposal.create({
            data: {
                tenantId: ctx.tenantId,
                kind: input.kind,
                status: 'PENDING',
                payloadJson: JSON.stringify(sanitized),
                rationale,
                proposedViaKeyId: ctx.apiKeyId ?? null,
                proposedBySessionRef: input.proposedBySessionRef ?? null,
            },
            select: { id: true, kind: true, status: true },
        }),
    );

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'API_KEY',
        entity: 'AgentProposal',
        entityId: proposal.id,
        action: 'AGENT_PROPOSAL_CREATED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', kind: input.kind },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null },
    }).catch(() => undefined);

    return { id: proposal.id, kind: proposal.kind as AgentProposalKind, status: proposal.status };
}

/** List proposals for the review queue (bounded). */
export async function listAgentProposals(
    ctx: RequestContext,
    opts: { status?: string; take?: number } = {},
) {
    assertCanRead(ctx);
    // `opts.status` is a raw `?status=` query-string value — the `as never`
    // this replaces silenced the compiler but not Prisma, which 500'd on a
    // comma-joined multi-select or a status from another entity's enum.
    const status = parseEnumListFilter<SuggestionItemStatus>(
        opts.status,
        Object.values(SuggestionItemStatus),
        'proposal status',
    );
    return runInTenantContext(ctx, (db) =>
        db.agentProposal.findMany({
            where: { tenantId: ctx.tenantId, status },
            orderBy: { createdAt: 'desc' },
            take: opts.take ?? 100,
        }),
    );
}

export async function getAgentProposal(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const proposal = await runInTenantContext(ctx, (db) =>
        db.agentProposal.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!proposal) throw notFound('Proposal not found');
    return proposal;
}

const editsSchema = z.record(z.string(), z.unknown());

export interface ApproveResult {
    proposalId: string;
    kind: AgentProposalKind;
    createdEntityId: string;
    status: 'ACCEPTED' | 'EDITED';
}

/**
 * Approve a PENDING proposal — a privileged HUMAN action. Merges any edits,
 * runs the REAL create-usecase for the kind (which re-validates + re-sanitises
 * + audits its own creation), and records the human+agent dual attribution.
 * The agent never reaches this path — only a human with write permission does.
 */
export async function approveAgentProposal(
    ctx: RequestContext,
    id: string,
    edits?: Record<string, unknown>,
): Promise<ApproveResult> {
    assertCanWrite(ctx);
    const parsedEdits = edits ? editsSchema.parse(edits) : undefined;

    const proposal = await getAgentProposal(ctx, id);
    if (proposal.status !== 'PENDING') {
        throw badRequest(`Proposal is already ${proposal.status}`);
    }

    const base = JSON.parse(proposal.payloadJson) as Record<string, unknown>;
    const merged = parsedEdits ? { ...base, ...parsedEdits } : base;
    const kind = proposal.kind as AgentProposalKind;

    // AI Guard — the load-bearing auto-commit-block invariant. This is the ONE
    // path where agent-proposed content becomes a live compliance record, so
    // re-scan the merged payload (base + reviewer edits) one last time: a
    // strict-mode malicious verdict or a secret-leak egress hit blocks the
    // commit before the real create-usecase runs.
    assertGuardAllowed(
        await guardUntrustedInput(ctx, JSON.stringify(merged), {
            source: `agent-proposal-approve:${kind}`,
        }),
    );
    assertGuardAllowed(
        await guardEgress(ctx, merged, { source: `agent-proposal-approve:${kind}:egress` }),
    );

    // Run the REAL create-usecase — same validation/sanitisation/audit/cache
    // path a human create takes. The proposal only becomes a record HERE.
    let createdEntityId: string;
    switch (kind) {
        case 'RISK': {
            const risk = await createRisk(ctx, CreateRiskSchema.parse(merged) as Parameters<typeof createRisk>[1]);
            createdEntityId = risk.id;
            break;
        }
        case 'CONTROL': {
            const control = await createControl(ctx, CreateControlSchema.parse(merged) as Parameters<typeof createControl>[1]);
            createdEntityId = control.id;
            break;
        }
        case 'POLICY': {
            const policy = await createPolicy(ctx, CreatePolicySchema.parse(merged) as Parameters<typeof createPolicy>[1]);
            createdEntityId = policy.id;
            break;
        }
        case 'FINDING': {
            const finding = await createFinding(ctx, CreateFindingSchema.parse(merged));
            createdEntityId = finding.id;
            break;
        }
        default:
            throw badRequest(`Unknown proposal kind: ${kind}`);
    }

    const status: 'ACCEPTED' | 'EDITED' = parsedEdits ? 'EDITED' : 'ACCEPTED';
    await runInTenantContext(ctx, (db) =>
        db.agentProposal.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status, reviewedByUserId: ctx.userId, reviewedAt: new Date(), createdEntityId },
        }),
    );

    // Human action, with agent attribution in structured metadata.
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AgentProposal',
        entityId: id,
        action: 'AGENT_PROPOSAL_APPROVED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', kind, createdEntityId },
        metadataJson: { proposedByApiKeyId: proposal.proposedViaKeyId, createdEntityId, edited: !!parsedEdits },
    }).catch(() => undefined);

    return { proposalId: id, kind, createdEntityId, status };
}

/** Reject a PENDING proposal — nothing is created. */
export async function rejectAgentProposal(ctx: RequestContext, id: string): Promise<void> {
    assertCanWrite(ctx);
    const proposal = await getAgentProposal(ctx, id);
    if (proposal.status !== 'PENDING') {
        throw badRequest(`Proposal is already ${proposal.status}`);
    }
    await runInTenantContext(ctx, (db) =>
        db.agentProposal.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status: 'REJECTED', reviewedByUserId: ctx.userId, reviewedAt: new Date() },
        }),
    );
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AgentProposal',
        entityId: id,
        action: 'AGENT_PROPOSAL_REJECTED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access' },
    }).catch(() => undefined);
}
