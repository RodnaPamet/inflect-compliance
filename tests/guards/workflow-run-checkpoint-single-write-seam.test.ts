/**
 * A `WorkflowRunCheckpoint` row is written in exactly ONE place (#5854 item 3):
 * the engine's checkpoint store (`drivers/checkpoint-store.ts`).
 *
 * The checkpoint is the conversation a Tool Runner run continues from when its
 * segment is retried, and the anchor that tells a retried Flue or Managed
 * Agents segment it is a retry. A second writer could write a conversation the
 * run never had (and it would be continued from), keep one past the run's end
 * (skip the clear), or move the anchor so a retry reads as a first attempt.
 * Every write in the store is fenced on the run lease; a writer elsewhere would
 * not be. The database's trigger freezes a settled row; this holds who may
 * write at all. Raw SQL is a second path, and is checked too.
 *
 * Named for the invariant, not the step.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SEAMS = ['src/lib/agentic/drivers/checkpoint-store.ts'];

const WRITE_CALL =
    /\bworkflowRunCheckpoint\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
const RAW_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?WorkflowRunCheckpoint"?/i;

function codeOnly(src: string): string {
    return codeOf(src)
        .split('\n')
        .map((l) => codeOf(l))
        .join('\n');
}

describe('WorkflowRunCheckpoint has exactly one write seam', () => {
    const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });

    it('scans a real population', () => {
        expect(sources.length).toBeGreaterThan(500);
        for (const seam of SEAMS) expect(sources.map(repoRelative)).toContain(seam);
    });

    it('writes a checkpoint in the store only, by the client or by raw SQL', () => {
        const writers = new Set<string>();
        for (const abs of sources) {
            const code = codeOnly(readFileSync(abs, 'utf8'));
            WRITE_CALL.lastIndex = 0;
            if (WRITE_CALL.test(code) || RAW_WRITE.test(code)) writers.add(repoRelative(abs));
        }
        // Exact equality: a seam that stops writing fails too.
        expect([...writers].sort()).toEqual([...SEAMS].sort());
    });

    it('the detector fires on a planted writer, and not on a read', () => {
        for (const planted of [
            'await db.workflowRunCheckpoint.create({ data });',
            'await tx . workflowRunCheckpoint . updateMany ({ where });',
            'await db.workflowRunCheckpoint.deleteMany({ where });',
        ]) {
            WRITE_CALL.lastIndex = 0;
            expect(WRITE_CALL.test(planted)).toBe(true);
        }
        expect(RAW_WRITE.test('UPDATE "WorkflowRunCheckpoint" SET "transcriptJson" = NULL')).toBe(true);
        for (const benign of ['await db.workflowRunCheckpoint.findFirst({ where });', 'await db.workflowRunCheckpoint.count()']) {
            WRITE_CALL.lastIndex = 0;
            expect(WRITE_CALL.test(benign)).toBe(false);
        }
    });
});
