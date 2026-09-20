/**
 * PR-BB item 1 — the NIS2 plain-CONTROL_GAP reconcile skip, CONFIRMED.
 *
 * NIS2 gap-lifecycle remediations (CONTROL_CREATE / plain-TASK) spawn tasks
 * with `type: 'CONTROL_GAP'` and `controlId: null` — they carry no control to
 * re-attest. `reconcileTaskSource` deliberately does NOT reconcile those: the
 * gap self-assessment ANSWER is the source of truth, and closing a nudge task
 * must not silently flip a question the tenant never answered. Only NIS2
 * CONTROL_LINK remediations (which carry a real `controlId`) re-attest.
 *
 * That is the intended product behaviour, re-confirmed in PR-BB rather than
 * wired to advance the gap. It is locked here because the skip is *invisible*
 * — it's the absence of a call — so a future "helpful" reconciler could add it
 * without anyone noticing the self-assessment had started answering itself.
 * Changing this must be a deliberate act that updates this test.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = 'src/app-layer/usecases/task-source-reconcile.ts';
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
const src = codeOf(fs.readFileSync(path.join(ROOT, SRC), 'utf-8'));
// DELIBERATELY RAW, for the one test below that asserts the load-bearing
// COMMENT is still there. Masking that read would delete its subject.
const srcRaw = fs.readFileSync(path.join(ROOT, SRC), 'utf-8');

describe('NIS2 plain-CONTROL_GAP reconcile skip (confirmed behaviour)', () => {
    it('reconcileControlGap only runs when the task carries a real controlId', () => {
        // The guard clause is the whole control: `task.controlId` must be
        // truthy. A bare `task.type === 'CONTROL_GAP'` check would start
        // reconciling the NIS2 nudge tasks.
        expect(src).toMatch(
            /if\s*\(\s*task\.type\s*===\s*'CONTROL_GAP'\s*&&\s*task\.controlId\s*\)/,
        );
    });

    it('the reason for the skip is documented at the call site', () => {
        // Load-bearing comment: it explains WHY an obvious-looking reconciler
        // is deliberately absent. Without it the next reader "fixes" the gap.
        expect(srcRaw).toMatch(/source of truth/i);
        expect(srcRaw).toMatch(/NIS2/);
    });

    it('no reconciler advances a self-assessment answer from a task close', () => {
        // If a future change wires the gap self-assessment into the reconcile
        // path, this fails — forcing the author to revisit the decision above
        // rather than inherit it by accident.
        expect(src).not.toMatch(/nis2(Gap)?SelfAssessment|markGapAddressed|advanceGap/i);
    });
});
