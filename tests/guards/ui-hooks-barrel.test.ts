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

const ROOT = path.resolve(__dirname, '../..');

/**
 * Hooks live in TWO places as of #3046 step 3a, and the barrel stays in `src/`.
 *
 * 21 of these modules moved into `packages/ui`; three did not, because the
 * boundary compiler rejected them — each reaches for something that belongs in
 * the package but has not moved yet (`@/lib/ui-storage`,
 * `@/components/ui/undo-toast`, `@/lib/hooks/use-keyboard-shortcut`). The barrel
 * therefore re-exports from both locations and must stay in `src/` until they
 * follow.
 *
 * The >= 5 floor below fired on that move, exactly as its own comment said it
 * would ("if the directory moves or gets accidentally emptied"). It is NOT
 * lowered to fit the three that remain: the files did not go away, so the
 * discovery follows them. Lowering it would be the thing the floor exists to
 * catch, wearing a diff.
 */
const HOOK_DIRS = [
    path.join(ROOT, 'src/components/ui/hooks'),
    path.join(ROOT, 'packages/ui/src/components/ui/hooks'),
];

/** The barrel stays in `src/` — see HOOK_DIRS. */
const BARREL = path.join(ROOT, 'src/components/ui/hooks/index.ts');

/** `use-foo` -> the directory that holds it, so each read goes to the right one. */
function dirOf(file: string): string {
    const hit = HOOK_DIRS.find((d) => fs.existsSync(path.join(d, file)));
    if (!hit) throw new Error(`discovered ${file} but cannot locate it`);
    return hit;
}

/** The specifier the barrel must use, which differs by where the file lives. */
function barrelSpecifier(file: string): RegExp {
    const stem = file.replace(/\.tsx?$/, '');
    const inPackage = dirOf(file).includes('packages/ui');
    return inPackage
        ? new RegExp(`from ["']@inflect/ui/components/ui/hooks/${stem}["']`)
        : new RegExp(`from ["']\\./${stem}["']`);
}

/** Convert `use-local-storage` → `useLocalStorage`. */
function slugToHookName(slug: string): string {
    return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('Epic 60 — ui/hooks barrel completeness', () => {
    const files = Array.from(
        new Set(
            HOOK_DIRS.filter((d) => fs.existsSync(d)).flatMap((d) =>
                fs.readdirSync(d).filter((f) => /^use-.+\.tsx?$/.test(f)),
            ),
        ),
    ).sort();

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

            const content = codeOf(fs.readFileSync(path.join(dirOf(file), file), 'utf-8'));
            // The file must export the hook (named export, no default).
            const fileExportsHook = new RegExp(
                `export (function|const|async function) ${expected}\\b|export \\{[^}]*\\b${expected}\\b[^}]*\\}`,
            ).test(content);
            expect(
                fileExportsHook,
            ).toBe(true);

            // The barrel must re-export it — relatively while the file is still
            // in `src/`, by package specifier once it has moved.
            expect(barrelSpecifier(file).test(barrelSrc)).toBe(true);
            expect(barrelSrc).toContain(expected);

            // Unused variables discharged for eslint peace.
            void hookName;
        },
    );
});

describe('Epic 60 — barrel export integrity', () => {
    it('barrel does not export a hook whose file has been deleted', () => {
        const barrelSrc = codeOf(fs.readFileSync(BARREL, 'utf-8'));
        // BOTH specifier forms, or the check goes blind on the 21 that moved —
        // a barrel line pointing at a deleted package module would pass.
        const referencedFiles = [
            ...Array.from(
                barrelSrc.matchAll(/from ["']\.\/(use-[a-z0-9-]+)["']/g),
                (m) => m[1],
            ),
            ...Array.from(
                barrelSrc.matchAll(
                    /from ["']@inflect\/ui\/components\/ui\/hooks\/(use-[a-z0-9-]+)["']/g,
                ),
                (m) => m[1],
            ),
        ];
        expect(referencedFiles.length).toBeGreaterThanOrEqual(5);
        for (const ref of referencedFiles) {
            const found = HOOK_DIRS.some((d) =>
                ['.ts', '.tsx'].some((e) => fs.existsSync(path.join(d, `${ref}${e}`))),
            );
            expect({ ref, found }).toEqual({ ref, found: true });
        }
    });
});
