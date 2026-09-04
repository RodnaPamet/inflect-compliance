/**
 * The five generic control tasks may exist in exactly one place.
 *
 * They lived as FOUR byte-identical copies — `seed.ts`, `seed-catalog.ts`,
 * `catalog-applier.ts` and `scripts/backfill-framework-catalog.mjs` — and two
 * of those are npm-reachable (`db:seed`, `framework:import`). A fix applied to
 * one and not the others would have kept emitting the old text from a path
 * nobody was looking at, which is precisely how four copies happened in the
 * first place.
 *
 * This is a DOWNWARD ratchet. It does not merely forbid a fifth copy: as the
 * content PRs land, the allowlist below shrinks, and when the last framework
 * has authored tasks `prisma/generic-template-tasks.ts` is deleted and this
 * file asserts the strings are gone entirely.
 *
 * The strings are frozen here deliberately, not imported. Importing them
 * would mean an edit to the constant silently changed what this test can
 * catch — the classic derived-value-equals-constant shape. If they ever
 * legitimately change, both copies move in the same commit and a reviewer
 * sees it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { GENERIC_TEMPLATE_TASKS } from '../../prisma/generic-template-tasks';

/** Frozen. See the docblock for why this is not an import. */
const FROZEN_GENERIC_TITLES = [
    'Define control owner and scope',
    'Document procedure or policy',
    'Implement technical or operational measure',
    'Collect evidence of implementation',
    'Review effectiveness',
] as const;

/**
 * Files permitted to contain the strings, each with the reason.
 *
 * Shrink this. Do not grow it.
 */
const ALLOWED: Record<string, string> = {
    'prisma/generic-template-tasks.ts':
        'The single owner. Deleted when the last framework has authored content.',
    'scripts/backfill-framework-catalog.mjs':
        'A completed one-off production backfill, in ESM, run directly with node — it cannot import ' +
        'the TypeScript constant. Frozen rather than converted: what it wrote is history, and ' +
        'rewriting the strings would change a record rather than a behaviour.',
    'tests/guardrails/no-generic-task-strings.test.ts': 'This file. It has to name them to forbid them.',
};

/**
 * Does `content` carry `title` as a COMPLETE string literal?
 *
 * A bare `includes` is too loose, and it fired on its first run:
 * `src/data/clauses.ts:123` reads `'Review effectiveness of corrective
 * actions'`, an ISO clause item that merely starts with the shortest of the
 * five titles. Matching the closing delimiter is what distinguishes a copy of
 * the string from a sentence that begins with it — a real copy is always a
 * complete literal, because that is what a task title is.
 */
function containsAsCompleteLiteral(content: string, title: string): boolean {
    return [`'${title}'`, `"${title}"`, `\`${title}\``].some((lit) => content.includes(lit));
}

describe('the generic tasks have exactly one owner', () => {
    it('the frozen copy still matches the constant', () => {
        // If this fails, someone edited the constant. That is allowed — but
        // the frozen list here has to move in the same commit, or this whole
        // file quietly stops matching anything that ships.
        expect(GENERIC_TEMPLATE_TASKS.map((t) => t.title)).toEqual([...FROZEN_GENERIC_TITLES]);
    });

    it('no file outside the allowlist contains a generic task title', () => {
        const offenders: string[] = [];
        for (const rel of repoRelativeFiles()) {
            if (ALLOWED[rel]) continue;
            if (!/\.(ts|tsx|mjs|js|json)$/.test(rel)) continue;
            if (rel.startsWith('node_modules/')) continue;
            let content: string;
            try {
                content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            } catch {
                continue;
            }
            // Comments stripped first. A docblock that NAMES a generic title —
            // control-task-conformance.test.ts quotes one to explain why
            // substring matching is wrong — is discussing the string, not
            // shipping it. The sender-identity guard makes the same
            // distinction for the same reason.
            if (FROZEN_GENERIC_TITLES.some((title) => containsAsCompleteLiteral(codeOf(content), title))) {
                offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every allowlisted file exists and actually contains one (no stale entries)', () => {
        // An allowlist entry for a file that no longer has the strings is a
        // lie that makes the list look larger than the debt. House style.
        const stale = Object.keys(ALLOWED).filter((rel) => {
            const abs = path.join(REPO_ROOT, rel);
            if (!fs.existsSync(abs)) return true;
            const body = codeOf(fs.readFileSync(abs, 'utf8'));
            return !FROZEN_GENERIC_TITLES.some((t) => containsAsCompleteLiteral(body, t));
        });
        expect(stale).toEqual([]);
    });

    it('the allowlist is not growing', () => {
        // Three today: the owner, the frozen one-off, and this file. Any
        // fourth is a new copy, which is the thing being prevented.
        expect(Object.keys(ALLOWED)).toHaveLength(3);
    });
});
