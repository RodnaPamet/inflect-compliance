/**
 * Tasks roadmap TP-5 — universal-inbox completeness ratchet.
 *
 * /tasks is only a "universal inbox" if every WORK source that can raise
 * work actually routes it into a Task row — and if that source is a
 * first-class, filterable dimension of the list. This guard locks both
 * halves structurally so a regression (a sweep quietly reverting to
 * notifications-only, or the source field silently dropping off the list /
 * filter) fails CI instead of shipping a half-empty inbox.
 *
 * Three invariants:
 *
 *   1. Every WORK `TaskSource` value has a task-creation call that
 *      stamps that source somewhere in `src/app-layer`. MANUAL + TEMPLATE
 *      are user-/template-initiated (not autonomous sweeps) and are
 *      explicitly exempt with a reason. A NEW enum value that is neither
 *      wired to a create path nor exempted fails the coverage check below.
 *
 *   2. `WorkItemRepository.taskListSelect` returns `source: true` — the
 *      field the list needs to render + filter by origin.
 *
 *   3. The Tasks filter config exposes a `source` filter whose option
 *      values are EXACTLY the `TaskSource` enum set.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskSource } from '@prisma/client';

import { buildTaskFilterDefs } from '../../src/app/t/[tenantSlug]/(app)/tasks/filter-defs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_LAYER_DIR = path.join(REPO_ROOT, 'src/app-layer');

// ─── Which sources represent AUTONOMOUS work that must reach the inbox ──
//
// MANUAL — a user typed the task in by hand; it already IS a task.
// TEMPLATE — instantiated from a task template by a user action; the
//   template apply-flow is the create path, not an autonomous sweep.
// Everything else is a system-driven signal that must materialise a task.
const EXEMPT_SOURCES: Record<string, string> = {
    MANUAL: 'User-created tasks are already Task rows — nothing to route.',
    TEMPLATE: 'Instantiated from a task template by an explicit user action, not an autonomous sweep.',
};

const REQUIRED_SOURCES = Object.values(TaskSource).filter(
    (s) => !(s in EXEMPT_SOURCES),
);

/** Recursively collect every `.ts` file under `src/app-layer`. */
function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectTsFiles(full));
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
}

const APP_LAYER_FILES = collectTsFiles(APP_LAYER_DIR).map((f) => ({
    path: f,
    content: fs.readFileSync(f, 'utf8'),
}));

// A file "creates tasks" if it calls the createTask usecase or a raw
// Prisma `.task.create(` — the two shapes the codebase uses.
const TASK_CREATE_TOKEN = /createTask\s*\(|\.task\.create\s*\(/;

describe('inbox completeness — work sources route into Tasks', () => {
    it('exempt + required sources together cover the whole TaskSource enum', () => {
        // Forces triage of any NEW enum value: it must either be wired to a
        // create path (REQUIRED) or documented as exempt.
        const all = Object.values(TaskSource).sort();
        const covered = [...REQUIRED_SOURCES, ...Object.keys(EXEMPT_SOURCES)].sort();
        expect(covered).toEqual(all);
    });

    it.each(REQUIRED_SOURCES)(
        'work source %s has a task-creation call stamping it in src/app-layer',
        (source) => {
            const literal = new RegExp(`source:\\s*['"]${source}['"]`);
            const hit = APP_LAYER_FILES.find(
                (f) => literal.test(f.content) && TASK_CREATE_TOKEN.test(f.content),
            );
            expect(hit).toBeDefined();
        },
    );
});

describe('inbox completeness — source is selectable + filterable', () => {
    it('taskListSelect returns source: true', () => {
        const repo = fs.readFileSync(
            path.join(APP_LAYER_DIR, 'repositories/WorkItemRepository.ts'),
            'utf8',
        );
        const selectBlock = repo.slice(
            repo.indexOf('const taskListSelect'),
            repo.indexOf('} as const'),
        );
        expect(selectBlock).toMatch(/source:\s*true/);
    });

    it('the Tasks filter config exposes a source filter over the full enum set', () => {
        const identity = (k: string) => k;
        const defs = buildTaskFilterDefs(identity, identity);
        const sourceFilter = defs.getFilter('source');
        expect(sourceFilter).toBeDefined();
        const values = (sourceFilter?.options ?? []).map((o) => o.value).sort();
        expect(values).toEqual(Object.values(TaskSource).sort());
    });
});
