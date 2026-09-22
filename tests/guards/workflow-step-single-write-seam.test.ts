/**
 * A `WorkflowStep` row is created in exactly ONE place, and that place also
 * writes the step's audit entry.
 *
 * ── WHY THIS BECAME WORTH ENFORCING ─────────────────────────────────────────
 *
 * It was true by accident while one driver existed: `recordStep` was private
 * to `static-driver.ts` and there was a single `workflowStep.create` in the
 * repo. A second driver changes the arithmetic, not the principle — the step
 * ledger is the run's system of record, so the number of places that write it
 * should stay one whether there are two engines or five.
 *
 * The cost of a second creator is not duplication. `recordStep` does TWO
 * things: the row, and its hash-chained `WORKFLOW_STEP` audit entry. A driver
 * that copied only the first would produce steps that happened with no durable
 * record that they did — and in the ledger they would look identical to steps
 * that were fully recorded. That is the same shape as the `AgentProposal` seam
 * next door, where a second creator would be a proposal that never met the
 * output guard.
 *
 * The repo already writes this rule down for the identity subsystem — "Each
 * table has exactly one write seam. Do not add a second." — and this is the
 * same invariant for the same reason.
 *
 * Named for the invariant, not the epic.
 */
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { readFileSync } from 'fs';

/** The one file allowed to write a step, and the audit call it must make. */
const SEAM = 'src/lib/agentic/drivers/step-recorder.ts';
const AUDIT = 'appendAuditEntry';

/** Creation verbs. `createMany` and `upsert` bypass the seam just as `create` would. */
const CREATE_CALL = /\bworkflowStep\s*\.\s*(create|createMany|upsert)\s*\(/g;

/**
 * Comments name the rule while documenting it; source must not be judged on
 * them. The repo has lost three CI round-trips to guards that read prose —
 * a table guard that audited a file for MENTIONING a component, and the
 * explicit-`any` ratchet matching an English phrase.
 */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
}

describe('WorkflowStep has exactly one write seam', () => {
    // `repoFiles` is the option-taking one returning ABSOLUTE paths;
    // `repoRelativeFiles()` takes no arguments and returns the WHOLE repo.
    const sources = repoFiles({ under: 'src', extensions: ['.ts'] });

    it('scans a real population (the scan itself is not vacuous)', () => {
        expect(sources.length).toBeGreaterThan(500);
        expect(sources.map(repoRelative)).toContain(SEAM);
    });

    it('creates a step in one file only', () => {
        const creators: string[] = [];
        for (const abs of sources) {
            const code = codeOnly(readFileSync(abs, 'utf8'));
            if (CREATE_CALL.test(code)) creators.push(repoRelative(abs));
            CREATE_CALL.lastIndex = 0;
        }
        // Exact equality, not a cap: a second creator is a finding to fix,
        // never an entry to add. There is deliberately no allowlist.
        expect(creators).toEqual([SEAM]);
    });

    it('and that seam writes the audit entry beside the row', () => {
        // The half a copy would omit. Without this the guard would be
        // satisfied by a seam that had quietly stopped auditing.
        const code = codeOnly(readFileSync(repoFiles({ under: 'src' }).find((f) => repoRelative(f) === SEAM)!, 'utf8'));
        expect(code).toContain(AUDIT);
        expect(code).toContain('WORKFLOW_STEP');
    });

    it('the detector fires on a planted second creator', () => {
        // The positive control. `creators` toEqual([SEAM]) is also satisfied
        // by a regex that matches nothing anywhere, which would be a guard
        // reporting a clean sweep of a population it cannot read.
        for (const planted of [
            'await db.workflowStep.create({ data });',
            'await tx.workflowStep.createMany({ data });',
            'await db . workflowStep . upsert ({ where });',
        ]) {
            CREATE_CALL.lastIndex = 0;
            expect(CREATE_CALL.test(planted)).toBe(true);
        }
    });

    it('does NOT fire on a read of the same model', () => {
        // `findMany` / `aggregate` / `deleteMany` are not creation, and a
        // guard that flagged them would push the next author toward an
        // allowlist rather than toward the seam.
        for (const benign of [
            'await db.workflowStep.findMany({ where });',
            'await db.workflowStep.aggregate({ _max });',
            'await tx.workflowStep.update({ where, data });',
        ]) {
            CREATE_CALL.lastIndex = 0;
            expect(CREATE_CALL.test(benign)).toBe(false);
        }
    });
});
