/**
 * Consumer-side counterpart to `list-page-perf-ratchet.test.ts`.
 *
 * That ratchet pins the four PRODUCER parts of the backfill-cap
 * package (server page cap, repository `take`, route
 * `applyBackfillCap`, single cap constant). It says nothing about the
 * CLIENTS that read those endpoints — and that is exactly the gap a
 * real outage fell through.
 *
 * #1788 changed `GET /api/t/:slug/assets` from a bare array to the
 * capped `{ rows, truncated }` envelope. Every list page was updated.
 * One consumer was missed: the "Link a CVE" modal on the
 * Vulnerabilities page still declared
 *
 *     useTenantSWR<AssetOption[]>('/assets')
 *
 * and then called `.map` on it. The SWR/`apiGet` generic is an
 * UNCHECKED assertion — there is no runtime validation behind it — so
 * `tsc` was perfectly happy and the break only surfaced in production
 * as `TypeError: (d ?? []).map is not a function`, which the error
 * boundary escalated into a blank page.
 *
 * TypeScript structurally cannot catch this class: the whole point of
 * the generic is that the caller asserts the shape. So the invariant
 * is enforced here instead.
 *
 * INVARIANT: no client may declare a bare-array generic (`T[]`) on a
 * tenant endpoint that returns the capped envelope. Declare
 * `CappedList<T>` (or the tolerant `CappedList<T> | T[]` union used by
 * modals that predate the change) and read `.rows`.
 *
 * When a new list entity adopts `applyBackfillCap`, add it to
 * `CAPPED_ENDPOINTS` below.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * Tenant endpoints whose GET returns `CappedList<T>`. Kept in sync
 * with the routes that call `applyBackfillCap` — the completeness
 * test below derives the real list from source and fails if this
 * drifts, so a new capped route cannot silently skip the check.
 */
const CAPPED_ENDPOINTS: readonly string[] = [
    'access-reviews',
    'assets',
    'audits',
    'controls',
    'evidence',
    'findings',
    'policies',
    'risks',
    'tasks',
    'vendors',
];

/** Recursively collect `.ts` / `.tsx` files under a directory. */
function walk(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

const SOURCE_FILES = walk(SRC);

/**
 * Matches a read helper called with an array generic against one of
 * the capped endpoints, e.g.
 *   useTenantSWR<AssetOption[]>('/assets')
 *   apiGet<ControlDTO[]>(`/api/t/${slug}/controls`)
 *
 * A `CappedList<T> | T[]` union also contains `[]`, so the pattern
 * requires the generic to END at `[]` with no `CappedList` anywhere
 * in it — the tolerant union stays legal.
 */
function findViolations(): string[] {
    const violations: string[] = [];
    const endpointAlt = CAPPED_ENDPOINTS.join('|');
    // <...[]> followed by a call whose first argument names a capped endpoint.
    const pattern = new RegExp(
        String.raw`(useTenantSWR|apiGet)<([^>]*\[\])>\s*\(\s*[^,)]*?['"\`]/(?:api/t/\$\{[^}]*\}/)?(${endpointAlt})['"\`]`,
        'g',
    );

    for (const file of SOURCE_FILES) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(pattern)) {
            const generic = m[2];
            // The tolerant union (`CappedList<T> | T[]`) is the sanctioned form.
            if (generic.includes('CappedList')) continue;
            const line = text.slice(0, m.index).split('\n').length;
            violations.push(
                `${path.relative(ROOT, file)}:${line} — ${m[1]}<${generic}>('/${m[3]}') ` +
                    `declares a bare array; /${m[3]} returns CappedList<T> ({ rows, truncated }).`,
            );
        }
    }
    return violations;
}

describe('capped-list consumers', () => {
    it('never declare a bare-array generic on a capped endpoint', () => {
        const violations = findViolations();
        expect(violations).toEqual([]);
    });

    it('CAPPED_ENDPOINTS matches the routes that actually call applyBackfillCap', () => {
        const apiRoot = path.join(SRC, 'app/api/t/[tenantSlug]');
        const actual = walk(apiRoot)
            .filter((f) => f.endsWith('route.ts'))
            .filter((f) => fs.readFileSync(f, 'utf8').includes('applyBackfillCap'))
            .map((f) => path.relative(apiRoot, f).replace(/\/route\.ts$/, ''))
            // Only top-level entity routes participate; nested ones inherit.
            .filter((p) => !p.includes('/'))
            .sort();

        expect(actual).toEqual([...CAPPED_ENDPOINTS].sort());
    });

    it('detects the exact regression that shipped (mutation proof)', () => {
        // The guard is only worth its runtime if it actually fires on the
        // pattern that broke production. Prove it against the real string
        // rather than trusting the regex by inspection.
        const broken = `const { data: assets } = useTenantSWR<AssetOption[]>('/assets');`;
        const pattern = new RegExp(
            String.raw`(useTenantSWR|apiGet)<([^>]*\[\])>\s*\(\s*[^,)]*?['"\`]/(?:api/t/\$\{[^}]*\}/)?(${CAPPED_ENDPOINTS.join('|')})['"\`]`,
        );
        expect(pattern.test(broken)).toBe(true);

        // ...and does NOT fire on the sanctioned tolerant union.
        const fixed = `useTenantSWR<CappedList<AssetOption> | AssetOption[]>('/assets')`;
        const m = fixed.match(pattern);
        expect(m === null || m[2].includes('CappedList')).toBe(true);
    });
});
