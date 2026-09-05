/**
 * MCP propose-not-commit WRITE tools (Epic MCP Phase 3).
 *
 * These are the ONLY MCP tools that write — and they write a PENDING PROPOSAL,
 * never a real record. Each validates the proposed content against the target
 * create-schema and sanitises it (inside `createAgentProposal`), then queues an
 * `AgentProposal`. A human approves it before the real create-usecase runs.
 *
 * Gating, and there are now three independent terms:
 *
 *   • the `mcp:propose` capability scope (strictly more privileged than
 *     `mcp:read`) PLUS the domain read scope — the CREDENTIAL's authority to
 *     propose. A read-only key cannot propose;
 *   • deny-by-default tool exposure — the AGENT must be granted this tool;
 *   • the create permission the equivalent human route demands, evaluated
 *     against the PRINCIPAL. `propose_risks` needs `risks.create`, the same key
 *     `POST /api/t/:slug/risks` requires.
 *
 * The third term is the one that was missing, and its absence was the confused
 * deputy in the write direction: `createAgentProposal` makes no policy
 * assertion at all, so a key minted by a READER with `mcp:propose` + `risks:read`
 * could queue a risk its principal could not create — and a human approver, who
 * sees a legitimate-looking pending proposal, then creates it for them.
 * Propose-not-commit means the agent cannot commit; it never meant the agent
 * could propose anything it liked.
 *
 * Why the PRINCIPAL and not the intersected context: a propose key carries no
 * `<domain>:write` scope by design, so `scopesToPermissions` gives it
 * `risks.create: false` and the intersection would deny every propose call ever
 * made. The credential axis for proposing is `mcp:propose`; the human axis is
 * `risks.create`. See `src/lib/agentic/agent-authority.ts`.
 *
 * No propose tool imports a create/update/delete ENTITY usecase — it only calls
 * `createAgentProposal` (the queue). This is what the `mcp-propose-coverage`
 * ratchet locks.
 */
import { z } from 'zod';

import { badRequest } from '@/lib/errors/types';
import { pinFromCard } from '@/lib/agentic/policy-card-pin';
import {
    createAgentProposal,
    type AgentProposalKind,
} from '@/app-layer/usecases/agent-proposals';

import {
    authorizeToolCall,
    isToolLoadable,
    resolveOfferedTool,
    type McpInvocation,
} from '../authorize';
import { RpcErrorCode, type McpToolDescriptor, type McpToolResult } from '../protocol';
import type { McpToolAuthorization } from './types';

export interface McpProposeTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    kind: AgentProposalKind;
    /** Domain read scope required in addition to the `mcp:propose` capability. */
    resourceScope: { resource: string; action: 'read' };
    /**
     * The create authorization the equivalent human route demands, evaluated
     * against the PRINCIPAL. Same `assertPermission` the human route's
     * `requirePermission` calls — see the header for why the basis differs from
     * a read tool's.
     */
    authorize: McpToolAuthorization;
}

/** Args every propose tool accepts: 1–20 candidate items + an optional rationale. */
const proposeArgs = z
    .object({
        items: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
        rationale: z.string().max(4000).optional(),
    })
    .strict();

function proposeInputSchema(itemNoun: string): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: `The candidate ${itemNoun}(s) to propose. Each is validated against the ${itemNoun} create-schema; malformed items are rejected, never queued.`,
                items: { type: 'object' },
            },
            rationale: { type: 'string', maxLength: 4000, description: 'The agent\'s reasoning (stored encrypted, shown to the human reviewer).' },
        },
        required: ['items'],
        additionalProperties: false,
    };
}

export const PROPOSE_TOOLS: McpProposeTool[] = [
    {
        name: 'propose_risks',
        description:
            'Propose one or more candidate RISKS for human approval (NOT created). ' +
            'Each item uses the risk create shape (title required; description, ' +
            'category, impact 1-10, likelihood 1-10, …). Returns the pending ' +
            'proposal ids — a human approves them before any risk is created.',
        inputSchema: proposeInputSchema('risk'),
        kind: 'RISK',
        resourceScope: { resource: 'risks', action: 'read' },
        authorize: {
            keys: ['risks.create'],
            basis: 'principal',
            mirrors: 'POST /api/t/:slug/risks',
        },
    },
    {
        name: 'propose_controls',
        description:
            'Propose one or more candidate CONTROLS for human approval (NOT ' +
            'created). Each item uses the control create shape (name required; ' +
            'description, category, status, frequency, …). Returns pending proposal ids.',
        inputSchema: proposeInputSchema('control'),
        kind: 'CONTROL',
        resourceScope: { resource: 'controls', action: 'read' },
        authorize: {
            keys: ['controls.create'],
            basis: 'principal',
            mirrors: 'POST /api/t/:slug/controls',
        },
    },
    {
        name: 'draft_policy',
        description:
            'Draft one or more POLICIES for human approval (NOT published). Each ' +
            'item uses the policy create shape (title required; description, ' +
            'category, content markdown, …). Returns pending proposal ids.',
        inputSchema: proposeInputSchema('policy'),
        kind: 'POLICY',
        resourceScope: { resource: 'policies', action: 'read' },
        authorize: {
            keys: ['policies.create'],
            basis: 'principal',
            mirrors: 'POST /api/t/:slug/policies',
        },
    },
    {
        name: 'propose_finding',
        description:
            'Propose one or more candidate FINDINGS for human approval (NOT ' +
            'created). Each item uses the finding create shape (severity, type, ' +
            'title required; description, rootCause, …). Returns pending proposal ids.',
        inputSchema: proposeInputSchema('finding'),
        kind: 'FINDING',
        resourceScope: { resource: 'audits', action: 'read' },
        // `POST /api/t/:slug/findings` carries no permission key —
        // `PermissionSet` has no `findings` domain — so its real gate is
        // `assertCanWrite` inside `createFinding`. Naming `audits.manage`
        // instead would be stricter but WRONG: an EDITOR holds
        // `audits.manage: false` and can create a finding through the human
        // API, so the tool would refuse a proposal its principal could commit.
        authorize: {
            keys: ['audits.view'],
            policy: 'write',
            basis: 'principal',
            mirrors: 'POST /api/t/:slug/findings (getTenantCtx + assertCanWrite)',
        },
    },
];

/**
 * `tools/list` descriptors for the propose surface, filtered to what this
 * invocation could actually call — the tools it may LOAD (offered at assembly,
 * granted in the register AND permitted by the agent's policy card), and only
 * when the credential carries `mcp:propose`. Same reasoning as the read registry's
 * filter: a catalogue of tools that will 403 turns ordinary planning into a
 * stream of `AUTHZ_DENIED` rows and buries the signal they exist for.
 *
 * The PERMISSION is not probed here, only the capability and the exposure. A
 * propose tool's key is checked against the principal, and an agent whose
 * principal cannot create risks should still be told the tool exists — the
 * refusal, when it comes, is the interesting event and belongs in the trail.
 */
export function listProposeToolDescriptors(inv: McpInvocation): McpToolDescriptor[] {
    const scopes = inv.ctx.apiKeyScopes;
    const mayPropose =
        !scopes ||
        scopes.includes('*') ||
        scopes.includes('mcp:*') ||
        scopes.includes('mcp:propose');
    if (!mayPropose) return [];
    return PROPOSE_TOOLS.filter((t) => isToolLoadable(inv, t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
    }));
}

export class McpProposeToolNotFoundError extends Error {
    readonly rpcCode = RpcErrorCode.MethodNotFound;
    constructor(name: string) {
        super(`Unknown MCP propose tool: ${name}`);
        this.name = 'McpProposeToolNotFoundError';
    }
}

export function isProposeTool(name: string): boolean {
    return PROPOSE_TOOLS.some((t) => t.name === name);
}

/**
 * Execute a propose tool: enforce the `mcp:propose` capability + domain scope,
 * validate args, then queue one PENDING `AgentProposal` per item via
 * `createAgentProposal` (which re-validates against the create-schema +
 * sanitises). NEVER creates the real entity. Returns the pending proposal ids.
 */
export async function runProposeTool(
    inv: McpInvocation,
    name: string,
    rawArgs: unknown,
): Promise<McpToolResult> {
    // 0. LOAD the tool through this invocation's pinned manifest rather than
    //    straight out of `PROPOSE_TOOLS` — the same door `runReadTool` uses, for
    //    the same reason. See `resolveOfferedTool` and `tool-manifest.ts`.
    const tool = await resolveOfferedTool(inv, PROPOSE_TOOLS, name);
    if (!tool) throw new McpProposeToolNotFoundError(name);

    const ctx = inv.ctx;

    // 1. The one gate: exposure → the `mcp:propose` capability → the domain
    //    scope → the PRINCIPAL's create permission (the same `assertPermission`
    //    the human create route runs). Exactly one audit row on refusal.
    await authorizeToolCall(
        inv,
        { ...tool, capability: 'propose', capabilityClass: 'propose' },
        rawArgs,
    );

    // 2. Validate the envelope.
    const parsed = proposeArgs.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        throw badRequest(`Invalid arguments for "${name}": ${parsed.error.message}`);
    }

    // 3. Queue one proposal per item (createAgentProposal validates each item
    //    against the create-schema + sanitises + GUARDS + audits). Malformed →
    //    throws. An item the agentic output guard quarantines is written as a
    //    terminal QUARANTINED row and never enters the review queue.
    const queued: string[] = [];
    const quarantined: string[] = [];
    for (const item of parsed.data.items) {
        const proposal = await createAgentProposal(ctx, {
            kind: tool.kind,
            payload: item,
            rationale: parsed.data.rationale ?? null,
            // The version that ALLOWED this call, taken from the invocation the
            // gate above authorized — not re-read from the card here. A re-read
            // would answer "what is in force now", which is a different claim
            // and is not what this proposal executed under; between the gate and
            // this line an operator can have edited the card.
            policyCardVersion: pinFromCard(inv.policyCard?.inForce ?? null),
        });
        (proposal.status === 'QUARANTINED' ? quarantined : queued).push(proposal.id);
    }

    // The result reports the two counts SEPARATELY. It used to hard-code
    // `status: 'PENDING'` for the whole batch, which is now a claim the seam
    // cannot make — and reporting a quarantined item as pending would tell the
    // agent (and any human reading a run transcript) that a record is waiting
    // for review when nothing is.
    //
    // Rule ids are deliberately NOT returned. The count is what an honest
    // client needs; the ids are what an attacker would use to tune a payload,
    // and they are already in the audit trail where a responder can read them.
    const message =
        quarantined.length === 0
            ? `Proposed ${queued.length} ${tool.kind.toLowerCase()}(s), pending human approval in the tenant's agent-proposals review queue. Nothing was created.`
            : `Proposed ${queued.length} ${tool.kind.toLowerCase()}(s) for human approval; ${quarantined.length} were QUARANTINED by the content guard and did NOT enter the review queue. Nothing was created.`;

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(
                    {
                        proposed: queued.length,
                        quarantined: quarantined.length,
                        kind: tool.kind,
                        proposalIds: queued,
                        quarantinedProposalIds: quarantined,
                        status: 'PENDING',
                        message,
                    },
                    null,
                    2,
                ),
            },
        ],
    };
}
