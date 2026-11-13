/**
 * A `WorkflowRunDeferral` row is written in exactly TWO places (Step 2f of
 * `docs/claude-tool-runner-design.md`, #5530): the engine's store
 * (`drivers/deferral-store.ts`) and the decision hook
 * (`usecases/workflow-run-deferrals.ts`).
 *
 * A deferral is a proposal a run waits on, and its transcript is the
 * conversation the run resumes from. A third writer could resume a run with no
 * decision (move a row to DECIDED outside the queue's hook), keep a transcript
 * past the run (skip the clear), or park a run nobody can continue. The
 * database's trigger holds the one-way status and the clear; this holds who
 * may write at all. Raw SQL is a second path, and is checked too.
 *
 * Named for the invariant, not the step.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SEAMS = ['src/app-layer/usecases/workflow-run-deferrals.ts', 'src/lib/agentic/drivers/deferral-store.ts'];

const WRITE_CALL =
    /\bworkflowRunDeferral\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
const RAW_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?WorkflowRunDeferral"?/i;

function codeOnly(src: string): string {
    return codeOf(src)
        .split('\n')
        .map((l) => codeOf(l))
        .join('\n');
}

describe('WorkflowRunDeferral has exactly two write seams', () => {
    const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });

    it('scans a real population', () => {
        expect(sources.length).toBeGreaterThan(500);
        for (const seam of SEAMS) expect(sources.map(repoRelative)).toContain(seam);
    });

    it('writes a deferral in the two seams only, by the client or by raw SQL', () => {
        const writers = new Set<string>();
        for (const abs of sources) {
            const code = codeOnly(readFileSync(abs, 'utf8'));
            WRITE_CALL.lastIndex = 0;
            if (WRITE_CALL.test(code) || RAW_WRITE.test(code)) writers.add(repoRelative(abs));
        }
        // Exact equality: an allowlisted seam that stops writing fails too.
        expect([...writers].sort()).toEqual([...SEAMS].sort());
    });

    it('the detector fires on a planted writer, and not on a read', () => {
        for (const planted of [
            'await db.workflowRunDeferral.create({ data });',
            'await tx . workflowRunDeferral . updateMany ({ where });',
            'await db.workflowRunDeferral.deleteMany({ where });',
        ]) {
            WRITE_CALL.lastIndex = 0;
            expect(WRITE_CALL.test(planted)).toBe(true);
        }
        expect(RAW_WRITE.test('UPDATE "WorkflowRunDeferral" SET "status" = \'DECIDED\'')).toBe(true);
        for (const benign of ['await db.workflowRunDeferral.findFirst({ where });', 'await db.workflowRunDeferral.count()']) {
            WRITE_CALL.lastIndex = 0;
            expect(WRITE_CALL.test(benign)).toBe(false);
        }
    });
});
