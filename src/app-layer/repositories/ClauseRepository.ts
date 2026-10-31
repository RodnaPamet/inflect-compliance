import prisma from '@/lib/prisma';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { getISO27001Clauses } from '@/app-layer/libraries';
import { ClauseStatus } from '@prisma/client';

export class ClauseRepository {
    static async list(db: PrismaTx, ctx: RequestContext) {
        const CLAUSES = getISO27001Clauses();
        // Clause is a global catalogue (no tenantId, no RLS), read through the
        // global prisma and seeded on first use: only the clauses that are
        // missing are inserted, and existing rows are never touched. This runs
        // inside the caller's tenant transaction, where every write is audited
        // into the tenant's hash-chained trail — an upsert per clause on every
        // call put one audit row per clause into the trail on each read, and
        // the appends were enough to overrun TENANT_TX_TIMEOUT_MS.
        const readCatalogue = () => prisma.clause.findMany({ orderBy: { sortOrder: 'asc' } });
        let clauses = await readCatalogue();
        const present = new Set(clauses.map((c) => c.number));
        const missing = CLAUSES.filter((c) => !present.has(c.number));
        if (missing.length > 0) {
            await prisma.clause.createMany({
                data: missing.map((c) => ({ number: c.number, title: c.title, description: c.description, artifacts: c.artifacts, sortOrder: parseInt(c.number) })),
                skipDuplicates: true,
            });
            clauses = await readCatalogue();
        }

        // ClauseProgress is tenant-scoped — read via tenant tx
        const progress = await db.clauseProgress.findMany({ where: { tenantId: ctx.tenantId } });

        return clauses.map((clause) => {
            const p = progress.find((pr) => pr.clauseId === clause.id);
            const clauseInfo = CLAUSES.find((c) => c.number === clause.number);
            return {
                ...clause,
                status: p?.status || 'NOT_STARTED',
                notes: p?.notes || '',
                checklist: clauseInfo?.checklist || [],
                progressId: p?.id,
            };
        });
    }

    /**
     * `notes` undefined leaves the stored notes alone. A status-only save used
     * to write `''` over them, so changing a clause's status erased its notes
     * (#4738).
     */
    static async updateProgress(db: PrismaTx, ctx: RequestContext, clauseId: string, data: { status: ClauseStatus; notes?: string | null }) {
        return db.clauseProgress.upsert({
            where: {
                tenantId_clauseId: { tenantId: ctx.tenantId, clauseId },
            },
            create: {
                tenantId: ctx.tenantId,
                clauseId,
                status: data.status,
                notes: data.notes ?? '',
            },
            update: {
                status: data.status,
                ...(data.notes !== undefined && { notes: data.notes ?? '' }),
            },
        });
    }
}
