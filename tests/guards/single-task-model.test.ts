/**
 * TP-2 P4.4 — single work-item model ratchet.
 *
 * The product carries exactly ONE task/work-item model: the unified `Task`
 * aggregate. The legacy per-control `ControlTask` stack (its own model +
 * 4-value `ControlTaskStatus` enum + bespoke repo methods, route, and
 * create modals) was removed in TP-2 after its rows were migrated into
 * `Task`. This guard asserts none of that stack can return — so the
 * two-system split (a per-control task table invisible to the global Tasks
 * list) is structurally impossible to reintroduce without deleting this
 * test in the same diff.
 *
 * The control-detail Tasks tab renders unified `Task` rows via
 * `LinkedTasksPanel`; see `tests/guards/b4-control-tasks-tab.test.ts` and
 * `tests/guards/control-task-create-modal.test.ts` for the UI-side locks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
import { codeOf } from '../helpers/source-blocks';

// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read in this
// file is TypeScript, re-derived here rather than assumed from the paths.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/** Concatenated text of every `.prisma` file in the schema folder. */
function schemaText(): string {
    const dir = path.join(ROOT, 'prisma/schema');
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
        .join('\n');
}

describe('single work-item model (TP-2)', () => {
    it('no `model ControlTask` remains in the Prisma schema', () => {
        expect(schemaText()).not.toMatch(/^\s*model\s+ControlTask\s*\{/m);
    });

    it('no `enum ControlTaskStatus` remains in the Prisma schema', () => {
        expect(schemaText()).not.toMatch(/^\s*enum\s+ControlTaskStatus\s*\{/m);
    });

    it('ControlRepository has no ControlTask CRUD methods', () => {
        const repo = read('src/app-layer/repositories/ControlRepository.ts');
        for (const method of ['listTasks', 'createTask', 'updateTask', 'deleteTask']) {
            expect(repo).not.toMatch(new RegExp(`static\\s+async\\s+${method}\\b`));
        }
        // And nothing references the dropped Prisma delegate.
        expect(repo).not.toMatch(/\bcontrolTask\b/);
    });

    it('the legacy control-task usecase file is gone', () => {
        expect(exists('src/app-layer/usecases/control/tasks.ts')).toBe(false);
    });

    it('the per-control task API routes are gone', () => {
        expect(exists('src/app/api/t/[tenantSlug]/controls/[controlId]/tasks/route.ts')).toBe(false);
        expect(exists('src/app/api/t/[tenantSlug]/controls/tasks/[taskId]/route.ts')).toBe(false);
    });

    it('the bespoke ControlTask create modals are gone', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/controls/[controlId]/_modals/NewControlTaskModal.tsx')).toBe(false);
        expect(exists('src/components/LinkedTaskCreateModal.tsx')).toBe(false);
    });
});
