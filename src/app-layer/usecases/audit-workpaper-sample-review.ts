/**
 * INTERNAL AUDIT'S REVIEW OF A SAMPLED WORKPAPER — reading it, answering it,
 * and getting the number out (#3677, step 3d).
 *
 * The sweep (`jobs/audit-workpaper-sample-review.ts`) draws the auditor agent's
 * workpapers and assigns each to a member of internal audit. This module is
 * what that member uses to re-perform and answer, and what the governance pack
 * reads the agreement rate from. The draw and the assignment have no route and
 * no usecase here: a person cannot open a review on a workpaper of their
 * choosing, or choose who answers it.
 *
 * ── Who may read and answer ──────────────────────────────────────────
 *
 * The route takes `audits.view`, which every role holds — an internal auditor
 * is often on the AUDITOR role, which holds no `audits.manage`. So the narrowing
 * is here, and it is the same rule the sweep drew the reviewer by
 * (`isEligibleReviewer`), asked again at the moment of the request:
 *
 *   • a PERSON — a context speaking for an API key, an agent or a job is a 403
 *     (`NOT_A_PERSON`);
 *   • the ASSIGNED reviewer of that row, and nobody else;
 *   • still an ACTIVE member whose line of defence is THIRD;
 *   • not the auditor agent's CURRENT owner (ownership may have moved since the
 *     draw; whoever answers for the auditor today does not review its work).
 *
 * Each of the last three refusals is a 403 with a named `details.reason` and a
 * hash-chained `AUTHZ_DENIED` row: they are statements about who holds the
 * authority to answer, not about the request's shape. The database refuses the
 * same answerer below this (`audit_workpaper_sample_review_assert_reviewer`).
 *
 * ── Internal audit sees the whole queue, and sets the rate ───────────
 *
 * Owner decisions, 2026-10-19. "Internal audit" is one rule, `isInternalAudit`:
 * a person, an ACTIVE member whose line of defence is THIRD, who owns no agent
 * that is or has been the auditor. Such a member sees EVERY assignment in the
 * tenant and its status (the overview) and answers only their own; and only
 * such a member changes the sampling rate. Everybody else holding `audits.view`
 * sees their own assignments only. The auditor's owner never sees the overview
 * and never sets the rate, even on the third line: the second line operates
 * the auditor, and the check on it must not be steerable by whoever answers
 * for it.
 *
 * ── The answer is write-once ─────────────────────────────────────────
 *
 * CONCURRED, DISSENTED or INDETERMINATE, with stable dissent codes and no free
 * text. A conditional claim moves the row out of PENDING exactly once, and the
 * trigger refuses any later change. Answering also sets the workpaper's own
 * review stamp (3b), when nobody has set it yet.
 *
 * ── A dissent queues a finding proposal ──────────────────────────────
 *
 * Owner decision 4 (2026-10-19). Each DISSENTED review queues ONE finding
 * proposal for a person to decide, through the existing queue
 * (`createAgentProposal`) — the seam every proposal passes, a person's included
 * (the assistant and the AI-system conformity draft already raise theirs
 * through it). No Finding is written here and there is no second approval
 * path: the proposal is decided by `approveAgentProposal` like any other.
 *
 * It is raised under the reviewer's own session, not through the MCP tool
 * funnel as the auditor agent, deliberately. The dissent is internal audit's
 * judgement about the auditor; raising it as the auditor would attribute it to
 * the auditee, spend the auditor's budgets, and let the auditor's kill switch
 * or breaker stop the check on the auditor from reaching anybody. With no agent
 * and no key the queue's tiering reads it as `HUMAN_AUTHOR` (one approver) and
 * pins `NO_POLICY_CARD`.
 *
 * Exactly once per review, across retries and races: the raise takes a
 * per-review advisory lock, returns the proposal the row already links, and
 * otherwise looks for one an interrupted run already raised by its origin ref
 * (`proposedBySessionRef`, a plain column — the payload is encrypted) before
 * raising. If the raise fails after the answer committed, the answer stands
 * and the next sweep raises it (`healDissentProposals`).
 */
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { badRequest, ConflictError, forbidden, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import {
    dissentFindingProposal,
    dissentProposalOriginRef,
    effectiveSamplePercent,
    isEligibleReviewer,
    WORKPAPER_REVIEWER_LINE,
    workpaperReviewRate,
    type WorkpaperReviewRate,
    type WorkpaperReviewRefusal,
} from '@/lib/agentic/workpaper-review-sampling';
import { assertCanRead } from '../policies/common';
import { AuditWorkpaperRepository } from '../repositories/AuditWorkpaperRepository';
import { narrativeOfWorkpaper } from './audit-workpaper-narrative';
import {
    RecordWorkpaperReviewSchema,
    SetWorkpaperReviewSamplePercentSchema,
} from '../schemas/audit-workpaper-sample-review.schemas';
import type { RequestContext } from '../types';
import { createAgentProposal } from './agent-proposals';
import { stampWorkpaperReviewedInTx } from './audit-workpaper';
// MOVED, not copied (#3868 step 2): a second caller needed this predicate, and
// two copies of "is this a person" drift invisibly — both keep compiling and
// both keep passing their own tests, while one of them is wrong about whether
// an API key may act as a person.
import { isPersonContext } from '../request-context-kind';

/** The most rows one reviewer's list returns. Read one past it to know. */
export const REVIEW_LIST_CAP = 200;

/** The outer transaction of a raise holds while the queue's own transactions run. */
const RAISE_TX_TIMEOUT_MS = 30_000;

type ReviewerStanding =
    | { eligible: true; reason: null }
    | { eligible: false; reason: Extract<WorkpaperReviewRefusal, 'REVIEWER_NOT_ACTIVE_MEMBER' | 'REVIEWER_LINE_NOT_THIRD'> };

/** A person, holding `audits.view`. Everything else about who may answer is per row. */
function assertPersonWithAuditsView(ctx: RequestContext): void {
    assertCanRead(ctx);
    if (!isPersonContext(ctx)) {
        throw forbidden('A sampled workpaper is reviewed by a person, never by a credential, an agent or a job.', {
            reason: 'NOT_A_PERSON' satisfies WorkpaperReviewRefusal,
        });
    }
    if (ctx.appPermissions?.audits?.view !== true) {
        throw forbidden('You do not have permission to review audit workpapers.');
    }
}

async function denyReview(
    ctx: RequestContext,
    reviewId: string,
    reason: WorkpaperReviewRefusal,
    message: string,
    workpaperId: string | null,
): Promise<never> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AuditWorkpaperSampleReview',
        entityId: reviewId,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', event: 'authz_denied', reason, workpaperId },
        metadataJson: { role: ctx.role, reason },
    }).catch(() => undefined);
    throw forbidden(message, { reason });
}

function refuse(reason: WorkpaperReviewRefusal, message: string): never {
    throw new ConflictError(message, { reason });
}

/** The caller's standing in internal audit, read now. */
function standingOf(member: { status: string; lineOfDefence: string | null } | null): ReviewerStanding {
    if (!member || member.status !== 'ACTIVE') return { eligible: false, reason: 'REVIEWER_NOT_ACTIVE_MEMBER' };
    if (member.lineOfDefence !== WORKPAPER_REVIEWER_LINE) return { eligible: false, reason: 'REVIEWER_LINE_NOT_THIRD' };
    return { eligible: true, reason: null };
}

type Db = Parameters<Parameters<typeof runInTenantContext>[1]>[0];

/** Agents one person can own before "owns the auditor" stops being provable by one read. */
const OWNED_AGENT_READ_CAP = 200;

/**
 * Whether the caller owns an agent that IS the auditor or HAS BEEN one — marked
 * `isAuditor`, or the author of any workpaper in this tenant. The second half
 * matters: unmarking the auditor must not hand its owner the overview of the
 * workpapers it wrote. A caller who owns more agents than one read can show is
 * treated as an owner — the answer that cannot be proved fails closed.
 */
async function ownsAnAuditorAgent(db: Db, ctx: RequestContext): Promise<boolean> {
    const owned = await db.registeredAgent.findMany({
        where: { tenantId: ctx.tenantId, ownerUserId: ctx.userId },
        select: { id: true, isAuditor: true },
        orderBy: { id: 'asc' },
        take: OWNED_AGENT_READ_CAP + 1,
    });
    if (owned.length === 0) return false;
    if (owned.length > OWNED_AGENT_READ_CAP || owned.some((a) => a.isAuditor)) return true;
    const wrote = await db.auditWorkpaper.findFirst({
        where: { tenantId: ctx.tenantId, auditorAgentId: { in: owned.map((a) => a.id) } },
        select: { id: true },
    });
    return wrote !== null;
}

/**
 * The caller's standing as INTERNAL AUDIT — the one rule behind the overview
 * and the rate: an ACTIVE third-line member who owns no auditor agent. The
 * `refusal` names the first condition that fails, for the page and the 403.
 */
interface InternalAuditStanding {
    reviewer: ReviewerStanding;
    ownsAuditor: boolean;
    isInternalAudit: boolean;
    refusal: Extract<
        WorkpaperReviewRefusal,
        'REVIEWER_NOT_ACTIVE_MEMBER' | 'REVIEWER_LINE_NOT_THIRD' | 'REVIEWER_OWNS_AUDITOR'
    > | null;
}

async function readInternalAuditStanding(db: Db, ctx: RequestContext): Promise<InternalAuditStanding> {
    const [member, ownsAuditor] = await Promise.all([
        db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            select: { status: true, lineOfDefence: true },
        }),
        ownsAnAuditorAgent(db, ctx),
    ]);
    const reviewer = standingOf(member);
    const refusal = reviewer.eligible ? (ownsAuditor ? 'REVIEWER_OWNS_AUDITOR' : null) : reviewer.reason;
    return { reviewer, ownsAuditor, isInternalAudit: refusal === null, refusal };
}

const listSelect = {
    id: true,
    workpaperId: true,
    samplingEpoch: true,
    samplePercent: true,
    sampledAt: true,
    assignedToUserId: true,
    unassignedReason: true,
    assignedAt: true,
    outcome: true,
    dissentCodes: true,
    reviewedAt: true,
    findingProposalId: true,
    workpaper: {
        select: {
            procedureId: true,
            catalogueVersion: true,
            periodLabel: true,
            conclusion: true,
            conclusionBasis: true,
            populationCount: true,
            sampleSize: true,
            exceptionCount: true,
            auditorAgentId: true,
            createdAt: true,
        },
    },
} as const;

/**
 * Whose rows a list holds: `ALL` for internal audit (owner decision,
 * 2026-10-19 — every assignment and its status, answerable only where it is
 * the viewer's own), `OWN` for everybody else holding `audits.view`.
 */
export type WorkpaperReviewScope = 'ALL' | 'OWN';

/** The sampling rate as the page shows it, and whether this viewer may change it. */
export interface WorkpaperReviewSampleRateView {
    percent: number;
    canChange: boolean;
    /** Why not, when `canChange` is false. */
    refusal: WorkpaperReviewRefusal | null;
}

/**
 * The sampled workpapers this caller may see, oldest unanswered first — an
 * unanswered one is the failure mode, so the list leads with the one that has
 * waited longest.
 *
 *   • Internal audit (`isInternalAudit`) sees EVERY row in the tenant, with
 *     who it is assigned to; it answers only its own (`mine`).
 *   • Anybody else on the third line — the auditor's owner, in practice — sees
 *     only the rows assigned to them.
 *   • Somebody who is not an ACTIVE third-line member gets no rows and the
 *     reason, which the page shows instead of an empty queue that reads as
 *     "nothing to do".
 */
export async function listWorkpaperReviews(ctx: RequestContext) {
    assertPersonWithAuditsView(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [standing, settings] = await Promise.all([
            readInternalAuditStanding(db, ctx),
            db.tenantSecuritySettings.findFirst({
                where: { tenantId: ctx.tenantId },
                select: { workpaperReviewSamplePercent: true },
            }),
        ]);
        const { reviewer } = standing;
        const sampleRate: WorkpaperReviewSampleRateView = {
            percent: effectiveSamplePercent(settings?.workpaperReviewSamplePercent),
            canChange: standing.isInternalAudit,
            refusal: standing.refusal,
        };
        const scope: WorkpaperReviewScope = standing.isInternalAudit ? 'ALL' : 'OWN';
        if (!reviewer.eligible) return { reviewer, scope, sampleRate, rows: [], truncated: false };

        const rows = await db.auditWorkpaperSampleReview.findMany({
            where: { tenantId: ctx.tenantId, ...(scope === 'OWN' ? { assignedToUserId: ctx.userId } : {}) },
            // PENDING sorts first: the enum's declaration order is the column's.
            orderBy: [{ outcome: 'asc' }, { sampledAt: 'asc' }, { id: 'asc' }],
            select: listSelect,
            take: REVIEW_LIST_CAP + 1,
        });
        const shown = rows.slice(0, REVIEW_LIST_CAP);
        const auditorIds = [...new Set(shown.map((r) => r.workpaper.auditorAgentId))];
        const assigneeIds = [
            ...new Set(shown.map((r) => r.assignedToUserId).filter((id): id is string => id !== null)),
        ];
        const [owners, assignees] = await Promise.all([
            auditorIds.length === 0
                ? []
                : db.registeredAgent.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: auditorIds } },
                      select: { id: true, ownerUserId: true },
                      take: auditorIds.length,
                  }),
            assigneeIds.length === 0
                ? []
                : db.tenantMembership.findMany({
                      where: { tenantId: ctx.tenantId, userId: { in: assigneeIds } },
                      select: { userId: true, user: { select: { name: true, email: true } } },
                      take: assigneeIds.length,
                  }),
        ]);
        const ownerOf = new Map(owners.map((o) => [o.id, o.ownerUserId]));
        const nameOf = new Map(assignees.map((a) => [a.userId, a.user.name ?? a.user.email ?? a.userId]));
        return {
            reviewer,
            scope,
            sampleRate,
            truncated: rows.length > REVIEW_LIST_CAP,
            rows: shown.map((r) => {
                const mine = r.assignedToUserId === ctx.userId;
                const owner = ownerOf.get(r.workpaper.auditorAgentId) ?? null;
                // Answerable now — the same rule the answer path asks. A row
                // assigned before its reviewer came to own the auditor stays
                // listed and cannot be answered; the next sweep re-draws it.
                // Somebody else's row is never answerable here: the overview
                // is read-only.
                const refusal: WorkpaperReviewRefusal | null =
                    r.outcome !== 'PENDING'
                        ? 'ALREADY_REVIEWED'
                        : !mine
                          ? r.assignedToUserId === null
                              ? 'UNASSIGNED'
                              : 'NOT_ASSIGNED_REVIEWER'
                          : owner === null
                            ? 'AUDITOR_OWNER_UNKNOWN'
                            : owner === ctx.userId
                              ? 'REVIEWER_OWNS_AUDITOR'
                              : null;
                return {
                    ...r,
                    mine,
                    assignee: r.assignedToUserId
                        ? { userId: r.assignedToUserId, name: nameOf.get(r.assignedToUserId) ?? r.assignedToUserId }
                        : null,
                    answerable: refusal === null,
                    refusal,
                };
            }),
        };
    });
}

const reviewSelect = {
    id: true,
    workpaperId: true,
    samplingEpoch: true,
    samplePercent: true,
    seedFingerprint: true,
    sampledAt: true,
    assignedToUserId: true,
    unassignedReason: true,
    assignedAt: true,
    outcome: true,
    dissentCodes: true,
    reviewedAt: true,
    reviewedByUserId: true,
    findingProposalId: true,
    workpaper: { select: { auditorAgentId: true } },
} as const;

/** One row for internal audit's read-only overview. The caller has established who may. */
async function loadReadOnly(ctx: RequestContext, reviewId: string) {
    const review = await runInTenantContext(ctx, (db) =>
        db.auditWorkpaperSampleReview.findFirst({ where: { id: reviewId, tenantId: ctx.tenantId }, select: reviewSelect }),
    );
    if (!review) throw notFound('Sampled workpaper not found');
    return review;
}

/**
 * Load one row and run every check that decides whether this caller may read
 * or answer it, in a fixed order: the row exists here, it is assigned, it is
 * assigned to the caller, the caller is still in internal audit, and the caller
 * does not own the auditor. Authority refusals come before any state refusal,
 * so a refused attempt leaves its `AUTHZ_DENIED` row whatever state the review
 * is in.
 */
async function loadForReviewer(ctx: RequestContext, reviewId: string) {
    const loaded = await runInTenantContext(ctx, async (db) => {
        const review = await db.auditWorkpaperSampleReview.findFirst({
            where: { id: reviewId, tenantId: ctx.tenantId },
            select: reviewSelect,
        });
        if (!review) return null;
        const [member, auditor] = await Promise.all([
            db.tenantMembership.findFirst({
                where: { tenantId: ctx.tenantId, userId: ctx.userId },
                select: { userId: true, status: true, lineOfDefence: true },
            }),
            db.registeredAgent.findFirst({
                where: { tenantId: ctx.tenantId, id: review.workpaper.auditorAgentId },
                select: { ownerUserId: true },
            }),
        ]);
        return { review, member, auditorOwnerUserId: auditor?.ownerUserId ?? null };
    });
    if (!loaded) throw notFound('Sampled workpaper not found');
    const { review, member, auditorOwnerUserId } = loaded;

    if (review.assignedToUserId === null) {
        refuse(
            'UNASSIGNED',
            `Nobody can be asked to review this workpaper yet (${review.unassignedReason}). The next sweep ` +
                'assigns it once a third-line member who does not own the auditor agent exists.',
        );
    }
    if (review.assignedToUserId !== ctx.userId) {
        await denyReview(ctx, review.id, 'NOT_ASSIGNED_REVIEWER', 'This sampled workpaper is assigned to another reviewer.', review.workpaperId);
    }
    const standing = standingOf(member);
    if (!standing.eligible) {
        await denyReview(
            ctx,
            review.id,
            standing.reason,
            standing.reason === 'REVIEWER_NOT_ACTIVE_MEMBER'
                ? 'Only an active member of this workspace reviews a sampled workpaper.'
                : 'A sampled workpaper is reviewed by internal audit: your line of defence is not THIRD.',
            review.workpaperId,
        );
    }
    if (auditorOwnerUserId === null) {
        // Not an authority refusal: nobody can answer this until it is
        // re-drawn, because an owner that cannot be read cannot be excluded.
        refuse(
            'AUDITOR_OWNER_UNKNOWN',
            'The auditor agent that wrote this workpaper is no longer in the register, so its owner cannot be ' +
                'excluded and nobody can answer it.',
        );
    }
    if (!isEligibleReviewer(member, auditorOwnerUserId)) {
        await denyReview(
            ctx,
            review.id,
            'REVIEWER_OWNS_AUDITOR',
            'The owner of the auditor agent never reviews its workpapers.',
            review.workpaperId,
        );
    }
    return review;
}

/** Whether the viewer of one review may answer it, and whose it is. */
export interface WorkpaperReviewViewer {
    mine: boolean;
    answerable: boolean;
    refusal: WorkpaperReviewRefusal | null;
}

/**
 * One review with the whole workpaper it is about — what the reviewer
 * re-performs. Its assignee reads it through every check the answer path runs
 * (`loadForReviewer`), so a read that would be refused as an answer is refused
 * as a read too. Internal audit reads anybody's row, READ-ONLY: `viewer`
 * says so, and the answer path still refuses it as `NOT_ASSIGNED_REVIEWER`.
 */
export async function getWorkpaperReview(ctx: RequestContext, reviewId: string) {
    assertPersonWithAuditsView(ctx);
    const overview = await runInTenantContext(ctx, async (db) => {
        const row = await db.auditWorkpaperSampleReview.findFirst({
            where: { id: reviewId, tenantId: ctx.tenantId },
            select: { assignedToUserId: true },
        });
        if (!row || row.assignedToUserId === ctx.userId) return null;
        return (await readInternalAuditStanding(db, ctx)).isInternalAudit;
    });

    let review: Awaited<ReturnType<typeof loadForReviewer>>;
    let viewer: WorkpaperReviewViewer;
    if (overview === true) {
        review = await loadReadOnly(ctx, reviewId);
        viewer = {
            mine: false,
            answerable: false,
            refusal:
                review.outcome !== 'PENDING'
                    ? 'ALREADY_REVIEWED'
                    : review.assignedToUserId === null
                      ? 'UNASSIGNED'
                      : 'NOT_ASSIGNED_REVIEWER',
        };
    } else {
        review = await loadForReviewer(ctx, reviewId);
        const pending = review.outcome === 'PENDING';
        viewer = { mine: true, answerable: pending, refusal: pending ? null : 'ALREADY_REVIEWED' };
    }
    const { workpaper, narrative } = await runInTenantContext(ctx, async (db) => ({
        workpaper: await AuditWorkpaperRepository.getById(db, ctx, review.workpaperId),
        // The auditor agent's narrative of it (#3749), when one is stored.
        narrative: await narrativeOfWorkpaper(db, ctx, review.workpaperId),
    }));
    if (!workpaper) throw notFound('Workpaper not found');
    return { review, workpaper, viewer, narrative };
}

export interface RecordWorkpaperReviewResult {
    id: string;
    outcome: 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE';
    /** Set on the workpaper by this answer, or false when somebody had already stamped it. */
    workpaperStamped: boolean;
    /** The finding proposal a DISSENTED answer queued; null otherwise. */
    findingProposal: { status: 'RAISED' | 'NOT_RAISED'; proposalId: string | null } | null;
}

/**
 * Answer one assigned review, once. See the module docstring for who may, and
 * for what a DISSENTED answer goes on to do.
 */
export async function recordWorkpaperReview(
    ctx: RequestContext,
    reviewId: string,
    input: unknown,
): Promise<RecordWorkpaperReviewResult> {
    assertPersonWithAuditsView(ctx);
    const parsed = RecordWorkpaperReviewSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest(`Invalid review answer: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const answer = parsed.data;
    const dissentCodes = answer.outcome === 'DISSENTED' ? [...(answer.dissentCodes ?? [])] : [];

    const review = await loadForReviewer(ctx, reviewId);
    if (review.outcome !== 'PENDING') {
        refuse('ALREADY_REVIEWED', `This sampled workpaper was already answered ${review.outcome}; an answer is set once.`);
    }

    const now = new Date();
    const workpaperStamped = await runInTenantContext(ctx, async (db) => {
        // The conditional claim: exactly one request moves the row out of
        // PENDING, and only for the assignee it was assigned to when read.
        const claim = await db.auditWorkpaperSampleReview.updateMany({
            where: { id: review.id, tenantId: ctx.tenantId, outcome: 'PENDING', assignedToUserId: ctx.userId },
            data: { outcome: answer.outcome, dissentCodes, reviewedByUserId: ctx.userId, reviewedAt: now },
        });
        if (claim.count === 0) {
            refuse('ALREADY_REVIEWED', 'This sampled workpaper was answered, or re-assigned, while this request was in flight.');
        }
        return stampWorkpaperReviewedInTx(db, ctx, review.workpaperId, now);
    });

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AuditWorkpaperSampleReview',
        entityId: review.id,
        action: 'AUDIT_WORKPAPER_SAMPLE_REVIEW_RECORDED',
        requestId: ctx.requestId,
        // Codes and ids only — the reason dissent is a vocabulary is that this
        // row can be shipped to a SIEM without carrying any of the workpaper.
        detailsJson: {
            category: 'access',
            workpaperId: review.workpaperId,
            samplingEpoch: review.samplingEpoch,
            outcome: answer.outcome,
            dissentCodes,
        },
        metadataJson: { workpaperId: review.workpaperId, outcome: answer.outcome },
    }).catch(() => undefined);

    let findingProposal: RecordWorkpaperReviewResult['findingProposal'] = null;
    if (answer.outcome === 'DISSENTED') {
        try {
            const raised = await raiseDissentFindingProposal(ctx, review.id);
            findingProposal = { status: raised.proposalId ? 'RAISED' : 'NOT_RAISED', proposalId: raised.proposalId };
        } catch (err) {
            // The answer stands; the next sweep raises what this could not.
            logger.warn('workpaper review: dissent finding proposal not raised; the next sweep raises it', {
                component: 'audit-workpaper-sample-review',
                tenantId: ctx.tenantId,
                reviewId: review.id,
                error: err instanceof Error ? err.name : 'unknown',
            });
            findingProposal = { status: 'NOT_RAISED', proposalId: null };
        }
    }

    return { id: review.id, outcome: answer.outcome, workpaperStamped, findingProposal };
}

export interface DissentProposalRaise {
    /** The review's finding proposal, or null when the review is not a dissent. */
    proposalId: string | null;
    /** Whether THIS call queued it (false: already linked, or recovered by its origin). */
    raised: boolean;
}

/**
 * Queue the ONE finding proposal a DISSENTED review raises, or return the one
 * it already raised. Safe to call any number of times, from the answer path
 * and from the sweep's heal, concurrently: the per-review advisory lock
 * serialises callers, the row's link answers a repeat, and the origin ref
 * answers a run interrupted between the raise and the link.
 *
 * `ctx` is whoever carries it: the reviewer's session on the answer path, the
 * sweep's system context on a heal. Either way the proposal names the
 * reviewer, the workpaper and the codes, and a person decides it.
 */
export async function raiseDissentFindingProposal(
    ctx: RequestContext,
    reviewId: string,
): Promise<DissentProposalRaise> {
    const origin = dissentProposalOriginRef(reviewId);
    return runInTenantContext(
        ctx,
        async (db) => {
            await db.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtext($1))`,
                `audit-workpaper-review-proposal:${ctx.tenantId}:${reviewId}`,
            );
            const review = await db.auditWorkpaperSampleReview.findFirst({
                where: { id: reviewId, tenantId: ctx.tenantId },
                select: {
                    id: true,
                    outcome: true,
                    dissentCodes: true,
                    reviewedByUserId: true,
                    samplingEpoch: true,
                    findingProposalId: true,
                    workpaper: {
                        select: {
                            id: true,
                            procedureId: true,
                            catalogueVersion: true,
                            periodLabel: true,
                            conclusion: true,
                            conclusionBasis: true,
                            auditorAgentId: true,
                        },
                    },
                },
            });
            if (!review || review.outcome !== 'DISSENTED' || !review.reviewedByUserId) {
                return { proposalId: null, raised: false };
            }
            if (review.findingProposalId) return { proposalId: review.findingProposalId, raised: false };

            // Raised by a run that stopped before linking it. A FINDING proposal
            // with this origin is this review's, whoever raised it.
            const earlier = await db.agentProposal.findFirst({
                where: { tenantId: ctx.tenantId, kind: 'FINDING', proposedBySessionRef: origin },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true },
            });

            let proposalId = earlier?.id ?? null;
            if (!proposalId) {
                const { payload, rationale } = dissentFindingProposal({
                    reviewId: review.id,
                    workpaperId: review.workpaper.id,
                    procedureId: review.workpaper.procedureId,
                    catalogueVersion: review.workpaper.catalogueVersion,
                    periodLabel: review.workpaper.periodLabel,
                    conclusion: review.workpaper.conclusion,
                    conclusionBasis: review.workpaper.conclusionBasis,
                    auditorAgentId: review.workpaper.auditorAgentId,
                    reviewerUserId: review.reviewedByUserId,
                    dissentCodes: review.dissentCodes,
                    samplingEpoch: review.samplingEpoch,
                });
                // Its own transaction, committed before the link below: the
                // queue's seam opens its own, and the lock this one holds keeps
                // a second caller out until the link lands.
                const created = await createAgentProposal(ctx, {
                    kind: 'FINDING',
                    payload,
                    rationale,
                    // No agent proposed this — the sentinel, not null: the
                    // question was asked and the answer was "none".
                    policyCardVersion: NO_POLICY_CARD,
                    proposedBySessionRef: origin,
                });
                proposalId = created.id;
            }

            const linked = await db.auditWorkpaperSampleReview.updateMany({
                where: { id: review.id, tenantId: ctx.tenantId, outcome: 'DISSENTED', findingProposalId: null },
                data: { findingProposalId: proposalId },
            });
            if (linked.count > 0) {
                await appendAuditEntry({
                    tenantId: ctx.tenantId,
                    userId: ctx.actorType === 'JOB' ? null : ctx.userId,
                    actorType: ctx.actorType === 'JOB' ? 'JOB' : 'USER',
                    entity: 'AuditWorkpaperSampleReview',
                    entityId: review.id,
                    action: 'AUDIT_WORKPAPER_SAMPLE_REVIEW_FINDING_PROPOSED',
                    requestId: ctx.requestId,
                    detailsJson: {
                        category: 'access',
                        workpaperId: review.workpaper.id,
                        proposalId,
                        reviewerUserId: review.reviewedByUserId,
                        dissentCodes: review.dissentCodes,
                        recoveredInterruptedRaise: earlier !== null,
                    },
                    metadataJson: { workpaperId: review.workpaper.id, proposalId },
                }).catch(() => undefined);
            }
            return { proposalId, raised: earlier === null };
        },
        { timeout: RAISE_TX_TIMEOUT_MS },
    );
}

export interface SetWorkpaperReviewSamplePercentResult {
    samplePercent: number;
    previous: number;
    /** False when the rate already was the value asked for: nothing written, nothing audited. */
    changed: boolean;
}

/**
 * Change the share of the auditor agent's workpapers internal audit draws —
 * `TenantSecuritySettings.workpaperReviewSamplePercent`, read by the next
 * sweep. Owner decision, 2026-10-19: ONLY INTERNAL AUDIT changes it — a person,
 * an ACTIVE third-line member, who owns no auditor agent. The second line runs
 * the auditor; if it could lower the rate it would be choosing how closely its
 * own agent is checked. Every refusal is a 403 with a named reason and an
 * `AUTHZ_DENIED` row; the change is audited with the rate before and after.
 *
 * A lowered rate draws fewer of the workpapers the sweep has not decided yet
 * and un-draws nothing; a raised one draws, on the next sweep, the not-yet-drawn
 * workpapers of the lookback window that the higher rate now selects. Every row
 * keeps the rate it was drawn at, so each re-derives from its own.
 */
export async function setWorkpaperReviewSamplePercent(
    ctx: RequestContext,
    input: unknown,
): Promise<SetWorkpaperReviewSamplePercentResult> {
    assertCanRead(ctx);
    if (!isPersonContext(ctx)) {
        await denySampleRate(ctx, 'NOT_A_PERSON', 'Internal audit’s sampling rate is set by a person, never by a credential, an agent or a job.');
    }
    // Authority before shape: a refused caller leaves its AUTHZ_DENIED row
    // whatever it sent.
    const standing = await runInTenantContext(ctx, (db) => readInternalAuditStanding(db, ctx));
    if (!standing.isInternalAudit) await denySampleRateFor(ctx, standing.refusal ?? 'REVIEWER_LINE_NOT_THIRD');

    const parsed = SetWorkpaperReviewSamplePercentSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest(`Invalid sampling rate: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const next = parsed.data.samplePercent;

    const outcome = await runInTenantContext(ctx, async (db) => {
        // One change at a time per tenant, so `previous` is the value this
        // change replaced and two concurrent changes audit a true chain.
        await db.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `audit-workpaper-review-sample-rate:${ctx.tenantId}`,
        );
        // Asked again under the lock: the standing read above is a moment ago.
        const now = await readInternalAuditStanding(db, ctx);
        if (!now.isInternalAudit) {
            return { kind: 'REFUSED', refused: now.refusal ?? 'REVIEWER_LINE_NOT_THIRD' } as const;
        }
        const settings = await db.tenantSecuritySettings.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { workpaperReviewSamplePercent: true },
        });
        const previous = effectiveSamplePercent(settings?.workpaperReviewSamplePercent);
        if (previous === next && settings !== null) return { kind: 'DONE', previous, changed: false } as const;
        await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, workpaperReviewSamplePercent: next },
            update: { workpaperReviewSamplePercent: next },
        });
        return { kind: 'DONE', previous, changed: previous !== next } as const;
    });

    if (outcome.kind === 'REFUSED') return denySampleRateFor(ctx, outcome.refused);
    if (!outcome.changed) return { samplePercent: next, previous: outcome.previous, changed: false };

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'TenantSecuritySettings',
        entityId: ctx.tenantId,
        action: 'AUDIT_WORKPAPER_REVIEW_SAMPLE_RATE_CHANGED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            setting: 'workpaperReviewSamplePercent',
            before: outcome.previous,
            after: next,
        },
        metadataJson: { before: outcome.previous, after: next },
    }).catch(() => undefined);
    logger.info('workpaper review: sampling rate changed', {
        component: 'audit-workpaper-sample-review',
        tenantId: ctx.tenantId,
        before: outcome.previous,
        after: next,
    });
    return { samplePercent: next, previous: outcome.previous, changed: true };
}

function denySampleRateFor(
    ctx: RequestContext,
    reason: NonNullable<InternalAuditStanding['refusal']>,
): Promise<never> {
    return denySampleRate(
        ctx,
        reason,
        reason === 'REVIEWER_OWNS_AUDITOR'
            ? 'The owner of the auditor agent never sets how closely internal audit checks it.'
            : reason === 'REVIEWER_NOT_ACTIVE_MEMBER'
              ? 'Only an active member of this workspace sets internal audit’s sampling rate.'
              : 'Internal audit’s sampling rate is set by internal audit: your line of defence is not THIRD.',
    );
}

async function denySampleRate(ctx: RequestContext, reason: WorkpaperReviewRefusal, message: string): Promise<never> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : ctx.actorType === 'JOB' ? 'JOB' : 'USER',
        entity: 'TenantSecuritySettings',
        entityId: ctx.tenantId,
        action: 'AUTHZ_DENIED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            event: 'authz_denied',
            reason,
            attemptedAction: 'set_workpaper_review_sample_percent',
        },
        metadataJson: { role: ctx.role, reason, apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);
    throw forbidden(message, { reason });
}

/**
 * THE NUMBER, for the governance pack: re-performance agreement over the
 * reviews drawn inside the window. `workpaperReviewRate` holds the rule — a
 * drawn but unreviewed workpaper counts toward nothing, INDETERMINATE and
 * UNASSIGNED are excluded and returned beside the rate, and no concluded
 * review means no rate.
 */
export async function getWorkpaperReviewRate(
    ctx: RequestContext,
    opts: { sinceDays?: number } = {},
): Promise<WorkpaperReviewRate> {
    assertCanRead(ctx);
    const since = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * 86_400_000) : undefined;
    const grouped = await runInTenantContext(ctx, (db) =>
        db.auditWorkpaperSampleReview.groupBy({
            by: ['outcome', 'unassignedReason'],
            where: { tenantId: ctx.tenantId, ...(since ? { sampledAt: { gte: since } } : {}) },
            _count: { _all: true },
        }),
    );
    const count = (pred: (g: (typeof grouped)[number]) => boolean) =>
        grouped.filter(pred).reduce((n, g) => n + g._count._all, 0);
    return workpaperReviewRate({
        drawn: count(() => true),
        unassigned: count((g) => g.outcome === 'PENDING' && g.unassignedReason !== null),
        awaiting: count((g) => g.outcome === 'PENDING' && g.unassignedReason === null),
        concurred: count((g) => g.outcome === 'CONCURRED'),
        dissented: count((g) => g.outcome === 'DISSENTED'),
        indeterminate: count((g) => g.outcome === 'INDETERMINATE'),
    });
}
