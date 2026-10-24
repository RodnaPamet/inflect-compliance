/**
 * ONE projection from `ControlTemplateTask` to a `Task`.
 *
 * Four call sites install tasks from a template — three in
 * `framework/install.ts` (161, 269, 426) and one in `control/mappings.ts`
 * (127) — and until now each spelled the mapping itself. The sibling file
 * `template-projection.ts` exists because the same thing happened one level
 * up and silently produced different Controls from one template; this is that
 * lesson applied before it costs anything.
 *
 * ═══ THE BUG THIS FIXES, STATED ACCURATELY ═══
 *
 * Every task installed from a template has always been recorded as
 * `source: MANUAL`. Not because any call site set it — none of the four so
 * much as mentions `source` — but because `tasks.prisma` declares
 * `source TaskSource? @default(MANUAL)` and nobody overrode it.
 * `TaskSource.TEMPLATE` has existed in the enum the whole time, unused.
 *
 * The cost is not cosmetic. It means no query anywhere can tell a task the
 * product installed from a task a person wrote, which is why a backfill for
 * existing tenants is impossible rather than merely awkward: those rows are
 * permanently ambiguous and no later change can disambiguate them. Every row
 * written from today forward carries `TEMPLATE` and a `templateTaskId`, so
 * the ambiguity has an end date even though it has no beginning.
 *
 * ═══ WHY IT RETURNS A CREATE-MANY INPUT ═══
 *
 * `mappings.ts:127` uses `createMany`, whose element type is
 * `Prisma.TaskCreateManyInput` — a flat scalar shape that forbids the nested
 * `connect` writers a `create` allows. Returning the intersection means one
 * projection serves both, so the two cannot drift; the price is that this
 * file names foreign keys as scalars rather than relations.
 *
 * @module usecases/control/task-from-template
 */
import type { Prisma } from '@prisma/client';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    MAX_CHECKLIST_HINT,
    MAX_CHECKLIST_TEXT,
    MAX_CHECKLIST_ITEMS,
    type TaskChecklist,
} from '@/app-layer/schemas/task-checklist.schemas';

/** The template-task fields this projection reads. Structural on purpose, so
 *  a caller may pass a full row or a `select`ed subset. */
export interface TemplateTaskLike {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly sortOrder?: number;
    readonly phase?: string | null;
    readonly stepsJson?: unknown;
    readonly evidenceHint?: string | null;
    readonly suggestedRole?: string | null;
    readonly deprecatedAt?: Date | null;
}

/** One authored step, as it appears in `stepsJson`. */
interface AuthoredStep {
    readonly text?: unknown;
    readonly hint?: unknown;
}

/**
 * The English text of an authored string: a bare string, or a locale map.
 *
 * The catalogue stores every step as `{ text: { en, bg? }, hint?: { en, bg? } }`
 * — `CatalogTaskSchema`'s shape, written verbatim into `stepsJson` by
 * `reconcileTemplateTasks`. This file read only a bare-string `text`, and its
 * tests fed it only that, so every catalogue step failed the `typeof` check,
 * every checklist came out empty and was omitted, and from 2026-09-04 no task
 * installed from any framework carried a single step — ISO 42001, whose every
 * task has steps, included. `en` because the task's scalar columns carry `en`
 * (see `reconcileTemplateTasks`); the checklist is read beside them.
 */
function authoredText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        const en = (value as { en?: unknown }).en;
        if (typeof en === 'string') return en;
    }
    return undefined;
}

/**
 * Build a checklist from authored steps.
 *
 * Sanitises here rather than at the caller, and that placement is the whole
 * point: the coverage ratchet is model-keyed and `Task` is already
 * classified, so a new free-text field on it is invisible to CI. Routing
 * every item through one function is what makes the discipline hold without a
 * guard watching.
 *
 * Ids come from `crypto.randomUUID()` — the repo has no `nanoid` dependency
 * (it appears only inside `overrides`, as a security pin), and the two other
 * places that need a generated id use exactly this.
 */
export function checklistFromSteps(stepsJson: unknown): TaskChecklist | undefined {
    if (!Array.isArray(stepsJson) || stepsJson.length === 0) return undefined;

    const items = stepsJson.slice(0, MAX_CHECKLIST_ITEMS).flatMap((raw): TaskChecklist => {
        const step = (raw ?? {}) as AuthoredStep;
        // A step may be a bare string or a { text, hint } object, and text and
        // hint may each be a bare string or a locale map — the catalogue writes
        // the locale map. See `authoredText`.
        const rawText = typeof raw === 'string' ? raw : authoredText(step.text);
        if (rawText === undefined) return [];
        const text = sanitizePlainText(rawText).trim().slice(0, MAX_CHECKLIST_TEXT);
        if (!text) return [];

        const rawHint = typeof raw === 'string' ? undefined : authoredText(step.hint);
        const hint = rawHint
            ? sanitizePlainText(rawHint).trim().slice(0, MAX_CHECKLIST_HINT) || undefined
            : undefined;

        return [{ id: crypto.randomUUID(), text, ...(hint ? { hint } : {}), done: false }];
    });

    return items.length > 0 ? items : undefined;
}

/**
 * Project one template task onto the Task row an install should create.
 *
 * Returns a `Prisma.TaskCreateManyInput` so both `create` and `createMany`
 * callers can use it unchanged.
 */
export function taskFromTemplateTask(
    templateTask: TemplateTaskLike,
    ctx: { readonly tenantId: string; readonly userId: string },
    controlId: string,
): Prisma.TaskCreateManyInput {
    const checklist = checklistFromSteps(templateTask.stepsJson);

    return {
        tenantId: ctx.tenantId,
        controlId,
        title: templateTask.title,
        description: templateTask.description,
        status: 'OPEN',
        type: 'TASK',
        // The two fields this file exists for.
        source: 'TEMPLATE',
        templateTaskId: templateTask.id,
        ...(checklist ? { checklistJson: checklist } : {}),
        // Phase, evidence hint and suggested role travel as metadata rather
        // than as columns on Task: they describe the TEMPLATE's intent, not
        // the tenant's task, and a tenant editing the task must not be taken
        // to have edited the template's advice.
        metadataJson: {
            ...(templateTask.phase ? { phase: templateTask.phase } : {}),
            ...(templateTask.evidenceHint ? { evidenceHint: templateTask.evidenceHint } : {}),
            ...(templateTask.suggestedRole ? { suggestedRole: templateTask.suggestedRole } : {}),
        },
        createdByUserId: ctx.userId,
        // All four call sites assigned the installer, and this preserves that
        // exactly. It is load-bearing beyond convention: it is the only thing
        // that makes an installed task's assignee a KNOWN value, which is what
        // any later "has a human touched this?" question has to compare
        // against.
        assigneeUserId: ctx.userId,
    };
}

/**
 * The template tasks an install should act on, in authored order.
 *
 * Deprecated tasks are excluded — a template task removed from its source
 * file is never deleted (a tenant may have installed it), but it must not be
 * installed again. Sorting happens here as well as in the query's `orderBy`
 * so a caller that forgets the `orderBy` still gets the authored sequence.
 */
export function installableTemplateTasks<T extends TemplateTaskLike>(tasks: readonly T[]): T[] {
    return tasks
        .filter((t) => !t.deprecatedAt)
        .slice()
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
