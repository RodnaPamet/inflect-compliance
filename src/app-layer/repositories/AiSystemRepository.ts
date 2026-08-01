/**
 * EU AI Act AI-System Registry — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS). All
 * writes run inside `runInTenantContext` at the usecase layer, so `db` here is
 * always the tenant-bound client.
 */
import { Prisma, AiRiskTier, AiSystemStatus } from '@prisma/client';
import type { AiDeploymentRole } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { parseEnumListFilter } from '../domain/list-filter';

const listSelect = {
    id: true,
    tenantId: true,
    name: true,
    provider: true,
    deploymentRole: true,
    riskTier: true,
    classificationClauseId: true,
    status: true,
    ownerUserId: true,
    createdAt: true,
    _count: { select: { requirementLinks: true } },
} as const satisfies Prisma.AiSystemSelect;

const detailInclude = {
    requirementLinks: {
        select: {
            id: true,
            requirementId: true,
            requirement: {
                select: {
                    id: true,
                    code: true,
                    title: true,
                    framework: { select: { key: true, name: true } },
                },
            },
        },
        orderBy: { createdAt: 'asc' },
    },
} as const satisfies Prisma.AiSystemInclude;

export class AiSystemRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; riskTier?: string; status?: string } = {},
    ) {
        return db.aiSystem.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                // Both filters are raw `?riskTier=` / `?status=` query-string
                // values. `riskTier` used to be typed `AiRiskTier` here while
                // the route `as`-cast a bare string into it — the cast moved
                // the same bug one layer up, out of this file's ratchet.
                // Prisma still rejects an unknown or comma-joined value with
                // a validation error (a 500). Same class as /risks?status=ACTIVE.
                riskTier: parseEnumListFilter<AiRiskTier>(
                    options.riskTier,
                    Object.values(AiRiskTier),
                    'AI risk tier',
                ),
                status: parseEnumListFilter<AiSystemStatus>(
                    options.status,
                    Object.values(AiSystemStatus),
                    'AI system status',
                ),
            },
            select: listSelect,
            orderBy: [{ riskTier: 'asc' }, { createdAt: 'desc' }],
            take: options.take ?? 200,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.aiSystem.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: detailInclude,
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            name: string;
            purpose: string | null;
            useContext: string | null;
            provider: string | null;
            deploymentRole: AiDeploymentRole;
            riskTier: AiRiskTier;
            classificationClauseId: string;
            classificationRationale: string;
            ownerUserId: string | null;
        },
    ) {
        return db.aiSystem.create({
            data: {
                tenantId: ctx.tenantId,
                createdByUserId: ctx.userId,
                ...data,
            },
            select: { id: true, riskTier: true, classificationClauseId: true },
        });
    }

    /**
     * Link an AI system to framework requirements, idempotently. Returns the
     * count of NEW links created. Requirement ids MUST already be validated as
     * belonging to the AI-Act / ISO 42001 library (the usecase resolves them).
     */
    static async linkRequirements(
        db: PrismaTx,
        ctx: RequestContext,
        aiSystemId: string,
        requirementIds: string[],
    ): Promise<number> {
        let created = 0;
        for (const requirementId of requirementIds) {
            try {
                await db.aiSystemRequirementLink.create({
                    data: { tenantId: ctx.tenantId, aiSystemId, requirementId },
                });
                created++;
            } catch {
                // @@unique([aiSystemId, requirementId]) violation → already linked.
            }
        }
        return created;
    }
}
