/**
 * The skill that enumerates harness criteria must enumerate the LIVE ladder.
 *
 * ═══ WHY THIS DID NOT EXIST, AND WHY IT SHOULD ═══
 *
 * `harness-level-assessment/SKILL.md` lists the criteria by id, rung by rung. It
 * is the only prose in the repository that does, and nothing compared it to
 * `HARNESS_CRITERIA`.
 *
 * The OpenShell roadmap assumed the mount gate covered this: "the mount gate
 * refuses SET_MISMATCH and HASH_MISMATCH until somebody" updates the skill. It
 * does not. Those refusals bind a record to the skill's own text, version and
 * evaluation set — they fire when the SKILL changes without re-recording, and
 * say nothing about the ladder. Measured: adding `H3.egress_enforced` to the
 * ladder left the skill a criterion short and every suite green.
 *
 * So the drift is silent in exactly the direction that matters. An assessor
 * working from a stale enumeration returns verdicts for six H3 criteria when the
 * rung has seven, and `parseHarnessAssessment` refuses an answer that leaves a
 * criterion out — so the stale skill produces a refused assessment at runtime,
 * for a reason no test names.
 *
 * ═══ BOTH DIRECTIONS, AND THE SECOND IS THE EASY ONE TO FORGET ═══
 *
 *   ladder → skill   a criterion the ladder requires and the skill never names
 *   skill → ladder   an id the skill names that the ladder does not define,
 *                    which is what a rename or a removal leaves behind
 *
 * The ladder's own rule is that ids "are authored, never generated, and never
 * renamed", so the second direction is about removals and typos rather than
 * renames — a typo'd id in the skill is an instruction to assess something that
 * does not exist.
 */
import * as fs from 'fs';
import * as path from 'path';

import { HARNESS_CRITERIA, ALL_HARNESS_CRITERIA } from '@/lib/agentic/harness-ladder';

const SKILL = path.join(
    process.cwd(),
    'src/lib/agentic/flue/skills/harness-level-assessment/SKILL.md',
);

/** Every `H<rung>.<id>` the text names, deduplicated. */
export function criteriaNamedIn(text: string): string[] {
    return [...new Set(text.match(/\bH[0-5]\.[a-z_]+\b/g) ?? [])].sort();
}

/** Ladder criteria the text never names. */
export function unnamedByText(all: readonly string[], named: readonly string[]): string[] {
    const seen = new Set(named);
    return all.filter((c) => !seen.has(c));
}

/** Ids the text names that the ladder does not define. */
export function unknownToLadder(all: readonly string[], named: readonly string[]): string[] {
    const defined = new Set(all);
    return named.filter((c) => !defined.has(c));
}

describe('the assessment skill enumerates the live ladder', () => {
    const text = fs.readFileSync(SKILL, 'utf8');
    const named = criteriaNamedIn(text);

    it('found criteria in the text at all (the scan is not vacuous)', () => {
        // Without this, a regex that stopped matching would make both
        // assertions below pass by naming nothing.
        expect(named.length).toBeGreaterThanOrEqual(ALL_HARNESS_CRITERIA.length);
        expect(ALL_HARNESS_CRITERIA.length).toBeGreaterThan(20);
    });

    it('names every criterion the ladder requires', () => {
        expect(unnamedByText(ALL_HARNESS_CRITERIA, named)).toEqual([]);
    });

    it('names no criterion the ladder does not define', () => {
        expect(unknownToLadder(ALL_HARNESS_CRITERIA, named)).toEqual([]);
    });

    it('covers each rung that has criteria', () => {
        // A rung dropped wholesale from the prose would pass the two checks
        // above only if every one of its ids also vanished from the ladder, but
        // stating it per rung makes the failure name the rung.
        for (const [rung, criteria] of Object.entries(HARNESS_CRITERIA)) {
            if (criteria.length === 0) continue;
            expect(unnamedByText(criteria as readonly string[], named)).toEqual([]);
        }
    });
});

describe('the comparisons can fail, in both directions', () => {
    it('flags a ladder criterion the text omits', () => {
        expect(unnamedByText(['H3.a', 'H3.b'], ['H3.a'])).toEqual(['H3.b']);
    });

    it('flags an id the text invents', () => {
        expect(unknownToLadder(['H3.a'], ['H3.a', 'H3.typo'])).toEqual(['H3.typo']);
    });

    it('is empty when the two agree', () => {
        expect(unnamedByText(['H3.a'], ['H3.a'])).toEqual([]);
        expect(unknownToLadder(['H3.a'], ['H3.a'])).toEqual([]);
    });

    it('reads ids out of prose, backticks and parentheses alike', () => {
        expect(criteriaNamedIn('pinned (`H3.manifests_pinned`), and H2.policy_card too')).toEqual([
            'H2.policy_card',
            'H3.manifests_pinned',
        ]);
    });
});
