/**
 * RQ4-1 — Page/subpage segregation ratchet.
 *
 * Walks `src/app/t/[tenantSlug]/(app)/**` and confirms that every `page.tsx`
 * found on disk is classified by `src/lib/nav/page-segregation.ts`. An
 * unlisted route fails CI — the segregation file is the structural source
 * of truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    MAIN_PAGES,
    SUBPAGES,
    classifyRoute,
    normalizePathname,
} from '@/lib/nav/page-segregation';

const APP_PAGES = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === 'page.tsx') out.push(full);
    }
    return out;
}

function routeFromFile(file: string): string {
    const rel = path.relative(APP_PAGES, file);
    return '/' + rel.replace(/\/page\.tsx$/, '');
}

describe('rq4-1 page segregation', () => {
    it('every page.tsx is classified as MAIN or SUBPAGE', () => {
        const pages = walk(APP_PAGES).map(routeFromFile);
        const unclassified: string[] = [];

        // AN EXACT ENTRY, not a pattern match.
        //
        // `classifyRoute` resolves a RUNTIME pathname, so `[param]` segments
        // are wildcards — `matchesPattern` skips them. That is right for
        // classifying `/agents/cm123`, and wrong for asking "is this page on
        // disk listed": every new `/agents/<name>` matched `/agents/[agentId]`
        // and came back classified.
        //
        // Not hypothetical. Measured when this changed: `/agents/decisions`
        // and `/agents/reports` — both real, both shipped — had never been
        // listed, and this scan had reported nothing about either.
        //
        // The route derived from disk preserves the directory name, so
        // `agents/[agentId]/page.tsx` yields the literal `/agents/[agentId]`
        // and a dynamic route still matches its own entry exactly.
        const listed = new Set([...MAIN_PAGES, ...SUBPAGES] as readonly string[]);
        for (const route of pages) {
            if (!listed.has(route)) unclassified.push(route);
        }

        expect(unclassified).toEqual([]);
    });

    it('MAIN_PAGES and SUBPAGES are disjoint', () => {
        const overlap = MAIN_PAGES.filter((p) =>
            (SUBPAGES as readonly string[]).includes(p),
        );
        expect(overlap).toEqual([]);
    });

    it('no duplicate entries within either list', () => {
        expect(new Set(MAIN_PAGES).size).toBe(MAIN_PAGES.length);
        expect(new Set(SUBPAGES).size).toBe(SUBPAGES.length);
    });

    it('normalizePathname strips the tenant prefix and resolves dynamic segments', () => {
        expect(normalizePathname('/t/acme/risks/abc-123')).toBe('/risks/[riskId]');
        expect(normalizePathname('/t/acme/dashboard')).toBe('/dashboard');
        expect(normalizePathname('/t/acme/tests/runs/run-1')).toBe(
            '/tests/runs/[runId]',
        );
        expect(normalizePathname('/login')).toBeNull();
    });

    it('classifyRoute returns the expected class for representative routes', () => {
        expect(classifyRoute('/t/acme/dashboard')).toBe('main');
        expect(classifyRoute('/t/acme/risks')).toBe('main');
        expect(classifyRoute('/t/acme/risks/r1')).toBe('subpage');
        expect(classifyRoute('/t/acme/admin')).toBe('main');
        expect(classifyRoute('/t/acme/admin/security')).toBe('subpage');
        expect(classifyRoute('/login')).toBe('unknown');
    });
});
