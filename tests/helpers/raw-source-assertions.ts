/**
 * Class A — a source-scanning test that asserts against RAW TEXT.
 *
 * THE DEFECT
 * ──────────
 * A guard reads a source file and asserts against what it read. Nothing
 * strips the comments, so a COMMENT mentioning the thing satisfies an
 * assertion meant to be about code, and the "keep the note, drop the code"
 * diff is green. Demonstrated on this repo before the helper existed:
 * deleting the status chip from `ProcessInspector.tsx` and replacing it with
 * a JSX comment naming its `data-testid` left `tests/guards/p-polish-d.test.ts`
 * 20/20 GREEN — and that assertion was the only detector for that chip in the
 * tree (#2246).
 *
 * The mirror image is the same root cause and is also counted here: on
 * `expect(src).not.toMatch(/…/)` a comment mentioning the forbidden token
 * turns the guard RED while the code is fine. One is a guard that cannot
 * fail, the other a guard that cannot pass; both are "the assertion is about
 * prose", and both are closed by the same one-line change. They are reported
 * separately (`negatedRawSites`) so the split is visible rather than assumed.
 *
 * THE FIX, AND IT IS A SEAM NOT AN ASSERTION
 * ──────────────────────────────────────────
 * `codeOf()` from `tests/helpers/source-blocks.ts`, applied where the file is
 * READ:
 *
 *     const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
 *
 * One site instead of every call site, so an assertion added later is covered
 * by construction. Per-assertion `codeOf(src)` also counts here, and is
 * strictly worse for the same reason the helper has no `{ raw: true }` mode:
 * it is correct only while nobody forgets. String literals are KEPT by
 * `codeOf` and that is load-bearing — masking them would silently empty real
 * assertions (`code: 'CC1.1'`, `data-testid="…"`).
 *
 * Narrowing to the construct (`declarationOf`, `functionBodyOf`,
 * `interfaceBodyOf`, `braceBlockAfter`, `callExpressionOf`) masks as well as
 * narrows, and such a subject never reaches this analyser's population at
 * all — a narrowed read is not a whole-file read. Taking this ratchet's
 * advice can therefore only lower its count, never raise it.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT CLAIM
 * ──────────────────────────────────────────────
 * The unit is the FILE, not the assertion, and that is deliberate on both
 * sides:
 *
 *   · It matches the unit of the FIX. Masking at the read seam converts a
 *     whole file in one line, so "files still asserting raw" is the number
 *     that goes down when somebody does the work.
 *   · It does NOT claim that an already-listed file is safe to add raw
 *     assertions to. A file at 1 raw site can grow to 50 without moving this
 *     count. The claim is only that the POPULATION cannot grow: a test file
 *     that reads source and asserts on it unmasked cannot be ADDED while
 *     this is green.
 *
 * Nor is it a proof of exploitability. A raw assertion is exploitable when a
 * comment in the file it reads happens to carry the token — a property of
 * today's source file, not of the assertion. That is the point: the
 * assertion is one comment away from being satisfied by prose, and nothing
 * tells anyone when that day comes.
 *
 * TWO POPULATIONS ARE EXCLUDED, AND THEY ARE REPORTED, NOT DROPPED
 * ────────────────────────────────────────────────────────────────
 *   · A read of a file whose language `codeOf` does not lex — `.sql`, `.yml`,
 *     `.json`, `.md`, `.env`. Handing `codeOf` a `.sql` file produces the
 *     worst outcome available: a view that still carries every `--` comment
 *     while READING as masked. JSON has no comments at all, so there is no
 *     defect to close. These land in `unlexableLanguageSites` with a
 *     per-extension histogram, so the exclusion is arguable rather than
 *     invisible. (`tests/guards/rq2-6-appetite-lec.test.ts` shows the shape
 *     the excluded languages need: one reader per language, each with its own
 *     masker.)
 *   · A subject the analyser cannot resolve to a whole file. Those are
 *     reported per reason in `subjectSkips` and are NOT counted as raw —
 *     counting a blind spot as a finding is how a detector comes to report
 *     coverage it does not have.
 *
 * WHICH WAY THE RESIDUAL ERROR RUNS, measured rather than assumed. The skip
 * buckets make this an UNDER-count of raw files, not an over-count:
 * `tests/guards/bulk-actions-rollout.test.ts` masks its read seam with
 * `codeOf` and reads through a per-entity table, so all six of its subjects
 * are `path-not-constant` — the file is genuinely fixed and this analyser
 * cannot certify that it is. A file that hid a RAW read the same way would be
 * equally invisible here. What stops that being a free evasion is that the
 * identical site sits in Class D's population, where `path-not-constant` is
 * summed into the zero-headroom `UNANALYSABLE_READ_BASELINE`: the site moves
 * a ceiling either way, just not this one.
 *
 * THE EVASION ROUTE IS ALREADY CAPPED ELSEWHERE, WHICH IS WHY THERE IS ONE
 * CONSTANT HERE AND NOT THREE. Wrapping a raw read in something the analyser
 * cannot follow (`expect(String(src))`, `expect(src.trim())`) moves a site
 * from `raw` to `content-transformed` and out of this count. That same site
 * is in the population of
 * `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts`, whose
 * `UNANALYSABLE_READ_BASELINE` is a zero-headroom ceiling on exactly that
 * bucket — so the evasion turns that ratchet red instead. Two ratchets over
 * one analyser, one skip ceiling between them.
 */
import * as path from 'node:path';

import {
    collectExpectSites,
    parseTestFile,
    resolveSubjectMasked,
    siteRef,
    type SiteRef,
    type SubjectSkipReason,
} from './assertion-reach';
import { repoRelative } from './repo-files';

/**
 * Extensions `codeOf` actually lexes: `//`, `/* … *\/`, and quoted strings.
 *
 * `.prisma` is in the list because Prisma's comment syntax IS `//` and its
 * strings are double-quoted — the same lexer is correct there, and the
 * concatenated schema is the single most-read file in `tests/`.
 */
export const LEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.prisma',
]);

/**
 * The extension a read LABEL denotes.
 *
 * Not `path.extname`, and the difference cost 77 sites: `readPrismaSchema()`
 * labels its content `prisma/schema/*.prisma (concatenated)`, whose extname
 * is the string `.prisma (concatenated)` — which is in no set, so every
 * assertion against the concatenated schema silently left the population
 * through the EXCLUDED door. The schema is the single most-read file in
 * `tests/` and Prisma's comment syntax is `//`, so those are exactly the
 * sites this ratchet is for.
 */
function extensionOf(label: string): string {
    return path.extname(label.replace(/\s*\(concatenated\)$/, '')).toLowerCase();
}

export interface RawAssertionSite {
    readonly site: SiteRef;
    /** Repo-relative path of the file that was READ (not the test file). */
    readonly readLabel: string;
    /** The `expect(...)` subject as written, truncated for messages. */
    readonly subjectText: string;
}

export interface ClassAReport {
    /** Test files parsed. */
    readonly filesExamined: number;
    /** Every `expect(x).toMatch|toContain(y)` seen, the denominator. */
    readonly sites: number;
    /** Sites whose subject resolved to the whole text of a file on disk. */
    readonly wholeFileReads: number;

    /** Whole-file reads of a lexable language with NO comment mask applied. */
    readonly rawSites: readonly RawAssertionSite[];
    /** How many of `rawSites` are `.not.toMatch` / `.not.toContain`. */
    readonly negatedRawSites: number;
    /** Whole-file reads of a lexable language that WERE masked. */
    readonly maskedSites: number;
    /** Whole-file reads of a language `codeOf` cannot lex. */
    readonly unlexableLanguageSites: number;
    /** `.sql` → 12, `.yml` → 4 … over `unlexableLanguageSites`. */
    readonly unlexableByExtension: Readonly<Record<string, number>>;

    /** Why the remaining sites are not whole-file reads. */
    readonly subjectSkips: Readonly<Record<SubjectSkipReason, number>>;

    /** Test files carrying at least one raw site — THE ratcheted population. */
    readonly rawFiles: readonly string[];
    /** Test files that read lexable source and mask every read of it. */
    readonly maskedOnlyFiles: readonly string[];
}

const EMPTY_SUBJECT_SKIPS: Record<SubjectSkipReason, number> = {
    'not-a-file-read': 0,
    'binding-not-resolvable': 0,
    'path-not-constant': 0,
    'file-not-found': 0,
    'content-transformed': 0,
};

/**
 * Classify every `toMatch`/`toContain` in `absFiles`.
 *
 * One file parsed at a time and nothing but plain data retained — an AST
 * with parent pointers is several times the size of its source, and holding
 * 2,400 of them does not fit in the runner's worker budget (see
 * `parseTestFile`).
 */
export function analyseClassA(absFiles: readonly string[]): ClassAReport {
    const rawSites: RawAssertionSite[] = [];
    const subjectSkips = { ...EMPTY_SUBJECT_SKIPS };
    const unlexableByExtension: Record<string, number> = {};
    const rawFiles = new Set<string>();
    const maskedFiles = new Set<string>();

    let sites = 0;
    let wholeFileReads = 0;
    let maskedSites = 0;
    let unlexableLanguageSites = 0;
    let negatedRawSites = 0;

    for (const abs of absFiles) {
        const sf = parseTestFile(abs);
        const rel = repoRelative(abs);

        for (const site of collectExpectSites(sf)) {
            sites++;
            const { result, masked } = resolveSubjectMasked(site.subject, sf);

            if (result.kind === 'skipped') {
                subjectSkips[result.reason]++;
                continue;
            }

            wholeFileReads++;
            const ext = extensionOf(result.label);
            if (!LEXABLE_EXTENSIONS.has(ext)) {
                unlexableLanguageSites++;
                unlexableByExtension[ext] = (unlexableByExtension[ext] ?? 0) + 1;
                continue;
            }

            if (masked) {
                maskedSites++;
                maskedFiles.add(rel);
                continue;
            }

            if (site.negated) negatedRawSites++;
            rawFiles.add(rel);
            rawSites.push({
                site: siteRef(site),
                readLabel: result.label,
                subjectText: site.subjectText.slice(0, 60),
            });
        }
    }

    for (const f of rawFiles) maskedFiles.delete(f);

    return {
        filesExamined: absFiles.length,
        sites,
        wholeFileReads,
        rawSites,
        negatedRawSites,
        maskedSites,
        unlexableLanguageSites,
        unlexableByExtension,
        subjectSkips,
        rawFiles: [...rawFiles].sort(),
        maskedOnlyFiles: [...maskedFiles].sort(),
    };
}
