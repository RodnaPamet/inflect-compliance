/**
 * Every file under the shared-UI candidate roots is triaged, and a GENERIC
 * classification is re-derived rather than trusted.
 *
 * #3047. T01–T08 of #3003 neutralised the ~120-file keep-set playerz vendors;
 * the other ~490 under these roots had never been looked at. So "inflect's UI
 * is product-neutral" was true of the files somebody checked and UNKNOWN of
 * the rest. This is the triage, stored as data a guard reads.
 *
 * ─── Why data and not a document ────────────────────────────────────
 *
 * The issue is explicit that a 613-row markdown table is derived data stored
 * beside its own source, and starts rotting the day it merges — the failure
 * the `counts` header in `doc-classification.json` caused, where two branches
 * each bumping `494 -> 495` merged cleanly and left main wrong by one with no
 * suspicious diff.
 *
 * So: **this file stores no totals.** Every count below is derived from the
 * map at run time. There is no number for two branches to bump.
 *
 * ─── The split, and why it is not arbitrary ──────────────────────────
 *
 * Of the five couplings the port kept finding, three are greppable and two
 * need judgement:
 *
 *   JUDGEMENT, recorded in the map — hardcoded copy, and domain-specific
 *     props or domain examples in prose. A reader has to decide whether
 *     `controls` is the GRC noun or a widget prop.
 *   MECHANICAL, re-derived here — a storage key not built through the T01
 *     seam, a brand FILL token used as text, an import from `src/app-layer`
 *     or a domain module. These should never rest on an opinion, so a file
 *     recorded GENERIC that trips one of them fails.
 *
 * That asymmetry is the point: the audit's judgement is preserved where a
 * grep cannot substitute, and overruled where it can.
 *
 * ─── Read through `codeOf` ───────────────────────────────────────────
 *
 * Comments are masked at the read seam. Writing this guard the naive way
 * caught `use-local-storage.ts` — the storage primitive itself — because its
 * docstring contains the example `useLocalStorage('k', {})`. A guard that
 * reads prose as code reports the seam that exists to contain a pattern as a
 * violation of it. String literals are KEPT: a Tailwind class and a storage
 * key both live in one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    mechanicalCouplings,
    sharedUiPopulation,
} from '../helpers/shared-ui-couplings';

const ROOT = path.resolve(__dirname, '../..');
const MAP_PATH = 'docs/_status/ui-core-classification.json';

type Entry = {
    classification: 'GENERIC' | 'COUPLED' | 'MIXED';
    reason: string;
    derivation: string;
};

const MAP: Record<string, Entry> = JSON.parse(
    fs.readFileSync(path.join(ROOT, MAP_PATH), 'utf8'),
);

/**
 * The roots, the population and the three mechanical detectors all come from
 * `tests/helpers/shared-ui-couplings.ts`. They were defined inline here first;
 * #3048 needs the same derivation to ratchet the totals, and a detector copied
 * into two guards is two detectors that drift.
 */
const POPULATION = sharedUiPopulation(ROOT);
const mechanical = (rel: string) => mechanicalCouplings(ROOT, rel);

describe('shared-UI coupling classification (#3047)', () => {
    it('covers the population exactly — a new file must be triaged', () => {
        // The denominator is DERIVED from disk, never listed. A hand-maintained
        // population is one nothing checks, which is the lesson
        // `source-scan-population.test.ts` records.
        const mapped = new Set(Object.keys(MAP));
        const missing = POPULATION.filter((f) => !mapped.has(f));
        const stale = [...mapped].filter((f) => !POPULATION.includes(f)).sort();
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
        expect(POPULATION.length).toBeGreaterThan(600);
    });

    it('records a classification and a reason for every entry', () => {
        const bad = Object.entries(MAP)
            .filter(([, e]) => !['GENERIC', 'COUPLED', 'MIXED'].includes(e.classification) || !e.reason?.trim())
            .map(([p]) => p);
        expect(bad).toEqual([]);
    });

    it('no reason is severed mid-thought — balanced delimiters, no dangling connective', () => {
        // #3098 §2. The assertion above is a PRESENCE check, and a presence
        // check cannot tell a complete sentence from a truncated one. Two
        // reasons shipped cut off — one mid-identifier (`…use-`), one at a
        // bare colon — and both passed it.
        //
        // Why NOT "ends in terminal punctuation": measured over all 613
        // strings, that rule flags 319. Most are legitimate — the ~240 nucleo
        // icons share the complete-but-unpunctuated reason "Pure presentational
        // SVG icon: no copy, no storage key, no brand-as-text, no domain
        // import". A rule that flags half the population is noise, and noise
        // gets a blanket allowlist, which is a gate narrow enough to always
        // pass.
        //
        // So the rule is INTRINSIC instead: a string cut at an arbitrary
        // offset leaves evidence in its own grammar. An opened `code span`,
        // paren or quote never closes, or the last character is a connective
        // the author was mid-way through. Measured on the pre-fix tree it
        // flagged 14 and NOTHING ELSE — zero false positives over 613.
        //
        // Known blind spot, MEASURED rather than assumed: truncating a
        // complete reason at a word boundary, delimiters left balanced, was
        // run against this assertion and PASSED. So a cut that lands cleanly
        // is invisible here, and the population proves it is not theoretical
        // — 13 of the 14 were exactly 400 characters, the truncator's
        // fingerprint, and 27 reasons still are. Most of those read as cut
        // off (`typography.tsx` ends "is inside that prose, no"). No issue
        // tracks them as of 2026-10-02; completing them is prose authoring
        // per file.
        //
        // A second axis — "no reason is exactly 400 characters" — would catch
        // that whole class, and is deliberately NOT added: it needs a stored
        // count of the 27 survivors, and this file's header forbids stored
        // totals ("Every count below is derived from the map at run time.
        // There is no number for two branches to bump"). Closing the blind
        // spot means completing the 27, not seating a ceiling.
        //
        // So: this guard holds the line against a reason severed in a way
        // that shows, and it does not claim the existing ones are whole.
        const severed = (reason: string): string[] => {
            const why: string[] = [];
            if ((reason.match(/`/g) ?? []).length % 2) why.push('unbalanced backtick');
            if ((reason.match(/"/g) ?? []).length % 2) why.push('unbalanced double quote');
            let depth = 0;
            for (const ch of reason) {
                if (ch === '(') depth += 1;
                else if (ch === ')') depth -= 1;
                if (depth < 0) break;
            }
            if (depth !== 0) why.push('unbalanced parenthesis');
            // A reason may legitimately end on a word or `.`/`!`/`?`/`)`/`"`/
            // backtick-closed span. It may not end on a character that is
            // grammatically mid-phrase.
            if (/[:,;\-\/—–([=]$/.test(reason.trimEnd())) {
                why.push(`dangling final character ${JSON.stringify(reason.trimEnd().slice(-1))}`);
            }
            return why;
        };

        // Positive control FIRST. Without it this passes when `severed` has
        // rotted into a function that returns [] for everything, which is the
        // shape a dead detector shares with a clean population. Each case is
        // the real failure mode it is named for.
        expect(severed('Imports are `@/lib/cn` and `@/components/ui/hooks/use-'))
            .toEqual(['unbalanced backtick', 'dangling final character "-"']);
        expect(severed('…module. Worth flagging separately:'))
            .toEqual(['dangling final character ":"']);
        expect(severed('(Outside the five: a token nit, not a coupl'))
            .toEqual(['unbalanced parenthesis']);
        expect(severed('The `console.error("Filter.List received an activeFilter')).toEqual([
            'unbalanced backtick',
            'unbalanced double quote',
            'unbalanced parenthesis',
        ]);
        // And the negative control: the reason 240 icon entries share, which a
        // terminal-punctuation rule would have flagged.
        expect(
            severed(
                'Pure presentational SVG icon: no copy, no storage key, ' +
                    'no brand-as-text, no domain import',
            ),
        ).toEqual([]);

        const truncated = Object.entries(MAP)
            .map(([p, e]) => [p, severed(e.reason)] as const)
            .filter(([, why]) => why.length > 0)
            .map(([p, why]) => `${p} -> ${why.join(', ')}`);
        expect(truncated).toEqual([]);
    });

    it('no reason sits exactly on the 400-character cap that severed them', () => {
        // THE SECOND AXIS, and the one that closes the class.
        //
        // The delimiter rule above catches a reason whose cut happens to land
        // mid-span. It is blind to a cut that lands on a word boundary with every
        // backtick and bracket balanced — demonstrated by mutation, not assumed.
        // What both kinds share is the CAUSE: forty reasons were written against
        // a 400-character cap and stopped dead on it. Length is therefore the
        // discriminator the content cannot give us.
        //
        // This is a per-entry predicate, not a stored count. There is no number
        // here for two branches to bump, which is the rule this file's header
        // sets for itself.
        //
        // A reason that genuinely wants 400 characters can have 401 or 399. The
        // assertion costs an author nothing and costs a truncation its invisibility.
        const AWAITING_NAV_PR: Record<string, string> = {
            // These four describe files that PR #3100 (`port/t19-nav-wording`) is
            // rewriting as this lands. Completing prose about a file mid-rewrite
            // produces text that is wrong on arrival, so they are held rather than
            // guessed. Delete these four entries — do not add a fifth.
            'src/components/layout/nav-bar.tsx': '#3100 rewrites it',
            'src/components/layout/nav-item.tsx': '#3100 rewrites it',
            'src/components/layout/nav-section.tsx': '#3100 rewrites it',
            'src/components/layout/user-menu.tsx': '#3100 rewrites it',
        };

        const atCap = Object.entries(MAP)
            .filter(([, e]) => e.reason.length === 400)
            .map(([p]) => p);

        // The exemption list must not outlive what it exempts: an entry that is
        // no longer at the cap is a line somebody forgot to delete, and it would
        // silently keep a future truncation exempt.
        const staleExemptions = Object.keys(AWAITING_NAV_PR).filter(
            (p) => !atCap.includes(p),
        );
        expect(staleExemptions).toEqual([]);

        expect(atCap.filter((p) => !(p in AWAITING_NAV_PR))).toEqual([]);
    });

    it('no file recorded GENERIC trips a MECHANICAL coupling', () => {
        // The half that must not rest on judgement. A GENERIC here is a claim
        // that a second product can vendor the file as-is; these three are
        // exactly the claims a grep can check.
        const wrong = Object.entries(MAP)
            .filter(([, e]) => e.classification === 'GENERIC')
            .map(([p]) => [p, mechanical(p)] as const)
            .filter(([, c]) => c.length > 0)
            .map(([p, c]) => `${p} -> ${c.join(', ')}`);
        expect(wrong).toEqual([]);
    });

    it('the mechanical detectors fire — positive controls', () => {
        // Without this the assertion above passes when the regexes are broken,
        // which is the shape every "0 findings" result shares with a dead
        // detector. Each control is a file that genuinely trips its rule.
        const cases: Array<[string, string]> = [
            ['src/components/ui/charts/areas.tsx', 'brand-as-text'],
            ['src/components/ui/aside-panel.tsx', 'storage-key'],
            ['src/components/ui/FileDropzone.tsx', 'domain-import'],
        ];
        for (const [file, kind] of cases) {
            if (!fs.existsSync(path.join(ROOT, file))) continue; // moved; covered by the coverage case
            expect(mechanical(file)).toContain(kind);
        }
    });

    it('reads code, not prose — the negative control', () => {
        // `use-local-storage.ts` IS the storage primitive and its docstring
        // contains `useLocalStorage('k', {})`. Masking comments is what stops
        // the guard reporting the seam as a breach of itself.
        const hook = 'src/components/ui/hooks/use-local-storage.ts';
        if (fs.existsSync(path.join(ROOT, hook))) {
            expect(mechanical(hook)).not.toContain('storage-key');
        }
        // And a pure icon stays clean, so the detectors are not matching
        // everything indiscriminately.
        const icon = 'src/components/ui/icons/nucleo/shield-check.tsx';
        if (fs.existsSync(path.join(ROOT, icon))) {
            expect(mechanical(icon)).toEqual([]);
        }
    });

    it('stores no totals, so there is no number to drift', () => {
        // The `counts` header in `doc-classification.json` is the worked
        // example: two branches each bumping it merged clean and left main
        // wrong by one. Counts belong in the assertion, not the artefact.
        const raw = fs.readFileSync(path.join(ROOT, MAP_PATH), 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(Object.keys(parsed).every((k) => k.startsWith('src/'))).toBe(true);
        expect(raw).not.toMatch(/"counts"/);
    });
});
