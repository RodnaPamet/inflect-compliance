/**
 * #3279 — a guard that WALKS `src/components` loses coverage silently as
 * #3046 moves primitives into `packages/ui`.
 *
 * THE CLASS
 * ─────────
 * #3213 recorded one instance: moving a file into `packages/ui` removed it
 * from the i18n adoption ratchet's population. That is not specific to that
 * ratchet — it is the shape of every guard whose walk root is under `src/`.
 *
 * Batch 3a demonstrated both directions on the same day:
 *
 *   border-tone-budget            went red saying the tree IMPROVED. Three
 *                                 `border-border-default` occurrences left the
 *                                 scanned tree inside the moved files, so the
 *                                 ratchet reported unspent slack and advised
 *                                 lowering the budget — which would book a
 *                                 coverage loss as progress and hand a future
 *                                 regression three slots of headroom.
 *   still-surface-button-material went red on its own NEGATIVE CONTROL: the
 *                                 class it asserts is written somewhere is
 *                                 emitted by a moved file, so the assertion
 *                                 that exists to prove the check can say NO is
 *                                 the one that failed.
 *
 * Both were loud. The failure mode this file exists for is the quiet one: a
 * walk root whose subject moves, which then passes over a smaller population
 * forever, with no diff and no red. A guard with a baseline has something to go
 * stale; a guard without one has nothing.
 *
 * WALKERS, NOT READERS — and the difference is the whole measurement
 * ─────────────────────────────────────────────────────────────────
 * A guard that READS a named file (`src/components/ui/button.tsx`) and finds it
 * moved fails loudly with ENOENT. A guard that WALKS a directory and finds a
 * file moved just counts less. Only the second class is silent, and conflating
 * them is how I published the wrong number twice:
 *
 *   81   #3279's filed figure — a crude detector over "mentions src/components"
 *   207  a string-literal detector that still counted named-file reads
 *   32   walk roots only, comments stripped, `packages/ui`-aware suites excluded
 *
 * 173 of that 207 only read named files. The denominator is printed below for
 * the same reason: a detector that silently stopped matching would report zero
 * offenders and pass.
 *
 * WHAT THIS DOES NOT CLAIM
 * ────────────────────────
 * Not that all 32 are defects. A guard loses real coverage only when a file it
 * cares about actually moves, and some of these walk subtrees #3046 will never
 * touch (`src/components/processes`). The count is a CANDIDATE POPULATION, and
 * the ratchet's job is that it can only go down and that a new member is named
 * on sight — not that it should be zero today.
 *
 * AND NOT THAT THIS MIRRORS TAILWIND
 * ──────────────────────────────────
 * Tempting, and wrong — worth stating because #3279's own text got it wrong.
 * `tailwind.config.js` declares `content: ['./src/**\/*']`, so the obvious
 * story is "the real glob will gain packages/ui and a hand-copy will not".
 * Tailwind v4 does not work that way: it auto-detects from the cwd across the
 * whole repository, and `src/app/globals.css`'s docblock records the
 * measurement — compiling with and without its `@source "../../packages/ui/src"`
 * line emits BYTE-IDENTICAL output, 248,903 bytes either way, with probes in
 * `scripts/` and `infra/` picked up too though neither is matched by `content`.
 * So `content` governs nothing and there is no glob to drift from. The reason a
 * walk root should know both places is simply that both places hold UI source.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';
import { REPO_ROOT, repoRelative } from '../helpers/repo-files';

/**
 * Suites that walk a `src/components` directory and never name `packages/ui`.
 *
 * Can only go DOWN. Raising it means a new guard was written with a population
 * that will narrow silently; widen that guard instead of this number.
 */
// 32 -> 21 at #3046 batch 3a. This batch repoints ELEVEN guards to walk
// `packages/ui/src` alongside `src/components`, which is the class this ratchet
// exists to retire — so the count falling is the intended direction and the
// drift sentinel correctly refused the old number.
//
// Worth recording that this is the ratchet's FIRST payment. It was seeded at 32
// in #3279 from a measurement on main, and the very next PR through the queue
// was the one widening those walkers. The sentinel caught a four-hour-old green
// on a 54-file change that had drifted 28 commits behind main — had the branch
// been enqueued on its stale green instead of updated first, this would have
// surfaced as a merge-group ejection rather than a PR check.
const SRC_ONLY_WALKER_BASELINE = 21;

/** A directory literal — a walk root. Excludes anything with a file extension. */
const DIR_LITERAL = /['"`](?:\.{0,2}\/)?src\/components(?:\/[A-Za-z0-9_-]+)*['"`]/g;
/** Any mention of the package, in code. Enough to show the author knew. */
const KNOWS_PACKAGE = /['"`][^'"`]*packages\/ui[^'"`]*['"`]/;

function suitesUnder(...dirs: readonly string[]): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.test\.tsx?$/.test(e.name)) out.push(full);
        }
    };
    for (const d of dirs) walk(path.join(REPO_ROOT, d));
    return out.sort();
}

interface Offender {
    readonly rel: string;
    readonly roots: readonly string[];
}

function classify(): { offenders: Offender[]; scanned: number; packageAware: number } {
    const offenders: Offender[] = [];
    let packageAware = 0;
    const files = suitesUnder('tests/guards', 'tests/guardrails');

    for (const abs of files) {
        // Comments stripped: a docblock DISCUSSING `src/components` is not a
        // walk root, and this file is itself the proof — it names the path
        // many times above and must not count itself.
        const code = codeOf(fs.readFileSync(abs, 'utf-8'));
        const dirs = [...new Set(code.match(DIR_LITERAL) ?? [])].map((s) => s.slice(1, -1));
        if (dirs.length === 0) continue;
        if (KNOWS_PACKAGE.test(code)) {
            packageAware += 1;
            continue;
        }
        offenders.push({ rel: repoRelative(abs), roots: dirs.sort() });
    }
    return { offenders, scanned: files.length, packageAware };
}

describe('#3279 — a src/-scoped walk root narrows silently as #3046 proceeds', () => {
    const { offenders, scanned, packageAware } = classify();

    it('the detector can still see the population it grades', () => {
        // The denominator beside the result. A detector whose regex stopped
        // matching — a quote style change, a helper that builds the path from
        // parts — would report zero offenders and PASS, which is the exact
        // failure this whole file is about. These three numbers moving to zero
        // together is the tell.
        expect(scanned).toBeGreaterThan(700);
        expect(offenders.length).toBeGreaterThan(0);
        expect(packageAware).toBeGreaterThan(0);
    });

    it(`src-only walk roots stay at or below ${SRC_ONLY_WALKER_BASELINE}`, () => {
        if (offenders.length > SRC_ONLY_WALKER_BASELINE) {
            const added = offenders
                .map((o) => `  ${o.rel}  walks ${o.roots.join(', ')}`)
                .join('\n');
            throw new Error(
                `${offenders.length} suites walk a src/components directory without ` +
                    `naming packages/ui (baseline ${SRC_ONLY_WALKER_BASELINE}).\n\n` +
                    `${added}\n\n` +
                    `A walk root under src/ loses files to packages/ui SILENTLY — the\n` +
                    `guard keeps passing over a smaller population. Fix the new guard,\n` +
                    `not this number: walk both roots, or scope to a subtree #3046 will\n` +
                    `not touch and say so in a comment.\n\n` +
                    `If a guard was legitimately widened and this count FELL, lower the\n` +
                    `baseline to the live count in the same diff.`,
            );
        }
        expect(offenders.length).toBeLessThanOrEqual(SRC_ONLY_WALKER_BASELINE);
    });

    it('the baseline has not drifted above the live count', () => {
        // Symmetric to every other ratchet here: slack above the live count is
        // headroom a future regression spends with a green build.
        expect(offenders.length).toBe(SRC_ONLY_WALKER_BASELINE);
    });
});
