/**
 * Instant-navigation guard — every dynamic detail route ships a `loading.tsx`.
 *
 * A detail route is a `[param]` directory containing a `page.tsx`. Without a
 * sibling `loading.tsx`, navigating to it shows a BLANK screen until the
 * server resolves the page data (the App Router has no instant boundary to
 * fall back to) — the single worst perceived-latency offender the perf audit
 * found (11 routes were blank). A `loading.tsx` renders an instant skeleton.
 *
 * This locks the fix: a new detail route can't ship without a skeleton.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

/**
 * Detail routes intentionally without their own `loading.tsx`. Add an entry
 * only with a written reason (e.g. a pure redirect with no data fetch).
 */
const EXEMPTIONS: ReadonlyArray<{ route: string; reason: string }> = [
    {
        route: 'admin/agents/[agentId]',
        reason:
            'Pure redirect shim (AGENTIC UI 1/4, #2427) — the agent detail page moved to ' +
            '/agents/[agentId], which HAS a loading.tsx and moved with it. This file is a ' +
            'one-line `redirect()` that fetches nothing, so there is no data wait for a ' +
            'skeleton to cover; rendering one would flash a fake agent page on the way past.',
    },
];
const EXEMPT = new Set(EXEMPTIONS.map((e) => e.route));

/** Walk the (app) tree, collecting `[param]` dirs that contain a page.tsx. */
function findDetailRouteDirs(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        const isDynamic = /^\[.+\]$/.test(entry.name);
        if (isDynamic && fs.existsSync(path.join(full, 'page.tsx'))) {
            acc.push(full);
        }
        findDetailRouteDirs(full, acc);
    }
    return acc;
}

describe('Instant-nav — detail routes have a loading.tsx skeleton', () => {
    const detailDirs = findDetailRouteDirs(APP_DIR);

    it('discovers the dynamic detail routes', () => {
        // Sanity: the scanner finds the known set (guards against a broken
        // walk silently asserting nothing).
        expect(detailDirs.length).toBeGreaterThanOrEqual(10);
    });

    it.each(detailDirs.map((d) => [path.relative(APP_DIR, d), d] as const))(
        '%s has a loading.tsx',
        (rel, dir) => {
            if (EXEMPT.has(rel)) return;
            expect(fs.existsSync(path.join(dir, 'loading.tsx'))).toBe(true);
        },
    );

    it('every exemption still exists (no stale entries)', () => {
        for (const { route } of EXEMPTIONS) {
            expect(fs.existsSync(path.join(APP_DIR, route, 'page.tsx'))).toBe(true);
        }
    });
});
