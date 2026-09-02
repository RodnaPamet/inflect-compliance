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
import { braceBlockAfter, codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Comments masked at the READER, so the whole-file assertions in this file
 * are about code on the same terms as the bounded ones.
 *
 * Masking BLANKS rather than deletes, which is a real semantic difference and
 * not a detail — see the long note in the STATUS_CHANGED block below before
 * writing any assertion here that measures a DISTANCE between two tokens.
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

        /**
         * Every `detailsJson: { … }` object literal in `src`, each bounded by
         * its own braces rather than by a character count.
         *
         * ─── WHY A BLOCK AND NOT A WINDOW ────────────────────────────────
         *
         * The two assertions below used to measure PROXIMITY:
         * `entityName: 'Task'` within `[\s\S]{0,80}` of `fromStatus: null`,
         * and `category: 'status_change'` within `[\s\S]{0,200}` of
         * `toStatus: status`. Both were correct only while the reader
         * DELETED comments, which is what the local `.replace()` pair that
         * used to sit here did. `read` MASKS them instead, and masking
         * BLANKS — it writes a space over each comment byte to keep offsets
         * aligned — so a comment's characters still occupy the window that
         * deleting them used to vacate.
         *
         * The two maskers are not interchangeable, and this is the whole of
         * the difference:
         *
         *   • a PRESENCE / ABSENCE assertion asks "does this text contain
         *     X?". Blanking and deleting agree: neither leaves any of the
         *     comment's characters as matchable text.
         *   • a PROXIMITY assertion asks "is X within N characters of Y?".
         *     It measures DISTANCE — and blanking PRESERVES distance where
         *     deleting REMOVES it.
         *
         * So the note that used to stand here — that blanking is "safe for a
         * `not.toMatch` (it can only decline to match)" — was backwards. On a
         * NEGATIVE assertion, declining to match IS the green. Measured, not
         * argued: put the original regression back at the `setTaskStatus`
         * audit payload behind one 57-character comment,
         *
         *     entityName: 'Task',
         *     // parked as null until the repo returns the prior status
         *     fromStatus: null,
         *
         * and the windowed form was 7/7 GREEN while `main`'s delete-stripper
         * form failed. One comment ate the 80-character budget and the guard
         * named for this invariant went blind to the bug it is named for.
         *
         * Widening the window would only raise the number a comment has to
         * beat, so nothing below measures distance at all. The payload
         * assertions bound the read to the audit object's own braces; the
         * file-wide negative drops its `entityName` anchor entirely. Both are
         * strictly stronger than what they replace: the window fired only
         * when the two tokens were CLOSE and `entityName: 'Task'` was
         * present, where these fire on a wrong status-change payload wherever
         * it is written and on a `fromStatus: null` at any distance from
         * anything.
         *
         * `braceBlockAfter` throws rather than returning '' when a literal is
         * unbalanced, so a shape this cannot parse fails loudly instead of
         * asserting against an empty string.
         */
        const detailsJsonPayloads = (src: string): string[] => {
            const payloads: string[] = [];
            let rest = src;
            while (/detailsJson\s*:\s*\{/.test(rest)) {
                const payload = braceBlockAfter(rest, 'detailsJson\\s*:\\s*\\{');
                payloads.push(payload);
                rest = rest.slice(rest.indexOf(payload) + payload.length);
            }
            return payloads;
        };

        const statusChangePayloads = (src: string) =>
            detailsJsonPayloads(src).filter((payload) =>
                /category:\s*['"]status_change['"]/.test(payload),
            );

        // The bug this locks: `detailsJson.fromStatus` was hardcoded
        // `null` and `toStatus` held the action name, so an auditor
        // reading the trail could not tell what a task moved FROM.
        it('task.ts never writes a null fromStatus or an action-name toStatus', () => {
            expect(taskSrc).not.toMatch(/fromStatus:\s*null/);
            expect(taskSrc).not.toMatch(/toStatus:\s*['"]TASK_STATUS_CHANGED['"]/);
        });

        // Positive companion to the negative above — on its own, that one is
        // also satisfied by deleting `fromStatus` outright, and an absence is
        // ambiguous. Bounded to each payload's own braces.
        it('every status_change audit payload names a real fromStatus + toStatus', () => {
            const payloads = statusChangePayloads(taskSrc);
            // `setTaskStatus` + `bulkSetTaskStatus`. More is fine; fewer means
            // an emitter was dropped or its category was retagged.
            expect(payloads.length).toBeGreaterThanOrEqual(2);
            for (const payload of payloads) {
                expect(payload).toMatch(/\bfromStatus\b/);
                expect(payload).not.toMatch(/fromStatus:\s*(?:null|undefined)\b/);
                expect(payload).toMatch(/toStatus:\s*status\b/);
                // `toStatus` holding a string literal is the original bug in
                // its general form, not only the one action name.
                expect(payload).not.toMatch(/toStatus:\s*['"]/);
            }
        });

        it('setTaskStatus and bulkSetTaskStatus each emit one status_change payload', () => {
            for (const fn of ['setTaskStatus', 'bulkSetTaskStatus']) {
                const payloads = statusChangePayloads(functionBodyOf(taskSrc, fn));
                expect({ fn, count: payloads.length }).toEqual({ fn, count: 1 });
                expect(payloads[0]).toMatch(/\bfromStatus\b/);
                expect(payloads[0]).not.toMatch(/fromStatus:\s*(?:null|undefined)\b/);
                expect(payloads[0]).toMatch(/toStatus:\s*status\b/);
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
