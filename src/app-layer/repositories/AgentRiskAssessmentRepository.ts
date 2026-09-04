/**
 * Agent risk assessment — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS); all calls
 * run inside `runInTenantContext` at the usecase, so `db` is always the
 * tenant-bound client.
 *
 * The two GLOBAL reference reads (`listDomains` / `listQuestions`) live here too
 * and take no tenant predicate ON PURPOSE — `AgentAssessmentDomain` and
 * `AgentAssessmentQuestion` are shared library content with no `tenantId` and no
 * RLS, exactly like `AiGovDomain` / `AiGovQuestion`. Adding a tenant filter
 * would silently return nothing.
 */
import type { AgentDataAccessScope, AgentProvenance, AgentReversibility, AgentRiskTier, Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

/** Upper bound on rows any one read here can return. */
const MAX_DOMAINS = 100;
const MAX_QUESTIONS = 500;
const MAX_ANSWERS = 500;
const MAX_ASSESSMENTS = 200;

export interface AssessmentBasisFields {
    basisAutonomyLevel: number;
    basisDataAccessScope: AgentDataAccessScope;
    basisReversibility: AgentReversibility;
    basisProvenance: AgentProvenance;
    basisToolCount: number;
    basisModelRef: string | null;
}

export class AgentRiskAssessmentRepository {
    // ── Global reference content (no tenant predicate — see the header) ──

    static async listDomains(db: PrismaTx) {
        return db.agentAssessmentDomain.findMany({
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            take: MAX_DOMAINS,
        });
    }

    static async listQuestions(db: PrismaTx) {
        return db.agentAssessmentQuestion.findMany({
            orderBy: { id: 'asc' },
            take: MAX_QUESTIONS,
        });
    }

    // ── Tenant-scoped runs ──

    /** The agent's open run, if it has one. */
    static async findOpen(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentRiskAssessment.findFirst({
            where: {
                tenantId: ctx.tenantId,
                agentId,
                status: { in: ['DRAFT', 'IN_PROGRESS'] },
            },
            orderBy: { updatedAt: 'desc' },
        });
    }

    /** The agent's most recent COMPLETED run — the one whose tier is in force. */
    static async findLatestCompleted(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentRiskAssessment.findFirst({
            where: { tenantId: ctx.tenantId, agentId, status: 'COMPLETED' },
            orderBy: { completedAt: 'desc' },
        });
    }

    static async listForAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentRiskAssessment.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            orderBy: { createdAt: 'desc' },
            take: MAX_ASSESSMENTS,
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentRiskAssessment.create({
            data: {
                tenantId: ctx.tenantId,
                agentId,
                status: 'DRAFT',
                createdById: ctx.userId,
                staleTriggers: [],
            },
        });
    }

    static async listAnswers(db: PrismaTx, ctx: RequestContext, assessmentId: string) {
        return db.agentRiskAssessmentAnswer.findMany({
            where: { tenantId: ctx.tenantId, assessmentId },
            take: MAX_ANSWERS,
        });
    }

    static async upsertAnswer(
        db: PrismaTx,
        ctx: RequestContext,
        input: { assessmentId: string; questionId: string; answer: string; note: string | null },
    ) {
        return db.agentRiskAssessmentAnswer.upsert({
            where: {
                assessmentId_questionId: {
                    assessmentId: input.assessmentId,
                    questionId: input.questionId,
                },
            },
            update: {
                answer: input.answer,
                note: input.note,
                answeredById: ctx.userId,
                answeredAt: new Date(),
            },
            create: {
                tenantId: ctx.tenantId,
                assessmentId: input.assessmentId,
                questionId: input.questionId,
                answer: input.answer,
                note: input.note,
                answeredById: ctx.userId,
            },
        });
    }

    /**
     * Conditional status move — the `tenantId` predicate is part of the WHERE,
     * so a caller naming another tenant's run updates ZERO rows rather than
     * throwing, and the count is the evidence that the row was theirs.
     */
    static async setStatus(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: string,
    ): Promise<number> {
        const res = await db.agentRiskAssessment.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { status },
        });
        return res.count;
    }

    /** Record the score, the basis it was true of, and clear any staleness. */
    static async recordScore(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: AssessmentBasisFields & {
            scoredTier: AgentRiskTier;
            score: number;
            scoreBreakdownJson: Prisma.InputJsonValue;
        },
    ): Promise<number> {
        const res = await db.agentRiskAssessment.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: {
                ...data,
                status: 'COMPLETED',
                completedAt: new Date(),
                // A freshly scored run is fresh BY CONSTRUCTION: the basis it
                // just recorded is the live agent. Clearing both columns here
                // rather than leaving a previous run's staleness to be tidied
                // up later means "stale" is never a leftover.
                staleAt: null,
                staleTriggers: [],
            },
        });
        return res.count;
    }

    /** Stamp (or clear) staleness on one run. */
    static async setStaleness(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        stale: { staleAt: Date | null; triggers: string[] },
    ): Promise<number> {
        const res = await db.agentRiskAssessment.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { staleAt: stale.staleAt, staleTriggers: stale.triggers },
        });
        return res.count;
    }
}
