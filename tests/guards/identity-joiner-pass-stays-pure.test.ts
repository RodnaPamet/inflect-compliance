/**
 * `identity-joiner-pass.ts` reaches nothing: no prisma, no db-context, no
 * provider, no writer (#3650).
 *
 * Its own docblock called this "a load-bearing property rather than a style
 * choice" and said it was "pinned by a guard
 * (`tests/guards/identity-joiner-dry-run-is-inert.test.ts`)". That file has
 * never existed in this repository's history. The property held anyway — the
 * module has exactly two imports, both from `@/lib/identity/` — but it held by
 * habit, and the docblock told every reader to stop checking.
 *
 * WHY THE PROPERTY MATTERS. The pass is the DERIVATION half of the joiner: it
 * decides what identity a new starter should get. Keeping it free of the
 * database and the writers is what makes a dry run inert — you can derive the
 * whole plan, show it to an operator, and know that nothing was provisioned
 * because nothing in here can provision. An import of the writer would not fail
 * any test; it would quietly make "dry run" a claim rather than a fact.
 *
 * ALLOWLIST, NOT DENYLIST. A denylist of `prisma|db-context|provider|writer`
 * would pass the moment somebody imported a database helper under a name none
 * of those four words appear in — `@/lib/tenant-scope`, say. The allowlist
 * fails on anything new instead, which is the direction that cannot be
 * sidestepped by naming.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3650
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SUBJECT = 'src/app-layer/usecases/identity-joiner-pass.ts';

/**
 * Module specifiers this file may import.
 *
 * Deliberately narrow: pure helpers over identity strings. Adding to this list
 * is a decision somebody makes in a diff, which is the point — the property is
 * "reaches nothing", and every addition is a chance to ask whether it still
 * holds.
 */
const ALLOWED = ['@/lib/identity/write-ladder', '@/lib/identity/email-key'];

/** Every module specifier imported by a source text, static imports included. */
function importsOf(src: string): string[] {
    return [
        ...Array.from(src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm), (m) => m[1]),
        ...Array.from(src.matchAll(/^import\s+'([^']+)'/gm), (m) => m[1]),
        ...Array.from(src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g), (m) => m[1]),
    ].filter((x): x is string => typeof x === 'string');
}

describe('identity-joiner-pass reaches nothing (#3650)', () => {
    const src = fs.readFileSync(path.join(ROOT, SUBJECT), 'utf-8');

    it('finds the subject and its imports at all', () => {
        // Without this the assertion below passes over an empty list the moment
        // the file is renamed or the import syntax changes — and "no forbidden
        // imports" is exactly what an empty list looks like.
        expect(src.length).toBeGreaterThan(500);
        expect(importsOf(src).length).toBeGreaterThan(0);
    });

    it('imports only from the allowlist', () => {
        const unexpected = importsOf(src).filter((m) => !ALLOWED.includes(m));
        // A new import here is not automatically wrong — it is a decision.
        // Add it to ALLOWED only after asking whether this module can still be
        // run as a dry run that provably writes nothing.
        expect(unexpected).toEqual([]);
    });

    it('detects a forbidden import, and does not invent one', () => {
        // The negative control, driving the real extractor. A regex that matched
        // nothing would satisfy the assertion above for ever.
        const withPrisma = `import { prisma } from '@/lib/prisma';\n${src}`;
        expect(importsOf(withPrisma)).toContain('@/lib/prisma');
        expect(importsOf(withPrisma).filter((m) => !ALLOWED.includes(m))).toEqual([
            '@/lib/prisma',
        ]);

        // And the shapes a static-import-only regex would miss.
        expect(importsOf("import '@/lib/side-effect';")).toEqual(['@/lib/side-effect']);
        expect(importsOf("const x = await import('@/lib/lazy');")).toEqual(['@/lib/lazy']);
    });
});
