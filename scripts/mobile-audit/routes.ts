/**
 * Every page route of the app, read from `src/app/**\/page.tsx`.
 *
 * Route groups (`(app)`) and private folders (`_components`) do not appear in
 * a URL and are dropped; a dynamic segment keeps its `[name]` and is resolved
 * later (`resolve.ts`). The list is derived from the file system on every run,
 * so a page added to the app is in the next audit without anybody listing it.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type RouteAudience =
    /** `/t/[tenantSlug]/…` — signed in as the seeded tenant OWNER. */
    | 'tenant'
    /** `/org/[orgSlug]/…` — signed in as the seeded ORG_OWNER. */
    | 'org'
    /** Account pages outside a tenant that still need a session. */
    | 'session'
    /** Sign-in, invitations and the public pages: no session. */
    | 'anonymous';

export interface AppRoute {
    /** The route pattern, e.g. `/t/[tenantSlug]/risks/[riskId]`. */
    pattern: string;
    /** The page file, relative to the repository root. */
    file: string;
    audience: RouteAudience;
    /** Dynamic segment names, in order: `['tenantSlug', 'riskId']`. */
    params: string[];
}

/** Pages outside a tenant or org that are reached with a session. */
const SESSION_ROUTES = new Set(['/account/profile', '/account/security', '/dashboard', '/tenants', '/no-tenant']);

export function audienceOf(pattern: string): RouteAudience {
    if (pattern === '/t/[tenantSlug]' || pattern.startsWith('/t/[tenantSlug]/')) return 'tenant';
    if (pattern === '/org/[orgSlug]' || pattern.startsWith('/org/[orgSlug]/')) return 'org';
    if (SESSION_ROUTES.has(pattern)) return 'session';
    return 'anonymous';
}

/** `src/app/t/[tenantSlug]/(app)/risks/page.tsx` → `/t/[tenantSlug]/risks`. */
export function patternOfPageFile(fileUnderApp: string): string | null {
    const parts = fileUnderApp.split(/[\\/]/);
    if (parts.pop() !== 'page.tsx') return null;
    const segments: string[] = [];
    for (const p of parts) {
        if (p.startsWith('_') || p.startsWith('@')) return null; // private folder / parallel slot
        if (p.startsWith('(') && p.endsWith(')')) continue; // route group
        segments.push(p);
    }
    return `/${segments.join('/')}`;
}

export function paramsOf(pattern: string): string[] {
    return Array.from(pattern.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g), (m) => m[1]);
}

function walk(dir: string, into: string[]): void {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, into);
        else if (name === 'page.tsx') into.push(full);
    }
}

/** Every page route under `<repoRoot>/src/app`, sorted by pattern. */
export function enumerateRoutes(repoRoot: string): AppRoute[] {
    const appDir = path.join(repoRoot, 'src', 'app');
    const files: string[] = [];
    walk(appDir, files);
    const routes: AppRoute[] = [];
    for (const file of files) {
        const pattern = patternOfPageFile(path.relative(appDir, file));
        if (!pattern) continue;
        routes.push({
            pattern: pattern === '/' ? '/' : pattern.replace(/\/$/, ''),
            file: path.relative(repoRoot, file).split(path.sep).join('/'),
            audience: audienceOf(pattern),
            params: paramsOf(pattern),
        });
    }
    return routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** Fill a pattern's `[name]` segments from `values`; null when one is missing. */
export function fillPattern(pattern: string, values: Readonly<Record<string, string>>): string | null {
    let missing = false;
    const url = pattern.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_, name: string) => {
        const v = values[name];
        if (v === undefined) missing = true;
        return v === undefined ? '' : encodeURIComponent(v);
    });
    return missing ? null : url;
}

/** A file-system-safe name for a route, used for screenshots: `/t/[tenantSlug]/risks` → `t_tenantSlug_risks`. */
export function routeSlug(pattern: string): string {
    return pattern.replace(/^\//, '').replace(/[[\]]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'root';
}
