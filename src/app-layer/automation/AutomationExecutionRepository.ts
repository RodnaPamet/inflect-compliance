import { Prisma } from '@prisma/client';
import type { AutomationExecution, AutomationExecutionStatus } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import type {
    AutomationExecutionListFilters,
    RecordAutomationExecutionCompletionInput,
    RecordAutomationExecutionStartInput,
} from './types';

/**
 * Append-only history of automation rule firings.
 *
 * A PENDING row is inserted the moment the dispatcher picks up an event
 * and matches it to a rule; that single insert also doubles as the
 * dedupe lock (`tenantId + idempotencyKey` is unique, so a retried
 * event with the same key hits P2002 and we skip the second run).
 *
 * Terminal status (`SUCCEEDED | FAILED | SKIPPED`) is written by
 * `recordCompletion`. Rows are never updated after that, never deleted.
 */
export class AutomationExecutionRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: AutomationExecutionListFilters = {}
    ) {
        const where: Prisma.AutomationExecutionWhereInput = {
            tenantId: ctx.tenantId,
        };
        if (filters.ruleId) where.ruleId = filters.ruleId;
        if (filters.status) where.status = filters.status;
        if (filters.triggerEvent) where.triggerEvent = filters.triggerEvent;

        return db.automationExecution.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.automationExecution.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
    }

    /** Find the existing execution for an idempotency key, if any. */
    static async findByIdempotencyKey(
        db: PrismaTx,
        ctx: RequestContext,
        idempotencyKey: string
    ) {
        return db.automationExecution.findFirst({
            where: { tenantId: ctx.tenantId, idempotencyKey },
        });
    }

    /**
     * Insert the PENDING row that claims the dedupe slot. The caller
     * must treat a P2002 (unique violation on idempotencyKey) as a
     * signal that another runner has already taken this event — skip,
     * don't retry.
     */
    static async recordStart(
        db: PrismaTx,
        ctx: RequestContext,
        input: RecordAutomationExecutionStartInput
    ) {
        return db.automationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                ruleId: input.ruleId,
                triggerEvent: input.triggerEvent,
                triggerPayloadJson:
                    input.triggerPayload as Prisma.InputJsonValue,
                status: 'PENDING',
                idempotencyKey: input.idempotencyKey ?? null,
                triggeredBy: input.triggeredBy ?? 'event',
                jobRunId: input.jobRunId ?? null,
                startedAt: new Date(),
            },
        });
    }

    /** Flip PENDING → RUNNING once the runner has picked up the row. */
    static async markRunning(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        jobRunId?: string | null
    ) {
        return db.automationExecution.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'PENDING' },
            data: {
                status: 'RUNNING',
                jobRunId: jobRunId ?? undefined,
            },
        });
    }

    static async recordCompletion(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        input: RecordAutomationExecutionCompletionInput
    ) {
        const existing = await db.automationExecution.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing) return null;

        return db.automationExecution.update({
            where: { id },
            data: {
                status: input.status,
                outcomeJson:
                    input.outcome === null || input.outcome === undefined
                        ? Prisma.JsonNull
                        : (input.outcome as Prisma.InputJsonValue),
                errorMessage: input.errorMessage ?? null,
                errorStack: input.errorStack ?? null,
                durationMs: input.durationMs ?? null,
                completedAt: new Date(),
            },
        });
    }

    /**
     * Settle an execution ONLY while it is still RUNNING; true when this call
     * settled it (#5305).
     *
     * `recordCompletion` overwrites whatever status the row holds. The SLA
     * sweep reads RUNNING rows and then settles them, so a dispatcher that
     * committed SUCCEEDED in between had its success overwritten to FAILED,
     * and the sweep then audited a breach and notified its recipients for an
     * action that had succeeded. The status predicate is in the write, so the
     * loser of that race changes nothing and is told so.
     */
    static async recordCompletionIfRunning(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        input: RecordAutomationExecutionCompletionInput
    ): Promise<boolean> {
        const res = await db.automationExecution.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'RUNNING' },
            data: {
                status: input.status,
                outcomeJson:
                    input.outcome === null || input.outcome === undefined
                        ? Prisma.JsonNull
                        : (input.outcome as Prisma.InputJsonValue),
                errorMessage: input.errorMessage ?? null,
                errorStack: input.errorStack ?? null,
                durationMs: input.durationMs ?? null,
                completedAt: new Date(),
            },
        });
        return res.count === 1;
    }

    /** Per-rule history feed (used by the rule detail page). */
    static async listForRule(
        db: PrismaTx,
        ctx: RequestContext,
        ruleId: string,
        limit = 50
    ) {
        return db.automationExecution.findMany({
            where: { tenantId: ctx.tenantId, ruleId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    /**
     * Cursor-paginated per-rule history (Epic 6). Fetches `limit + 1` to
     * detect a next page; returns the page + the next cursor (the id to
     * resume after) or null when exhausted.
     */
    static async listForRulePaginated(
        db: PrismaTx,
        ctx: RequestContext,
        ruleId: string,
        opts: { limit?: number; cursor?: string; status?: AutomationExecutionStatus } = {}
    ): Promise<{ items: AutomationExecution[]; nextCursor: string | null }> {
        const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
        const rows = await db.automationExecution.findMany({
            where: {
                tenantId: ctx.tenantId,
                ruleId,
                ...(opts.status ? { status: opts.status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        });
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }
}
