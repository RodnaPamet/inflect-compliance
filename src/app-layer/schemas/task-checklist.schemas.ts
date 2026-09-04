/**
 * `Task.checklistJson` — the authored steps of a template task, with per-item
 * done state.
 *
 * WHY A JSON COLUMN AND NOT A MODEL. A `TaskChecklistItem` table would be
 * queryable and would let evidence attach per item. Neither is reachable
 * today: task evidence is `Evidence.taskId`, a direct FK to the task, and no
 * seam anywhere carries an item id — so a model would buy a capability the
 * rest of the stack cannot express, at the cost of RLS policies, a tenant
 * isolation test, an index and a retention classification. Revisit if
 * per-item evidence is ever actually wanted; until then this is the smaller
 * true thing.
 *
 * WHAT THAT COSTS, STATED PLAINLY. `sanitize-rich-text-coverage` is
 * model-keyed and `Task` is already classified, so nothing in CI notices that
 * a new free-text field arrived on it. The sanitisation below is therefore
 * enforced by a behavioural test rather than by a guard, and anyone adding a
 * second write path for these items has to remember. That asymmetry is the
 * reason this docblock exists.
 *
 * @module schemas/task-checklist
 */
import { z } from 'zod';
import { badRequest } from '@/lib/errors/types';

/**
 * Bounds. Chosen from the authoring rules rather than invented: a template
 * task carries 3-8 steps, so 20 is generous headroom for a hand-edited list
 * while still refusing a paste of a whole runbook into one column.
 */
export const MAX_CHECKLIST_ITEMS = 20;
export const MAX_CHECKLIST_TEXT = 500;
export const MAX_CHECKLIST_HINT = 300;

export const ChecklistItemSchema = z.object({
    /** Stable across edits — it is what a toggle addresses. */
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_CHECKLIST_TEXT),
    hint: z.string().max(MAX_CHECKLIST_HINT).optional(),
    done: z.boolean(),
    /** Set on the transition to done; cleared when un-done. */
    doneAt: z.string().datetime().optional(),
    doneByUserId: z.string().optional(),
});

export const TaskChecklistSchema = z.array(ChecklistItemSchema).max(MAX_CHECKLIST_ITEMS);

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type TaskChecklist = z.infer<typeof TaskChecklistSchema>;

/**
 * Validate a checklist, or throw 400.
 *
 * Accepts null/undefined and returns undefined, so an optional column reads
 * naturally at every call site — the same shape `validateAuditDetailsJson`
 * uses two files over.
 */
export function validateTaskChecklist(input: unknown): TaskChecklist | undefined {
    if (input === undefined || input === null) return undefined;
    const result = TaskChecklistSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid task checklist structure', result.error.issues);
    }
    return result.data;
}
