/**
 * No route hand-builds a `Content-Disposition` filename.
 *
 * Seventeen sites interpolated a filename into `attachment; filename="${x}"`
 * and exactly ONE sanitised it. That ratio is the argument for a structural
 * guard rather than a behavioural one: the defect is not that any single route
 * was written wrong, it is that writing the next one correctly depended on
 * noticing what the sixteenth did.
 *
 * The dangerous characters are `"` (closes the quoted-string, so the rest of a
 * user-chosen name parses as further header parameters) and CR/LF (terminates
 * the header line — response splitting).
 *
 * @see src/lib/http/content-disposition.ts
 * @see tests/unit/content-disposition.test.ts — the behavioural half
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
        } else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * `filename="${…}"` in a template literal — the exact shape that shipped
 * sixteen times. Deliberately also catches S3's `ResponseContentDisposition`,
 * which is the same injection laundered through a presigned URL: S3 echoes
 * the value back as a real `Content-Disposition` header, served from the
 * bucket's origin. A grep for the header NAME alone misses it, and did.
 */
const RAW_INTERPOLATION = /filename="\$\{/;

const ALLOWED: Record<string, string> = {
    'src/lib/http/content-disposition.ts':
        'The builder itself — the one place the quoting may be written by hand.',
};

describe('Content-Disposition filenames go through the shared builder', () => {
    const files = walk(SRC);

    it('no file interpolates a filename into the header by hand', () => {
        const offenders = files
            .filter((f) => {
                const rel = path.relative(ROOT, f);
                if (ALLOWED[rel]) return false;
                return RAW_INTERPOLATION.test(stripComments(fs.readFileSync(f, 'utf8')));
            })
            .map((f) => path.relative(ROOT, f));

        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('the sanitiser still removes both dangerous character classes', () => {
        // A "simplification" that dropped either replace would leave the
        // helper looking correct at every call site while reopening the hole
        // at all of them at once — the cost of centralising.
        const src = fs.readFileSync(
            path.join(SRC, 'lib/http/content-disposition.ts'),
            'utf8',
        );
        // Non-printable ASCII → placeholder. This is the CR/LF defence.
        expect(src).toMatch(/\\x20-\\x7E/);
        // The quote that would end the quoted-string.
        expect(src).toMatch(/replace\(\/"\/g/);
    });

    it('every carve-out still exists and carries a reason', () => {
        for (const [rel, reason] of Object.entries(ALLOWED)) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });
});
