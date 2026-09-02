/**
 * Guardrail: the work-item status machine stays wired into the task
 * usecase, and every STATUS_CHANGED audit row carries the real
 * transition.
 *
 * ─── Scope, stated honestly ─────────────────────────────────────────
 *
 * This file checks the **transition** gate from
 * `domain/task-status.ts` (`checkTaskTransition` — is
 * `from → to` a legal edge?) and the audit `detailsJson` shape. It
 * says NOTHING about the four-eyes reviewer sign-off gate, the
 * assignee≠reviewer SoD guard, `assertActiveMembers`, or source
 * reconciliation. Those are separate gates with separate tests; do
 * not read a green run here as evidence any of them is wired.
 *
 * The previous name of this file ("audit-s8-task-remediation") and
 * of its cases ("wires the gate into setIssueStatus + bulkSetStatus")
 * over-promised on both counts: "the gate" was only ever the
 * transition check, and the `bulkSetStatus` half named a function in
 * `usecases/issue.ts` that no longer exists — the `/issues` bulk
 * routes were retired and the parallel implementation deleted with
 * them, leaving `usecases/task.ts` as the single work-item mutation
 * surface.
 *
 * ─── Why these two assertions are source-shaped ─────────────────────
 *
 * Everything else the old file asserted is already covered by tests
 * that EXECUTE the code, so the source regexes were pure duplication.
 * They are kept here only where a behavioural test exists, so a
 * failure points at the honest owner:
 *
 *   • legal/illegal transitions + terminal sets →
 *     `tests/unit/task-status.test.ts`
 *   • `setTaskStatus` / `bulkSetTaskStatus` rejecting an illegal
 *     transition and a terminal move with no resolution →
 *     `tests/integration/task-usecase-branches.test.ts`
 *   • `getTask` attaching the derived `sla` shape →
 *     `tests/integration/task-usecase-branches.test.ts`
 *
 * What is left below is the audit-row *shape*, which no behavioural
 * test currently reads, and the bundle-freeze categorisation, whose
 * `logEvent` call is unreachable at runtime (the underlying
 * `EvidenceBundleRepository` is a deprecated stub that throws before
 * it) and therefore cannot be reached by a behavioural test at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Comments masked at the READER, so the two whole-file assertions in this
 * file are about code on the same terms as the `functionBodyOf` ones.
 *
 * The import check below is the sharp case. Its regex spans
 * `import { … checkTaskTransition … } from '../domain/task-status'`, and an
 * import line is the single most likely thing in a diff to be COMMENTED OUT
 * rather than deleted — so the assertion that the gate is still wired in was
 * satisfiable by the disconnected wire itself. The bounded-body assertions
 * would fail alongside it today, which makes this a redundancy rather than a
 * hole; that is an argument for fixing it, not for leaving it, because the
 * redundancy is what the file's own header promises.
 */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));



describe('task status machine — wiring + audit shape', () => {
    describe('the transition gate is wired into the task usecase', () => {
        const src = read('src/app-layer/usecases/task.ts');

        it('imports the shared checker/formatter pair', () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]*?checkTaskTransition[\s\S]*?\}\s*from\s*['"]\.\.\/domain\/task-status['"]/,
            );
        });

        it('setTaskStatus checks the transition and rejects with the formatted error', () => {
            const body = functionBodyOf(src, 'setTaskStatus');
            expect(body).toMatch(/checkTaskTransition\(fromStatus,\s*status\)/);
            expect(body).toMatch(/throw badRequest\(formatTransitionError/);
        });

        it('bulkSetTaskStatus pre-fetches every row and checks each transition', () => {
            const body = functionBodyOf(src, 'bulkSetTaskStatus');
            expect(body).toMatch(/TaskRepository\.listByIds/);
            expect(body).toMatch(/checkTaskTransition\(/);
        });

        /**
         * The regression this bounding protects against. An unbounded
         * `slice(indexOf(name))` runs to EOF, so an emptied function
         * body still "matches" on text belonging to a later function.
         * Proven here rather than asserted in prose.
         */
        it('a gutted function body is not rescued by a later function in the file', () => {
            const fake = [
                'export async function bulkSetTaskStatus(ctx) {',
                '    return null;',
                '}',
                'export async function somethingElse(ctx) {',
                '    const rows = await TaskRepository.listByIds(db, ctx, ids);',
                '    return checkTaskTransition(a, b);',
                '}',
            ].join('\n');

            // The old, unbounded shape passes on this gutted input …
            const unbounded = fake.slice(fake.indexOf('export async function bulkSetTaskStatus'));
            expect(unbounded).toMatch(/TaskRepository\.listByIds/);

            // … the bounded one does not.
            const bounded = functionBodyOf(fake, 'bulkSetTaskStatus');
            expect(bounded).not.toMatch(/TaskRepository\.listByIds/);
            expect(bounded).not.toMatch(/checkTaskTransition\(/);
        });
    });

    describe('STATUS_CHANGED audit rows carry the real transition', () => {
        const taskSrc = read('src/app-layer/usecases/task.ts');

        // The bug this locks: `detailsJson.fromStatus` was hardcoded
        // `null` and `toStatus` held the action name, so an auditor
        // reading the trail could not tell what a task moved FROM.
        //
        // The local `.replace()` pair that used to strip comments here is
        // gone: `read` masks them now, for every assertion in the file
        // rather than these two. Note the one behavioural difference —
        // `codeOf` BLANKS a comment where the old pair DELETED it, so
        // characters a comment occupies still count against the
        // `[\s\S]{0,80}` window below. That direction is safe for a
        // `not.toMatch` (it can only decline to match), and it is what keeps
        // `indexOf`/`slice` offsets aligned with the real file everywhere
        // else.
        it('task.ts never writes a null fromStatus or an action-name toStatus', () => {
            expect(taskSrc).not.toMatch(
                /entityName:\s*['"]Task['"][\s\S]{0,80}fromStatus:\s*null/,
            );
            expect(taskSrc).not.toMatch(/toStatus:\s*['"]TASK_STATUS_CHANGED['"]/);
        });

        it('setTaskStatus and bulkSetTaskStatus each emit a real fromStatus + toStatus', () => {
            for (const fn of ['setTaskStatus', 'bulkSetTaskStatus']) {
                const body = functionBodyOf(taskSrc, fn);
                expect(body).toMatch(
                    /category:\s*['"]status_change['"][\s\S]{0,200}fromStatus[\s\S]{0,200}toStatus:\s*status/,
                );
            }
        });
    });

    describe('bundle freeze is an entity_lifecycle event, not a status change', () => {
        const issueSrc = read('src/app-layer/usecases/issue.ts');

        // Freezing an evidence bundle is a one-shot lifecycle event on
        // the bundle, not a transition on the issue. Tagged
        // `status_change` it polluted every SIEM filter watching real
        // WorkItem transitions.
        it('freezeBundle logs BUNDLE_FROZEN under entity_lifecycle', () => {
            const body = functionBodyOf(issueSrc, 'freezeBundle');
            expect(body).toMatch(/action:\s*['"]BUNDLE_FROZEN['"]/);
            expect(body).toMatch(/category:\s*['"]entity_lifecycle['"]/);
            expect(body).not.toMatch(/category:\s*['"]status_change['"]/);
            expect(body).not.toMatch(/toStatus:/);
        });
    });
});
