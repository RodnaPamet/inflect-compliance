/**
 * Bulgarian for the five generic template tasks.
 *
 * Keyed through `GENERIC_TEMPLATE_TASKS` rather than by repeating the English
 * titles: `prisma/generic-template-tasks.ts` is their single owner
 * (`tests/guardrails/no-generic-task-strings.test.ts`), so this file holds
 * only the translations, in the owner's order.
 */
import { GENERIC_TEMPLATE_TASK_TITLES } from '../../../../prisma/generic-template-tasks';

const BULGARIAN: readonly string[] = [
    'Определете отговорника и обхвата на контрола',
    'Документирайте процедурата или политиката',
    'Въведете техническата или оперативната мярка',
    'Съберете доказателства за прилагането',
    'Прегледайте ефективността',
];

if (BULGARIAN.length !== GENERIC_TEMPLATE_TASK_TITLES.length) {
    throw new Error('generic-tasks: one Bulgarian title per generic template task');
}

export const genericTasks: Readonly<Record<string, string>> = Object.fromEntries(
    GENERIC_TEMPLATE_TASK_TITLES.map((title, i) => [title, BULGARIAN[i]]),
);
