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
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { guardUntrustedInput, guardEgress, assertGuardAllowed } from '@/app-layer/ai/guard';
import {
    guardAgentProposal,
    type AgentProposalGuardResult,
} from '@/app-layer/ai/guard/proposal-guard';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { NO_POLICY_CARD, narrowApprovalRung, type ApprovalRung } from '@/lib/agentic/policy-card';
import {
    resolveApprovalRequirement,
    type ApprovalPinState,
    type ApprovalRequirement,
} from '@/lib/agentic/approval-tiering';
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
    /**
     * WHICH VERSION of the proposing agent's policy card was in force.
     * `NO_POLICY_CARD` (0, from `@/lib/agentic/policy-card-pin`) when none
     * was — a human-started assistant proposal, or an agent with no card.
     *
     * REQUIRED, and deliberately not optional-with-a-fallback. A caller that
     * may omit it is a caller that will, and the row it omits from is
     * indistinguishable from one written before the column existed. Every
     * caller has the answer cheaply: the MCP propose path holds the invocation
     * the boundary already authorized (`pinFromCard`), and the assistant path
     * has no agent at all (`resolvePolicyCardPin` returns the sentinel without
     * a query). Making it required puts the decision at the call site, where a
     * reader can see which of the two it is.
     */
    policyCardVersion: number;
}

export interface ProposalResult {
    id: string;
    kind: AgentProposalKind;
    /** `PENDING` when queued for review, `QUARANTINED` when the guard refused it. */
    status: string;
    /** The agentic output-guard verdict written on the row. */
    guardVerdict: AgentProposalGuardResult['verdict'];
}

/**
 * The refusal every review path shares. A QUARANTINED proposal is TERMINAL: the
 * queue does not list it, approval refuses it, and rejection has nothing left to
 * do. The refusal lives HERE, at the usecase, and not only in the list filter —
 * a filter hides a row from one surface, and every other caller (a direct
 * approve by id, a future bulk action, a script) walks straight past it.
 *
 * Writes exactly one hash-chained `AUTHZ_DENIED` row, then throws a 403 whose
 * body names the CONDITION and nothing else — no permission key, no rule ids,
 * no fragment of the payload.
 */
async function refuseQuarantined(
    ctx: RequestContext,
    proposal: { id: string; status: string; guardVerdict: string; guardRuleIds: string[] },
    attemptedAction: 'approve' | 'reject',
): Promise<never> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'AgentProposal',
        entityId: proposal.id,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: {
            // `access` is the canonical security-event category, matching
            // `auditPermissionDenied` in the permission middleware.
            category: 'access',
            event: 'authz_denied',
            reason: 'agent_proposal_quarantined',
            attemptedAction,
            guardVerdict: proposal.guardVerdict,
            // Rule IDS only — they carry no user content, and they are the
            // thing a responder needs. They go in the TRAIL, never the 403.
            ruleIds: proposal.guardRuleIds,
        },
        metadataJson: {
            role: ctx.role,
            apiKeyId: ctx.apiKeyId ?? null,
            guardVerdict: proposal.guardVerdict,
        },
    }).catch(() => undefined);

    throw forbidden('agent_proposal_quarantined');
}

/**
 * HOW MANY DISTINCT HUMANS must sign this proposal — the same answer for the
 * seam that writes the row and the seam that reads it back.
 *
 * ONE function, called from both, because the composition lives in
 * `approval-tiering.ts` and a second copy of it would be the four-verbatim-copies
 * failure the identity write-ladder already cost this repo. The DATABASE holds a
 * third reading of the same number (the four-eyes trigger reads
 * `AgentProposal.requiredApprovals`), and it reads the PINNED integer rather
 * than re-deriving the ladder in plpgsql for exactly that reason.
 *
 * The card version read here is the PINNED one, never the one in force today.
 * That distinction is the whole point of the pin: "what was this agent allowed
 * to do when it proposed" and "what is it allowed to do now" differ precisely
 * when somebody has edited the card, which is the case a review exists to find.
 */
async function resolveRequirementForRow(
    ctx: RequestContext,
    row: {
        agentId: string | null;
        policyCardVersion: number | null;
        proposedViaKeyId: string | null;
    },
): Promise<ApprovalRequirement> {
    return runInTenantContext(ctx, async (db) => {
        const agent = row.agentId
            ? await db.registeredAgent.findFirst({
                  where: { id: row.agentId, tenantId: ctx.tenantId },
                  select: { riskTier: true, autonomyLevel: true },
              })
            : null;

        // The three states of `policyCardVersion`, kept apart. See
        // `policy-card-pin.ts`: NULL is "we do not know", 0 is "asked, and the
        // answer was none", >= 1 is a real version. Collapsing them is how a
        // governance gap becomes a bypass.
        const pinState: ApprovalPinState =
            row.policyCardVersion === null
                ? 'UNPINNED'
                : row.policyCardVersion === NO_POLICY_CARD
                  ? 'NO_CARD'
                  : 'PINNED';

        let pinnedRung: ApprovalRung | null = null;
        if (pinState === 'PINNED' && row.agentId) {
            const card = await db.agentPolicyCard.findFirst({
                where: { tenantId: ctx.tenantId, agentId: row.agentId },
                select: { id: true },
            });
            const version = card
                ? await db.agentPolicyCardVersion.findFirst({
                      where: {
                          tenantId: ctx.tenantId,
                          cardId: card.id,
                          version: row.policyCardVersion ?? NO_POLICY_CARD,
                      },
                      select: { approvalRung: true },
                  })
                : null;
            // A pin naming a version that cannot be read is a BROKEN policy, not
            // an absent one — `null` here, which the resolver reads as the
            // strictest rung. Same call `loadPolicyCardInForce` makes when a
            // card's head points at a version row that is not there.
            pinnedRung = version ? narrowApprovalRung(version.approvalRung) : null;
        }

        return resolveApprovalRequirement({
            agent,
            agentNamed: row.agentId !== null,
            pinState,
            pinnedRung,
            viaApiKey: row.proposedViaKeyId !== null,
        });
    });
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
    const inputOutcome = await guardUntrustedInput(ctx, proposedText, {
        source: `agent-proposal:${input.kind}`,
    });
    const egressOutcome = await guardEgress(ctx, { payload: sanitized, rationale }, {
        source: `agent-proposal:${input.kind}:egress`,
    });

    // 2c. The AGENTIC OUTPUT GUARD — the decision the two calls above could not
    // make. `guardUntrustedInput` resolves enforcement through the tenant's
    // `aiGuardMode`, whose DEFAULT is `balanced`, where a MALICIOUS input
    // verdict resolves to `flag` — and `flag` does not throw. So before this,
    // a proposal whose own text tripped a high-severity injection rule was
    // written as an ordinary PENDING row and reached the reviewer looking
    // exactly like a clean one.
    //
    // `guardAgentProposal` is pure and reads the PROVENANCE instead of the
    // tenant's appetite: an external agent's output is third-party content by
    // construction, and third-party content that reads as an instruction is an
    // injection whatever the tenant has configured for its model calls. See
    // `ai/guard/proposal-guard.ts`.
    const guard = guardAgentProposal({ kind: input.kind, payload: sanitized, rationale });

    // A quarantine is strictly stronger than either outcome above (both fire on
    // the same malicious verdicts), so the throwing assertions apply only to the
    // rows that are about to be QUEUED. A quarantined proposal is written
    // instead of thrown, deliberately: the row is the only durable evidence that
    // the attempt happened, and an operator triaging an injection needs to see
    // what was tried, not an error somebody's agent swallowed.
    if (!guard.quarantined) {
        assertGuardAllowed(inputOutcome);
        assertGuardAllowed(egressOutcome);
    }

    // 2d. HOW MANY HUMANS WILL HAVE TO SIGN THIS — resolved once, here, and
    // PINNED onto the row. The composition (strictest of the pinned card rung,
    // the scored risk tier and the registered autonomy) lives in
    // `approval-tiering.ts`; nothing downstream recomputes it, because the card
    // and the tier can both move between the proposal and the review, and the
    // question a reviewer is answering is what was required when the work was
    // proposed.
    const requirement = await resolveRequirementForRow(ctx, {
        agentId: ctx.agentId ?? null,
        policyCardVersion: input.policyCardVersion,
        proposedViaKeyId: ctx.apiKeyId ?? null,
    });

    // 3. Persist the proposal (RLS-scoped). NOT the real entity — and, when the
    // guard quarantined it, not a queued one either.
    const proposal = await runInTenantContext(ctx, async (db) => {
        const row = await db.agentProposal.create({
            data: {
                tenantId: ctx.tenantId,
                kind: input.kind,
                status: guard.quarantined ? 'QUARANTINED' : 'PENDING',
                payloadJson: JSON.stringify(sanitized),
                rationale,
                // The verdict is a fact about the ROW, not a re-derivable
                // opinion: the rule table moves, and a refusal that has to be
                // recomputed at review time is a refusal that can evaporate
                // under a later pattern edit.
                guardVerdict: guard.verdict,
                guardRuleIds: guard.ruleIds,
                guardInputDigest: guard.inputDigest,
                guardProvenance: guard.provenance,
                proposedViaKeyId: ctx.apiKeyId ?? null,
                proposedBySessionRef: input.proposedBySessionRef ?? null,
                // WHICH registered agent proposed this. Resolved at the MCP
                // entry gate from the credential's binding; `null` means the
                // credential names no agent, which only a tenant with the
                // registration gate OFF can still produce. Written explicitly
                // rather than omitted so the row's attribution is a decision
                // this seam made, not a column nobody thought about — the
                // `local/require-agent-attribution` lint rule enforces that.
                agentId: ctx.agentId ?? null,
                // …and under WHICH VERSION of that agent's declared policy the
                // call that produced this proposal was authorized. Write-once
                // at the database: a trigger refuses any UPDATE that changes a
                // pin already set, so approving or rejecting this proposal
                // later cannot rewrite what the rules were when it was made.
                policyCardVersion: input.policyCardVersion,
                // …and HOW MANY HUMANS have to sign it. Written here rather
                // than derived at review time so a card edit or a re-score
                // between now and then cannot change what this proposal was
                // queued under. The four-eyes database trigger reads this
                // column, so it is also the reason the rule needs no second
                // implementation in plpgsql.
                requiredApprovals: requirement.requiredApprovals,
            },
            select: { id: true, kind: true, status: true },
        });

        // The AI-FEATURE record, for the agentic path. Same three properties
        // `AiDecisionLog` has carried for the AI features since the Art 12
        // work — an input DIGEST (never the prompt or the payload), a BOUNDED
        // summary, and the guard verdict — written in the same transaction as
        // the row it describes.
        //
        // `sanitizedInput` is the exact object `guardAgentProposal` hashed, so
        // `AiDecisionLog.inputDigest` and `AgentProposal.guardInputDigest` are
        // the same string and the two records join. `logAiDecision` hashes it
        // and discards it; nothing of the content is persisted here.
        await logAiDecision(db, ctx, {
            feature: 'agent-proposal',
            provider: 'mcp-agent',
            sanitizedInput: { kind: input.kind, payload: sanitized, rationale },
            // Structural facts only — field names and lengths, never an
            // excerpt. See `summarizeWithoutContent`.
            outputSummary: guard.outputSummary,
            guardVerdict: `${guard.verdict} provenance=${guard.provenance} rules=${guard.ruleIds.join('|') || 'none'}`,
            guardBlocked: guard.quarantined,
            sessionRef: input.proposedBySessionRef ?? null,
        }).catch(() => undefined);

        return row;
    });

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'API_KEY',
        entity: 'AgentProposal',
        entityId: proposal.id,
        action: guard.quarantined ? 'AGENT_PROPOSAL_QUARANTINED' : 'AGENT_PROPOSAL_CREATED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            kind: input.kind,
            agentId: ctx.agentId ?? null,
            policyCardVersion: input.policyCardVersion,
            // The review requirement AND the term that set it. The basis is a
            // propose-time fact and is recorded only here: by review time the
            // tier may have moved, so re-deriving it would answer a different
            // question than the one this row is evidence of.
            requiredApprovals: requirement.requiredApprovals,
            approvalBasis: requirement.decidedBy,
            guardVerdict: guard.verdict,
            // Rule ids carry no user content — that is the contract the whole
            // guard is built on (`patterns.ts`: "Rules never capture or return
            // the raw matched substring").
            ruleIds: guard.ruleIds,
            provenance: guard.provenance,
        },
        metadataJson: {
            apiKeyId: ctx.apiKeyId ?? null,
            agentId: ctx.agentId ?? null,
            guardVerdict: guard.verdict,
            inputDigest: guard.inputDigest,
        },
    }).catch(() => undefined);

    return {
        id: proposal.id,
        kind: proposal.kind as AgentProposalKind,
        status: proposal.status,
        guardVerdict: guard.verdict,
    };
}

/**
 * The statuses the NORMAL review queue can ever show. `QUARANTINED` is absent
 * and that is the point: the guard's whole value is that a reviewer is never
 * handed an injected proposal to rubber-stamp, and a queue that lists it —
 * even greyed out, even behind a filter chip — is a queue that can approve it.
 *
 * Derived by subtraction from the live enum rather than written out, so a
 * status added to `SuggestionItemStatus` later appears in the queue by default.
 * That direction is deliberate: a new REVIEW state that nobody remembers to
 * list is an invisible backlog, whereas a new REFUSAL state that nobody
 * remembers to hide is caught by `REVIEWABLE_STATUSES` being wrong in a way the
 * quarantine tests notice.
 */
export const NON_REVIEWABLE_STATUSES: readonly SuggestionItemStatus[] = ['QUARANTINED'];

const REVIEWABLE_STATUSES: SuggestionItemStatus[] = Object.values(SuggestionItemStatus).filter(
    (s) => !NON_REVIEWABLE_STATUSES.includes(s),
);

/**
 * List proposals for the review queue (bounded).
 *
 * QUARANTINED rows are excluded UNCONDITIONALLY — including when a caller asks
 * for them by name through `?status=QUARANTINED`. The filter narrows what a
 * reviewer sees; it never widens it. Triage lives in
 * `listQuarantinedAgentProposals`, a separate call that cannot be reached by
 * mistyping a query string.
 */
export async function listAgentProposals(
    ctx: RequestContext,
    opts: { status?: string; take?: number } = {},
) {
    assertCanRead(ctx);
    // `opts.status` is a raw `?status=` query-string value — the `as never`
    // this replaces silenced the compiler but not Prisma, which 500'd on a
    // comma-joined multi-select or a status from another entity's enum.
    //
    // Parsed against the REVIEWABLE vocabulary, so `?status=QUARANTINED` is a
    // 400 ("unknown status") rather than a way in.
    const requested = parseEnumListFilter<SuggestionItemStatus>(
        opts.status,
        REVIEWABLE_STATUSES,
        'proposal status',
    );
    // Belt and braces: even with no filter at all, the query names the
    // reviewable set. A quarantined row cannot reach this surface through an
    // absent parameter either.
    const status = requested ?? { in: REVIEWABLE_STATUSES };
    return runInTenantContext(ctx, (db) =>
        db.agentProposal.findMany({
            where: { tenantId: ctx.tenantId, status },
            orderBy: { createdAt: 'desc' },
            take: opts.take ?? 100,
        }),
    );
}

/**
 * The QUARANTINE TRIAGE listing — what the output guard refused, for an
 * operator investigating an injection attempt.
 *
 * A separate function rather than a flag on the queue listing, because the two
 * answer different questions and only one of them ends in an approval. Nothing
 * here is actionable: `approveAgentProposal` refuses every row this returns.
 */
export async function listQuarantinedAgentProposals(
    ctx: RequestContext,
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.agentProposal.findMany({
            where: { tenantId: ctx.tenantId, status: 'QUARANTINED' },
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
 * What comes back when a human's approval was RECORDED but the proposal still
 * needs another one. Nothing was created.
 *
 * A distinct shape rather than `ApproveResult` with a null entity id, because
 * the two outcomes are different facts and a caller that reads them as one is
 * the automation-bias failure in miniature: a reviewer told "approved" for a
 * proposal that has not been approved learns that clicking the button is what
 * approval means.
 */
export interface ApprovalRecordedResult {
    proposalId: string;
    kind: AgentProposalKind;
    status: 'AWAITING_APPROVAL';
    createdEntityId: null;
    approvalsRecorded: number;
    approvalsRequired: number;
}

export type ApproveOutcome = ApproveResult | ApprovalRecordedResult;

/**
 * Which four-eyes constraint refused, as the database reported it.
 *
 * Both are DATABASE refusals and neither is a check this usecase performs, which
 * is the point: counting approvals and then writing one is a read-then-write,
 * and two concurrent requests both read "one signature so far" and both write
 * the second. The unique index and the trigger have no window between the read
 * and the write because they do not read.
 *
 * `null` means the failure was something else and must be rethrown — swallowing
 * an unrelated error here would turn a broken database into a silent four-eyes
 * refusal, which reads to an operator as the control working.
 */
function fourEyesRefusal(err: unknown): { rule: string; message: string } | null {
    const text = err instanceof Error ? err.message : '';
    if (text.includes('AGENT_PROPOSAL_APPROVAL_OWNER_SELF_REVIEW')) {
        return {
            rule: 'agent_owner_may_not_approve',
            message:
                'This proposal needs two independent approvers, and you are the ' +
                'registered owner of the agent that made it. Someone else has to sign.',
        };
    }
    if (text.includes('AGENT_PROPOSAL_APPROVAL_NO_PROPOSAL')) {
        return {
            rule: 'proposal_not_visible',
            message: 'Proposal not found.',
        };
    }
    if ((err as { code?: unknown } | null)?.code === 'P2002') {
        return {
            rule: 'approver_already_signed',
            message:
                'You have already approved this proposal. A second approval has ' +
                'to come from a different person.',
        };
    }
    return null;
}

/**
 * The four-eyes refusal, audited then thrown. Same shape as
 * `refuseQuarantined`: exactly one hash-chained `AUTHZ_DENIED` row, then a 403
 * whose body names the CONDITION and nothing else — no permission key, no
 * approver identity, no fragment of the payload.
 */
async function refuseFourEyes(
    ctx: RequestContext,
    proposal: { id: string; kind: string; agentId: string | null; requiredApprovals: number | null },
    refusal: { rule: string; message: string },
): Promise<never> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'AgentProposal',
        entityId: proposal.id,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            event: 'authz_denied',
            reason: 'agent_proposal_four_eyes',
            attemptedAction: 'approve',
            // WHICH constraint refused goes in the TRAIL, never in the 403.
            fourEyesRule: refusal.rule,
            kind: proposal.kind,
            approvalsRequired: proposal.requiredApprovals,
        },
        metadataJson: {
            role: ctx.role,
            agentId: proposal.agentId,
            apiKeyId: ctx.apiKeyId ?? null,
        },
    }).catch(() => undefined);

    throw forbidden('agent_proposal_four_eyes');
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
): Promise<ApproveOutcome> {
    assertCanWrite(ctx);
    const parsedEdits = edits ? editsSchema.parse(edits) : undefined;

    const proposal = await getAgentProposal(ctx, id);
    // ═══ QUARANTINE IS REFUSED BEFORE ANYTHING ELSE ═══
    //
    // Ahead of the PENDING check, and not folded into it, because the two say
    // different things. `Proposal is already REJECTED` is a 400 about
    // sequencing; this is a 403 about authority, it writes an AUTHZ_DENIED row,
    // and it must not be reachable by any ordering of the checks below.
    if (proposal.status === 'QUARANTINED' || proposal.guardVerdict === 'QUARANTINED') {
        await refuseQuarantined(ctx, proposal, 'approve');
    }
    if (proposal.status !== 'PENDING') {
        throw badRequest(`Proposal is already ${proposal.status}`);
    }

    // ═══ HOW MANY HUMANS THIS ONE NEEDS ═══
    //
    // Read from the PIN. `??` is not a convenience: a row written before this
    // column existed had its requirement composed by nothing at all, and an
    // uncomputed requirement must fail toward the expensive answer, so those
    // rows are re-resolved from what they DO record (their pinned card version
    // and their attribution) rather than defaulted to the cheap one. The
    // re-resolution reads the PINNED version, which is immutable, so it is not
    // the "re-derive against today's card" this module refuses to do.
    const review = {
        required:
            proposal.requiredApprovals ??
            (await resolveRequirementForRow(ctx, proposal)).requiredApprovals,
    };

    // ═══ A TWO-APPROVER PROPOSAL IS SIGNED AS PROPOSED ═══
    //
    // Edits are refused outright when a second approver is required, and this is
    // the four-eyes bypass that is easiest to miss: approver one signs the
    // content they read, approver two approves WITH EDITS, and the record that
    // commits is one no two people ever agreed on. Merging the first approver's
    // edits instead has the same defect pointing the other way.
    //
    // The alternative — re-arming the queue on every edit so both signatures
    // reattach to the new content — is a real design and a larger one; refusing
    // is the honest version of it until that exists. Rejecting and re-proposing
    // costs one round trip and leaves both decisions legible.
    if (review.required > 1 && parsedEdits) {
        throw badRequest(
            'This proposal needs two independent approvers, so it must be ' +
                'approved exactly as proposed — an edit after the first signature ' +
                'would commit content nobody signed twice. Reject it and propose ' +
                'the corrected content instead.',
        );
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

    const status: 'ACCEPTED' | 'EDITED' = parsedEdits ? 'EDITED' : 'ACCEPTED';

    // ═══ RECORD THIS HUMAN'S SIGNATURE. THE DATABASE ARBITRATES. ═══
    //
    // The insert IS the check. Two constraints on `AgentProposalApproval` do the
    // work, and neither is a read:
    //
    //   • `@@unique([tenantId, proposalId, approverUserId])` — the same person
    //     cannot be both approvers. That is the classic four-eyes bypass, and a
    //     usecase that counted first and wrote second would let two concurrent
    //     requests from one reviewer both pass the count.
    //   • the `agent_proposal_approval_four_eyes` trigger — the agent's
    //     registered owner is not among the approvers of a proposal that needs
    //     two. A CHECK cannot read `RegisteredAgent`; a trigger can.
    //
    // Written BEFORE the claim, so a signature that does not yet complete the
    // requirement is still durable evidence that this person looked. A queue
    // whose first approval leaves no trace cannot tell "one person approved" from
    // "nobody has looked yet", and those are the two states the whole control is
    // about.
    try {
        await runInTenantContext(ctx, (db) =>
            db.agentProposalApproval.create({
                data: {
                    tenantId: ctx.tenantId,
                    proposalId: proposal.id,
                    approverUserId: ctx.userId,
                    outcome: status,
                    requiredApprovals: review.required,
                },
                select: { id: true },
            }),
        );
    } catch (err) {
        const refusal = fourEyesRefusal(err);
        // Not a four-eyes refusal — a real failure. Rethrow rather than let a
        // broken database read to an operator as the control working.
        if (!refusal) throw err;
        await refuseFourEyes(ctx, proposal, refusal);
    }

    // ═══ IS THE REQUIREMENT MET? ═══
    //
    // DISTINCT approvers, and only TERMINAL APPROVING outcomes. A `PENDING` row
    // is not a signature — the column defaults to it precisely so that a writer
    // which never stated an outcome grants nothing — and a `REJECTED` one is the
    // opposite of a signature.
    const signatures = await runInTenantContext(ctx, (db) =>
        db.agentProposalApproval.findMany({
            where: {
                tenantId: ctx.tenantId,
                proposalId: proposal.id,
                outcome: { in: ['ACCEPTED', 'EDITED'] },
            },
            select: { approverUserId: true },
            take: 32,
        }),
    );
    const approvers = new Set(signatures.map((row) => row.approverUserId));

    if (approvers.size < review.required) {
        // Short of the requirement. NOTHING is created and the proposal stays
        // PENDING for the next reviewer — the claim below is never reached.
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'USER',
            entity: 'AgentProposal',
            entityId: proposal.id,
            action: 'AGENT_PROPOSAL_APPROVAL_RECORDED',
            requestId: ctx.requestId,
            detailsJson: {
                category: 'access',
                kind: proposal.kind,
                approvalsRecorded: approvers.size,
                approvalsRequired: review.required,
            },
            metadataJson: { agentId: proposal.agentId },
        }).catch(() => undefined);

        return {
            proposalId: proposal.id,
            kind,
            status: 'AWAITING_APPROVAL',
            createdEntityId: null,
            approvalsRecorded: approvers.size,
            approvalsRequired: review.required,
        };
    }

    // ═══ CLAIM BEFORE CREATING. THE ORDER IS THE WHOLE FIX. ═══
    //
    // This used to run the create-usecase first and mark the proposal
    // afterwards. The marking `updateMany` was correctly predicated on
    // `status: 'PENDING'`, so it looked atomic — and it is, but it ran too
    // late to prevent anything. Two reviewers approving the same proposal
    // concurrently both passed the PENDING read above, both created a live
    // compliance record, and only then did one of them lose the update.
    //
    // The result was TWO risks (or controls, or policies) from one proposal,
    // one of them orphaned — and the loser's `updateMany` returned count 0
    // into a discarded value, so it reported success to its caller. A
    // duplicate that nothing errors on is a duplicate nobody goes looking for.
    //
    // Claiming first makes the database the arbiter: exactly one caller can
    // move the row out of PENDING, and only that caller proceeds to create.
    // Same shape as `redeemInvite` — claim, then act.
    const claim = await runInTenantContext(ctx, (db) =>
        db.agentProposal.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status, reviewedByUserId: ctx.userId, reviewedAt: new Date() },
        }),
    );
    if (claim.count === 0) {
        // Lost the race, or the proposal moved between the read above and
        // here. Either way nothing has been created, which is the point.
        throw badRequest('Proposal is no longer pending');
    }

    // Run the REAL create-usecase — same validation/sanitisation/audit/cache
    // path a human create takes. The proposal only becomes a record HERE.
    //
    // From this point the claim is held. Anything that throws must hand it
    // back, or a transient failure would burn the proposal permanently: it
    // would read as ACCEPTED with nothing created and no way to retry.
    let createdEntityId: string;
    try {
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
    } catch (err) {
        // ═══ THE CLAIM IS DELIBERATELY *NOT* HANDED BACK ═══
        //
        // An earlier version of this fix reverted the row to PENDING here, on
        // the premise "the create threw, therefore nothing was committed".
        // That premise is false across a transaction boundary, and it fails in
        // exactly the direction this whole function exists to prevent.
        //
        // `runInTenantContext` is one `prisma.$transaction`, so the premise
        // holds only INSIDE the create callback. Two real paths commit the
        // entity and still reject the call:
        //
        //   1. Post-commit work. `createRisk` / `createControl` await
        //      `bumpEntityCacheVersion` AFTER their transaction closes, and
        //      `getRedis()` is called outside that helper's try/catch — so it
        //      can reject with the row already written.
        //   2. The in-doubt COMMIT. Runtime traffic goes through PgBouncer in
        //      transaction mode; a server-connection drop during COMMIT
        //      surfaces to the client as a rejected transaction while Postgres
        //      has already committed.
        //
        // Reverting in either case re-arms the create path over a record that
        // already exists, and the next approver makes a SECOND one. That is
        // the original duplicate bug, reintroduced through the rollback.
        //
        // So the row stays claimed. The cost is a proposal that reads
        // ACCEPTED/EDITED with a null `createdEntityId` and cannot be
        // re-approved — recovery is a deliberate human act, not an automatic
        // retry, precisely because we CANNOT tell "nothing was created" from
        // "something was created and we lost the id".
        //
        // That is the same trade the rest of this function makes: a visible
        // stuck row beats a silent duplicate compliance record.
        //
        // The failure is therefore recorded loudly rather than swallowed — a
        // burned row nobody can see is the one outcome worse than either.
        logger.error('agent proposal approval failed after claim', {
            component: 'agent-proposals',
            tenantId: ctx.tenantId,
            proposalId: id,
            kind,
            status,
            error: err instanceof Error ? err.message : String(err),
        });
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'USER',
            entity: 'AgentProposal',
            entityId: id,
            action: 'AGENT_PROPOSAL_APPROVAL_FAILED',
            requestId: ctx.requestId,
            detailsJson: {
                category: 'access',
                kind,
                claimedStatus: status,
                error: err instanceof Error ? err.message : String(err),
            },
            metadataJson: { proposedByApiKeyId: proposal.proposedViaKeyId, needsManualReview: true },
        }).catch(() => undefined);
        throw err;
    }

    // Attach the created entity to the claim we already hold. Predicated on
    // that same status so this cannot revive a row someone else has moved.
    await runInTenantContext(ctx, (db) =>
        db.agentProposal.updateMany({
            where: { id, tenantId: ctx.tenantId, status },
            data: { createdEntityId },
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
        detailsJson: {
            category: 'access',
            kind: proposal.kind,
            createdEntityId,
            // How many humans actually signed, and how many were required. The
            // pair is the evidence: "approved" on its own is the claim this
            // whole subsystem exists to stop taking on trust.
            approvalsRecorded: approvers.size,
            approvalsRequired: review.required,
        },
        metadataJson: { proposedByApiKeyId: proposal.proposedViaKeyId, createdEntityId, edited: !!parsedEdits },
    }).catch(() => undefined);

    return { proposalId: id, kind, createdEntityId, status };
}

/** Reject a PENDING proposal — nothing is created. */
export async function rejectAgentProposal(ctx: RequestContext, id: string): Promise<void> {
    assertCanWrite(ctx);
    const proposal = await getAgentProposal(ctx, id);
    // Rejection is refused too, and the reason is not symmetry for its own
    // sake. QUARANTINED is TERMINAL — a row moved to REJECTED would leave the
    // triage listing, so "dispose of it" and "hide the evidence" would be the
    // same click. The refusal is audited identically, so an operator trying to
    // clear a quarantined row leaves a trail rather than a gap.
    if (proposal.status === 'QUARANTINED' || proposal.guardVerdict === 'QUARANTINED') {
        await refuseQuarantined(ctx, proposal, 'reject');
    }
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
