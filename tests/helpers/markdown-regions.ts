/**
 * Markdown REGIONS — bounding a documentation assertion to the part of the
 * document it names (#2246 Class A, the narrowing half).
 *
 * WHY NARROWING AND NOT MASKING
 * ─────────────────────────────
 * The usual Class A fix is a comment mask at the read seam: `codeOf(...)`
 * separates a file's CODE from its PROSE so "delete the code, keep the note
 * explaining it" stops being a green diff. That fix assumes the assertion is
 * about code.
 *
 * On a documentation guard it is about prose, and the markdown masker
 * `mdCodeOf` keeps a document's CODE — fenced blocks and inline spans — and
 * blanks everything else. Pointing it at a guard that asserts a section
 * exists, a licence is credited, or a decision is recorded DELETES the
 * subject: the assertion then runs against a mostly-blank string. Measured
 * across the six guards converted with this module, every needle that is
 * plain prose matches once raw and ZERO times through `mdCodeOf`.
 *
 * Worse, on a NEGATIVE assertion masking is silent: `expect(doc).not.toMatch(
 * /L3[- ]verified/i)` passes VACUOUSLY once the prose it forbids has been
 * blanked, so the guard reads as converted while asserting nothing at all.
 *
 * So the fix for these is the OTHER route the Class A advice names — bound
 * the READ to the region the assertion is about. `/## Scaling/` or
 * `/helm rollback/` against a whole runbook is satisfied by that text
 * ANYWHERE in it: a sibling section, a table cell, a fenced sample. Against
 * the section that owns it, the needle has to come from the place the test
 * claims to be checking.
 *
 * FENCE AWARENESS IS LOAD-BEARING HERE, and it is the one thing these
 * functions do that the three hand-rolled `mdSection` copies from #2789 do
 * not. Those were written against documents whose fenced blocks contain no
 * `#`. `docs/deployment.md` is a runbook: it is mostly shell, and shell
 * comments start with `#`. A section finder that scans for `^#{1,6}\s` without
 * tracking fences stops at the first `# Adjust bounds + reapply via helm
 * upgrade` INSIDE a bash block — measured, that truncated
 * `### Scaling` from 1700 characters to 164 and `#### Files (S3 storage
 * bucket)` from 1845 to 587, which took four separate needles to ZERO
 * matches. A narrowing that drops a needle to zero has deleted the subject
 * exactly as masking would; the measurement is what caught it, not review.
 *
 * WHY TWO ARGUMENTS, AND WHY THAT IS NOT COSMETIC
 * ──────────────────────────────────────────────
 * `tests/helpers/assertion-reach.ts` tells a NARROWING from a MASK by ARITY.
 * A one-argument `f(<content>)` is the shape of a wrapper — `codeOf(src)` —
 * and resolves as `content-transformed`, a CAPPED skip that the Class C/D
 * ratchets hold a ceiling over. A second argument is the shape of an
 * EXTRACTION — `declarationOf(src, 'fetchVendor')` — and is out of scope,
 * because narrowing is the fix those ratchets ask for.
 *
 * That is not a technicality to route around: the second argument is what
 * makes the region NAMEABLE, and a region the caller cannot name is a
 * wrapper. #2789 measured the difference — spelling `headingLines(md)` with
 * one argument pushed `UNANALYSABLE_READ_BASELINE` from 1460 to 1467, so
 * taking the ratchet's own advice turned a ceiling red.
 *
 * WHAT THIS MODULE IS NOT. It is not a masker and must never be given a
 * one-argument spelling, a default parameter, or a convenience wrapper that
 * hides the region name. `tests/helpers/source-blocks.ts` is the masker
 * home. These three keep the text exactly as written inside the bound.
 *
 * Every EXTRACTOR in that module — `declarationOf`, `functionBodyOf` and the
 * rest — is comment-FREE by design, which is why none of THEM can serve a
 * guard whose subject is a comment or a line of prose. Its two inverse
 * MASKERS can (`commentsOf` for a comment, `mdProseOf` for markdown prose);
 * what they cannot do is narrow.
 *
 * THAT MODULE NOW HAS A PROSE MASKER TOO, and the two are complements rather
 * than rivals. `mdProseOf` blanks a document's fences and code spans and keeps
 * everything else — the general tool for a prose assertion whose subject is
 * spread across a document. Narrowing is still the better fix WHEREVER THE
 * PROSE SITS IN A NAMEABLE REGION, because the second argument makes the guard
 * say which part of the document is supposed to carry the claim, and because
 * a narrowing keeps the text byte-for-byte (a needle that straddles a code
 * span and the prose beside it — `` `hover:scale-*` are banned`` — survives a
 * narrowing and dies under EITHER mask). Reach for `mdProseOf` when the region
 * has no name.
 */

/**
 * Which lines of `md` are real ATX headings, and at what level.
 *
 * `null` for every line that is not a heading, INCLUDING every line inside a
 * fenced block — see the fence note in the file header. Fences are matched on
 * the opening marker character so a ``` block containing ~~~ (or the reverse)
 * does not close early.
 */
function headingLevels(md: string): (number | null)[] {
    const levels: (number | null)[] = [];
    let open: string | null = null;
    for (const line of md.split('\n')) {
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (open === null) open = fence[1][0];
            else if (fence[1][0] === open) open = null;
            levels.push(null);
            continue;
        }
        const h = open === null ? /^(#{1,6})\s/.exec(line) : null;
        levels.push(h === null ? null : h[1].length);
    }
    return levels;
}

/**
 * The document's ATX heading lines AT ONE LEVEL, and nothing else.
 *
 * For assertions about a document's SECTION STRUCTURE. `/## Scaling/` against
 * the whole document is satisfied by a sentence naming the section, a table
 * cell, or a fenced markdown sample; against the level-2 heading lines it is
 * satisfied only by a level-2 heading.
 *
 * `level` is a parameter rather than baked in because it states what the
 * assertions mean — a guard writing `##` is about the level-2 structure and
 * not "any heading".
 */
export function headingLines(md: string, level: number): string {
    const levels = headingLevels(md);
    return md
        .split('\n')
        .filter((_, i) => levels[i] === level)
        .join('\n');
}

/**
 * The document's PREAMBLE — everything above its first heading at `level`.
 *
 * The region `mdSection` and `headingLines` cannot cut. A guide's opening
 * block — the `#` title, the status banner, the one-line statement of what the
 * document is for — belongs to no `##` section, so a guard asserting "this doc
 * declares which epic owns it" or "this doc names itself the source of truth"
 * had nowhere to bind and read the whole file. Against the whole file such a
 * needle is satisfied by a later mention in a migration table or a fenced
 * sample; against the preamble it has to come from the banner the test says it
 * is checking.
 *
 * LEVEL IS A REAL PARAMETER, not padding to satisfy an arity rule. "Above the
 * first `##`" and "above the first `#`" are different regions of the same
 * document, and which one a guard means is exactly what it should have to say
 * — the same argument `headingLines(md, level)` makes for its own second
 * argument. It happens to also be what keeps this a two-argument EXTRACTION
 * rather than a one-argument WRAPPER, and the file header explains why that
 * distinction is load-bearing for `tests/helpers/assertion-reach.ts`: a
 * one-argument `headingLines(md)` pushed `UNANALYSABLE_READ_BASELINE` from
 * 1460 to 1467.
 *
 * Fence-aware through the shared `headingLevels`, which matters here for the
 * same reason as everywhere else in this module: a `#` comment inside an
 * opening bash block would otherwise end the preamble at the first line of the
 * first sample.
 *
 * THROWS when the document has no heading at `level`, rather than returning
 * the whole document. That is not defensiveness — returning everything would
 * be a narrowing that silently WIDENS back to a whole-file read, which is the
 * exact state the caller is converting away from, and nothing would report it.
 * `mdSection` throws for the sibling reason.
 */
export function mdPreamble(md: string, level: number): string {
    const lines = md.split('\n');
    const levels = headingLevels(md);
    const first = levels.findIndex((l) => l === level);
    if (first < 0) {
        throw new Error(`markdown preamble not bounded: no level-${level} heading`);
    }
    return lines.slice(0, first).join('\n');
}

/**
 * ONE ATX section of a markdown document, heading line included.
 *
 * `heading` is the heading TEXT without its hashes, matched exactly (after
 * trimming) at whatever level it occurs; the section runs to the next heading
 * of the same level or higher, so a `##` section carries its `###`
 * subsections and a `####` subsection stops at its next `####` sibling.
 *
 * Throws when the heading is gone rather than returning '' — an empty string
 * would fail every `toMatch` below it anyway, but the throw names WHICH
 * heading vanished, and a guard whose subject was deleted must fail loudly
 * rather than assert against nothing. This is the rule the `source-blocks`
 * extractors already follow.
 */
export function mdSection(md: string, heading: string): string {
    const lines = md.split('\n');
    const levels = headingLevels(md);
    const want = heading.trim();

    const start = lines.findIndex((line, i) => {
        const level = levels[i];
        return level !== null && line.trimEnd().slice(level).trim() === want;
    });
    if (start < 0) throw new Error(`markdown section not found: ${want}`);

    const level = levels[start] as number;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const l = levels[i];
        if (l !== null && l <= level) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}
