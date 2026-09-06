/**
 * THE RETROSPECTIVE SAMPLE AUDIT — reading and answering it.
 *
 * OWASP ASI09. The propose-not-commit queue claims that a human approved every
 * agent-authored write. Nothing in the product tested that claim: every signal
 * it emitted described the SHAPE of the review (how many, how fast, by whom),
 * and a queue rubber-stamped under volume scores perfectly on all of them while
 * manufacturing an auditable record of consent nobody gave.
 *
 * The sampler (`jobs/agent-proposal-sample-audit.ts`) draws a keyed random
 * sample of already-approved proposals; this module is what a second human uses
 * to answer, and what a reader uses to get the number out.
 *
 * ── The one control that makes an answer worth anything ──────────────
 *
 * THE REVIEWER MAY NOT BE THE APPROVER. A retrospective review in which the
 * original approver marks their own approval CONCURRED measures nothing at all
 * — it is the same judgement twice, and it would drive the disagreement rate to
 * zero exactly in the tenants where rubber-stamping is worst, because there the
 * approver is also the only person looking. So `recordSampleAuditOutcome`
 * refuses when the caller is the proposal's `reviewedByUserId`, writes a
 * hash-chained `AUTHZ_DENIED` row, and returns a 403 naming the condition and
 * nothing else.
 *
 * That refusal is a 403 rather than a 400 for the reason `refuseExpired` is:
 * it is a statement about who has the authority to answer, not about the shape
 * of the request.
 *
 * ── There is no create seam here, on purpose ─────────────────────────
 *
 * A row is created by the SAMPLER and by nothing else. If a human could open a
 * sample audit on a proposal of their choosing, the sample would stop being a
 * sample: the selection could be steered toward approvals somebody already
 * wanted re-examined, and the rate would describe that choice rather than the
 * queue. Same discipline the JML subsystem states as "each table has exactly
 * one write seam" — see `tests/guards/sample-audit-single-draw-seam.test.ts`
 * for the enforcement.
 */
import { z } from 'zod';
import { AgentSampleAuditOutcome } from '@prisma/client';

import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import {
    SAMPLE_AUDIT_DISSENT_CODES,
    narrowDissentCodes,
    type SampleAuditDissentCode,
} from '@/lib/agentic/proposal-sampling';
import type { RequestContext } from '@/app-layer/types';

/**
 * The verdicts a human may WRITE.
 *
 * `PENDING` is absent and that is the point: it is the state the sampler
 * creates a row in, never a state a reviewer chooses. Allowing it as an answer
 * would let somebody return a decided row to undecided, which erases a judgement
 * that has already been made and is the only way the disagreement rate could be
 * revised downward after the fact.
 *
 * Derived by subtraction from the live enum, so a verdict added later is
 * writable by default — the same direction `REVIEWABLE_STATUSES` takes in
 * `agent-proposals.ts`, and for the same reason: a new ANSWER nobody remembers
 * to allow is an invisible dead end, whereas a new non-answer nobody remembers
 * to exclude fails the tests that pin this list.
 */
// `as const satisfies`, NOT a `readonly AgentSampleAuditOutcome[]` annotation.
// The annotation widens the element type to the whole union, and
// `z.enum(...).exclude([...])` then subtracts the whole union — leaving `never`,
// so every call site that passes a real verdict fails to typecheck. `satisfies`
// keeps the membership check (a typo here is still an error) while preserving
// the literal type the subtraction needs.
export const NON_ANSWERABLE_OUTCOMES = ['PENDING'] as const satisfies readonly AgentSampleAuditOutcome[];

export const ANSWERABLE_OUTCOMES: AgentSampleAuditOutcome[] = Object.values(
    AgentSampleAuditOutcome,
).filter((o) => !(NON_ANSWERABLE_OUTCOMES as readonly AgentSampleAuditOutcome[]).includes(o));

/**
 * Built by SUBTRACTION from the generated enum rather than from a second list
 * of literals, so `NON_ANSWERABLE_OUTCOMES` above is the only place the
 * exclusion is written down. A hand-typed tuple here would be a second opinion
 * about which verdicts a human may write, and the two would differ on exactly
 * the value somebody added most recently.
 */
const RecordOutcomeSchema = z.object({
    outcome: z.enum(AgentSampleAuditOutcome).exclude([...NON_ANSWERABLE_OUTCOMES]),
    dissentCodes: z.array(z.enum(SAMPLE_AUDIT_DISSENT_CODES)).optional(),
});

export type RecordSampleAuditOutcomeInput = z.infer<typeof RecordOutcomeSchema>;

/** The reviewer's queue — open sample audits for this tenant, oldest first. */
export async function listAgentProposalSampleAudits(
    ctx: RequestContext,
    opts: { open?: boolean; take?: number } = {},
) {
    assertCanRead(ctx);
    const take = Math.min(opts.take ?? 50, 200);
    return runInTenantContext(ctx, (db) =>
        db.agentProposalSampleAudit.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(opts.open === false ? {} : { outcome: 'PENDING' }),
            },
            // Oldest first — the opposite of every other queue in the product,
            // and deliberate. A sample audit that is never answered is the
            // failure mode here, so the surface has to lead with the one that
            // has waited longest rather than the one that arrived last.
            orderBy: { sampledAt: 'asc' },
            take,
        }),
    );
}

/**
 * THE NUMBER. Concurrence, dissent and indeterminacy over the answered
 * population, plus how much of the drawn sample is still unanswered.
 *
 * `pending` is returned alongside the rate rather than folded into the
 * denominator, because they say different things and only one of them is about
 * the queue's correctness. A rate of 0% over 2 answers and a rate of 0% over
 * 200 are the same number and completely different evidence — so `answered` is
 * returned too, and a caller that renders the percentage without it is
 * rendering a number that cannot be wrong.
 *
 * `disagreementRate` is `null`, never 0, when nothing has been answered. Zero
 * would read as "nobody disagreed", which is the claim a tenant with a perfect
 * record and a tenant nobody ever reviewed both produce — an absence is
 * ambiguous, so it is reported as an absence.
 */
export interface SampleAuditRate {
    sampled: number;
    answered: number;
    pending: number;
    concurred: number;
    dissented: number;
    indeterminate: number;
    /** dissented / answered, or `null` when nothing has been answered. */
    disagreementRate: number | null;
}

export async function getSampleAuditDisagreementRate(
    ctx: RequestContext,
    opts: { sinceDays?: number } = {},
): Promise<SampleAuditRate> {
    assertCanRead(ctx);
    const since = opts.sinceDays
        ? new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000)
        : undefined;

    const grouped = await runInTenantContext(ctx, (db) =>
        db.agentProposalSampleAudit.groupBy({
            by: ['outcome'],
            where: {
                tenantId: ctx.tenantId,
                ...(since ? { sampledAt: { gte: since } } : {}),
            },
            _count: { _all: true },
        }),
    );

    const countOf = (outcome: AgentSampleAuditOutcome) =>
        grouped.find((g) => g.outcome === outcome)?._count._all ?? 0;

    const pending = countOf('PENDING');
    const concurred = countOf('CONCURRED');
    const dissented = countOf('DISSENTED');
    const indeterminate = countOf('INDETERMINATE');
    const answered = concurred + dissented + indeterminate;

    return {
        sampled: pending + answered,
        answered,
        pending,
        concurred,
        dissented,
        indeterminate,
        disagreementRate: answered === 0 ? null : dissented / answered,
    };
}

/**
 * Answer one sample audit.
 *
 * Refuses, in this order and for these reasons:
 *   1. The audit does not exist in this tenant           → 404
 *   2. The caller approved the proposal being reviewed   → 403 + AUTHZ_DENIED
 *   3. The audit already has an answer                   → 400
 *   4. DISSENTED with no codes, or codes without DISSENT → 400
 *
 * The self-review check sits ABOVE the already-answered check, so an approver
 * who tries to close their own sample audit leaves an `AUTHZ_DENIED` row
 * whether or not somebody else got there first. A refusal that depends on
 * timing is a refusal that is missing from the record exactly when two people
 * raced for it.
 */
export async function recordSampleAuditOutcome(
    ctx: RequestContext,
    id: string,
    input: RecordSampleAuditOutcomeInput,
): Promise<{ id: string; outcome: AgentSampleAuditOutcome }> {
    assertCanWrite(ctx);
    const parsed = RecordOutcomeSchema.parse(input);

    const audit = await runInTenantContext(ctx, (db) =>
        db.agentProposalSampleAudit.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: {
                id: true,
                outcome: true,
                proposalId: true,
                proposal: { select: { reviewedByUserId: true } },
            },
        }),
    );
    if (!audit) throw notFound('Sample audit not found');

    if (audit.proposal.reviewedByUserId && audit.proposal.reviewedByUserId === ctx.userId) {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'USER',
            entity: 'AgentProposalSampleAudit',
            entityId: audit.id,
            action: 'AUTHZ_DENIED',
            requestId: ctx.requestId,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                reason: 'sample_audit_self_review',
                proposalId: audit.proposalId,
            },
            metadataJson: { role: ctx.role, proposalId: audit.proposalId },
        }).catch(() => undefined);
        throw forbidden('sample_audit_self_review');
    }

    if (audit.outcome !== 'PENDING') {
        throw badRequest(`Sample audit is already ${audit.outcome}`);
    }

    const dissentCodes: SampleAuditDissentCode[] = narrowDissentCodes(parsed.dissentCodes ?? []);
    if (parsed.outcome === 'DISSENTED' && dissentCodes.length === 0) {
        throw badRequest('A DISSENTED sample audit must name at least one dissent code');
    }
    if (parsed.outcome !== 'DISSENTED' && dissentCodes.length > 0) {
        throw badRequest('Dissent codes belong only to a DISSENTED sample audit');
    }

    // Conditional claim, same shape as `approveAgentProposal`: exactly one
    // caller can move the row out of PENDING, so two reviewers answering at
    // once cannot both write a verdict.
    const claim = await runInTenantContext(ctx, (db) =>
        db.agentProposalSampleAudit.updateMany({
            where: { id, tenantId: ctx.tenantId, outcome: 'PENDING' },
            data: {
                outcome: parsed.outcome,
                dissentCodes,
                reviewedByUserId: ctx.userId,
                reviewedAt: new Date(),
            },
        }),
    );
    if (claim.count === 0) throw badRequest('Sample audit is no longer pending');

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AgentProposalSampleAudit',
        entityId: audit.id,
        action: 'AGENT_PROPOSAL_SAMPLE_AUDIT_RECORDED',
        requestId: ctx.requestId,
        // Codes and ids only. The whole point of recording dissent as a stable
        // vocabulary rather than prose is that this row can be shipped to a
        // SIEM without carrying any of the agent-authored content it is about.
        detailsJson: {
            category: 'access',
            proposalId: audit.proposalId,
            outcome: parsed.outcome,
            dissentCodes,
        },
        metadataJson: { proposalId: audit.proposalId, outcome: parsed.outcome },
    }).catch(() => undefined);

    return { id: audit.id, outcome: parsed.outcome };
}
