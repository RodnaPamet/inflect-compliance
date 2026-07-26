import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, ChecklistResult } from '@prisma/client';

// PR-3 — tight SELECT shape for the Audits master/detail list. Master
// list renders id/title/status + the two _count badges; detail pane
// fetches the heavier shape via getById.
const auditListSelect = {
    id: true,
    title: true,
    status: true,
    _count: { select: { checklist: true, findings: true } },
} as const;

export class AuditRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; auditCycleId?: string } = {},
    ) {
        return db.audit.findMany({
            where: {
                tenantId: ctx.tenantId,
                // feat/audit-cycle-unify — optional filter to the audits
                // that are fieldwork within a given cycle.
                ...(options.auditCycleId ? { auditCycleId: options.auditCycleId } : {}),
            },
            orderBy: { createdAt: 'desc' },
            select: auditListSelect,
            // Bounded by default — the legacy /api/audits route calls this
            // with no `take`, which would otherwise be an unbounded findMany.
            take: options.take ?? 500,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.audit.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                checklist: { orderBy: { sortOrder: 'asc' } },
                findings: { orderBy: { createdAt: 'desc' } },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.AuditUncheckedCreateInput, 'tenantId'>) {
        return db.audit.create({
            data: {
                ...data,
                tenantId: ctx.tenantId,
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.AuditUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.audit.update({
            where: { id },
            data,
        });
    }

    static async createChecklistItem(db: PrismaTx, ctx: RequestContext, auditId: string, prompt: string, sortOrder: number) {
        return db.auditChecklistItem.create({
            data: {
                tenantId: ctx.tenantId,
                auditId,
                prompt,
                sortOrder,
            },
        });
    }


    static async updateChecklistItem(
        db: PrismaTx,
        ctx: RequestContext,
        itemId: string,
        auditId: string,
        data: { result?: string | null; notes?: string | null },
    ) {
        // Tenant + audit scoped write. AuditChecklistItem has no
        // @@unique([id, tenantId]) compound (only `id` is unique), so we
        // cannot narrow a `.update` where by tenant/audit — `updateMany`
        // is the only way to bind the write to (id, tenantId, auditId).
        // Without this, `where: { id }` alone let a caller update a
        // checklist item belonging to another audit (or tenant).
        const res = await db.auditChecklistItem.updateMany({
            where: { id: itemId, tenantId: ctx.tenantId, auditId },
            data: {
                // `result` maps to the non-null ChecklistResult enum column —
                // a null/absent input means "leave unchanged".
                result: data.result == null ? undefined : (data.result as ChecklistResult),
                notes: data.notes,
            },
        });
        // Exactly one row matches for a legitimate (tenant-owned, correct
        // audit) item; 0 means the id was foreign / mismatched and nothing
        // was written.
        return res.count === 1;
    }
}
