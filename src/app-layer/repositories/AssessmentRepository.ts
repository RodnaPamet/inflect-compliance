import { PrismaTx } from '@/lib/db-context';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { AssessmentStatus, VendorCriticality } from '@prisma/client';

export class QuestionnaireRepository {
    static async listTemplates(db: PrismaTx) {
        return db.questionnaireTemplate.findMany({
            where: { isGlobal: true },
            orderBy: { name: 'asc' },
            include: { _count: { select: { questions: true } } },
        });
    }

    static async getByKey(db: PrismaTx, key: string) {
        return db.questionnaireTemplate.findUnique({
            where: { key },
            include: {
                questions: { orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] },
            },
        });
    }
}

export class VendorAssessmentRepository {
    static async listByVendor(db: PrismaTx, ctx: RequestContext, vendorId: string) {
        return db.vendorAssessment.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            orderBy: { createdAt: 'desc' },
            include: {
                template: { select: { key: true, name: true } },
                requestedBy: { select: { id: true, name: true } },
                decidedBy: { select: { id: true, name: true } },
                _count: { select: { answers: true } },
            },
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, assessmentId: string) {
        return db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            include: {
                template: { include: { questions: { orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] } } },
                requestedBy: { select: { id: true, name: true } },
                decidedBy: { select: { id: true, name: true } },
                answers: true,
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, vendorId: string, templateId: string) {
        return db.vendorAssessment.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId,
                templateId,
                requestedByUserId: ctx.userId,
                status: 'DRAFT',
                startedAt: new Date(),
            },
            include: {
                template: { select: { key: true, name: true } },
                requestedBy: { select: { id: true, name: true } },
            },
        });
    }

    static async submit(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await db.vendorAssessment.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        if (existing.status !== 'DRAFT') return null;

        return db.vendorAssessment.update({
            where: { id },
            data: { status: 'IN_REVIEW', submittedAt: new Date() },
        });
    }

    static async decide(db: PrismaTx, ctx: RequestContext, id: string, decision: string, notes?: string | null) {
        const existing = await db.vendorAssessment.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        if (existing.status !== 'IN_REVIEW') return null;

        return db.vendorAssessment.update({
            where: { id },
            data: {
                status: decision as AssessmentStatus,
                decidedAt: new Date(),
                decidedByUserId: ctx.userId,
                notes: notes || null,
            },
        });
    }

    static async updateScore(db: PrismaTx, id: string, score: number, riskRating: string) {
        return db.vendorAssessment.update({
            where: { id },
            data: { score, riskRating: riskRating as VendorCriticality },
        });
    }
}
