/**
 * Ticking one step of a task's checklist.
 *
 * `Task.checklistJson` has carried the authored steps of every template task
 * installed since 2026-09-04 (`taskFromTemplateTask`), with a per-item `done`
 * flag and an `id` documented as "what a toggle addresses" — but nothing
 * toggled it and nothing displayed it. The steps were written, sanitised,
 * bounded and then never seen, so a control installed from ISO 42001, where
 * every task has steps, looked exactly as step-less as one installed from a
 * framework with none. This file is the write half of closing that.
 *
 * The verb is one item at a time, addressed by id, never "replace the list".
 * A whole-array PUT would let any editor rewrite the authored step text, which
 * is the template's advice rather than the tenant's work — and it would need
 * its own sanitisation path, the asymmetry the checklist schema's docblock
 * warns about. Toggling `done` writes no free text at all.
 *
 * @module usecases/task-checklist
 */
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { TaskRepository } from '../repositories/TaskRepository';
import { assertCanWriteTasks } from '../policies/task.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    TaskChecklistSchema,
    type ChecklistItem,
    type TaskChecklist,
} from '../schemas/task-checklist.schemas';

/**
 * Validate a stored checklist, or throw 400.
 *
 * Accepts null/undefined and returns undefined, so an optional column reads
 * naturally at the call site.
 *
 * Lives here rather than beside the schema because the schema module is
 * imported by `task-from-template.ts`, which the per-start checklist backfill
 * (`prisma/task-checklist-backfill.ts`) bundles. `@/lib/errors/types` imports
 * `@/env`, so a throw helper in the schema module made a seeder that needs
 * only a database URL fail on every unrelated variable the app requires.
 */
export function validateTaskChecklist(input: unknown): TaskChecklist | undefined {
    if (input === undefined || input === null) return undefined;
    const result = TaskChecklistSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid task checklist structure', result.error.issues);
    }
    return result.data;
}

/** What a toggle did, so the caller can tell a no-op from a write. */
export interface ChecklistToggleResult {
    readonly checklist: TaskChecklist;
    readonly changed: boolean;
}

/**
 * Apply one toggle to a checklist. Pure, so the stamping rules are tested
 * without a database.
 *
 * `doneAt` / `doneByUserId` are set on the transition to done and REMOVED on
 * the transition back — the schema says "cleared when un-done", and a stale
 * `doneBy` on an open step would credit somebody with work that was undone.
 * Asking for the state an item is already in changes nothing, including its
 * stamps: re-ticking a ticked step must not move who ticked it, or when.
 *
 * Returns `null` when no item carries the id.
 */
export function toggleChecklistItem(
    checklist: TaskChecklist,
    itemId: string,
    done: boolean,
    actorUserId: string,
    now: Date,
): ChecklistToggleResult | null {
    const index = checklist.findIndex((item) => item.id === itemId);
    if (index === -1) return null;

    const current = checklist[index];
    if (current.done === done) return { checklist, changed: false };

    const base: ChecklistItem = {
        id: current.id,
        text: current.text,
        ...(current.hint !== undefined ? { hint: current.hint } : {}),
        done,
    };
    const next: ChecklistItem = done
        ? { ...base, doneAt: now.toISOString(), doneByUserId: actorUserId }
        : base;

    return {
        checklist: checklist.map((item, i) => (i === index ? next : item)),
        changed: true,
    };
}

/**
 * Mark one checklist item done or not done.
 *
 * The row is read `FOR UPDATE` (see `TaskRepository.lockChecklist`), so two
 * ticks on the same task serialise instead of one overwriting the other.
 *
 * A stored checklist that fails the schema is refused rather than repaired:
 * it can only have come from a write path this file does not know about, and
 * rewriting it here would launder that path's output through a toggle.
 */
export async function setTaskChecklistItem(
    ctx: RequestContext,
    taskId: string,
    itemId: string,
    done: boolean,
): Promise<TaskChecklist> {
    assertCanWriteTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const row = await TaskRepository.lockChecklist(db, ctx, taskId);
        if (!row) throw notFound('Task not found');

        const stored = validateTaskChecklist(row.checklistJson);
        if (!stored) throw notFound('Checklist item not found');

        const result = toggleChecklistItem(stored, itemId, done, ctx.userId, new Date());
        if (!result) throw notFound('Checklist item not found');
        if (!result.changed) return result.checklist;

        await TaskRepository.setChecklist(
            db,
            ctx,
            taskId,
            result.checklist as unknown as Prisma.InputJsonValue,
        );

        const position = stored.findIndex((item) => item.id === itemId) + 1;
        await logEvent(db, ctx, {
            action: 'TASK_CHECKLIST_ITEM_UPDATED',
            entityType: 'Task',
            entityId: taskId,
            details: `Checklist step ${position} of ${stored.length} marked ${done ? 'done' : 'not done'}`,
            detailsJson: { category: 'custom', event: 'task_checklist_item_updated' },
            metadata: { itemId, done, position, total: stored.length },
        });

        return result.checklist;
    });
}
