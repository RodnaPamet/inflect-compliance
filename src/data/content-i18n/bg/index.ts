/**
 * The Bulgarian content dictionaries (#5996), one JSON file per catalogue:
 * `{ "<English source text>": "<Bulgarian text>" }`.
 *
 * Imported statically so the server bundle carries them (a runtime `fs` read
 * would depend on output file tracing). A JSON file in this folder that is
 * missing from the list fails `tests/unit/content-i18n/dictionary.test.ts`.
 * `generic-tasks` is the one dictionary built in code (see its header).
 */
import { genericTasks } from './generic-tasks';

export const BG_DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'generic-tasks': genericTasks,
};
