/**
 * Every in-app link written as a literal tenant path resolves to a page.
 *
 * The incident page told its reader to configure the notification authority
 * under "tenant security settings" and linked `/t/<slug>/admin/settings`, a
 * route that never had a `page.tsx`: a 404 on the one sentence that says
 * where to go. A sweep found four more (a search hit, two portfolio
 * drill-downs, a BIA link and the calendar connect callback). Nothing checked
 * that a written path names a page, so each one shipped green.
 *
 * WHAT IS READ. Every template literal in `src/` that starts
 * `` `/t/${…}/… `` — the form links, `router.push` targets, redirects and
 * notification URLs take — cut at its query or fragment. The population comes
 * from git (`repoFiles`), and so does the set of pages: every `page.tsx` under
 * `src/app/t/[tenantSlug]`, route groups dropped.
 *
 * HOW A PATH MATCHES. Segment by segment. A static segment matches the same
 * name or a dynamic route segment; an interpolated segment (`${id}`) matches
 * only a dynamic one, so `/evidence/${id}` against a list page with no
 * `[id]` child is a miss. A catch-all accepts the rest.
 *
 * WHAT IS NOT JUDGED, and why, so a skip is never silent:
 *   - a path whose FIRST segment is interpolated (`/t/${slug}/${section}`),
 *     or that is computed whole (`/t/${slug}${path}`): only the code that
 *     computes it knows the set;
 *   - a segment that is part literal and part interpolated
 *     (`business-continuity${query}`): the split is not knowable from text;
 *   - the bare tenant root (`/t/${slug}`), a base other paths are built on.
 * The skipped count is bounded below, so hiding a link behind one of these
 * shapes is not free.
 */
import * as fs from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';

const TENANT_PAGE_ROOT = 'src/app/t/[tenantSlug]/';

type Segment = { kind: 'static'; name: string } | { kind: 'dynamic' };

/** The route segments of every tenant page, route groups dropped. */
function tenantRoutes(): string[][] {
    return repoFiles({ under: 'src/app/t' })
        .map(repoRelative)
        .filter((rel) => rel.startsWith(TENANT_PAGE_ROOT) && /\/page\.tsx?$/.test(rel))
        .map((rel) =>
            rel
                .slice(TENANT_PAGE_ROOT.length)
                .replace(/\/?page\.tsx?$/, '')
                .split('/')
                .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s)),
        );
}

function routeAccepts(route: readonly string[], target: readonly Segment[]): boolean {
    for (let i = 0; i < route.length; i++) {
        const seg = route[i];
        if (seg.startsWith('[[...')) return true;
        if (seg.startsWith('[...')) return target.length > i;
        const t = target[i];
        if (!t) return false;
        if (seg.startsWith('[')) continue;
        if (t.kind === 'dynamic' || t.name !== seg) return false;
    }
    return route.length === target.length;
}

/** `undefined` when the path is one this guard does not judge (see header). */
function parseTarget(rest: string): Segment[] | undefined {
    if (!rest.startsWith('/')) return undefined;
    const parts = rest.split('/').filter((s) => s.length > 0);
    if (parts.length === 0) return undefined;
    const segments: Segment[] = [];
    for (const part of parts) {
        if (/^\$\{[^}]*\}$/.test(part)) segments.push({ kind: 'dynamic' });
        else if (part.includes('${')) return undefined;
        else segments.push({ kind: 'static', name: part });
    }
    if (segments[0].kind === 'dynamic') return undefined;
    return segments;
}

/** The literal tenant paths in one file's text: `` `/t/${…}<rest>` ``, rest cut at `?` / `#`. */
function tenantPathsIn(text: string): string[] {
    const found: string[] = [];
    const re = /`\/t\/\$\{[^}`]+\}((?:\$\{[^}`]*\}|[^`?#$])*)[`?#$]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.push(m[1]);
    return found;
}

interface Scan {
    misses: string[];
    judged: number;
    skipped: number;
}

function scan(files: ReadonlyArray<{ rel: string; text: string }>, routes: string[][]): Scan {
    const out: Scan = { misses: [], judged: 0, skipped: 0 };
    for (const { rel, text } of files) {
        for (const rest of tenantPathsIn(text)) {
            const target = parseTarget(rest);
            if (!target) {
                out.skipped++;
                continue;
            }
            out.judged++;
            if (!routes.some((route) => routeAccepts(route, target))) {
                out.misses.push(`${rel}: /t/<slug>${rest}`);
            }
        }
    }
    return out;
}

const routes = tenantRoutes();
const sourceFiles = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
    rel: repoRelative(abs),
    text: fs.readFileSync(abs, 'utf8'),
}));

describe('literal tenant paths resolve to a page', () => {
    it('finds the tenant pages it matches against', () => {
        // A broken page discovery would make every path a miss, or (with a
        // bug in the matcher) none; both are caught by the cases below, and
        // this one says which half broke.
        expect(routes.length).toBeGreaterThan(100);
        expect(routes).toContainEqual(['admin', 'security']);
        expect(routes).toContainEqual(['incidents', '[incidentId]']);
    });

    it('every literal `/t/${…}/…` path in src names a page', () => {
        const result = scan(sourceFiles, routes);
        expect(result.misses).toEqual([]);
    });

    it('judges far more paths than it skips', () => {
        const result = scan(sourceFiles, routes);
        expect(result.judged).toBeGreaterThan(250);
        // The skipped shapes are few and named in the header. A jump here is
        // links moving into a shape the guard cannot read.
        expect(result.skipped).toBeLessThanOrEqual(35);
    });

    describe('the matcher (planted paths)', () => {
        const plant = (line: string) => scan([{ rel: 'planted.tsx', text: line }], routes);

        it('reports a static page that does not exist', () => {
            expect(plant('<Link href={`/t/${tenantSlug}/admin/settings`} />').misses).toEqual([
                'planted.tsx: /t/<slug>/admin/settings',
            ]);
        });

        it('reports an id under a list page that has no detail route', () => {
            expect(plant('const u = `/t/${tenant.slug}/evidence/${e.id}`;').misses).toHaveLength(1);
        });

        it('accepts a real page, with an id, a query and a fragment', () => {
            const r = plant(
                'a(`/t/${s}/incidents/${id}`); b(`/t/${s}/evidence?ev=${id}`); c(`/t/${s}/admin/security#x`);',
            );
            expect(r.judged).toBe(3);
            expect(r.misses).toEqual([]);
        });

        it('skips a computed section and a part-interpolated segment, and counts them', () => {
            const r = plant('a(`/t/${s}/${section}/x`); b(`/t/${s}/audits${q}`); c(`/t/${s}`);');
            expect(r.judged).toBe(0);
            expect(r.skipped).toBe(3);
        });
    });
});
