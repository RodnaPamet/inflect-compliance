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
 * The same invariant holds for internal audit's review of the auditor agent's
 * sampled workpapers (`AuditWorkpaperSampleReview`, #3677), with a second seam
 * for the answer: the sweep draws and assigns and never answers, the review
 * usecase answers and never draws or assigns. It lives here rather than in a
 * guard of its own because it is this rule — a sample is drawn, never chosen —
 * applied to the second table that samples.
 *
 * Named for the invariant, not the epic.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { allCallExpressionsOf, braceBlockAfter, codeOf, functionBodyOf } from '../helpers/source-blocks';

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

// ─── AuditWorkpaperSampleReview (#3677) ──────────────────────────────

const DRAW_SEAM = 'src/app-layer/jobs/audit-workpaper-sample-review.ts';
const ANSWER_SEAM = 'src/app-layer/usecases/audit-workpaper-sample-review.ts';

const WRITE_VERBS = ['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'];
const WRITE_CALL = new RegExp(`\\bauditWorkpaperSampleReview\\s*\\.\\s*(${WRITE_VERBS.join('|')})\\s*\\(`, 'g');
const RAW_METHOD = /\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)/;
const RAW_MUTATION_OF_TABLE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+"?AuditWorkpaperSampleReview\b/i;

/** The columns an answer is made of, and the columns an assignment is made of. */
const ANSWER_COLUMNS = ['outcome', 'dissentCodes', 'reviewedByUserId', 'reviewedAt', 'findingProposalId'];
const ASSIGNMENT_COLUMNS = ['assignedToUserId', 'unassignedReason', 'assignmentPoolSize', 'assignmentPoolDigest', 'assignedAt'];

const read = (rel: string): string => {
    const abs = repoFiles({ under: 'src' }).find((p) => repoRelative(p) === rel);
    if (!abs) throw new Error(`seam not found: ${rel}`);
    return codeOf(readFileSync(abs, 'utf8'));
};

/** The `data: { … }` object of every write call of `verb` in `code`. */
function dataBlocksOf(code: string, verb: string): string[] {
    return allCallExpressionsOf(code, `auditWorkpaperSampleReview\\s*\\.\\s*${verb}`).map((call) => braceBlockAfter(call, 'data\\s*:'));
}

const keysOf = (block: string, keys: readonly string[]) => keys.filter((k) => new RegExp(`\\b${k}\\s*[:,}]`).test(block));

describe('AuditWorkpaperSampleReview: drawn and assigned by the sweep, answered by its reviewer — and by nothing else', () => {
    const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });

    it('scans a real population', () => {
        expect(sources.length).toBeGreaterThan(500);
        const rels = sources.map(repoRelative);
        expect(rels.includes(DRAW_SEAM)).toBe(true);
        expect(rels.includes(ANSWER_SEAM)).toBe(true);
    });

    it('is written by the sweep and the review usecase only, with the verbs each needs', () => {
        const writers: Record<string, string[]> = {};
        for (const abs of sources) {
            const code = codeOf(readFileSync(abs, 'utf8'));
            const verbs = new Set<string>();
            let m: RegExpExecArray | null;
            WRITE_CALL.lastIndex = 0;
            while ((m = WRITE_CALL.exec(code)) !== null) verbs.add(m[1]);
            if (verbs.size > 0) writers[repoRelative(abs)] = [...verbs].sort();
        }
        // Exact equality: a third writer is a finding to fix, never an entry to add.
        expect(writers).toStrictEqual({
            [DRAW_SEAM]: ['createMany', 'updateMany'],
            [ANSWER_SEAM]: ['updateMany'],
        });
    });

    it('is never mutated by raw SQL from application code', () => {
        const raw = sources
            .filter((abs) => {
                const code = codeOf(readFileSync(abs, 'utf8'));
                return RAW_METHOD.test(code) && RAW_MUTATION_OF_TABLE.test(code);
            })
            .map(repoRelative);
        expect(raw).toEqual([]);
    });

    it('the sweep draws and assigns by the keyed draw, and never writes an answer', () => {
        const code = read(DRAW_SEAM);
        const body = functionBodyOf(code, 'runAuditWorkpaperSampleReview');
        expect(body).toContain('drawWorkpapersForReview(');
        expect(body).toContain('assignReviewer(');
        const created = allCallExpressionsOf(code, 'auditWorkpaperSampleReview\\s*\\.\\s*createMany');
        const moved = dataBlocksOf(code, 'updateMany');
        expect(created.length).toBe(1);
        expect(moved.length).toBe(1);
        for (const block of [...created, ...moved]) expect(keysOf(block, ANSWER_COLUMNS)).toEqual([]);
        // The re-draw is conditional on the row still being unanswered.
        const reassign = allCallExpressionsOf(code, 'auditWorkpaperSampleReview\\s*\\.\\s*updateMany')[0];
        expect(braceBlockAfter(reassign, 'where\\s*:')).toMatch(/outcome:\s*'PENDING'/);
    });

    it('the review usecase answers and links, and never moves an assignment', () => {
        const code = read(ANSWER_SEAM);
        const blocks = dataBlocksOf(code, 'updateMany');
        expect(blocks.length).toBe(2);
        for (const block of blocks) expect(keysOf(block, ASSIGNMENT_COLUMNS)).toEqual([]);
        // The answer is a conditional claim on a PENDING row assigned to the caller.
        const answer = functionBodyOf(code, 'recordWorkpaperReview');
        const claim = allCallExpressionsOf(answer, 'auditWorkpaperSampleReview\\s*\\.\\s*updateMany')[0];
        const where = braceBlockAfter(claim, 'where\\s*:');
        expect(where).toMatch(/outcome:\s*'PENDING'/);
        expect(where).toMatch(/assignedToUserId:\s*ctx\.userId/);
        // The link is set once, only on a dissent.
        const raise = functionBodyOf(code, 'raiseDissentFindingProposal');
        const link = allCallExpressionsOf(raise, 'auditWorkpaperSampleReview\\s*\\.\\s*updateMany')[0];
        expect(braceBlockAfter(link, 'where\\s*:')).toMatch(/outcome:\s*'DISSENTED',\s*findingProposalId:\s*null/);
    });
});
