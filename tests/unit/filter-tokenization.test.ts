/**
 * Epic 53 gap remediation — Dub-ported filter components on semantic tokens.
 *
 * The three filter components were ported from `@dub/ui` verbatim, which
 * meant they shipped with Dub's light-theme palette hard-coded (`bg-white`,
 * `text-black`, `border-neutral-200`, etc.). On Inflect's dark glassmorphism
 * shell that rendered as a white island inside a dark toolbar. This pass
 * swapped the raw colors for Inflect's semantic tokens so the filter UI
 * flips correctly under the Epic 51 theme toggle.
 *
 * Guards:
 *   1. Drift sentinel — the three files must not re-introduce raw Dub colors.
 *   2. Dead-code sentinel — `use-router-stuff` / `use-pagination` were
 *      superseded by `useListPagination`; deleting them means the hooks
 *      barrel no longer lists them. Re-adding either regresses the cleanup.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}
function exists(rel: string): boolean {
    return fs.existsSync(path.join(ROOT, rel));
}

// Raw-color vocabulary that the Dub ports brought in and that the token pass
// swapped out. Any reappearance means a refactor accidentally reverted to the
// Dub-native palette — fail CI so the fix stays sticky.
const RAW_COLOR_PATTERNS: RegExp[] = [
    /\bbg-white\b/,
    /\btext-black\b/,
    /\bbg-neutral-\d/,
    /\btext-neutral-\d/,
    /\bborder-neutral-\d/,
    /\bring-neutral-\d/,
    /\bdivide-neutral-\d/,
    /\bplaceholder-neutral-\d/,
    /\bplaceholder:text-neutral-\d/,
];

const TOKENISED_FILES = [
    'src/components/ui/filter/filter-range-panel.tsx',
    'src/components/ui/filter/filter-list.tsx',
    'src/components/ui/filter/filter-select.tsx',
] as const;

describe('Filter components — no raw Dub palette colors', () => {
    it.each(TOKENISED_FILES)('%s uses only semantic tokens', (rel) => {
        const src = read(rel);
        for (const pattern of RAW_COLOR_PATTERNS) {
            expect(src).not.toMatch(pattern);
        }
    });

    it.each(TOKENISED_FILES)(
        '%s imports + applies at least one semantic color token',
        (rel) => {
            const src = read(rel);
            // A file that legitimately renders colors must carry at least one
            // of the documented token surfaces. Catches a regression that
            // swaps raw classes for `bg-transparent` without going to tokens.
            expect(src).toMatch(/\b(bg-bg-|text-content-|border-border-|bg-brand-|text-brand-)/);
        },
    );
});

describe('Dead code sentinel — Dub pagination hooks removed', () => {
    const REMOVED = [
        'src/components/ui/hooks/use-router-stuff.ts',
        'src/components/ui/hooks/use-pagination.ts',
    ];

    it.each(REMOVED)('%s no longer exists (superseded by useListPagination)', (rel) => {
        expect(exists(rel)).toBe(false);
    });

    it('hooks barrel does not re-export useRouterStuff or usePagination', () => {
        const barrel = read('src/components/ui/hooks/index.ts');
        expect(barrel).not.toMatch(/useRouterStuff/);
        expect(barrel).not.toMatch(/usePagination\b/);
    });

    it('nothing in src/ still imports the removed hooks', () => {
        // Walk src/ and look for imports; tests directory is allowed to
        // document the removal but shouldn't actively depend on them.
        const files: string[] = [];
        function walk(dir: string) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) files.push(full);
            }
        }
        walk(path.join(ROOT, 'src'));

        const offenders: string[] = [];
        for (const f of files) {
            const src = codeOf(fs.readFileSync(f, 'utf-8'));
            if (/from ["'].*use-router-stuff["']/.test(src)) offenders.push(path.relative(ROOT, f));
            if (/from ["'].*use-pagination["']/.test(src)) offenders.push(path.relative(ROOT, f));
        }
        expect(offenders).toEqual([]);
    });
});
