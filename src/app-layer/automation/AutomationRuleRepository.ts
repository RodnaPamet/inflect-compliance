import { Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { badRequest } from '@/lib/errors/types';
import type {
    AutomationRuleListFilters,
    CreateAutomationRuleInput,
    UpdateAutomationRuleInput,
} from './types';

/**
 * Tenant-scoped CRUD for AutomationRule.
 *
 * Two shapes of mutation, both append-only from an audit-log POV:
 *   - `create` / `update` — rule config lifecycle.
 *   - `archive` — soft-delete. Archived rules stop firing but the
 *     execution history survives; if a tenant wants to re-use the name
 *     they must hard-delete the archived row first (the DB unique
 *     constraint is tenant+name, not tenant+name+live).
 *
 * Every query filters by `ctx.tenantId`. The Postgres RLS policy
 * enforces the same invariant as belt-and-braces.
 */
export class AutomationRuleRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: AutomationRuleListFilters = {}
    ) {
        const where = AutomationRuleRepository.buildWhere(ctx, filters);
        return db.automationRule.findMany({
            where,
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.automationRule.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
    }

    /**
     * Dispatcher hot path: find enabled rules that subscribe to a given
     * event, highest priority first. Soft-deleted rules are always
     * excluded here even though `deletedAt` is already orthogonal to
     * status — defence in depth.
     */
    static async findEnabledForEvent(
        db: PrismaTx,
        ctx: RequestContext,
        event: string
    ) {
        return db.automationRule.findMany({
            where: {
                tenantId: ctx.tenantId,
                triggerEvent: event,
                status: 'ENABLED',
                deletedAt: null,
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        input: CreateAutomationRuleInput
    ) {
        // Verify chain link targets belong to THIS tenant before writing them.
        //
        // `create` writes `nextRuleId`/`elseRuleId` as RAW FK SCALARS, and
        // PostgreSQL evaluates foreign-key checks with row security bypassed —
        // so a cross-tenant id satisfies the constraint and PERSISTS. Runtime
        // re-scoping in `rule-chain-dispatch` stops it firing, but the stored
        // row is still an existence oracle for another tenant's rule ids.
        //
        // `update` does NOT share this hole: it uses `connect`, which runs
        // under the tenant-bound role and rejects a foreign id as P2025. That
        // asymmetry is why the guard lives here and `update` is left alone.
        const linkTargets = [
            ['nextRuleId', input.nextRuleId],
            ['elseRuleId', input.elseRuleId],
        ] as const;
        const linkIds = linkTargets
            .map(([, id]) => id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (linkIds.length > 0) {
            // ONE query for both fields — a per-field lookup would be an N+1
            // (and the query-shape ratchet rightly rejects reads inside loops).
            const found = await db.automationRule.findMany({
                where: { id: { in: linkIds }, tenantId: ctx.tenantId },
                select: { id: true },
            });
            const ok = new Set(found.map((r: { id: string }) => r.id));
            for (const [field, id] of linkTargets) {
                if (id && !ok.has(id)) {
                    throw badRequest(`${field} does not reference a rule in this tenant`);
                }
            }
        }

        return db.automationRule.create({
            data: {
                tenantId: ctx.tenantId,
                name: input.name,
                description: input.description ?? null,
                triggerEvent: input.triggerEvent,
                triggerFilterJson:
                    input.triggerFilter
                        ? (input.triggerFilter as unknown as Prisma.InputJsonValue)
                        : Prisma.JsonNull,
                actionType: input.actionType,
                actionConfigJson: input.actionConfig as unknown as Prisma.InputJsonValue,
                status: input.status ?? 'DRAFT',
                priority: input.priority ?? 0,
                slaWindowMinutes: input.slaWindowMinutes ?? null,
                slaBreachActionType: input.slaBreachActionType ?? null,
                slaBreachConfigJson: input.slaBreachConfig
                    ? (input.slaBreachConfig as Prisma.InputJsonValue)
                    : Prisma.JsonNull,
                nextRuleId: input.nextRuleId ?? null,
                nextRuleDelay: input.nextRuleDelay ?? null,
                elseRuleId: input.elseRuleId ?? null,
                scheduleConfigJson: input.scheduleConfig
                    ? (input.scheduleConfig as Prisma.InputJsonValue)
                    : Prisma.JsonNull,
                createdByUserId: ctx.userId,
                updatedByUserId: ctx.userId,
            },
        });
    }

    static async update(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        input: UpdateAutomationRuleInput
    ) {
        const existing = await db.automationRule.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing) return null;

        const data: Prisma.AutomationRuleUpdateInput = {
            updatedByUserId: ctx.userId,
        };
        if (input.name !== undefined) data.name = input.name;
        if (input.description !== undefined) data.description = input.description;
        if (input.triggerEvent !== undefined) data.triggerEvent = input.triggerEvent;
        if (input.triggerFilter !== undefined) {
            data.triggerFilterJson =
                input.triggerFilter === null
                    ? Prisma.JsonNull
                    : (input.triggerFilter as unknown as Prisma.InputJsonValue);
        }
        if (input.actionType !== undefined) data.actionType = input.actionType;
        if (input.actionConfig !== undefined) {
            data.actionConfigJson =
                input.actionConfig as unknown as Prisma.InputJsonValue;
        }
        if (input.status !== undefined) data.status = input.status;
        if (input.priority !== undefined) data.priority = input.priority;
        if (input.slaWindowMinutes !== undefined) data.slaWindowMinutes = input.slaWindowMinutes;
        if (input.slaBreachActionType !== undefined) {
            data.slaBreachActionType = input.slaBreachActionType;
        }
        if (input.slaBreachConfig !== undefined) {
            data.slaBreachConfigJson =
                input.slaBreachConfig === null
                    ? Prisma.JsonNull
                    : (input.slaBreachConfig as Prisma.InputJsonValue);
        }
        if (input.nextRuleId !== undefined) {
            data.nextRule =
                input.nextRuleId === null
                    ? { disconnect: true }
                    : { connect: { id: input.nextRuleId } };
        }
        if (input.nextRuleDelay !== undefined) data.nextRuleDelay = input.nextRuleDelay;
        if (input.elseRuleId !== undefined) {
            data.elseRule =
                input.elseRuleId === null
                    ? { disconnect: true }
                    : { connect: { id: input.elseRuleId } };
        }
        if (input.scheduleConfig !== undefined) {
            data.scheduleConfigJson =
                input.scheduleConfig === null
                    ? Prisma.JsonNull
                    : (input.scheduleConfig as Prisma.InputJsonValue);
        }

        return db.automationRule.update({ where: { id }, data });
    }

    static async archive(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await db.automationRule.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!existing) return null;

        return db.automationRule.update({
            where: { id },
            data: {
                status: 'ARCHIVED',
                deletedAt: new Date(),
                updatedByUserId: ctx.userId,
            },
        });
    }

    /**
     * Enable/disable toggle (Epic 2). Convenience over `update` that
     * refuses to flip an ARCHIVED rule back to life — archived is a
     * terminal soft-deleted state; resurrection would need an explicit
     * un-archive flow, not a status toggle. Returns null when the rule
     * is missing or archived.
     */
    static async toggle(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: 'ENABLED' | 'DISABLED',
    ) {
        const existing = await db.automationRule.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing || existing.status === 'ARCHIVED' || existing.deletedAt) {
            return null;
        }
        return db.automationRule.update({
            where: { id },
            data: { status, updatedByUserId: ctx.userId },
        });
    }

    /**
     * Dispatcher-only counter bump. Not intended for usecase code —
     * keep it separate so every *user-visible* mutation goes through
     * `update` (which sets `updatedByUserId` + writes audit log).
     */
    static async recordFired(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.automationRule.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: {
                executionCount: { increment: 1 },
                lastTriggeredAt: new Date(),
            },
        });
    }

    private static buildWhere(
        ctx: RequestContext,
        filters: AutomationRuleListFilters
    ): Prisma.AutomationRuleWhereInput {
        const where: Prisma.AutomationRuleWhereInput = {
            tenantId: ctx.tenantId,
        };
        if (!filters.includeDeleted) where.deletedAt = null;
        if (filters.status) where.status = filters.status;
        if (filters.triggerEvent) where.triggerEvent = filters.triggerEvent;
        if (filters.actionType) where.actionType = filters.actionType;
        return where;
    }
}
