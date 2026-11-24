/**
 * Code and monospace identifiers wrap instead of running off a phone screen.
 *
 * A webhook URL, a redirect URI, an environment variable name or a digest has
 * no space to break at. In `<code>` or `font-mono` it ran past the right edge,
 * where the shell's `overflow-x-clip` cut it off. One global rule fixes every
 * such element: `overflow-wrap: anywhere` on `code`, `samp` and `.font-mono`.
 *
 * `anywhere`, not `break-word`: only `anywhere` lowers the element's
 * min-content width, which is what lets a `<dd className="font-mono">` in a
 * flex row shrink beside its `<dt>`. And in `@layer base`, so a utility on one
 * element (`whitespace-nowrap`, `wrap-normal`) still overrides it.
 *
 * Compiles the real stylesheet through the real Tailwind plugin (a child
 * process: Jest cannot load `@tailwindcss/postcss`).
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

let css = '';
beforeAll(() => {
    css = execFileSync(
        process.execPath,
        [path.join(__dirname, '../helpers/compile-globals-css.mjs')],
        { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
}, 180_000);

function codeRule(): RegExpMatchArray {
    const rule = css.match(/code,\s*samp,\s*\.font-mono\s*\{[^}]*\}/);
    if (!rule) throw new Error('no rule for code, samp, .font-mono in the compiled stylesheet');
    return rule;
}

describe('code and identifiers wrap', () => {
    it('compiles to something substantial (floor on the collector)', () => {
        expect(css.length).toBeGreaterThan(50_000);
    });

    it('breaks code, samp and .font-mono anywhere', () => {
        expect(codeRule()[0]).toMatch(/overflow-wrap:\s*anywhere/);
        expect(codeRule()[0]).not.toMatch(/overflow-wrap:\s*break-word/);
    });

    it('sits in the base layer, below every utility', () => {
        const before = css.slice(0, codeRule().index);
        const base = before.lastIndexOf('@layer base');
        expect(base).toBeGreaterThan(-1);
        expect(base).toBeGreaterThan(before.lastIndexOf('@layer components'));
        expect(base).toBeGreaterThan(before.lastIndexOf('@layer utilities'));
    });
});
