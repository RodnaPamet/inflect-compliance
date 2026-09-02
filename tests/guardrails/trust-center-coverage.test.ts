/**
 * Trust Center coverage ratchet — this test IS a security control.
 *
 * A Trust Center is the ONLY intentionally-public surface in an otherwise
 * auth+RLS-locked multi-tenant app. The single worst failure mode is the
 * public page leaking one un-curated field. These structural locks make that
 * regression class fail CI:
 *
 *   1. TrustCenter model exists; `enabled` defaults FALSE (off by default).
 *   2. IMPORT ISOLATION (the leak-prevention lock): the entire transitive
 *      import graph reachable from the public /trust/[slug] route contains NO
 *      tenant-data usecase/repository (Risk/Control/Evidence/Finding/…). The
 *      only data path is the single curated TrustCenter read.
 *   3. The public read selects an explicit field ALLOWLIST (never tenantId).
 *   4. `/trust/` is in the middleware public-path allowlist (with a comment)
 *      AND is edge-rate-limited.
 *   5. Publish/unpublish is OWNER-permission-gated + audited.
 *   6. All TrustCenter free-text fields are sanitised on write.
 *   7. A disabled/missing slug returns 404 (notFound), never 403.
 *
 * Concept credit: Govrix (MIT) "Trust Center". No Govrix code was ported.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { braceBlockAfter } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const PUBLIC_ROUTE = 'src/app/trust/[slug]/page.tsx';
const PUBLIC_READ = 'src/lib/trust-center/public.ts';
// H4 — the ACTUAL anonymous API entry points (previously un-ratcheted). Their
// only allowed tenant-touching module is the curated `gated.ts`.
const PUBLIC_API_ROUTES = [
    'src/app/api/trust/[slug]/access-request/route.ts',
    'src/app/api/trust/download/[token]/route.ts',
];
const CURATED_GATED = 'src/lib/trust-center/gated.ts';

// ─── Transitive import graph of the public route ────────────────────
// Follows local (`@/…` and relative) imports, collecting every reachable
// source file. Third-party (bare) imports are leaves. This is the engine
// behind the import-isolation lock.
function resolveImport(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
    else return null; // bare/3rd-party — not part of our source graph
    const candidates = [
        base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
        path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(ROOT, c);
    }
    return null;
}

function importsOf(rel: string): string[] {
    const src = read(rel);
    const specs: string[] = [];
    const re = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    // dynamic import('…')
    const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(src)) !== null) specs.push(m[1]);
    return specs;
}

function transitiveGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
        const f = stack.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        for (const spec of importsOf(f)) {
            const resolved = resolveImport(spec, f);
            if (resolved && !seen.has(resolved)) stack.push(resolved);
        }
    }
    return seen;
}

describe('Trust Center — model + publish defaults', () => {
    const schema = readPrismaSchema();
    it('defines TrustCenter with enabled defaulting to false (off by default)', () => {
        // Bound to the model. `slug String @unique` is declared by 3 models
        // (Tenant, Organization, TrustCenter), so the off-by-default claim
        // this test exists to make was checkable only for `enabled`.
        // `braceBlockAfter` throws when the model is gone, replacing the
        // `/model TrustCenter \{/` existence check.
        const trustCenter = braceBlockAfter(schema, 'model TrustCenter\\s*\\{');
        expect(trustCenter).toMatch(/enabled\s+Boolean\s+@default\(false\)/);
        expect(trustCenter).toMatch(/slug\s+String\s+@unique/);
    });
});

describe('Trust Center — public route IMPORT ISOLATION (the leak lock)', () => {
    const graph = transitiveGraph(PUBLIC_ROUTE);

    it('the public route exists and reads only the curated module', () => {
        expect(exists(PUBLIC_ROUTE)).toBe(true);
        expect(read(PUBLIC_ROUTE)).toMatch(/getPublicTrustCenter/);
    });

    it('NO tenant-data usecase/repository is reachable from the public route', () => {
        const FORBIDDEN = [...graph].filter((f) => {
            // The curated trust-center read is allowed; everything else under
            // the tenant-data layer is a leak risk.
            if (f === PUBLIC_READ) return false;
            if (/^src\/app-layer\/repositories\//.test(f)) return true;
            if (/^src\/app-layer\/usecases\//.test(f) && !/trust-center/.test(f)) return true;
            return false;
        });
        expect(FORBIDDEN).toEqual([]);
    });

    // H4 — the public API routes are the real anonymous entry points; lock their
    // import graphs the same way (no repository / non-trust-center usecase).
    it.each(PUBLIC_API_ROUTES)('public API route %s reaches no tenant-data usecase/repository', (route) => {
        expect(exists(route)).toBe(true);
        const apiGraph = transitiveGraph(route);
        const FORBIDDEN = [...apiGraph].filter((f) => {
            if (f === PUBLIC_READ || f === CURATED_GATED) return false; // curated trust-center modules
            if (/^src\/lib\/trust-center\//.test(f)) return false;
            if (/^src\/app-layer\/repositories\//.test(f)) return true;
            if (/^src\/app-layer\/usecases\//.test(f) && !/trust-center/.test(f)) return true;
            return false;
        });
        expect(FORBIDDEN).toEqual([]);
    });

    it('does not reference live tenant-data domains anywhere in its graph', () => {
        const hay = [...graph].map(read).join('\n');
        // No import of Risk/Control/Evidence/Finding repositories or usecases.
        expect(hay).not.toMatch(/from ['"]@\/app-layer\/repositories\/(Risk|Control|Evidence|Finding)/);
        expect(hay).not.toMatch(/from ['"]@\/app-layer\/usecases\/(risk|control|evidence|finding)['"]/);
    });
});

describe('Trust Center — public read is an explicit allowlist', () => {
    const src = read(PUBLIC_READ);
    it('selects only publishable fields, never tenantId/internal ids', () => {
        expect(src).toMatch(/findFirst\(/);
        expect(src).toMatch(/enabled:\s*true/);
        const selectBlock = src.slice(src.indexOf('select:'), src.indexOf('});', src.indexOf('select:')));
        expect(selectBlock).not.toMatch(/tenantId/);
        expect(selectBlock).not.toMatch(/publishedByUserId/);
    });
    it('imports nothing from the tenant-data layer', () => {
        // Match actual `from '@/app-layer/...'` import statements, not the
        // explanatory security-contract comment that names those paths.
        expect(src).not.toMatch(/from\s*['"]@\/app-layer\/(usecases|repositories)/);
    });
});

describe('Trust Center — middleware: public allowlist + edge rate-limit', () => {
    it('/trust/ is in the public-path allowlist with a comment', () => {
        const guard = read('src/lib/auth/guard.ts');
        expect(guard).toMatch(/'\/trust\/'/);
        // a "Trust Center" explanatory comment accompanies the allowlist entry
        expect(guard).toMatch(/Trust Center/);
    });
    it('the /trust/ path is edge-rate-limited before the public allow', () => {
        const mw = read('src/middleware.ts');
        expect(mw).toMatch(/pathname\.startsWith\('\/trust\/'\)/);
        expect(mw).toMatch(/checkApiReadRateLimit\(req[\s\S]{0,40}?trust:/);
    });
});

describe('Trust Center — publish is OWNER-gated + audited', () => {
    const routePerms = read('src/lib/security/route-permissions.ts');
    const usecase = read('src/app-layer/usecases/trust-center.ts');

    it('the enable route requires admin.tenant_lifecycle (OWNER) and precedes the compose rule', () => {
        const enableIdx = routePerms.indexOf('trust-center\\\\/enable');
        const composeIdx = routePerms.indexOf('admin\\\\/trust-center(');
        expect(enableIdx).toBeGreaterThan(-1);
        expect(composeIdx).toBeGreaterThan(-1);
        expect(enableIdx).toBeLessThan(composeIdx); // first-match-wins ordering
        // the enable rule's permission is tenant_lifecycle
        const enableRule = routePerms.slice(enableIdx, enableIdx + 400);
        expect(enableRule).toMatch(/admin\.tenant_lifecycle/);
    });

    it('the enable API route uses requirePermission(admin.tenant_lifecycle)', () => {
        const route = read('src/app/api/t/[tenantSlug]/admin/trust-center/enable/route.ts');
        expect(route).toMatch(/requirePermission\('admin\.tenant_lifecycle'/);
    });

    it('publish/unpublish audits + re-asserts OWNER in the usecase', () => {
        expect(usecase).toMatch(/TRUST_CENTER_PUBLISHED/);
        expect(usecase).toMatch(/TRUST_CENTER_UNPUBLISHED/);
        expect(usecase).toMatch(/admin\?\.tenant_lifecycle/);
    });
});

describe('Trust Center — sanitisation + 404 semantics', () => {
    const usecase = read('src/app-layer/usecases/trust-center.ts');
    it('all free text is sanitised on write', () => {
        expect(usecase).toMatch(/sanitizePlainText/);
        // displayName, tagline, postureSummary, securityContact all routed through it
        for (const field of ['displayName', 'tagline', 'postureSummary', 'securityContact']) {
            expect(usecase).toMatch(new RegExp(`${field}:[^,]*sanitizePlainText`));
        }
    });
    it('document URLs are scheme-restricted to http(s)', () => {
        expect(usecase).toMatch(/protocol === 'http:'/);
        expect(usecase).toMatch(/protocol === 'https:'/);
    });
    it('a disabled/missing slug returns 404 (notFound), never 403', () => {
        const page = read(PUBLIC_ROUTE);
        expect(page).toMatch(/notFound\(\)/);
        // The page must not import or throw a forbidden/403 error helper —
        // a missing/disabled slug is a 404, never a tenant-existence 403.
        expect(page).not.toMatch(/from\s*['"]@\/lib\/errors/);
        expect(page).not.toMatch(/\bforbidden\(/);
    });
});
