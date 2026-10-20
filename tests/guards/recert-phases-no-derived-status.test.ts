/**
 * The recertification phases table must not store a status column.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A GUARD AND NOT A CONVENTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/legacy-access-recertification-phases.md` used to carry a `Status`
 * column beside the `Pull request` column it was derivable from. Two things went
 * wrong, and the second was worse:
 *
 *   1. Each step's own pull request set its own row to `Open`, which was true
 *      when written. MERGING that branch is what made the row false — so the
 *      commit that falsified the row was the commit that added it. 5 of 19 rows
 *      were wrong when the column was removed, and it had been wrong after
 *      almost every merge.
 *
 *   2. Every concurrent step edited the SAME rows, so the table conflicted on
 *      nearly every pair of steps in flight — three times in one day. Each
 *      resolution had the same shape: BOTH sides were stale snapshots, so the
 *      correct answer came from neither and every row had to be re-read from
 *      GitHub anyway. A naive resolution also duplicated rows, because the
 *      conflicting blocks sat far enough apart that a consecutive-duplicate
 *      filter removed none of them.
 *
 * The same class is already recorded in `CLAUDE.md`, about the per-class
 * `counts` header deleted from `docs/_status/doc-classification.json`: two
 * branches each bumping `494 → 495` do not conflict, so git keeps one copy,
 * both PRs are green, and main is wrong by one with no suspicious diff.
 *
 * A convention would not hold. The pressure to add the column back is strongest
 * exactly when it is most wrong — somebody reads the table, cannot tell what has
 * landed, and helpfully writes it down.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS STILL ALLOWED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The PR number, because that is the FACT rather than a projection of it. And
 * prose anywhere in the document may say whatever it likes — this guard reads
 * the table header only. A document that cannot discuss status would be a
 * document nobody could use.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3313
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';

const DOC = path.resolve(
    __dirname,
    '../../docs/legacy-access-recertification-phases.md'
);

const text = fs.readFileSync(DOC, 'utf8');

/** Every markdown table header row in the document. */
function headerRows(): string[] {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
        // A header is a pipe row followed by a delimiter row. Matching the PAIR
        // rather than any pipe row is what keeps a data row full of dashes from
        // reading as a header.
        if (/^\|.*\|$/.test(lines[i].trim()) && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
            out.push(lines[i].trim());
        }
    }
    return out;
}

const DERIVED = /\b(status|state|merged|landed|progress)\b/i;

/**
 * The rows of the STEP table specifically — the one whose header names a pull
 * request — from its header to the first line that is not a table row.
 *
 * The document contains more than one step-keyed table, so "a line beginning
 * with a step id" is not the same population and never was.
 */
function stepTableRows(): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex(
        (l) => l.trim().startsWith('| Step |') && l.includes('Pull request')
    );
    if (start < 0) return [];
    const out: string[] = [];
    // +2 skips the header and its delimiter row.
    for (let i = start + 2; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t.startsWith('|')) break;
        out.push(t);
    }
    return out;
}

/**
 * The rows of the OPERATIONAL EVIDENCE table — the one asking whether a phase
 * has run — from its header to the first line that is not a table row.
 */
function evidenceTableRows(): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.includes('has it run in production?'));
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 2; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t.startsWith('|')) break;
        out.push(t);
    }
    return out;
}

/** A date somebody can look up. */
const HAS_DATE = /\b20\d{2}-\d{2}-\d{2}\b/;
/** An identifier somebody can look up: a cuid, a `#NNNN`, or a bare job id. */
const HAS_ID = /`[a-z0-9]{20,}`|#\d{3,}|`\d{5,}`/;
/**
 * A COUNT of a named thing -- `3 journal rows`, `1 \`IdentityAccountLink\``.
 *
 * The document's rule is "a row, a run id OR A METRIC VALUE, with a date", and
 * the first version of this guard omitted the third alternative. It then failed
 * on phase 0, whose evidence is a date and two counts and is perfectly
 * checkable. The row was right and the predicate was wrong -- which is the
 * failure mode a guard is most likely to have and least likely to be suspected
 * of, since a red test reads as a finding about the subject.
 *
 * The space after the digits is what keeps `2026-10-16` from matching here and
 * satisfying the rule with its own date.
 */
const HAS_METRIC = /\b\d+ (?:`[^`]+`|[a-z][a-z ]*)/;

/**
 * The document's own rule, as a predicate: "An entry names a row, a run id or a
 * metric value, with a date, so somebody who was not there can check it."
 *
 * Exported shape rather than an inline regex so the negative control below can
 * drive THIS function. A control that re-implements the rule proves only that
 * two copies agree.
 */
function evidenceIsCheckable(runCell: string, evidenceCell: string): boolean {
    if (!/\byes\b/i.test(runCell)) return true;
    if (!HAS_DATE.test(evidenceCell)) return false;
    return HAS_ID.test(evidenceCell) || HAS_METRIC.test(evidenceCell);
}

/**
 * Every step the document defines, from its `#### Step Xx` headings.
 */
function stepIds(): string[] {
    return text
        .split('\n')
        .map((l) => /^#### Step ([0-9][a-z])\b/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]);
}

/**
 * The implementation notes declaring themselves as a given step's, by the
 * convention every one of the nineteen uses: `(Step 4b)` in the note's text.
 *
 * Population from git (`repoFiles`), not a directory walk, so an untracked
 * scratch file in that subtree cannot satisfy the criterion.
 */
function notesForStep(step: string): string[] {
    const needle = `(Step ${step})`;
    return repoFiles({ under: 'docs/implementation-notes', extensions: ['.md'] })
        .filter((f) => fs.readFileSync(f, 'utf8').includes(needle))
        .map((f) => path.basename(f));
}

/**
 * Backticked spans on a `**Verified #N:**` line — the document's own evidence.
 *
 * Most are test NAMES. Some are code (`mail || userPrincipalName`), constants
 * (`CONTRACT_VERSION = …`) or prose (`Issued: 2026-10-14`), and no classifier
 * separated them reliably: a first pass over this set flagged 54 absentees of
 * which 50 were my own false positives. So this does NOT try to decide which
 * spans are test names. It counts how many resolve and refuses a FALL.
 */
function verifiedSpans(): string[] {
    const out = new Set<string>();
    for (const line of text.split('\n')) {
        if (!line.includes('Verified #')) continue;
        for (const m of line.matchAll(/`([^`]+)`/g)) {
            const tok = m[1]!;
            if (!tok.includes(' ')) continue;
            if (/^(src|tests|docs|prisma)\//.test(tok)) continue;
            if (/\.tsx?$/.test(tok)) continue;
            out.add(tok);
        }
    }
    return [...out];
}

/** Every tracked test file's text, concatenated once. */
let testTreeBlob: string | null = null;
function testTree(): string {
    if (testTreeBlob === null) {
        testTreeBlob = repoFiles({ under: 'tests', extensions: ['.ts', '.tsx'] })
            .map((f) => fs.readFileSync(f, 'utf-8'))
            .join('\n');
    }
    return testTreeBlob;
}

/**
 * The floor. 259 of 285 spans resolved when this was written (#3794).
 *
 * A RATCHET rather than an equality, because the 26 that do not resolve are
 * code and prose and always will be. It may only be LOWERED in a diff that
 * says which citation was removed and why — which is the one thing that did
 * not happen when #3535 retired the Laya provider and deleted four tests that
 * three ticked criteria cited by name.
 */
const RESOLVING_CITATIONS_FLOOR = 259;

describe('the recert phases table stores no derived status', () => {
    it('finds the tables it is meant to be checking', () => {
        // The population, asserted. A heading-matcher that silently stopped
        // matching would make every assertion below pass over nothing.
        const heads = headerRows();
        expect(heads.length).toBeGreaterThanOrEqual(2);
        expect(heads.some((h) => h.includes('| Step |'))).toBe(true);
    });

    it('no table header declares a status-like column', () => {
        const offenders = headerRows()
            .filter((h) => h.split('|').some((cell) => DERIVED.test(cell)))
            .map((h) => h);

        expect(offenders).toEqual([]);
    });

    it('the step table still carries the pull request column, which is the fact', () => {
        // The other direction. Deleting the whole table would satisfy the test
        // above, and would lose the one piece of non-derivable information in it.
        const step = headerRows().find((h) => h.includes('| Step |') && h.includes('Title'));
        expect(step).toContain('Pull request');
    });

    /**
     * The shapes a pull-request cell may take.
     *
     * An em dash, a bare number, a numbered part, or a number with a COUNT of
     * the others — `#3373, and 10 more †`, which the footnote under the table
     * explains.
     *
     * The last of those was added on 2026-10-16 and widening the rule needed an
     * argument, because the rule exists to stop exactly this kind of edit. Its
     * purpose is that the cell holds a FACT rather than "a status by another
     * name". A count of pull requests is a fact: it is checkable against the
     * commit history, it does not change when somebody's opinion of the work
     * changes, and it goes stale only if the history does.
     *
     * "in review", "see branch", "blocked" and "done" remain rejected, and the
     * test below feeds each of them in to prove it rather than asserting it.
     *
     * Why not reuse `(part 1)`: 4b carried `#3344 (part 1)` for weeks and it
     * took reading the commit log to learn there were seven. "Part 1" says a
     * step was split; it does not say into how many, so a reader cannot tell
     * whether one more pull request is outstanding or six are merged.
     */
    const PR_CELL = /^(—|#\d+( \(part \d\))?|#\d+, and \d+ more †)$/;

    it('every recorded pull request is a number, a part, a count, or an explicit em dash', () => {
        // Scoped to the ROWS OF ONE TABLE, not to every row in the document that
        // starts with a step id. The document has a second step-keyed table —
        // dependencies and change class — whose third column is `Standard`, and
        // a filter on `| 0a |` alone reads those rows as malformed PR cells.
        // That is what the first version of this test did.
        const rows = stepTableRows();
        expect(rows.length).toBeGreaterThanOrEqual(15);
        for (const r of rows) {
            const cell = r.split('|')[3].trim();
            expect({ row: r.slice(0, 12), ok: PR_CELL.test(cell) })
                .toEqual({ row: r.slice(0, 12), ok: true });
        }
    });

    it('NEGATIVE CONTROL — the widened rule still refuses a status', () => {
        // The rule got looser on 2026-10-16, and a looser rule is worth
        // nothing without evidence of what it still rejects. These are the
        // shapes the original comment named as the rot it was built to catch.
        for (const rot of ['in review', 'see branch', 'blocked', 'done', 'WIP', 'n/a', '']) {
            expect({ cell: rot, accepted: PR_CELL.test(rot) })
                .toEqual({ cell: rot, accepted: false });
        }
        // And the four shapes it must accept, so the control cannot pass by
        // rejecting everything.
        for (const ok of ['—', '#3247', '#3344 (part 1)', '#3373, and 10 more †']) {
            expect({ cell: ok, accepted: PR_CELL.test(ok) })
                .toEqual({ cell: ok, accepted: true });
        }
    });
    it('finds the operational-evidence table at all', () => {
        // Without this the two assertions below pass over an empty list, which is
        // how a renamed heading turns a guard into decoration.
        const rows = evidenceTableRows();
        expect(rows.length).toBeGreaterThanOrEqual(7);
    });

    it('every phase claimed as RUN names a date and an identifier', () => {
        // The document states this rule about itself -- "A green test is not an
        // entry here. An entry names a row, a run id or a metric value, with a
        // date" -- and nothing enforced it. A row flipped to `yes` on the
        // strength of a passing test is exactly what the appendix exists to
        // prevent, and is indistinguishable from a real entry to a reader who
        // trusts the column.
        for (const r of evidenceTableRows()) {
            const cells = r.split('|');
            const run = (cells[2] ?? '').trim();
            const evidence = (cells[3] ?? '').trim();
            expect({ phase: cells[1]?.trim(), ok: evidenceIsCheckable(run, evidence) })
                .toEqual({ phase: cells[1]?.trim(), ok: true });
        }
    });

    it('refuses a yes whose evidence is unverifiable, and allows an honest no', () => {
        // The negative control, driving the SAME predicate the assertion above
        // uses. Without it, a rule that accidentally accepted everything would
        // look identical to a rule that holds.
        expect(evidenceIsCheckable('**yes**', 'the tests pass')).toBe(false);
        expect(evidenceIsCheckable('**yes**', 'it works, 2026-10-16')).toBe(false);
        expect(evidenceIsCheckable('**yes**', '`cmv9x9bdf00008bs3209exiqn`')).toBe(false);
        expect(evidenceIsCheckable('**yes, against the reference fixture**', 'green in CI')).toBe(
            false
        );

        // And the shapes it must keep accepting, so the control cannot pass by
        // rejecting everything.
        expect(
            evidenceIsCheckable('**yes**', '`cmv9x9bdf00008bs3209exiqn`, `OPEN`, 2026-10-15.')
        ).toBe(true);
        expect(evidenceIsCheckable('**yes**', '#3592, 2026-10-15. Connection established')).toBe(
            true
        );
        // A metric value with a date is checkable, and is how phase 0 qualifies.
        expect(evidenceIsCheckable('**yes**', '2026-09-12 — 3 journal rows')).toBe(true);
        // A count with no date still fails: the date is not the optional half.
        expect(evidenceIsCheckable('**yes**', '3 journal rows')).toBe(false);

        // A phase that has NOT run is exempt: the rule is about claims, not rows.
        expect(evidenceIsCheckable('**no, and cannot**', '`LegacyMatchVerdict` 0')).toBe(true);
        expect(evidenceIsCheckable('**no**', 'blocked behind phase 3')).toBe(true);
    });
    it('finds all nineteen steps, so the next assertion has a population', () => {
        expect(stepIds()).toHaveLength(19);
    });

    it('every step has an implementation note — criterion 9, enforced', () => {
        // This is the criterion the roadmap actually failed. It was missing for
        // 10 of 19 steps and nothing noticed, because "an implementation note in
        // docs/implementation-notes/" was a sentence in a definition-of-done and
        // nothing more. #3623 wrote the ten; this is what stops the eleventh.
        //
        // A convention would not hold here for the same reason the status column
        // did not: the moment to write the note is the moment the work is
        // finished and attention has moved on.
        const missing = stepIds().filter((st) => notesForStep(st).length === 0);
        expect(missing).toEqual([]);
    });

    it('reports a step with no note as missing, and does not invent one', () => {
        // The negative control. `notesForStep` returning a non-empty list for
        // everything -- a broken needle, a readFileSync that throws and is
        // swallowed -- would make the assertion above vacuous, and a step id
        // that cannot exist is the cheapest way to show it discriminates.
        expect(notesForStep('9z')).toEqual([]);
        // And a real one resolves, so the empty result above is about the step
        // and not about the search being broken.
        expect(notesForStep('6c').length).toBeGreaterThan(0);
    });
});

describe("the document's cited evidence still exists (#3794)", () => {
    it('finds a substantial set of cited spans', () => {
        // The denominator. A reworded marker would empty this set, and an empty
        // set passes a floor of zero silently.
        expect(verifiedSpans().length).toBeGreaterThan(200);
    });

    it('the number of cited test names that resolve has not fallen', () => {
        const blob = testTree();
        const resolving = verifiedSpans().filter((sp) => blob.includes(sp));
        // If this fires, a test a ticked criterion cites by name has been
        // deleted or renamed. Repoint the criterion at what proves it now, or
        // untick it with the reason — and lower the floor in the same diff.
        //
        // #3535 retired the Laya provider and took four cited tests with it.
        // A retirement has no reason to read a phases document; this is the
        // thing that reads it for them.
        expect({
            resolving: resolving.length >= RESOLVING_CITATIONS_FLOOR,
            floor: RESOLVING_CITATIONS_FLOOR,
            actual: resolving.length,
        }).toEqual({ resolving: true, floor: RESOLVING_CITATIONS_FLOOR, actual: resolving.length });
    });

    it('resolves a real cited name and not a fabricated one', () => {
        // The control, driving the real blob. A `testTree()` that returned
        // everything — or nothing — would make the ratchet meaningless in one
        // direction or the other, and both look like a pass from outside.
        const blob = testTree();
        expect(blob.length).toBeGreaterThan(1_000_000);
        expect(blob.includes('a tenant with NO settings row reads OFF')).toBe(true);

        // THE SENTINEL IS ASSEMBLED, NOT WRITTEN, and the first version of this
        // test failed because it was written. `testTree()` reads every file
        // under `tests/` — including THIS ONE — so any absent-name literal I
        // type here is present in the blob by the act of typing it, and the
        // control asserted `false` on something that was true.
        //
        // A guard's own source being its worst false-positive source is the
        // same shape as `flue-provider-is-never-set-per-run` needing comment
        // masking because its subject file quotes the forbidden call. Here the
        // join means no contiguous substring of the sentinel exists in source.
        const absent = ['zz', 'no', 'such', 'cited', 'name'].join('-') + '-3794';
        expect(blob.includes(absent)).toBe(false);
    });
});
