/**
 * "Current state (true today)" must not describe a retired thing as operating.
 *
 * #3579. The Laya estate was retired on 2026-10-14 and the retirement commit
 * DID update the design document — it added banners at the tops of subsections.
 * It did not rewrite the bodies underneath, so nine passages went on describing
 * a container that no longer exists, a provider that was deleted, and a key
 * rotation the owner had deferred. One of them read "the Laya service now
 * running on".
 *
 * THE MECHANISM IS WHAT NEEDS GUARDING, not that one lapse. A banner at the top
 * of a section is the natural minimum effort under time pressure, it reads as
 * sufficient, and it leaves the body wrong. A reminder would not have caught it;
 * the retirement author believed the doc was updated, and in a sense it was.
 *
 * THE RULE: inside the `## Current state (true today)` section, a retired
 * subject may appear only where its ENCLOSING SUBSECTION carries a status
 * banner. Subsection scope is the point — a banner governs what it introduces,
 * and #3579's own measurement used a fixed 12-line lookback, which reported two
 * false positives in a long section whose banner sat further up. Getting the
 * scope wrong in either direction makes the guard useless: too narrow and it
 * cries wolf, too wide and one banner excuses the whole document.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const DESIGN = 'docs/legacy-access-recertification-design.md';
const ROOT = path.resolve(__dirname, '../..');

/**
 * Identifiers this programme DELETED, and must therefore stop describing as
 * live.
 *
 * SPECIFIC IDENTIFIERS, NOT THE WORD "LAYA", and finding out why is the reason
 * this list is worth reading. My first cut was `['laya']`, and the honesty test
 * below rejected it — correctly:
 *
 *   · `LAYA_MODEL = 'laya-multilingual'`, `LAYA_MAX_CHOICE_OPTIONS` and the
 *     `'jev' | 'laya' | 'stub'` provider union are all still in `src/` ON
 *     PURPOSE. The `systemone` wire is shared with Jev, so retiring the Laya
 *     ESTATE did not retire the protocol that named it.
 *   · and `/laya/i` also matches `displayable`, `replayable` and
 *     `overlayActive` — a pattern that catches far more than it names.
 *
 * So the policed subjects are the things actually deleted: the two environment
 * variables and the provider module. Each is absent from `src/` as code, which
 * the test below checks rather than assumes — that is what keeps "retired" a
 * fact instead of a claim, and it is what stopped me policing a word the
 * product still uses.
 *
 * `TypeSafe` is deliberately absent too, for the same reason in a different
 * shape: its code exists on purpose (`src/env.ts`, `jev-provider.ts`), recorded
 * in the roadmap's own first unticked criterion. The honest statement about it
 * is "withdrawn processor, dormant code" — which its section now says in its
 * title, and which the value check below holds to the code.
 */
const RETIRED_SUBJECTS = ['LAYA_BASE_URL', 'LAYA_API_KEY', 'laya-provider'] as const;

/**
 * A line that introduces or continues a status banner — or that states the
 * retirement itself.
 *
 * `no longer exists` and friends are in here deliberately: a line SAYING the
 * thing is gone is not a line claiming it is live. Without that, the guard
 * fails on its own fix — which it did, on the sentence "could set
 * `LAYA_BASE_URL` — the variable no longer exists". A scar is not a wound, and
 * this is where that rule is encoded.
 */
const BANNER =
    /RETIRED|REMOVED|WITHDRAWN|DEFERRED|withdraw|no longer (runs|exists|fires)|was deleted|were deleted|Status, \d{4}-\d{2}-\d{2}/;

const designLines = fs.readFileSync(path.join(ROOT, DESIGN), 'utf-8').split('\n');

/** The `## Current state (true today)` section, as a half-open line range. */
const currentState = (() => {
    const start = designLines.findIndex((l) => /^## .*[Cc]urrent state/.test(l));
    const end = designLines.findIndex((l, i) => i > start && /^## /.test(l));
    return { start, end: end === -1 ? designLines.length : end };
})();

/**
 * Every region of Current state, as half-open line ranges.
 *
 * REGIONS, NOT SUBSECTIONS, and a mutation proved the difference matters. The
 * first version iterated lines matching `^#{3,4} `, which left the PREAMBLE —
 * everything between the `## Current state` heading and the first `###` —
 * scanned by nothing. Inserting "the adjudicator reads `LAYA_BASE_URL` on every
 * run" directly under the section heading passed the guard cleanly.
 *
 * So the preamble is a region of its own. A banner governs the region it opens,
 * and every line of the section now belongs to exactly one region.
 */
function regions(): ReadonlyArray<{ heading: string; start: number; end: number }> {
    const heads: number[] = [];
    for (let i = currentState.start; i < currentState.end; i++) {
        if (/^#{3,4} /.test(designLines[i])) heads.push(i);
    }
    const out = heads.map((h, n) => ({
        heading: designLines[h],
        start: h,
        end: n + 1 < heads.length ? heads[n + 1] : currentState.end,
    }));
    // The preamble, when there is one.
    const firstHead = heads.length ? heads[0] : currentState.end;
    if (firstHead > currentState.start + 1) {
        out.unshift({
            heading: '(preamble)',
            start: currentState.start,
            end: firstHead,
        });
    }
    return out;
}

describe('"Current state (true today)" stays true (#3579)', () => {
    it('finds the section and its regions at all', () => {
        // THE DENOMINATOR. Rename the heading and every assertion below would
        // pass over nothing — the exact way this guard would stop guarding.
        expect(currentState.start).toBeGreaterThanOrEqual(0);
        expect(currentState.end).toBeGreaterThan(currentState.start + 50);
        expect(regions().length).toBeGreaterThan(5);
    });

    it('lists only subjects that really are gone from the code', () => {
        // WHAT KEEPS THE CURATED LIST HONEST. A term stays on it only while
        // `src/` contains no CODE naming it — comments do not count, because a
        // comment recording a removal is the removal, not a survival. Without
        // this, the list could police something the product still uses and the
        // guard would be demanding a lie.
        const srcFiles: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.tsx?$/.test(e.name)) srcFiles.push(p);
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(srcFiles.length).toBeGreaterThan(200);

        // CASE-SENSITIVE, because these are identifiers rather than words. A
        // case-insensitive match is how `laya` caught `displayable`.
        const stillInCode = RETIRED_SUBJECTS.filter((subject) =>
            srcFiles.some((f) => codeOf(fs.readFileSync(f, 'utf-8')).includes(subject)),
        );
        expect(stillInCode).toEqual([]);
    });

    it('mentions a retired subject only under a banner', () => {
        // Mapped to a list of offenders rather than asserted in a loop, so the
        // failure names every line at once and the subject is not a loop
        // binding the Class D analyser cannot resolve.
        // PARAGRAPH SCOPE, NOT REGION SCOPE — and the difference is a mutation
        // that got through. The first version excused a whole region if ANY
        // line in it carried a banner word, so inserting "Set `LAYA_BASE_URL`
        // to point at the service" into a long subsection passed cleanly: that
        // subsection happens to say elsewhere that a record "was removed".
        //
        // One banner-ish word must not excuse everything beneath it. That is
        // the "too wide" failure this guard's own docstring warns about, and I
        // built it anyway. A banner governs its PARAGRAPH — the contiguous
        // non-blank block it sits in — which is the unit a reader also takes it
        // to govern.
        const paragraphOf = (at: number): string[] => {
            let a = at;
            let b = at;
            while (a > currentState.start && designLines[a - 1].trim() !== '') a -= 1;
            while (b < currentState.end - 1 && designLines[b + 1].trim() !== '') b += 1;
            return designLines.slice(a, b + 1);
        };
        const offenders = designLines
            .slice(currentState.start, currentState.end)
            .map((line, n) => ({ line, idx: currentState.start + n }))
            .filter(({ line }) => !line.trimStart().startsWith('>'))
            .filter(({ line }) => !BANNER.test(line))
            .filter(({ line }) => RETIRED_SUBJECTS.some((x) => line.includes(x)))
            .filter(({ idx }) => !paragraphOf(idx).some((l) => BANNER.test(l)))
            .map(({ line, idx }) => `${DESIGN}:${idx + 1}  ${line.trim().slice(0, 72)}`);
        expect(offenders).toEqual([]);
    });

    it('agrees with the code about TYPESAFE_SUBPROCESSOR_ACTIVE', () => {
        // THE TENTH ROTTED PASSAGE, and the one the word-policing rule above
        // could never have caught. The document asserted the constant "is
        // `true` since 2026-10-11"; the 2026-10-14 withdrawal set it back to
        // `false`, and the row went on saying otherwise.
        //
        // A claim about a value is DERIVABLE, which makes it the strongest kind
        // of thing to guard in prose: no curated list, no judgement about what
        // counts as retired — just the document against the code.
        const mode = fs.readFileSync(
            path.join(ROOT, 'src/lib/legacy-access/adjudication-mode.ts'),
            'utf-8',
        );
        const actual = /export const TYPESAFE_SUBPROCESSOR_ACTIVE = (true|false);/.exec(
            codeOf(mode),
        )?.[1];
        expect(actual).toMatch(/^(true|false)$/);

        // READ THE MARKER, NOT THE PROSE. The first version regexed the
        // sentence, and a mutation flipping the claim outright passed it —
        // because the row legitimately names BOTH values while telling the
        // story of the flip, so "what does the text say" has no answer. Parsing
        // English here either cries wolf or passes a lie.
        //
        // The document therefore carries one machine-readable fact, the same
        // technique #3540's notifier uses: invisible in rendered Markdown, and
        // the only thing here a guard needs to agree with. Mutating either side
        // fails this test.
        const body = designLines.slice(currentState.start, currentState.end).join('\n');
        const marker = /<!-- derived: TYPESAFE_SUBPROCESSOR_ACTIVE=(true|false) -->/.exec(body);
        expect(marker).not.toBeNull();
        expect(marker?.[1]).toBe(actual);
    });

    it('keeps the Retired section OUTSIDE Current state', () => {
        // Where the moved material went. A `## Retired` nested inside Current
        // state would satisfy every assertion above while putting history back
        // under a heading that says "true today".
        const retiredAt = designLines.findIndex((l) => /^## Retired/.test(l));
        expect(retiredAt).toBeGreaterThan(currentState.end - 1);
    });
});
