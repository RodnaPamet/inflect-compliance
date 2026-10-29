/**
 * Agent recertification campaigns (step 3a, #3674) — the AGENT scope.
 *
 * An access review over registered agents. The campaign FREEZES its population
 * of agents at creation and refuses an empty one; a workflow that uses read
 * tools only prepares a reviewer pack for every agent; each pack proposes the
 * NARROWING its evidence supports (delete grants not used in the window); a
 * person decides every narrowing and every subject; the close requires a
 * non-empty population with every subject decided, writes evidence whose
 * content hash recomputes from the stored rows, and draws a sample of the
 * decisions for a second human through the existing keyed sampler.
 *
 * ═══ WHY THE DECISIONS ARE CONNECTED-DECISION ROWS ═══
 *
 * As LEGACY_APP does: `AccessReviewConnectedDecision`, `subjectRef` as
 * `agent:<registeredAgentId>`, `connectedAccountId` NULL. A third decision
 * model would be a third copy of reminders, the register, the detail page and
 * the campaign lifecycle. What an agent subject needs beyond a connected one is
 * two columns (the agent, and its owner frozen) and three child tables (pack,
 * narrowing, sample) — see `prisma/schema/audit-workflow.prisma`.
 *
 * ═══ RULES EACH PATH HOLDS, AND WHERE THE DATABASE HOLDS THEM TOO ═══
 *
 *   - The agent's OWNER may not decide its subject, nor any of its narrowings,
 *     nor answer its sample: refused here against the frozen owner AND the
 *     current one, with a hash-chained AUTHZ_DENIED row; a CHECK refuses the
 *     frozen owner as `decidedByUserId` for any writer.
 *   - Decisions are one-way stamps: written only where nothing is stamped yet,
 *     and a trigger refuses any change to a stamped row.
 *   - The only change a campaign makes to an agent's authority is deleting a
 *     grant an accepted narrowing names. Nothing here creates a grant, writes a
 *     card version or edits a register row — `tests/guards/agent-recertification-single-write-seam.test.ts`.
 *   - Zero is never complete: `subjectCount > 0 && decided === subjectCount`.
 *
 * @module app-layer/usecases/access-review-agent
 */
import { Readable } from 'node:stream';
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { DomainError, badRequest, forbidden, internal, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { appendAuditEntry } from '@/lib/audit';
import { deriveSubkey } from '@/lib/security/encryption';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { logger } from '@/lib/observability/logger';
import { sampleSizeFor, samplingEpochFor, selectSample } from '@/lib/agentic/proposal-sampling';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import { mayReadAgentSubjects, type AgentSubjectSnapshot } from '@/lib/access-review/scope';
import {
    AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    AGENT_RECERTIFICATION_PACK_WORKFLOW,
    MAX_AGENT_SUBJECTS,
    PACK_PAGE_SIZE,
    PACK_SUBJECT_ALL_BUT_SELF,
    PackPlanSchema,
    RECERT_SAMPLE_DISSENT_CODES,
    RecertificationEvidenceSchema,
    agentCampaignEvidenceBytes,
    buildAgentCampaignEvidence,
    observationWindow,
    planAgentReviewPacks,
    sectionsOf,
    type AgentCampaignEvidence,
    type PackPlan,
    type RecertificationEvidence,
} from '@/lib/agentic/agent-recertification';
import { agentCampaignEvidenceHash, sha256Of } from '@/lib/agentic/agent-recertification-hash';
import { ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';
import { canonicalJson } from '@/lib/canonical-json';
import {
    ISO27001_FAMILY_URN,
    SOC2_FAMILY_URN,
    frameworkFamilyId,
    requirementCodeSpellings,
} from '../domain/framework-representation';
import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { AccessReviewRepository } from '../repositories/AccessReviewRepository';
import { RegisteredAgentToolRepository } from '../repositories/RegisteredAgentToolRepository';
import { DateField, refinePeriodOrder } from '../schemas/access-review.schemas';
import { remediationDescription } from './access-review-connected';
import { startWorkflowRun } from './workflow-runs';
import { assertAgentCampaignsAvailable } from './access-review-scope-gate';
import { assertReviewerIsActiveMember } from './access-review-reviewer';

// ── Refusals ─────────────────────────────────────────────────────────────

export type AgentCampaignRefusal =
    | 'NO_SUBJECTS'
    | 'NOT_AN_AGENT_CAMPAIGN'
    | 'CAMPAIGN_CLOSED'
    | 'PACKS_ALREADY_PREPARED'
    | 'PACKS_NOT_PREPARED'
    | 'PREPARER_REQUIRED'
    | 'PREPARERS_MUST_DIFFER'
    | 'PREPARER_NOT_FOUND'
    | 'PREPARER_NOT_ACTIVE'
    | 'PREPARER_UNSCORED'
    | 'PREPARER_KILL_SWITCHED'
    | 'PREPARER_BREAKER_LATCHED'
    | 'PREPARER_LACKS_READ_GRANT'
    | 'PREPARE_REQUIRES_PERSON'
    | 'SELF_PACK_REFUSED'
    | 'STATIC_PACK_NOT_PREPARERS_OWN'
    | 'PACK_RUN_FAILED'
    | 'PACK_PLAN_MISMATCH'
    | 'NARROWINGS_PENDING'
    | 'SUBJECTS_PENDING'
    | 'ALREADY_DECIDED';

/** Thrown with the code in the message so a caller and a test can both read it. */
function refuse(code: AgentCampaignRefusal, detail: string): never {
    if (code === 'NO_SUBJECTS') throw new DomainError(`NO_SUBJECTS: ${detail}`, 'NO_SUBJECTS', 400);
    throw badRequest(`${code}: ${detail}`);
}

/**
 * The owner refusal: a 403 with a hash-chained AUTHZ_DENIED row naming the
 * condition. Written BEFORE any check that depends on timing, so an owner who
 * tries is on the record whether or not somebody else got there first.
 */
async function refuseOwner(
    ctx: RequestContext,
    entity: string,
    entityId: string,
    reason: string,
): Promise<never> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity,
        entityId,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', event: 'authz_denied', reason },
        metadataJson: { role: ctx.role },
    }).catch(() => undefined);
    throw forbidden(reason);
}

function holdsRegistry(ctx: RequestContext): boolean {
    return ctx.appPermissions?.admin?.agent_registry === true;
}

// ── The preparing agents ─────────────────────────────────────────────────
//
// A REGISTERED AGENT prepares every pack (roadmap rule 1, owner decision of
// 2026-10-18): the pack workflow runs as that agent, through the funnel, with
// its grants, card and autonomy terms; the admin who asks only starts it. And
// no agent prepares the pack it is reviewed by (rule 8). Every agent able to
// prepare is ACTIVE, so it is always in the frozen population: the preparer
// prepares every pack but its own, and its own pack is prepared by the
// campaign's cross-preparer when one is named — otherwise by a PERSON on the
// static, agent-free path, for that one pack only (owner decision of
// 2026-10-18, which relaxes rule 1 there and nowhere else). CHECKs on
// `AccessReview` and on the pack hold all of it for any writer: two preparers
// differ, no agent prepares its own pack, the provenance is paired, and a pack
// no agent prepared is the preparer's own.

/** The provenance a pack records. */
export const PACK_PREPARATION_BASIS = {
    AGENT_RUN: 'AGENT_RUN',
    PERSON_STATIC_SELF_PACK: 'PERSON_STATIC_SELF_PACK',
} as const;
export type PackPreparationBasis = (typeof PACK_PREPARATION_BASIS)[keyof typeof PACK_PREPARATION_BASIS];

/** One of the agents a campaign names, and which role it plays. */
type PreparerRole = 'preparer' | 'cross-preparer';

/**
 * Can `agentId` prepare packs right now? The terms the automation dispatcher
 * asks before it starts an agent's run (`agent-invoke-dispatch`), each with its
 * own name, plus the one grant the pack needs. Asked at creation AND again at
 * preparation: an agent that stopped qualifying in between is refused, not run.
 * The funnel asks all of them again on the call itself; this is the half that
 * names the cause before a run row exists.
 */
async function assertPreparerEligible(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    agentId: string,
    role: PreparerRole,
): Promise<void> {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true, riskTier: true, isLegacyPlaceholder: true },
    });
    if (!agent || agent.isLegacyPlaceholder) refuse('PREPARER_NOT_FOUND', `the ${role} is not a registered agent of this tenant`);
    if (agent.status !== 'ACTIVE') refuse('PREPARER_NOT_ACTIVE', `the ${role} is ${agent.status}; only an ACTIVE agent prepares packs`);
    if (agent.riskTier === null) refuse('PREPARER_UNSCORED', `the ${role} has no risk tier; an unscored agent is denied`);
    const kill = await resolveKillState(ctx.tenantId, agentId);
    if (kill) refuse('PREPARER_KILL_SWITCHED', `the ${role} is stopped by a ${kill.scope} kill switch`);
    const latch = await readBreakerLatch(ctx.tenantId, agentId);
    if (latch?.state === 'OPEN') refuse('PREPARER_BREAKER_LATCHED', `the ${role}'s circuit breaker is open`);
    const grant = await db.registeredAgentTool.findFirst({
        where: { tenantId: ctx.tenantId, agentId, toolName: AGENT_RECERTIFICATION_EVIDENCE_TOOL },
        select: { id: true },
    });
    if (!grant) {
        refuse('PREPARER_LACKS_READ_GRANT', `the ${role} is not granted ${AGENT_RECERTIFICATION_EVIDENCE_TOOL}`);
    }
}

// ── Create ───────────────────────────────────────────────────────────────

export const CreateAgentAccessReviewSchema = z
    .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        reviewerUserId: z.string().min(1),
        /** Prepares every pack but its own. Required — refused by name when absent. */
        preparerAgentId: z.string().max(64).optional(),
        /**
         * Prepares the preparer's own pack. Optional: left out, a person prepares
         * that one pack on the static path.
         */
        crossPreparerAgentId: z.string().max(64).optional(),
        // The campaign schemas' one date field and one period rule.
        dueAt: DateField.optional(),
        periodStartAt: DateField.optional(),
        periodEndAt: DateField.optional(),
    })
    .superRefine(refinePeriodOrder);

export interface CreateAgentResult {
    readonly accessReviewId: string;
    readonly subjectCount: number;
    /** More agents than `MAX_AGENT_SUBJECTS`: this campaign covers a prefix. */
    readonly snapshotTruncated: boolean;
    /** Subjects the reviewer owns, which only another admin can decide. */
    readonly ownedByReviewer: number;
}

/**
 * Create an AGENT campaign, freezing its population of registered agents.
 *
 * The population is every agent that can hold authority: DRAFT, ACTIVE or
 * SUSPENDED, not deleted, not the legacy placeholder. A RETIRED agent holds
 * none — retirement deleted its grants and revoked its keys — so there is
 * nothing to certify about it. Zero agents is refused here and again at close.
 */
export async function createAgentAccessReview(
    ctx: RequestContext,
    input: unknown,
    now: Date = new Date(),
): Promise<CreateAgentResult> {
    assertCanAdmin(ctx);
    assertAgentCampaignsAvailable('create');
    const parsed = CreateAgentAccessReviewSchema.parse(input);
    const preparerAgentId = parsed.preparerAgentId?.trim() || null;
    const crossPreparerAgentId = parsed.crossPreparerAgentId?.trim() || null;
    if (!preparerAgentId) {
        refuse(
            'PREPARER_REQUIRED',
            'an agent campaign names the registered agent that prepares its packs',
        );
    }
    if (crossPreparerAgentId && preparerAgentId === crossPreparerAgentId) {
        refuse('PREPARERS_MUST_DIFFER', 'the preparer and the cross-preparer must be two different agents');
    }

    return runInTenantContext(ctx, async (db) => {
        await assertReviewerIsActiveMember(db, ctx, parsed.reviewerUserId);

        // MAX + 1, for the reason the connected flow gives: N rows back cannot
        // be told from a register of exactly N.
        const found = await db.registeredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                isLegacyPlaceholder: false,
                status: { in: ['DRAFT', 'ACTIVE', 'SUSPENDED'] },
            },
            select: {
                id: true, name: true, status: true, riskTier: true, ownerUserId: true,
                owner: { select: { email: true } },
                _count: { select: { tools: true } },
            },
            orderBy: { id: 'asc' },
            take: MAX_AGENT_SUBJECTS + 1,
        });
        if (found.length === 0) {
            refuse(
                'NO_SUBJECTS',
                'no registered agent can hold authority in this tenant — the campaign would have '
                + 'zero subjects, and a review over zero agents evidences nothing',
            );
        }
        const snapshotTruncated = found.length > MAX_AGENT_SUBJECTS;
        const agents = snapshotTruncated ? found.slice(0, MAX_AGENT_SUBJECTS) : found;

        // After the population, so an empty one is the refusal a caller meets
        // first, whatever agents the request names.
        await assertPreparerEligible(db, ctx, preparerAgentId, 'preparer');
        if (crossPreparerAgentId) await assertPreparerEligible(db, ctx, crossPreparerAgentId, 'cross-preparer');

        const review = await AccessReviewRepository.createAgentCampaign(db, ctx, {
            name: sanitizePlainText(parsed.name),
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            periodStartAt: parsed.periodStartAt ?? null,
            periodEndAt: parsed.periodEndAt ?? null,
            reviewerUserId: parsed.reviewerUserId,
            dueAt: parsed.dueAt ?? null,
            snapshotTruncated,
            createdAt: now,
            preparerAgentId,
            crossPreparerAgentId,
        });

        const created = await db.accessReviewConnectedDecision.createMany({
            data: agents.map((a) => {
                // `satisfies`, not an annotation: the deploy-1 readers' shape
                // is checked, and the literal keeps the type a JSON column takes.
                const snapshot = {
                    kind: 'AGENT' as const,
                    agentId: a.id,
                    agentName: a.name,
                    agentStatus: a.status,
                    ownerUserId: a.ownerUserId,
                    ownerEmail: a.owner.email,
                    grantCount: a._count.tools,
                    riskTier: a.riskTier,
                } satisfies AgentSubjectSnapshot & { riskTier: string | null };
                return {
                    tenantId: ctx.tenantId,
                    accessReviewId: review.id,
                    connectedAccountId: null,
                    subjectRef: `agent:${a.id}`,
                    subjectAgentId: a.id,
                    subjectOwnerUserId: a.ownerUserId,
                    snapshotJson: snapshot,
                };
            }),
        });
        // Not `skipDuplicates`: the subject reference is the agent's own id,
        // so a collision is impossible, and a population that came back one
        // short would be the silent drop invariant 5 was written about.
        if (created.count !== agents.length) {
            throw internal(`froze ${created.count} of ${agents.length} agent subjects`);
        }

        const ownedByReviewer = agents.filter((a) => a.ownerUserId === parsed.reviewerUserId).length;

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_CREATED',
            entityType: 'AccessReview',
            entityId: review.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AccessReview',
                operation: 'create',
                summary: `Agent recertification "${review.name}" created over ${agents.length} registered agent(s)`
                    + (snapshotTruncated ? ` (TRUNCATED at the ${MAX_AGENT_SUBJECTS}-agent cap)` : ''),
                after: {
                    scope: 'AGENT',
                    subjectCount: agents.length,
                    snapshotTruncated,
                    ownedByReviewer,
                    preparerAgentId,
                    crossPreparerAgentId,
                },
            },
        });

        return { accessReviewId: review.id, subjectCount: agents.length, snapshotTruncated, ownedByReviewer };
    });
}

// ── Packs ────────────────────────────────────────────────────────────────

export interface PreparePacksResult {
    readonly accessReviewId: string;
    readonly packs: number;
    readonly narrowings: number;
    readonly runIds: readonly string[];
}

/**
 * The plan of one run, re-derived from that run's own READ output.
 *
 * The SYNTHESIS step already computed it, and the step's recorded output is
 * what this compares against: a plan the usecase writes must be one the stored
 * evidence implies, so a recorded synthesis that disagrees with its own read —
 * a tampered row, or a planner change between the run and the write — is
 * refused rather than trusted. The plan carries no hash (the server hashes the
 * sections it stores), so this is the check that the plan follows. Exported so
 * the refusal is unit-testable without forging a run.
 */
export function checkedPlan(evidence: RecertificationEvidence, recorded: unknown): PackPlan {
    const derived = planAgentReviewPacks(evidence);
    const parsed = PackPlanSchema.safeParse(recorded);
    if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(derived)) {
        refuse('PACK_PLAN_MISMATCH', 'the recorded plan does not follow from the recorded evidence');
    }
    return derived;
}

/** One pack-preparation run, as the usecase reads it back. */
interface PreparedRun {
    readonly evidence: RecertificationEvidence;
    readonly plan: PackPlan;
    readonly runId: string;
    /** The agent whose run it was, or null for the person-started static run. */
    readonly agentId: string | null;
}

/**
 * The person-started static run may prepare ONE pack: the campaign preparer's
 * own. Exported so the refusal is unit-testable without forging a run; a CHECK
 * on the pack refuses the same thing for any writer.
 */
export function assertStaticRunIsPreparersOwn(evidence: RecertificationEvidence, preparerAgentId: string): void {
    const others = evidence.subjects.filter((x) => x.agentId !== preparerAgentId);
    if (others.length > 0 || evidence.subjects.length !== 1) {
        refuse(
            'STATIC_PACK_NOT_PREPARERS_OWN',
            `a person's static preparation prepares only the preparer's own pack; this one read ${evidence.subjects.length} `
            + `subject(s), ${others.length} of them not the preparer`,
        );
    }
}

/**
 * Start one pack run and read its recorded steps back.
 *
 * AS AN AGENT (`agentId` set): the requester's context with the agent bound —
 * the seam the automation dispatcher uses to start a run for a registered
 * agent. `startWorkflowRun` resolves the agent through the register, pins its
 * policy card and stamps `WorkflowRun.agentId`; the static driver builds the
 * invocation from the register, so the READ step's tool call is the agent's:
 * deny-by-default over ITS grants, its card, its autonomy ceiling, the kill and
 * credential checks. The requester's permissions are one term of that
 * intersection, never a way around it.
 *
 * AS A PERSON (`agentId` null): the same static workflow, read tool and stored
 * rows, with no agent bound — no model, `WorkflowRun.agentId` NULL — for the
 * preparer's own pack only, when the campaign names no cross-preparer.
 */
async function runPack(
    ctx: RequestContext,
    agentId: string | null,
    accessReviewId: string,
    page: number,
    subject: string,
): Promise<PreparedRun> {
    const runCtx: RequestContext = agentId ? { ...ctx, agentId } : { ...ctx, agentId: undefined };
    const run = await startWorkflowRun(runCtx, AGENT_RECERTIFICATION_PACK_WORKFLOW, {
        accessReviewId,
        page: String(page),
        subject,
    });
    const who = agentId ? `agent ${agentId}` : 'a person';
    if (run.status !== 'COMPLETED' || run.stepFailures > 0) {
        refuse('PACK_RUN_FAILED', `run ${run.runId} (${who}, page ${page}) ended ${run.status} with ${run.stepFailures} failed step(s)`);
    }
    const { steps, runAgentId } = await runInTenantContext(ctx, async (db) => ({
        steps: await db.workflowStep.findMany({
            where: { tenantId: ctx.tenantId, runId: run.runId },
            select: { seq: true, kind: true, toolCalled: true, status: true, outputJson: true },
            orderBy: { seq: 'asc' },
            take: 10,
        }),
        runAgentId: (await db.workflowRun.findFirst({
            where: { id: run.runId, tenantId: ctx.tenantId },
            select: { agentId: true },
        }))?.agentId ?? null,
    }));
    // The run row must say whose it was: the agent's, or — for the static
    // path — nobody's. A run stamped otherwise did not prepare a pack under
    // the terms this function exists to apply.
    if (runAgentId !== agentId) {
        refuse('PACK_RUN_FAILED', `run ${run.runId} is attributed to ${runAgentId ?? 'no agent'}, not ${agentId ?? 'no agent'}`);
    }
    const read = steps.find((x) => x.seq === 0 && x.kind === 'READ' && x.toolCalled === AGENT_RECERTIFICATION_EVIDENCE_TOOL && x.status === 'DONE');
    const syn = steps.find((x) => x.seq === 1 && x.kind === 'SYNTHESIS' && x.status === 'DONE');
    if (!read?.outputJson || !syn?.outputJson) {
        refuse('PACK_RUN_FAILED', `run ${run.runId} recorded no evidence read and plan`);
    }
    const evidence = RecertificationEvidenceSchema.parse(JSON.parse(read.outputJson));
    if (evidence.accessReviewId !== accessReviewId || evidence.page !== page) {
        refuse('PACK_RUN_FAILED', `run ${run.runId} read another page or campaign`);
    }
    // Rule 8 at the result, whatever the read did: an agent's run carries no
    // evidence about the agent itself.
    if (agentId && evidence.subjects.some((x) => x.agentId === agentId)) {
        refuse('SELF_PACK_REFUSED', `run ${run.runId} returned the running agent's own subject`);
    }
    const recorded = (JSON.parse(syn.outputJson) as { data?: unknown } | null)?.data;
    return { evidence, plan: checkedPlan(evidence, recorded), runId: run.runId, agentId };
}

/**
 * Prepare every subject's reviewer pack, through the pack workflow, run by the
 * campaign's registered agents.
 *
 * The PREPARER runs one static workflow per page of `PACK_PAGE_SIZE` subjects
 * over every subject but its own. The preparer's own pack is prepared by the
 * CROSS-PREPARER's run when the campaign names one, and otherwise by a run
 * this person starts with no agent bound (`PERSON_STATIC_SELF_PACK`), which
 * may prepare that one pack and no other. Each run's READ step is the evidence
 * read and its SYNTHESIS step the plan. The packs and narrowings are written
 * only after every run succeeded, in one transaction, so a campaign has all of
 * its packs or none — and every pack records how it was prepared, and by
 * which agent.
 *
 * Started by a person (OWNER/ADMIN), never by a credential: the person only
 * starts the agents' runs, and a key's own agent binding would otherwise decide
 * whose run it is.
 */
export async function prepareAgentReviewPacks(
    ctx: RequestContext,
    accessReviewId: string,
): Promise<PreparePacksResult> {
    assertCanAdmin(ctx);
    assertAgentCampaignsAvailable('prepare');
    if (ctx.apiKeyId || ctx.agentId) {
        refuse('PREPARE_REQUIRES_PERSON', 'packs are prepared by the campaign’s agents, started by a signed-in person');
    }

    const head = await runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, scope: true, status: true, createdAt: true, preparerAgentId: true, crossPreparerAgentId: true },
        });
        if (!review) throw notFound('Access review not found');
        if (review.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'only an AGENT campaign has reviewer packs');
        if (review.status !== 'OPEN') refuse('CAMPAIGN_CLOSED', `packs are prepared before any decision; this campaign is ${review.status}`);
        if (!review.preparerAgentId) {
            refuse('PREPARER_REQUIRED', 'this campaign names no preparing agent');
        }
        const existing = await db.accessReviewAgentPack.count({ where: { tenantId: ctx.tenantId, accessReviewId } });
        if (existing > 0) refuse('PACKS_ALREADY_PREPARED', 'a pack is written once; this campaign has its packs');
        const subjects = await db.accessReviewConnectedDecision.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: { id: true, subjectAgentId: true, subjectOwnerUserId: true },
            take: MAX_AGENT_SUBJECTS + 1,
        });
        if (subjects.length === 0) refuse('NO_SUBJECTS', 'this campaign has no subjects to prepare packs for');
        // Asked again: the agents named at creation may have stopped
        // qualifying since — suspended, killed, ungranted.
        await assertPreparerEligible(db, ctx, review.preparerAgentId, 'preparer');
        if (review.crossPreparerAgentId) {
            await assertPreparerEligible(db, ctx, review.crossPreparerAgentId, 'cross-preparer');
        }
        return {
            review: { ...review, preparerAgentId: review.preparerAgentId, crossPreparerAgentId: review.crossPreparerAgentId },
            subjects,
        };
    });

    const { preparerAgentId, crossPreparerAgentId } = head.review;
    const preparerSubjects = head.subjects.filter((x) => x.subjectAgentId !== preparerAgentId);
    const preparersOwn = head.subjects.filter((x) => x.subjectAgentId === preparerAgentId);

    const prepared: PreparedRun[] = [];
    const pages = Math.ceil(preparerSubjects.length / PACK_PAGE_SIZE);
    for (let page = 0; page < pages; page++) { // guardrail-allow: n+1 — one workflow run and one bounded step read per page of PACK_PAGE_SIZE agents
        prepared.push(await runPack(ctx, preparerAgentId, accessReviewId, page, PACK_SUBJECT_ALL_BUT_SELF));
    }
    if (preparersOwn.length > 0) {
        if (crossPreparerAgentId) {
            prepared.push(await runPack(ctx, crossPreparerAgentId, accessReviewId, 0, preparerAgentId));
        } else {
            // The one pack no agent prepares: the person who asked starts the
            // static run, for the preparer's subject alone.
            const own = await runPack(ctx, null, accessReviewId, 0, preparerAgentId);
            assertStaticRunIsPreparersOwn(own.evidence, preparerAgentId);
            prepared.push(own);
        }
    }
    const runIds = prepared.map((r) => r.runId);

    const window = observationWindow(head.review.createdAt);
    const subjectById = new Map(head.subjects.map((x) => [x.id, x]));
    const coveredBy = new Map<string, string | null>();
    for (const r of prepared) for (const x of r.evidence.subjects) coveredBy.set(x.decisionId, r.agentId);
    if (coveredBy.size !== head.subjects.length || [...coveredBy.keys()].some((id) => !subjectById.has(id))) {
        refuse('PACK_RUN_FAILED', `the runs covered ${coveredBy.size} of ${head.subjects.length} subject(s)`);
    }

    return runInTenantContext(ctx, async (db) => {
        const ownerByDecision = new Map(head.subjects.map((x) => [x.id, x.subjectOwnerUserId]));

        const packRows = prepared.flatMap(({ evidence, runId, agentId: preparedBy }) =>
            evidence.subjects.map((x) => {
                // The hash is over exactly the sections stored, computed here
                // rather than in the plan: the plan is built by a workflow
                // step the client bundle reaches, and hashing needs
                // `node:crypto`. That the plan follows from this evidence was
                // checked by `checkedPlan`; every subject has its pack there,
                // because the plan is derived from the same evidence.
                const sections = sectionsOf(x);
                const contentHash = sha256Of(sections);
                return {
                    tenantId: ctx.tenantId,
                    accessReviewId,
                    decisionId: x.decisionId,
                    agentId: x.agentId,
                    preparedByRunId: runId,
                    preparedByAgentId: preparedBy,
                    preparationBasis: preparedBy
                        ? PACK_PREPARATION_BASIS.AGENT_RUN
                        : PACK_PREPARATION_BASIS.PERSON_STATIC_SELF_PACK,
                    campaignPreparerAgentId: preparerAgentId,
                    preparedByUserId: ctx.userId,
                    windowStart: window.start,
                    windowEnd: window.end,
                    sectionsJson: sections as unknown as object,
                    contentHash,
                };
            }),
        );
        const packs = await db.accessReviewAgentPack.createManyAndReturn({
            data: packRows,
            select: { id: true, decisionId: true, agentId: true },
        });
        const packByDecision = new Map(packs.map((p) => [p.decisionId, p]));

        const narrowingRows = prepared.flatMap(({ plan }) =>
            plan.packs.flatMap((p) => p.narrowings.map((n) => ({
                tenantId: ctx.tenantId,
                accessReviewId,
                decisionId: p.decisionId,
                packId: packByDecision.get(p.decisionId)!.id,
                agentId: p.agentId,
                grantId: n.grantId,
                toolName: n.toolName,
                grantedByUserId: n.grantedByUserId,
                grantedAt: new Date(n.grantedAt),
                basis: n.basis,
                subjectOwnerUserId: ownerByDecision.get(p.decisionId) ?? '',
            }))),
        );
        if (narrowingRows.some((n) => n.subjectOwnerUserId === '')) {
            throw internal('an agent subject has no frozen owner');
        }
        const narrowed = narrowingRows.length
            ? await db.accessReviewAgentNarrowing.createMany({ data: narrowingRows })
            : { count: 0 };

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_AGENT_PACKS_PREPARED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AccessReviewAgentPack',
                operation: 'create',
                summary: `Prepared ${packs.length} reviewer pack(s) and ${narrowed.count} narrowing(s) in ${runIds.length} agent run(s)`,
                after: {
                    packs: packs.length,
                    narrowings: narrowed.count,
                    runIds,
                    preparerAgentId,
                    crossPreparerAgentId,
                    windowStart: window.start.toISOString(),
                    windowEnd: window.end.toISOString(),
                },
            },
        });

        return { accessReviewId, packs: packs.length, narrowings: narrowed.count, runIds };
    });
}

/**
 * The packs, narrowings and samples of one AGENT campaign, for its reviewer.
 *
 * Narrowed like the subjects: the campaign's reviewer, or a holder of
 * `admin.agent_registry`. Every role holds `access_reviews.view`, and a pack is
 * register data.
 */
export async function getAgentReviewPacks(ctx: RequestContext, accessReviewId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, scope: true, reviewerUserId: true, evidenceFileRecordId: true },
        });
        if (!review) throw notFound('Access review not found');
        if (review.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'only an AGENT campaign has reviewer packs');
        if (!mayReadAgentSubjects({ userId: ctx.userId, reviewerUserId: review.reviewerUserId, holdsAgentRegistry: holdsRegistry(ctx) })) {
            throw forbidden('A reviewer pack is readable by the campaign’s reviewer and by holders of admin.agent_registry');
        }
        const packs = await db.accessReviewAgentPack.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: {
                id: true, decisionId: true, agentId: true, preparedByRunId: true, preparedByAgentId: true,
                preparationBasis: true, windowStart: true,
                windowEnd: true, sectionsJson: true, contentHash: true, preparedAt: true,
            },
            orderBy: { decisionId: 'asc' },
            take: MAX_AGENT_SUBJECTS,
        });
        const narrowings = await db.accessReviewAgentNarrowing.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: {
                id: true, decisionId: true, packId: true, grantId: true, toolName: true,
                grantedByUserId: true, grantedAt: true, basis: true, outcome: true,
                decidedAt: true, decidedByUserId: true, executedAt: true, executionResult: true,
            },
            orderBy: [{ decisionId: 'asc' }, { toolName: 'asc' }],
            take: MAX_AGENT_SUBJECTS * 50,
        });
        const samples = await db.accessReviewDecisionSampleAudit.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: {
                id: true, decisionId: true, samplingEpoch: true, sampledAt: true, outcome: true,
                dissentCodes: true, reviewedByUserId: true, reviewedAt: true,
            },
            orderBy: { decisionId: 'asc' },
            take: MAX_AGENT_SUBJECTS,
        });

        // A closed campaign's evidence, re-derived from the rows on every read:
        // the stored file's sha256 beside the hash of the document the rows
        // rebuild, so a reader sees whether they still agree.
        let evidence: { fileRecordId: string; storedSha256: string | null; recomputedSha256: string; matches: boolean } | null = null;
        if (review.evidenceFileRecordId) {
            const file = await db.fileRecord.findFirst({
                where: { id: review.evidenceFileRecordId, tenantId: ctx.tenantId },
                select: { sha256: true },
            });
            const { rows } = await evidenceRowsOf(db, ctx, accessReviewId);
            const recomputedSha256 = agentCampaignEvidenceHash(buildAgentCampaignEvidence(rows));
            const storedSha256 = file?.sha256 ?? null;
            evidence = {
                fileRecordId: review.evidenceFileRecordId,
                storedSha256,
                recomputedSha256,
                matches: storedSha256 === recomputedSha256,
            };
        }
        return { accessReviewId, packs, narrowings, samples, evidence };
    });
}

// ── The owner rule ───────────────────────────────────────────────────────

/** Is `userId` the agent's owner — when the campaign froze it, or now? */
async function ownsAgent(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    frozenOwner: string | null,
    agentId: string | null,
): Promise<boolean> {
    if (frozenOwner && frozenOwner === ctx.userId) return true;
    if (!agentId) return false;
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId },
        select: { ownerUserId: true },
    });
    return agent?.ownerUserId === ctx.userId;
}

// ── Subject decisions ────────────────────────────────────────────────────

export const SubmitAgentDecisionSchema = z.object({
    decision: z.enum(['CONFIRM', 'REVOKE', 'MODIFY']),
    notes: z.string().max(2000).optional(),
});

/**
 * Record a verdict on one agent subject.
 *
 * Refused, in order: not found; not an AGENT campaign; closed; not the
 * assigned reviewer or an admin; the agent's OWNER (frozen or current — 403 and
 * AUTHZ_DENIED); the pack not prepared; a narrowing still pending; already
 * decided. The reviewer decides the narrowings first and certifies what
 * remains, so a subject verdict is never recorded beside an open question
 * about the same agent's grants.
 */
export async function submitAgentDecision(
    ctx: RequestContext,
    decisionId: string,
    input: unknown,
    now: Date = new Date(),
) {
    assertCanRead(ctx);
    assertAgentCampaignsAvailable('decide');
    const parsed = SubmitAgentDecisionSchema.parse(input);
    return runInTenantContext(ctx, async (db) => {
        const row = await db.accessReviewConnectedDecision.findFirst({
            where: { id: decisionId, tenantId: ctx.tenantId },
            select: {
                id: true, decision: true, subjectAgentId: true, subjectOwnerUserId: true,
                accessReview: { select: { id: true, scope: true, reviewerUserId: true, status: true, deletedAt: true } },
                agentPack: { select: { id: true } },
            },
        });
        if (!row || row.accessReview.deletedAt !== null) throw notFound('Decision not found.');
        if (row.accessReview.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'this decision is not an agent subject');
        if (row.accessReview.status === 'CLOSED') refuse('CAMPAIGN_CLOSED', 'this campaign is closed; decisions are immutable');
        if (row.accessReview.reviewerUserId !== ctx.userId && !ctx.permissions?.canAdmin) {
            throw forbidden('Only the assigned reviewer (or a tenant admin) may decide an agent subject.');
        }
        if (await ownsAgent(db, ctx, row.subjectOwnerUserId, row.subjectAgentId)) {
            await refuseOwner(ctx, 'AccessReviewConnectedDecision', decisionId, 'agent_owner_cannot_decide');
        }
        if (!row.agentPack) refuse('PACKS_NOT_PREPARED', 'prepare the reviewer packs before deciding');
        const pending = await db.accessReviewAgentNarrowing.count({
            where: { tenantId: ctx.tenantId, decisionId, outcome: 'PENDING' },
        });
        if (pending > 0) refuse('NARROWINGS_PENDING', `${pending} narrowing(s) of this agent are still undecided`);

        const res = await db.accessReviewConnectedDecision.updateMany({
            where: { id: decisionId, tenantId: ctx.tenantId, decision: null },
            data: {
                decision: parsed.decision,
                notes: parsed.notes ? sanitizePlainText(parsed.notes) : null,
                decidedAt: now,
                decidedByUserId: ctx.userId,
            },
        });
        if (res.count === 0) refuse('ALREADY_DECIDED', 'this subject has already been decided');

        if (row.accessReview.status === 'OPEN') {
            await AccessReviewRepository.setReviewStatus(db, ctx, row.accessReview.id, 'IN_REVIEW');
        }

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_DECISION_SUBMITTED',
            entityType: 'AccessReviewConnectedDecision',
            entityId: decisionId,
            detailsJson: {
                category: 'access',
                entityName: 'AccessReviewConnectedDecision',
                operation: 'submit',
                summary: `Reviewer recorded ${parsed.decision} on agent subject ${decisionId}`,
                after: {
                    accessReviewId: row.accessReview.id,
                    decision: parsed.decision,
                    subjectAgentId: row.subjectAgentId,
                    hasNotes: Boolean(parsed.notes),
                },
            },
        });
        return { decisionId, decision: parsed.decision };
    });
}

// ── Narrowings ───────────────────────────────────────────────────────────

export const DecideNarrowingSchema = z.object({ outcome: z.enum(['ACCEPT', 'REJECT']) });

/**
 * Accept or reject one narrowing.
 *
 * Accepting DELETES the grant the narrowing names, in the same transaction —
 * the only effect a campaign has on an agent's authority, and it only narrows.
 * Written directly through the repository seam, not `revokeAgentTool`, whose
 * `admin.agent_tool_exposure` gate would add itself to a reviewer's verdict
 * without anybody deciding it should: the roadmap gives this verb to
 * `access_reviews.decide`, because a delete only narrows. It writes the same
 * `AGENT_TOOL_REVOKED` audit row as the standalone revoke, so the authority
 * history an auditor reads (procedure 5, attribute A1) stays complete.
 */
export async function decideAgentNarrowing(
    ctx: RequestContext,
    accessReviewId: string,
    narrowingId: string,
    input: unknown,
    now: Date = new Date(),
) {
    assertCanRead(ctx);
    assertAgentCampaignsAvailable('decide');
    const parsed = DecideNarrowingSchema.parse(input);
    return runInTenantContext(ctx, async (db) => {
        const n = await db.accessReviewAgentNarrowing.findFirst({
            where: { id: narrowingId, tenantId: ctx.tenantId, accessReviewId },
            select: {
                id: true, outcome: true, agentId: true, grantId: true, toolName: true,
                decisionId: true, subjectOwnerUserId: true,
                accessReview: { select: { id: true, scope: true, reviewerUserId: true, status: true, deletedAt: true } },
            },
        });
        if (!n || n.accessReview.deletedAt !== null) throw notFound('Narrowing not found.');
        if (n.accessReview.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'this narrowing is not in an agent campaign');
        if (n.accessReview.status === 'CLOSED') refuse('CAMPAIGN_CLOSED', 'this campaign is closed; narrowings are immutable');
        if (n.accessReview.reviewerUserId !== ctx.userId && !ctx.permissions?.canAdmin) {
            throw forbidden('Only the assigned reviewer (or a tenant admin) may decide a narrowing.');
        }
        if (await ownsAgent(db, ctx, n.subjectOwnerUserId, n.agentId)) {
            await refuseOwner(ctx, 'AccessReviewAgentNarrowing', narrowingId, 'agent_owner_cannot_decide');
        }

        const outcome = parsed.outcome === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
        const claim = await db.accessReviewAgentNarrowing.updateMany({
            where: { id: narrowingId, tenantId: ctx.tenantId, outcome: 'PENDING' },
            data: { outcome, decidedAt: now, decidedByUserId: ctx.userId },
        });
        if (claim.count === 0) refuse('ALREADY_DECIDED', 'this narrowing has already been decided');

        let executionResult: 'GRANT_DELETED' | 'GRANT_ALREADY_ABSENT' | null = null;
        if (outcome === 'ACCEPTED') {
            const deleted = await RegisteredAgentToolRepository.revokeGrant(db, ctx, {
                grantId: n.grantId,
                agentId: n.agentId,
                toolName: n.toolName,
            });
            executionResult = deleted > 0 ? 'GRANT_DELETED' : 'GRANT_ALREADY_ABSENT';
            await db.accessReviewAgentNarrowing.updateMany({
                where: { id: narrowingId, tenantId: ctx.tenantId, executedAt: null },
                data: { executedAt: now, executionResult },
            });
        }

        if (n.accessReview.status === 'OPEN') {
            await AccessReviewRepository.setReviewStatus(db, ctx, n.accessReview.id, 'IN_REVIEW');
        }

        // Audit last: `logEvent` writes on its own connection, so a row written
        // before an effect that then threw would narrate a rollback.
        if (executionResult === 'GRANT_DELETED') {
            await logEvent(db, ctx, {
                action: 'AGENT_TOOL_REVOKED',
                entityType: 'RegisteredAgent',
                entityId: n.agentId,
                detailsJson: {
                    category: 'access',
                    entityName: 'RegisteredAgentTool',
                    operation: 'delete',
                    summary: `Revoked MCP tool "${n.toolName}" from agent ${n.agentId} — narrowing accepted in access review ${n.accessReview.id}`,
                    before: { toolName: n.toolName, agentId: n.agentId },
                    after: { via: 'access_review_narrowing', accessReviewId: n.accessReview.id, narrowingId },
                },
            });
        }
        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_AGENT_NARROWING_DECIDED',
            entityType: 'AccessReviewAgentNarrowing',
            entityId: narrowingId,
            detailsJson: {
                category: 'access',
                entityName: 'AccessReviewAgentNarrowing',
                operation: 'decide',
                summary: `Narrowing of "${n.toolName}" ${outcome}`,
                after: {
                    accessReviewId: n.accessReview.id,
                    decisionId: n.decisionId,
                    outcome,
                    executionResult,
                },
            },
        });
        return { narrowingId, outcome, executionResult };
    });
}

// ── Close ────────────────────────────────────────────────────────────────

/**
 * The obligations the closing evidence is filed against, by FAMILY, so a
 * tenant's controls are found whichever representation of the framework its
 * database holds (`resolveTargetControls` in `agentic-evidence-emission.ts`
 * gives the reason at length).
 *
 * The brief names ISO/IEC 27001 A.5.18, SOC 2 CC6.3 and OWASP ASI03, and all
 * three are present, so all three are what this files against.
 *
 * CC6.3 was in NEITHER representation of SOC 2 until #3369: the library
 * authored one criterion per series (CC6.1 standing in for CC6.1-CC6.8) and
 * the seed carried the same ten, so the obligation was CC6.1 as a substitute,
 * matching `legacy-evidence-controls.ts`. A test read both catalogues and
 * asserted the absence precisely so the substitution would be revisited the
 * day CC6.3 was authored. It was authored; this is that revisit, and the test
 * now asserts presence.
 */
export const AGENT_RECERT_EVIDENCE_OBLIGATIONS: ReadonlyArray<{
    readonly familyUrn: string;
    readonly legacyKeys: readonly string[];
    readonly requirementCode: string;
    readonly note: string;
}> = [
    {
        familyUrn: ISO27001_FAMILY_URN,
        legacyKeys: ['ISO27001', 'iso27001'],
        requirementCode: 'A.5.18',
        note: 'Access rights — provisioned, reviewed and removed. Named by the brief and present (seeded as 5.18).',
    },
    {
        familyUrn: SOC2_FAMILY_URN,
        legacyKeys: ['SOC2', 'soc2'],
        requirementCode: 'CC6.3',
        note: 'Role-based access, least privilege and periodic review. Named by the brief and present since #3369 completed CC6; it is what a recertification campaign evidences.',
    },
    {
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI03',
        note: 'Identity and Privilege Abuse — agent authority that exceeds what the task needs. Named by the brief and present.',
    },
];

/** The tenant's controls the evidence attaches to. Empty is a real answer. */
async function resolveEvidenceControls(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
): Promise<string[]> {
    const catalogue = await db.framework.findMany({ select: { id: true, key: true, sourceUrn: true }, take: 500 });
    const wanted = AGENT_RECERT_EVIDENCE_OBLIGATIONS.flatMap((o) => {
        const frameworkIds = catalogue
            .filter((f) => frameworkFamilyId(f) === o.familyUrn || o.legacyKeys.includes(f.key))
            .map((f) => f.id);
        return frameworkIds.length
            ? [{ frameworkIds, codes: requirementCodeSpellings(o.familyUrn, o.requirementCode) }]
            : [];
    });
    if (wanted.length === 0) return [];
    const requirements = await db.frameworkRequirement.findMany({
        where: { OR: wanted.map((w) => ({ frameworkId: { in: w.frameworkIds }, code: { in: w.codes } })), deprecatedAt: null },
        select: { id: true },
        take: 100,
    });
    if (requirements.length === 0) return [];
    const links = await db.controlRequirementLink.findMany({
        where: {
            tenantId: ctx.tenantId,
            requirementId: { in: requirements.map((r) => r.id) },
            control: { deletedAt: null },
        },
        select: { controlId: true },
        take: 500,
    });
    return [...new Set(links.map((l) => l.controlId))].sort();
}

/** The stored rows of one campaign, as the closing evidence reads them. */
async function evidenceRowsOf(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    accessReviewId: string,
) {
    const campaign = await db.accessReview.findFirst({
        where: { id: accessReviewId, tenantId: ctx.tenantId },
        select: {
            id: true, tenantId: true, name: true, scope: true, periodStartAt: true, periodEndAt: true,
            reviewerUserId: true, createdByUserId: true, createdAt: true, closedAt: true,
            closedByUserId: true, snapshotTruncated: true, preparerAgentId: true, crossPreparerAgentId: true,
        },
    });
    if (!campaign) throw notFound('Access review not found');
    const subjects = await db.accessReviewConnectedDecision.findMany({
        where: { tenantId: ctx.tenantId, accessReviewId },
        select: {
            id: true, subjectRef: true, subjectAgentId: true, subjectOwnerUserId: true, snapshotJson: true,
            decision: true, decidedAt: true, decidedByUserId: true, notes: true,
        },
        orderBy: { subjectRef: 'asc' },
        take: MAX_AGENT_SUBJECTS + 1,
    });
    const packs = await db.accessReviewAgentPack.findMany({
        where: { tenantId: ctx.tenantId, accessReviewId },
        select: { decisionId: true, contentHash: true, preparedByRunId: true, preparedByAgentId: true, preparationBasis: true },
        take: MAX_AGENT_SUBJECTS + 1,
    });
    const narrowings = await db.accessReviewAgentNarrowing.findMany({
        where: { tenantId: ctx.tenantId, accessReviewId },
        select: {
            id: true, decisionId: true, grantId: true, toolName: true, grantedByUserId: true, grantedAt: true,
            basis: true, outcome: true, decidedAt: true, decidedByUserId: true, executedAt: true, executionResult: true,
        },
        take: MAX_AGENT_SUBJECTS * 50,
    });
    const samples = await db.accessReviewDecisionSampleAudit.findMany({
        where: { tenantId: ctx.tenantId, accessReviewId },
        select: { decisionId: true, samplingEpoch: true },
        take: MAX_AGENT_SUBJECTS,
    });
    return {
        campaign,
        rows: {
            campaign,
            subjects: subjects.map((s) => ({
                decisionId: s.id,
                subjectRef: s.subjectRef,
                subjectAgentId: s.subjectAgentId,
                subjectOwnerUserId: s.subjectOwnerUserId,
                snapshotJson: s.snapshotJson,
                decision: s.decision,
                decidedAt: s.decidedAt,
                decidedByUserId: s.decidedByUserId,
                notes: s.notes,
            })),
            packs,
            narrowings,
            samples,
            obligations: AGENT_RECERT_EVIDENCE_OBLIGATIONS.map((o) => ({
                familyUrn: o.familyUrn,
                requirementCode: o.requirementCode,
            })),
        },
    };
}

/**
 * Rebuild a closed campaign's evidence from its stored rows, and its hash.
 *
 * The verification half of the contract: the hash a close wrote is the hash of
 * these bytes, and the evidence file's `sha256` is the same number, so anybody
 * holding the rows or the file can check the other.
 */
export async function recomputeAgentCampaignEvidence(
    ctx: RequestContext,
    accessReviewId: string,
): Promise<{ document: AgentCampaignEvidence; contentHash: string }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { campaign, rows } = await evidenceRowsOf(db, ctx, accessReviewId);
        if (campaign.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'only an AGENT campaign has this evidence');
        if (!mayReadAgentSubjects({ userId: ctx.userId, reviewerUserId: campaign.reviewerUserId, holdsAgentRegistry: holdsRegistry(ctx) })) {
            throw forbidden('An agent campaign’s evidence is readable by its reviewer and by holders of admin.agent_registry');
        }
        const document = buildAgentCampaignEvidence(rows);
        return { document, contentHash: agentCampaignEvidenceHash(document) };
    });
}

/** The HKDF purpose of the decision sampler's per-tenant seed. Versioned. */
const SAMPLE_SEED_PURPOSE = 'inflect-access-review-decision-sample-v1';

export interface CloseAgentResult {
    readonly accessReviewId: string;
    readonly subjectCount: number;
    readonly remediationTasks: number;
    readonly sampled: number;
    /** Hex SHA-256 of the evidence bytes, or null when the artefact failed (the close stands). */
    readonly contentHash: string | null;
    readonly evidenceFileRecordId: string | null;
}

/**
 * Close an AGENT campaign. Two phases, as the connected close: phase 1 is one
 * transaction (guards, the conditional close claim, remediation tasks, the
 * executed stamps, the sample draw, the close audit row); phase 2 builds the
 * evidence from the committed rows and stores it, outside the transaction.
 */
export async function closeAgentAccessReview(
    ctx: RequestContext,
    accessReviewId: string,
    now: Date = new Date(),
    options: { seed?: string } = {},
): Promise<CloseAgentResult> {
    assertCanAdmin(ctx);
    assertAgentCampaignsAvailable('close');

    const phase1 = await runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({
            where: { id: accessReviewId, tenantId: ctx.tenantId },
            select: { id: true, name: true, scope: true, status: true, deletedAt: true },
        });
        if (!review || review.deletedAt !== null) throw notFound('Access review not found');
        if (review.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'only an AGENT campaign closes here');
        if (review.status === 'CLOSED') refuse('CAMPAIGN_CLOSED', 'campaign is already closed');

        const decisions = await db.accessReviewConnectedDecision.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: { id: true, subjectRef: true, decision: true, decidedAt: true, executedAt: true },
            orderBy: { subjectRef: 'asc' },
            take: MAX_AGENT_SUBJECTS + 1,
        });

        // ZERO IS NOT COMPLETE. Both halves in ONE expression: `decided ===
        // subjectCount` alone is true of the empty set, which would close a
        // campaign over nobody and file evidence that every agent was reviewed.
        const subjectCount = decisions.length;
        const decided = decisions.filter((d) => d.decision !== null && d.decidedAt !== null).length;
        if (!(subjectCount > 0 && decided === subjectCount)) {
            if (subjectCount === 0) {
                refuse('NO_SUBJECTS', 'this campaign has no subjects; a review over zero agents evidences nothing');
            }
            refuse('SUBJECTS_PENDING', `${subjectCount - decided} of ${subjectCount} agent subject(s) are undecided`);
        }

        const packCount = await db.accessReviewAgentPack.count({ where: { tenantId: ctx.tenantId, accessReviewId } });
        if (packCount !== subjectCount) {
            refuse('PACKS_NOT_PREPARED', `${packCount} of ${subjectCount} subject(s) have a reviewer pack`);
        }
        const pendingNarrowings = await db.accessReviewAgentNarrowing.count({
            where: { tenantId: ctx.tenantId, accessReviewId, outcome: 'PENDING' },
        });
        if (pendingNarrowings > 0) refuse('NARROWINGS_PENDING', `${pendingNarrowings} narrowing(s) are undecided`);

        // The claim, before any side effect: two concurrent closes both pass
        // the reads above, and only one matches a not-CLOSED row.
        const claim = await db.accessReview.updateMany({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null, status: { not: 'CLOSED' } },
            data: { status: 'CLOSED', closedAt: now, closedByUserId: ctx.userId },
        });
        if (claim.count === 0) refuse('CAMPAIGN_CLOSED', 'another close won');

        let remediationTasks = 0;
        for (const d of decisions) { // guardrail-allow: n+1 — writes only, bounded by the campaign's subjects
            if (d.executedAt) continue;
            if (d.decision === 'REVOKE' || d.decision === 'MODIFY') {
                await db.task.create({
                    data: {
                        tenantId: ctx.tenantId,
                        title: `Recertification: ${d.decision} ${d.subjectRef}`.slice(0, 250),
                        description: remediationDescription({
                            scope: 'AGENT',
                            reviewName: review.name,
                            decision: d.decision,
                            subjectRef: d.subjectRef,
                        }),
                        createdByUserId: ctx.userId,
                        source: 'MANUAL',
                    },
                });
                remediationTasks += 1;
            }
        }
        await db.accessReviewConnectedDecision.updateMany({
            where: { tenantId: ctx.tenantId, accessReviewId, executedAt: null },
            data: { executedAt: now, executedByUserId: ctx.userId },
        });

        // ── The sample, through the existing keyed sampler ───────────────
        //
        // Over every decision of the campaign (all of them are decided — the
        // guard above), keyed per tenant and epoch-bound to THIS campaign, so
        // nobody deciding a subject can know whether it will be drawn. At least
        // one, whenever there is anything to draw from.
        const seed = options.seed ?? deriveSubkey(`${SAMPLE_SEED_PURPOSE}:${ctx.tenantId}`).toString('hex');
        const epoch = `${accessReviewId}@${samplingEpochFor(now)}`;
        const drawn = selectSample(
            decisions.map((d) => ({ id: d.id })),
            { seed, epoch, count: sampleSizeFor(decisions.length) },
        );
        await db.accessReviewDecisionSampleAudit.createMany({
            data: drawn.map((d) => ({
                tenantId: ctx.tenantId,
                accessReviewId,
                decisionId: d.id,
                samplingEpoch: epoch,
                sampledAt: now,
                assignedToUserId: null,
            })),
            skipDuplicates: true,
        });

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_CLOSED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            detailsJson: {
                category: 'status_change',
                entityName: 'AccessReview',
                fromStatus: review.status,
                toStatus: 'CLOSED',
                summary: `Closed agent recertification "${review.name}" — ${subjectCount} subject(s), `
                    + `${remediationTasks} remediation task(s), ${drawn.length} decision(s) sampled for a second review`,
                after: {
                    scope: 'AGENT',
                    subjectCount,
                    remediationTasks,
                    sampledDecisionIds: drawn.map((d) => d.id),
                    samplingEpoch: epoch,
                },
            },
        });

        return { subjectCount, remediationTasks, sampled: drawn.length };
    });

    const result: { -readonly [K in keyof CloseAgentResult]: CloseAgentResult[K] } = {
        accessReviewId,
        subjectCount: phase1.subjectCount,
        remediationTasks: phase1.remediationTasks,
        sampled: phase1.sampled,
        contentHash: null,
        evidenceFileRecordId: null,
    };

    // ── Phase 2 — the evidence, from the committed rows ──────────────────
    try {
        const { document, controlIds } = await runInTenantContext(ctx, async (db) => {
            const { rows } = await evidenceRowsOf(db, ctx, accessReviewId);
            return { document: buildAgentCampaignEvidence(rows), controlIds: await resolveEvidenceControls(db, ctx) };
        });
        const bytes = agentCampaignEvidenceBytes(document);
        const contentHash = agentCampaignEvidenceHash(document);
        const fileName = `agent_recertification_${accessReviewId}_${now.toISOString().slice(0, 10)}.json`;
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(ctx.tenantId, 'evidence', fileName);
        const written = await storage.write(pathKey, Readable.from(Buffer.from(bytes, 'utf8')), { mimeType: 'application/json' });
        if (written.sha256 !== contentHash) {
            throw internal(`stored evidence hashes to ${written.sha256}, not ${contentHash}`);
        }

        const fileRecordId = await runInTenantContext(ctx, async (db) => {
            const record = await db.fileRecord.create({
                data: {
                    tenantId: ctx.tenantId,
                    pathKey,
                    originalName: fileName,
                    mimeType: 'application/json',
                    sizeBytes: written.sizeBytes,
                    sha256: written.sha256,
                    status: 'STORED',
                    uploadedByUserId: ctx.userId,
                    storedAt: new Date(),
                    storageProvider: storage.name,
                    domain: 'evidence',
                    scanStatus: 'SKIPPED',
                },
            });
            // The evidence column only, and only once: the close stamp was
            // written by phase 1 and is part of what the evidence hashes.
            await db.accessReview.updateMany({
                where: { id: accessReviewId, tenantId: ctx.tenantId, evidenceFileRecordId: null },
                data: { evidenceFileRecordId: record.id },
            });
            const evidence = await db.evidence.create({
                data: {
                    tenantId: ctx.tenantId,
                    type: 'FILE',
                    title: `Agent recertification evidence — ${document.campaign.name}`.slice(0, 200),
                    fileRecordId: record.id,
                    fileName,
                    fileSize: written.sizeBytes,
                    category: 'access-review',
                    status: 'SUBMITTED',
                    ownerUserId: ctx.userId,
                    dateCollected: now,
                },
            });
            if (controlIds.length > 0) {
                await db.evidenceControlLink.createMany({
                    data: controlIds.map((controlId) => ({ tenantId: ctx.tenantId, evidenceId: evidence.id, controlId })),
                    skipDuplicates: true,
                });
            }
            await logEvent(db, ctx, {
                action: 'ACCESS_REVIEW_EVIDENCE_GENERATED',
                entityType: 'AccessReview',
                entityId: accessReviewId,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'FileRecord',
                    operation: 'create',
                    summary: `Generated agent recertification evidence (sha256=${contentHash})`,
                    after: {
                        fileRecordId: record.id,
                        evidenceId: evidence.id,
                        contentHash,
                        schema: document.schema,
                        controlsLinked: controlIds.length,
                    },
                },
            });
            return record.id;
        });
        result.contentHash = contentHash;
        result.evidenceFileRecordId = fileRecordId;
    } catch (err) {
        logger.error('access-review.agent_closeout.evidence_failed', {
            component: 'access-review',
            accessReviewId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return result;
}

// ── The second human ─────────────────────────────────────────────────────

export const RecordAgentSampleOutcomeSchema = z.object({
    outcome: z.enum(['CONCURRED', 'DISSENTED', 'INDETERMINATE']),
    dissentCodes: z.array(z.enum(RECERT_SAMPLE_DISSENT_CODES)).optional(),
});

/**
 * Answer one sampled decision.
 *
 * Refused, in order: not found (or in another campaign); not an AGENT
 * campaign; a caller who may not read the pack (neither the reviewer nor a
 * holder of `admin.agent_registry`); the caller DECIDED the sampled subject, or
 * OWNS the agent (frozen or current) — 403 and AUTHZ_DENIED, because a second
 * review by the first reviewer, or by the person whose agent it is, measures
 * nothing; already answered; dissent without codes, or codes without dissent.
 */
export async function recordAgentDecisionSampleOutcome(
    ctx: RequestContext,
    accessReviewId: string,
    sampleId: string,
    input: unknown,
    now: Date = new Date(),
) {
    assertCanRead(ctx);
    assertAgentCampaignsAvailable('decide');
    const parsed = RecordAgentSampleOutcomeSchema.parse(input);
    return runInTenantContext(ctx, async (db) => {
        const sample = await db.accessReviewDecisionSampleAudit.findFirst({
            where: { id: sampleId, tenantId: ctx.tenantId, accessReviewId },
            select: {
                id: true, outcome: true, accessReviewId: true,
                accessReview: { select: { scope: true, reviewerUserId: true } },
                decision: { select: { id: true, decidedByUserId: true, subjectOwnerUserId: true, subjectAgentId: true } },
            },
        });
        if (!sample) throw notFound('Sample not found');
        if (sample.accessReview.scope !== 'AGENT') refuse('NOT_AN_AGENT_CAMPAIGN', 'this sample is not in an agent campaign');
        // The second human reads the pack to judge the decision, and a pack is
        // register data: the same narrowing as the pack read.
        if (!mayReadAgentSubjects({ userId: ctx.userId, reviewerUserId: sample.accessReview.reviewerUserId, holdsAgentRegistry: holdsRegistry(ctx) })) {
            throw forbidden('A sampled agent decision is answered by the campaign’s reviewer or a holder of admin.agent_registry');
        }
        if (sample.decision.decidedByUserId === ctx.userId) {
            await refuseOwner(ctx, 'AccessReviewDecisionSampleAudit', sampleId, 'sample_audit_self_review');
        }
        if (await ownsAgent(db, ctx, sample.decision.subjectOwnerUserId, sample.decision.subjectAgentId)) {
            await refuseOwner(ctx, 'AccessReviewDecisionSampleAudit', sampleId, 'agent_owner_cannot_review');
        }
        if (sample.outcome !== 'PENDING') throw badRequest(`Sample is already ${sample.outcome}`);
        const codes = [...new Set(parsed.dissentCodes ?? [])];
        if (parsed.outcome === 'DISSENTED' && codes.length === 0) throw badRequest('A DISSENTED sample must name at least one dissent code');
        if (parsed.outcome !== 'DISSENTED' && codes.length > 0) throw badRequest('Dissent codes belong only to a DISSENTED sample');

        const claim = await db.accessReviewDecisionSampleAudit.updateMany({
            where: { id: sampleId, tenantId: ctx.tenantId, outcome: 'PENDING' },
            data: { outcome: parsed.outcome, dissentCodes: codes, reviewedByUserId: ctx.userId, reviewedAt: now },
        });
        if (claim.count === 0) throw badRequest('Sample is no longer pending');

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_DECISION_SAMPLE_RECORDED',
            entityType: 'AccessReviewDecisionSampleAudit',
            entityId: sampleId,
            detailsJson: {
                category: 'access',
                entityName: 'AccessReviewDecisionSampleAudit',
                operation: 'review',
                summary: `Second review of a sampled agent decision: ${parsed.outcome}`,
                after: {
                    accessReviewId: sample.accessReviewId,
                    decisionId: sample.decision.id,
                    outcome: parsed.outcome,
                    dissentCodes: codes,
                },
            },
        });
        return { sampleId, outcome: parsed.outcome };
    });
}
