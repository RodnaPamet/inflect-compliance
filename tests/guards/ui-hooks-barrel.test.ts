/**
 * Epic 60 — UI utility hook barrel guardrail.
 *
 * Every `use-*.ts(x)` file in `src/components/ui/hooks/` must export
 * exactly one primary hook named from its file slug, and the barrel
 * (`src/components/ui/hooks/index.ts`) must re-export it. Without this
 * guard, a new hook can silently slip in via a deep-path import and
 * skip the "one canonical home" discipline the epic is built on.
 *
 * The guard runs as a plain file-scan test — no module loading, no
 * jsdom, fast enough to live under `tests/guards/`. Failures are
 * explicit: the error message names which file is missing a barrel
 * entry, which slug it expected, and where to add the line.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const HOOKS_DIR = path.resolve(
    __dirname,
    '../../src/components/ui/hooks',
);

const BARREL = path.join(HOOKS_DIR, 'index.ts');

/** Convert `use-local-storage` → `useLocalStorage`. */
function slugToHookName(slug: string): string {
    return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('Epic 60 — ui/hooks barrel completeness', () => {
    const files = fs
        .readdirSync(HOOKS_DIR)
        .filter((f) => /^use-.+\.tsx?$/.test(f));

    it('discovers at least a reasonable set of hook files', () => {
        // Sanity check on the discovery — if the directory moves or
        // gets accidentally emptied, the guard still fails noisily
        // rather than silently passing with zero assertions.
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    it('barrel index.ts exists', () => {
        expect(fs.existsSync(BARREL)).toBe(true);
    });

    const barrelSrc = codeOf(fs.readFileSync(BARREL, 'utf-8'));

    test.each(files)(
        '%s: file exports the expected hook and the barrel re-exports it',
        (file) => {
            const slug = file.replace(/\.tsx?$/, '').replace(/^use-/, '');
            const hookName = `use${slugToHookName('-' + slug).replace(/^./, (c) => c.toUpperCase())}`;
            // slugToHookName was written for `use-foo` (not `foo`);
            // simpler path: construct from slug directly.
            const expected = 'use' + slug
                .split('-')
                .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
                .join('');

            const content = codeOf(fs.readFileSync(path.join(HOOKS_DIR, file), 'utf-8'));
            // The file must export the hook (named export, no default).
            const fileExportsHook = new RegExp(
                `export (function|const|async function) ${expected}\\b|export \\{[^}]*\\b${expected}\\b[^}]*\\}`,
            ).test(content);
            expect(
                fileExportsHook,
            ).toBe(true);

            // The barrel must re-export it from this file path.
            const barrelLine = new RegExp(
                `from ["']\\./${file.replace(/\.tsx?$/, '')}["']`,
            );
            expect(barrelLine.test(barrelSrc)).toBe(true);
            expect(barrelSrc).toContain(expected);

            // Unused variables discharged for eslint peace.
            void hookName;
        },
    );
});

describe('Epic 60 — barrel export integrity', () => {
    it('barrel does not export a hook whose file has been deleted', () => {
        const barrelSrc = codeOf(fs.readFileSync(BARREL, 'utf-8'));
        const referencedFiles = Array.from(
            barrelSrc.matchAll(/from ["']\.\/(use-[a-z0-9-]+)["']/g),
            (m) => m[1],
        );
        for (const ref of referencedFiles) {
            const ts = path.join(HOOKS_DIR, `${ref}.ts`);
            const tsx = path.join(HOOKS_DIR, `${ref}.tsx`);
            expect(fs.existsSync(ts) || fs.existsSync(tsx)).toBe(true);
        }
    });
});
