/**
 * RQ4-3 — NavigationTracker mount ratchet.
 *
 * Locks the structural invariants:
 *   - `<NavigationTracker>` is mounted exactly once in the tenant app
 *     layout.
 *   - The tracker file is a client component (`'use client'`) — it relies
 *     on `usePathname` which only works in the browser.
 *   - `usePreviousPath.ts` is the only writer to the sessionStorage slot.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const LAYOUT_PATH = path.resolve(
    __dirname,
    "../../src/app/t/[tenantSlug]/(app)/layout.tsx",
);
const TRACKER_PATH = path.resolve(
    __dirname,
    '../../src/components/nav/NavigationTracker.tsx',
);
const HOOK_PATH = path.resolve(
    __dirname,
    '../../src/lib/nav/usePreviousPath.ts',
);

describe('rq4-3 navigation tracker', () => {
    it('the tenant app layout imports NavigationTracker', () => {
        const source = codeOf(fs.readFileSync(LAYOUT_PATH, 'utf-8'));
        expect(source).toMatch(
            /import\s+\{\s*NavigationTracker\s*\}\s+from\s+['"]@\/components\/nav\/NavigationTracker['"]/,
        );
    });

    it('the layout mounts NavigationTracker exactly once', () => {
        const source = codeOf(fs.readFileSync(LAYOUT_PATH, 'utf-8'));
        const matches = source.match(/<NavigationTracker\s*\/?\s*>/g) ?? [];
        expect(matches.length).toBe(1);
    });

    it('NavigationTracker is a client component', () => {
        const source = codeOf(fs.readFileSync(TRACKER_PATH, 'utf-8'));
        expect(source.startsWith("'use client';")).toBe(true);
    });

    it('usePreviousPath module is a client module', () => {
        const source = codeOf(fs.readFileSync(HOOK_PATH, 'utf-8'));
        expect(source.startsWith("'use client';")).toBe(true);
    });

    it('the storage key prefix is namespaced and stable', () => {
        const source = codeOf(fs.readFileSync(HOOK_PATH, 'utf-8'));
        expect(source).toMatch(
            /PREV_PATH_KEY_PREFIX\s*=\s*['"]inflect:nav:prev:['"]/,
        );
    });

    it('uses sessionStorage (per-tab) and never window.localStorage (cross-tab)', () => {
        const source = codeOf(fs.readFileSync(HOOK_PATH, 'utf-8'));
        expect(source).toMatch(/window\.sessionStorage/);
        expect(source).not.toMatch(/window\.localStorage/);
    });

    it('exposes a cross-tenant clear helper (OB-E)', () => {
        const source = codeOf(fs.readFileSync(HOOK_PATH, 'utf-8'));
        expect(source).toMatch(/export\s+function\s+clearPreviousPath\b/);
        const trackerSource = codeOf(fs.readFileSync(TRACKER_PATH, 'utf-8'));
        expect(trackerSource).toMatch(/clearPreviousPath/);
    });
});
