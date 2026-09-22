/**
 * #2728 — a declaration needle must not be satisfiable by a LONGER name.
 *
 * `expect(schema).toMatch(/model Foo/)` is satisfied by `model FooBar`. Rename
 * a declaration to anything that EXTENDS the old name and the guard never
 * fires, while reading as though it still checks what it names.
 *
 * FOUND BY A MUTATION THAT REFUSED TO GO RED. Renaming `model RiskHierarchyNode`
 * to `model RiskHierarchyNodeRENAMED` left `rq5-hierarchy` green — both through
 * the masked read seam and the raw one, so masking was never the issue. With the
 * boundary the same mutation fails. That pair is the proof this file exists to
 * keep true.
 *
 * A DIFFERENT AXIS FROM CLASS D, which measures MULTIPLICITY — a needle matching
 * more than one position. A prefix needle can match exactly ONCE and still be
 * wrong, because the single thing it matches is not the thing it names. The
 * uniqueness ratchet is green on every one of these.
 *
 * THIS IS A BACKSTOP AND SHOULD STAY AT ZERO. When #2728 was filed the measured
 * live collision count was 0 of 32 — no declaration in `src/` or `prisma/` then
 * shared a prefix with a needle. It is here so the 34th needle cannot be written
 * loose, not because it is catching something today.
 */
import * as fs from 'fs';
import * as path from 'path';
import { testFilesUnder } from '../helpers/assertion-reach';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/** `toMatch(/<keyword> <Name>/)` with nothing bounding the name's end. */
const UNBOUNDED = /toMatch\(\/(model|enum|interface|type|function|class) ([A-Za-z_][A-Za-z0-9_]*)\//g;

/** The same shape, but correctly bounded — the positive control. */
const BOUNDED = /toMatch\(\/(?:model|enum|interface|type|function|class) [A-Za-z_][A-Za-z0-9_]*(?:\\b|\s*\\\{)/g;

/**
 * This file is EXCLUDED from its own scan, and that is not a convenience.
 *
 * The detector-proof below holds the defective shape as a STRING LITERAL on
 * purpose — it is the only way to show the pattern matches something. `codeOf`
 * blanks comments and KEEPS strings (deliberately: a string literal is code to
 * a guard), so those fixtures are indistinguishable from real assertions to
 * any text scan. Excluding the one file that is allowed to contain them is
 * narrower than teaching the scanner to ignore strings, which would blind it
 * to a real needle written inside one.
 */
const SELF = 'tests/guardrails/declaration-needle-boundaries.test.ts';

function scan(re: RegExp): { file: string; needle: string }[] {
    const hits: { file: string; needle: string }[] = [];
    for (const abs of testFilesUnder(['tests'])) {
        const rel = path.relative(ROOT, abs);
        if (rel === SELF) continue;
        // MASKED at the read seam (#2246). The first version of this guard read
        // raw source and reported the DOCBLOCK examples in
        // `tests/helpers/prisma-schema.ts` — prose explaining why the bounded
        // form matters — as four live defects. A scanner for a code shape that
        // cannot tell code from prose is the exact class this repo spent
        // thirteen batches removing.
        const src = codeOf(fs.readFileSync(abs, 'utf8'));
        for (const m of src.matchAll(new RegExp(re.source, 'g'))) {
            hits.push({ file: rel, needle: m[0] });
        }
    }
    return hits;
}

describe('declaration needles carry a word boundary (#2728)', () => {
    it('the scan works at all — bounded needles ARE found', () => {
        // Positive control FIRST. Without it, "no unbounded needles" passes
        // just as well when the scanner is broken as when the tree is clean,
        // and those are the two states this guard must tell apart.
        const bounded = scan(BOUNDED);
        expect(bounded.length).toBeGreaterThan(25);
    });

    it('no needle names a declaration without bounding its end', () => {
        const loose = scan(UNBOUNDED);
        const shown = loose.slice(0, 20).map((h) => `${h.file}  ${h.needle}`);
        expect({ count: loose.length, sample: shown }).toEqual({ count: 0, sample: [] });
    });

    it('the detector detects — proved on a synthetic, not on the tree being clean', () => {
        // A clean tree cannot distinguish "nothing to find" from "cannot find
        // anything". This runs the pattern against text that definitely
        // contains the defect.
        const bad = "expect(schema).toMatch(/model Foo/);";
        const good = "expect(schema).toMatch(/model Foo\\b/);";
        expect(new RegExp(UNBOUNDED.source).test(bad)).toBe(true);
        expect(new RegExp(UNBOUNDED.source).test(good)).toBe(false);
    });
});
