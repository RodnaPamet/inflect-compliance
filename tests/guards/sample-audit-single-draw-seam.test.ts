/**
 * A SAMPLE AUDIT IS DRAWN, NEVER CHOSEN.
 *
 * `AgentProposalSampleAudit` rows are created in exactly ONE place — the
 * sampler job — and that place selects by keyed rank rather than by anybody's
 * judgement.
 *
 * This is not stylistic. The row's only purpose is to measure whether approvals
 * on the propose-not-commit queue mean anything (OWASP ASI09), and the
 * measurement is worth exactly as much as the randomness of the draw. A second
 * create site — an admin "audit this one" button, a script, a helpful bulk
 * action — would let somebody choose WHICH approvals get re-examined, and the
 * disagreement rate would then describe that choice rather than the queue. It
 * would look identical in the table to a drawn row.
 *
 * The repo already writes this rule down twice: for the identity subsystem
 * ("Each table has exactly one write seam. Do not add a second." — CLAUDE.md,
 * JML) and for `AgentProposal` itself
 * (`tests/guards/agent-proposal-single-write-seam.test.ts`). This is the same
 * invariant for a table where the stake is the honesty of a metric.
 *
 * Named for the invariant, not the epic.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

/** The one file allowed to open a sample audit, and the selector it must use. */
const SEAM = 'src/app-layer/jobs/agent-proposal-sample-audit.ts';
const SELECTOR = 'selectSample';

/** Creation verbs. `createMany` and `upsert` bypass the seam just as `create` would. */
const CREATE_CALL = /\bagentProposalSampleAudit\s*\.\s*(create|createMany|upsert)\s*\(/g;

describe('AgentProposalSampleAudit has exactly one draw seam', () => {
    // `repoFiles` is the option-taking one and returns ABSOLUTE paths;
    // `repoRelativeFiles()` takes no arguments and returns the WHOLE repo, so an
    // `{ under: 'src' }` handed to it is silently ignored.
    const sources = repoFiles({ under: 'src', extensions: ['.ts'] });

    it('scans a real population (the scan itself is not vacuous)', () => {
        expect(sources.length).toBeGreaterThan(500);
        // `includes` rather than `toContain`: the assertion is about the file
        // LIST, and a needle-uniqueness ratchet reading `toContain` cannot tell
        // that subject apart from a whole-file read.
        expect(sources.map(repoRelative).includes(SEAM)).toBe(true);
    });

    it('creates a sample audit in one file only', () => {
        const creators: string[] = [];
        for (const abs of sources) {
            // Comments are masked at the READ SEAM (#2246), so the prose in
            // this file's own subject explaining the rule cannot satisfy — or
            // violate — an assertion about code.
            const code = codeOf(readFileSync(abs, 'utf8'));
            if (CREATE_CALL.test(code)) creators.push(repoRelative(abs));
            CREATE_CALL.lastIndex = 0;
        }
        // Exact equality, not a cap: a second creator is a finding to fix, never
        // an entry to add. There is deliberately no allowlist.
        expect(creators.sort()).toStrictEqual([SEAM]);
    });

    it('and that seam picks by the keyed sampler rather than by hand', () => {
        // Without this the guard would be satisfied by a single create site
        // that took the first N rows, or the newest, or the ones somebody
        // flagged — one seam, and a selection nobody could call random.
        //
        // The read is BOUND to the run function rather than to the whole file:
        // an import of `selectSample` at the top would satisfy a whole-file
        // needle while the body picked rows some other way, and a narrowed read
        // is what CLAUDE.md's assertion-reach section asks for besides.
        const abs = repoFiles({ under: 'src' }).find((p) => repoRelative(p) === SEAM)!;
        const body = functionBodyOf(codeOf(readFileSync(abs, 'utf8')), 'runAgentProposalSampleAudit');
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain(SELECTOR);
    });
});
