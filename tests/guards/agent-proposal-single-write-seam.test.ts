/**
 * An `AgentProposal` row is created in exactly ONE place, and that place runs
 * the output guard.
 *
 * This is not stylistic. `createAgentProposal` is where `guardAgentProposal`
 * decides whether a proposal showing instruction-following from untrusted input
 * is written `QUARANTINED` instead of joining the reviewer's queue as `PENDING`.
 * A second `agentProposal.create` anywhere would not be a duplicate — it would
 * be a proposal that never met the guard at all, and it would look identical in
 * the queue to one that had. That is precisely the hole an adversarial review
 * goes looking for, and nothing failed CI if it appeared.
 *
 * The repo already writes this rule down for the identity subsystem ("Each
 * table has exactly one write seam. Do not add a second." — CLAUDE.md, JML);
 * this is the same invariant for the same reason, enforced rather than
 * described.
 *
 * Named for the invariant, not the epic.
 */
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { readFileSync } from 'fs';

/** The one file allowed to create a proposal, and the guard it must call. */
const SEAM = 'src/app-layer/usecases/agent-proposals.ts';
const GUARD = 'guardAgentProposal';

/** Creation verbs. `createMany` and `upsert` bypass the seam just as `create` would. */
const CREATE_CALL = /\bagentProposal\s*\.\s*(create|createMany|upsert)\s*\(/g;

/** Comments carry these words while documenting the rule; source must not. */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
}

describe('AgentProposal has exactly one write seam, and it is guarded', () => {
    // `repoFiles` is the option-taking one and returns ABSOLUTE paths;
    // `repoRelativeFiles()` takes no arguments and returns the WHOLE repo — an
    // `{ under: 'src' }` handed to it is silently ignored, which is how this
    // scan first reported four test files as proposal creators.
    const sources = repoFiles({ under: 'src', extensions: ['.ts'] });

    it('scans a real population (the scan itself is not vacuous)', () => {
        expect(sources.length).toBeGreaterThan(500);
        expect(sources.map(repoRelative)).toContain(SEAM);
    });

    it('creates a proposal in one file only', () => {
        const creators: string[] = [];
        for (const abs of sources) {
            const code = codeOnly(readFileSync(abs, 'utf8'));
            if (CREATE_CALL.test(code)) creators.push(repoRelative(abs));
            CREATE_CALL.lastIndex = 0;
        }
        // Exact equality, not a cap: a second creator is a finding to fix, never
        // an entry to add. There is deliberately no allowlist.
        expect(creators.sort()).toStrictEqual([SEAM]);
    });

    it('and that seam runs the output guard before it writes', () => {
        const seamAbs = sources.find((a) => repoRelative(a) === SEAM)!;
        const code = codeOnly(readFileSync(seamAbs, 'utf8'));
        const guardAt = code.indexOf(`${GUARD}(`);
        CREATE_CALL.lastIndex = 0;
        const createAt = CREATE_CALL.exec(code)?.index ?? -1;

        expect(guardAt).toBeGreaterThan(-1);
        expect(createAt).toBeGreaterThan(-1);
        // Ordering matters: a guard that runs after the row is written records a
        // verdict but cannot withhold the row from the queue.
        expect(guardAt).toBeLessThan(createAt);
    });
});
