/**
 * Tasks list page → non-modal quick-view side panel (2026-06-20).
 *
 * Matches the Controls page: clicking a task TITLE (or the row pencil) opens
 * the editable task in a non-modal <AsidePanel> + <TaskEditPanel>; the table
 * stays visible so clicking another task switches the panel IN PLACE (no
 * close-first). Row double-click still navigates to the full detail page.
 *
 * Replaces the old modal `<TaskDetailSheet>` (deleted) — locks the migration
 * so a regression can't quietly reintroduce the dimming modal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const tasks = read('src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx');

describe('Tasks list page — non-modal quick-view side panel', () => {
    it('the title cell is a <button> that opens the quick-view panel', () => {
        expect(tasks).toMatch(/data-testid={`task-title-/);
        expect(tasks).toMatch(/onClick=\{[\s\S]{0,160}setSelectedTask\(row\.original\)/);
    });

    it('mounts the non-modal AsidePanel + TaskEditPanel, keyed by task id', () => {
        expect(tasks).toMatch(/<AsidePanel[\s\S]{0,400}openOnMount/);
        // Keyed by id so switching task→task re-seeds the panel.
        expect(tasks).toMatch(/key=\{`qv-task-\$\{selectedTask\.id\}`\}/);
        expect(tasks).toMatch(/<TaskEditPanel/);
        // The aside is wired into the list body (co-resident with the table).
        expect(tasks).toMatch(/<ListPageShell\.Body aside=\{taskQuickViewAside\}/);
    });

    it('row double-click still navigates to the full detail page', () => {
        // Behaviour, not syntax: the row action must navigate to the task
        // detail route. Previously this matched the handler body inline in
        // the JSX prop, which quietly required the identity-unstable form
        // — an inline arrow rebuilds the table model between the two
        // clicks of a double-click, so the gesture never fires. See
        // `datatable-stable-row-identity.test.ts`.
        expect(tasks).toMatch(/onRowClick=\{handleTaskRowClick\}/);
        expect(tasks).toMatch(
            /const handleTaskRowClick = useCallback\([\s\S]{0,200}\/tasks\/\$\{row\.original\.id\}/,
        );
    });

    it('the old modal TaskDetailSheet is gone', () => {
        expect(tasks).not.toMatch(/TaskDetailSheet/);
        expect(
            fs.existsSync(
                path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/tasks/TaskDetailSheet.tsx'),
            ),
        ).toBe(false);
    });
});
