/**
 * Structural ratchet for the PDF stamp helpers.
 *
 * `src/lib/pdf/layout.ts` contains three functions that render
 * absolute-positioned text near or beyond a page margin:
 *   - addHeader (top, y=20)
 *   - addFooter (bottom, y=PAGE_HEIGHT-30)
 *   - addWatermark (center, rotated)
 *
 * Each of those text writes MUST pass a `height:` option to its
 * `text()` call. Without it, pdfkit's auto-pagination fires when
 * the cursor crosses the bottom margin — which is what caused the
 * Audit Readiness / SoA PDFs to ship N trailing blank pages for
 * months (see `tests/unit/pdf-pagination.test.ts` and the
 * STAMP_TEXT_HEIGHT comment in `layout.ts`).
 *
 * This guard scans the source file and fails CI if ANY `text(`
 * call inside the three functions is missing the `height:` option.
 * It's a regex-level check, not an AST parse — but the rule is
 * shallow enough that the regex is both sufficient and resistant
 * to false positives.
 *
 * If a future contributor genuinely needs a text write without
 * `height:` (e.g. a debug-only call), they must either:
 *   (a) demonstrate that the new write cannot cross the bottom
 *       margin and update this ratchet to allowlist it by intent
 *       (with a comment explaining why), OR
 *   (b) just add `height:`. It's three keystrokes and defends
 *       against future margin/font/page-size changes shifting
 *       the rendering past the threshold.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const LAYOUT_PATH = path.resolve(__dirname, '../../src/lib/pdf/layout.ts');

interface FunctionRange {
    name: string;
    start: number;
    end: number;
}

function findFunctionRange(src: string, name: string): FunctionRange {
    // Match `export function NAME` OR `function NAME` — the
    // layout file uses `export function` for the public helpers.
    const startRe = new RegExp(`(?:export )?function ${name}\\s*\\(`);
    const startMatch = startRe.exec(src);
    if (!startMatch) {
        throw new Error(`${name} not found in src/lib/pdf/layout.ts`);
    }
    const start = startMatch.index;
    // Walk braces from the first `{` after the signature.
    const openIdx = src.indexOf('{', start);
    if (openIdx === -1) throw new Error(`${name} missing opening brace`);
    let depth = 0;
    let end = -1;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) throw new Error(`${name} missing closing brace`);
    return { name, start, end };
}

/**
 * Find every `text(` (or `.text(`) invocation inside [start, end)
 * and check whether the corresponding `text(...)` argument list
 * contains a `height:` key.
 *
 * Approach: walk the source, on each `text(` opener push a counter,
 * scan forward for the matching `)`, capture the contents, regex
 * for `height:` or `height ` (TS shorthand allowed). The regex
 * tolerates whitespace and string-interpolated text content
 * containing `(` characters (e.g. template literals).
 */
function findTextCallsMissingHeight(src: string, range: FunctionRange): Array<{ snippet: string; offset: number }> {
    const slice = src.slice(range.start, range.end);
    const offenders: Array<{ snippet: string; offset: number }> = [];

    // Find each `.text(` opener. We start the regex with a word
    // boundary + `.text(` (it's always called as a method on
    // pdfkit's doc — never standalone) OR `doc.text(`.
    const callRe = /\.text\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(slice)) !== null) {
        const openParenIdx = m.index + m[0].length - 1;
        // Brace-match the parentheses (respecting nested parens
        // inside template literals + nested option objects).
        let depth = 1;
        let inString: string | null = null;
        let i = openParenIdx + 1;
        for (; i < slice.length; i++) {
            const ch = slice[i];
            // Naive string detection — good enough for our shape.
            if (inString) {
                if (ch === inString && slice[i - 1] !== '\\') inString = null;
                continue;
            }
            if (ch === '`' || ch === '"' || ch === "'") {
                inString = ch;
                continue;
            }
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        if (depth !== 0) continue; // malformed — skip
        const argList = slice.slice(openParenIdx + 1, i);
        if (!/\bheight\s*:/.test(argList)) {
            offenders.push({
                snippet: argList.replace(/\s+/g, ' ').slice(0, 200),
                offset: range.start + m.index,
            });
        }
    }
    return offenders;
}

describe('PDF stamp helpers — every text() call must pass `height:`', () => {
    const src = codeOf(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    // The raw twin is the DELIBERATE seam (#2246): the rationale assertion
    // below has the PROSE as its subject — `auto-paginat` lives in a comment —
    // so over masked source it could never pass again.
    const srcDoc = fs.readFileSync(LAYOUT_PATH, 'utf8');

    // Scoped to the three stamp helpers — body-of-page text writes
    // (cover, metadata) live in different functions and follow the
    // normal pagination flow, so they don't need this guard.
    const TARGETED_FUNCTIONS = ['addHeader', 'addFooter', 'addWatermark'];

    it.each(TARGETED_FUNCTIONS)(
        '%s: every text() call carries height: to suppress auto-pagination',
        (fn) => {
            const range = findFunctionRange(src, fn);
            const offenders = findTextCallsMissingHeight(src, range);
            if (offenders.length > 0) {
                const list = offenders.map((o, idx) =>
                    `  [${idx + 1}] ${o.snippet}`,
                ).join('\n');
                throw new Error(
                    `${fn} has ${offenders.length} text() call(s) missing the \`height:\` option.\n` +
                    `Without \`height:\`, pdfkit auto-paginates when \`doc.y\` crosses the bottom margin, ` +
                    `creating trailing blank pages (the original Audit Readiness / SoA bug).\n\n` +
                    `Offenders:\n${list}\n\n` +
                    `See the STAMP_TEXT_HEIGHT comment in src/lib/pdf/layout.ts for the full rationale.`,
                );
            }
        },
    );

    it('STAMP_TEXT_HEIGHT constant is defined + load-bearing (anchors the rationale comment)', () => {
        expect(src).toMatch(/STAMP_TEXT_HEIGHT\s*=\s*\d+/);
        expect(srcDoc).toMatch(/auto-paginat/); // rationale anchor — RAW, it is a comment
    });
});
