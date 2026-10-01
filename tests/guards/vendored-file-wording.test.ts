/**
 * Files a downstream product copies VERBATIM carry no compliance vocabulary.
 *
 * #3074 and #3062. playerz (projectZ) vendors a set of this repo's UI files
 * byte-identical, and its `scripts/ui-sync/check-portable.mjs` refuses product
 * vocabulary in comments, strings and JSX text. That checker runs on THEIR
 * side, so a word added here surfaces only when someone over there tries to
 * vendor — which is how `controls` in `ThemeProvider` and `Dub` in `cn.ts`
 * reached main and blocked their T17.
 *
 * This is the near half of that loop: the same class, caught here.
 *
 * ─── Three limits, each stated because each is real ──────────────────
 *
 * 1. NOT THE GENERAL GUARD. #3048 owns that, including the harder half —
 *    deciding which of ~490 UI files are in scope. A file absent from
 *    `VENDORED` below is unguarded, NOT clean.
 *
 * 2. COMPLIANCE NOUNS ONLY, not brands. The brand half cannot be mirrored
 *    here honestly: `src/lib/ui-storage.ts` holds `UI_STORAGE_PREFIX =
 *    'inflect'` and spells example keys like `'inflect:theme'`, because being
 *    the one place the brand lives is that file's entire purpose (T01) — a
 *    downstream product changes one constant instead of carrying a diff at
 *    every call site. A brand rule applied here would fire on the seam that
 *    exists to contain it.
 *
 * 3. CRUDER THAN THEIRS. Their rule is AST-aware and skips identifiers and
 *    import paths; this is a line scan, so it would flag an identifier their
 *    checker spares. That asymmetry is safe in one direction only — this can
 *    report what theirs would not, never the reverse — so a finding here is
 *    worth reading rather than trusting blindly. Their own rule also
 *    over-reports: it flags the VERB "vendors" (projectZ#300 fixed two
 *    neighbouring cases of the same shape).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Vendored by projectZ T17, or cited in #3062 as owing neutral wording. */
const VENDORED = [
    'src/lib/cn.ts',
    'src/components/theme/ThemeProvider.tsx',
    'src/components/layout/session-expired-notice.tsx',
    'src/lib/auth/session-expiry.ts',
    'src/lib/ui-storage.ts',
] as const;

/** projectZ's compliance nouns, transcribed from `portable-rules.mjs`. */
const NOUNS = [
    'controls', 'risks', 'evidence', 'audit(?:s|ed|ing|ors?)?', 'policies',
    'vendors', 'findings', 'assessments', 'frameworks', 'requirements',
    'incidents', 'assets', 'posture', 'readiness',
];
const VOCAB = new RegExp(`(?<![\\w])(?:${NOUNS.join('|')})(?![\\w])`, 'gi');
// Their carve-out, kept: a technical attribute, not the GRC noun.
const NOT_VOCAB = /aria-controls/gi;
// "a product that VENDORS these files" is the verb. Their rule flags it; this
// one does not, rather than contorting accurate prose to satisfy a false
// positive.
const VENDORS_VERB = /\bthat vendors\b/gi;

function hits(rel: string): string[] {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return text.split('\n').flatMap((line, i) => {
        const masked = line
            .replace(NOT_VOCAB, (w) => ' '.repeat(w.length))
            .replace(VENDORS_VERB, (w) => ' '.repeat(w.length));
        return [...masked.matchAll(VOCAB)].map(
            (m) => `${rel}:${i + 1} [${m[0]}] ${line.trim().slice(0, 80)}`,
        );
    });
}

describe('vendored files carry no compliance vocabulary', () => {
    it('the population is what it claims — every listed file exists', () => {
        // Without this the suite passes by listing nothing, or by listing a
        // path that has since moved.
        for (const rel of VENDORED) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
        expect(VENDORED.length).toBeGreaterThanOrEqual(5);
    });

    it.each(VENDORED)('%s', (rel) => {
        expect(hits(rel)).toEqual([]);
    });

    it('the matcher can actually fire — positive control', () => {
        // Vacuous otherwise: a regex matching nothing passes every case above.
        const tmp = path.join(ROOT, 'tests/guards/__vocab-probe.tmp.ts');
        fs.writeFileSync(tmp, '// the control evidence and the risks\n');
        try {
            expect(hits('tests/guards/__vocab-probe.tmp.ts').length).toBeGreaterThan(0);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    it('spares the two shapes it is meant to spare', () => {
        const tmp = path.join(ROOT, 'tests/guards/__vocab-probe2.tmp.ts');
        fs.writeFileSync(
            tmp,
            '// <div aria-controls="x" /> and a product that vendors these files\n',
        );
        try {
            expect(hits('tests/guards/__vocab-probe2.tmp.ts')).toEqual([]);
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});
