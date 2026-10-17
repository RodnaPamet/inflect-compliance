/**
 * A source file that cites a test file must cite one that exists (#3355, #3650).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS WORSE THAN A DEAD LINK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/lib/security/route-permissions.ts` told a reader, in its header and
 * again in its rollout checklist, to verify a new route with
 * `tests/guards/route-permission-coverage.test.ts`. That file has never existed
 * in this repository's history — `git log --diff-filter=D --all` finds no
 * deletion to explain it. The real guard is
 * `tests/guardrails/api-permission-coverage.test.ts`, which the same file
 * already cited 230 lines further down.
 *
 * A rotted `file:line` tells a reader the citation moved. A citation to a file
 * that was never written tells a reader the PROTECTION EXISTS, so they stop
 * looking — which is the whole value the citation was supposed to add. #3650
 * records four claims of that shape, each asserting in the present tense that a
 * named guard pins an invariant nothing pins.
 *
 * Measured when this was written: 188 distinct test paths cited across `src/`,
 * of which 12 did not exist.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO THINGS THIS GUARD DOES DIFFERENTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. IT DOES NOT STRIP COMMENTS, and that inverts the usual rule. Most guards
 *    here mask comments first, because a pattern found in prose is usually a
 *    scar rather than a wound. Here the prose IS the subject: every one of these
 *    citations lives in a docblock. Stripping comments would make this guard
 *    pass over nothing, which is why the population floor below exists.
 *
 * 2. IT HAS NO EXEMPTION LIST, deliberately. Two legitimate cases came up while
 *    fixing the twelve — a sentence recording a guard that was RETIRED (`that
 *    guard was removed in #1800`) and an instruction to ADD a test at a path
 *    that therefore does not exist yet. Both were reworded to name the guard
 *    without a live path shape, rather than exempted. An exemption list on a
 *    rule this simple is where a real breakage would eventually be parked: two
 *    such lists were removed from this repo in #3638 the same week, one of them
 *    carrying a reason that was measurably false.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3355
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

/** A repo-relative test path as it appears in prose: `tests/…/x.test.ts(x)`. */
const CITATION = /tests\/[A-Za-z0-9_/.-]+\.test\.tsx?/g;

interface Citation {
    readonly from: string;
    readonly line: number;
    readonly cited: string;
}

/**
 * Every test path cited by a tracked file under `src/`.
 *
 * Population from git (`repoFiles`), not a directory walk, so an untracked
 * scratch file cannot add or hide a citation.
 */
function citations(): Citation[] {
    const out: Citation[] = [];
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        lines.forEach((text, i) => {
            for (const cited of text.match(CITATION) ?? []) {
                out.push({ from: rel, line: i + 1, cited });
            }
        });
    }
    return out;
}

const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

describe('a cited test path exists (#3355)', () => {
    it('finds a substantial population of citations', () => {
        // Without this the assertion below passes over nothing the moment the
        // regex stops matching — and since citations live in COMMENTS, a future
        // "strip comments first, like the other guards" change would do exactly
        // that while looking like a correctness improvement.
        expect(citations().length).toBeGreaterThan(100);
    });

    it('every test path cited in src/ exists on disk', () => {
        const broken = citations()
            .filter((c) => !exists(c.cited))
            .map((c) => `${c.from}:${c.line} cites ${c.cited}`);
        // Fix by repointing at the test that actually proves the claim —
        // verified by READING it, not by name similarity. Two of the seven
        // repointings in #3355 looked right by name and proved nothing about
        // their claim. If no test proves it, say so in the prose and file the
        // gap; do not cite a neighbour.
        expect(broken).toEqual([]);
    });

    it('reports a citation whose target is absent, and accepts one whose target is not', () => {
        // The negative control, driving the real regex and the real `exists`.
        // A guard that silently matched nothing would satisfy the assertion
        // above for ever.
        const line = 'see `tests/guards/this-file-does-not-exist.test.ts` for the ratchet';
        const found = line.match(CITATION) ?? [];
        expect(found).toEqual(['tests/guards/this-file-does-not-exist.test.ts']);
        expect(found.every((f) => !exists(f))).toBe(true);

        // And a real one, so the control cannot pass by reporting everything
        // absent — which is how a broken `exists` would look identical.
        expect(exists('tests/guards/no-epic-named-ratchets.test.ts')).toBe(true);

        // The shapes that must NOT be read as citations: a retired guard named
        // without a path, and a directory instruction. Both arose for real.
        expect('a now-retired guard, `rq2-9-matrix-movement` (removed in #1800)'.match(CITATION)).toBeNull();
        expect('add a unit test under `tests/unit/security/`'.match(CITATION)).toBeNull();
    });
});
