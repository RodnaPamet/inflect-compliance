/**
 * The docs site's generated reference (scripts/docs-reference/). Each case
 * pins what a reader of the reference relies on: the role table says what the
 * permission code says, a call is matched to the route Next.js would serve,
 * an unreadable call is reported rather than dropped, and a refusal carries
 * the status and message its own throw gives it.
 *
 * Fixtures are in-memory files, so none of this depends on the repository's
 * current pages. The role table is the exception: it is checked against the
 * real `getPermissionsForRole`, because agreeing with the code is its whole job.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPermissionsForRole, PERMISSION_SCHEMA } from '@/lib/permissions';
import { repoRelativeFiles } from '../helpers/repo-files';
import { matchRoutes, parseApiRoute, type ApiRoute } from '../../scripts/docs-reference/api-routes';
import { areaOf, isRedirectOnly, sidebarSections } from '../../scripts/docs-reference/inventory';
import { cell, linkLabel, repoHref } from '../../scripts/docs-reference/markdown';
import { apiCalls, inReach, pageActions, pageReach, toSegments, UrlResolver, type Source } from '../../scripts/docs-reference/page-actions';
import { domainCodes, errorClasses, refusals } from '../../scripts/docs-reference/refusals';
import { enumValues, roleMatrix } from '../../scripts/docs-reference/roles';
import { parse } from '../../scripts/docs-reference/source';

function memory(files: Record<string, string>): Source {
    const cache = new Map<string, ReturnType<typeof parse>>();
    return {
        exists: (f) => f in files,
        parsed: (f) => {
            if (!cache.has(f)) cache.set(f, parse(f, files[f]));
            return cache.get(f)!;
        },
    };
}

const route = (file: string, text: string) => parseApiRoute(file, text);

describe('roles and permissions — agrees with the permission code', () => {
    const roles = enumValues(fs.readFileSync(path.resolve(__dirname, '../../prisma/schema/enums.prisma'), 'utf8'), 'Role');
    const matrix = roleMatrix(roles, PERMISSION_SCHEMA, (r) => getPermissionsForRole(r as never) as never);
    const held = (role: string, key: string) => {
        const [area, action] = key.split('.');
        const row = matrix.rows.find((r) => r.area === area && r.action === action);
        return row?.held[matrix.roles.indexOf(role)];
    };

    it('lists every role of the enum and every key of PERMISSION_SCHEMA, once each', () => {
        expect(matrix.roles).toEqual(['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN']);
        const keys = matrix.rows.map((r) => `${r.area}.${r.action}`);
        const expected = Object.entries(PERMISSION_SCHEMA).flatMap(([a, actions]) => actions.map((x) => `${a}.${x}`));
        expect(keys).toEqual(expected);
    });

    it('marks a cell exactly when getPermissionsForRole grants it', () => {
        const wrong = matrix.rows.flatMap((r) =>
            matrix.roles.flatMap((role, i) => {
                const set = getPermissionsForRole(role as never) as unknown as Record<string, Record<string, boolean>>;
                return r.held[i] === (set[r.area][r.action] === true) ? [] : [`${role} ${r.area}.${r.action}`];
            }),
        );
        expect(wrong).toEqual([]);
    });

    it('shows the distinctions the role model is built on', () => {
        expect(held('OWNER', 'admin.tenant_lifecycle')).toBe(true);
        expect(held('ADMIN', 'admin.tenant_lifecycle')).toBe(false);
        expect(held('ADMIN', 'admin.owner_management')).toBe(false);
        expect(held('AI_ADMIN', 'admin.agent_registry')).toBe(true);
        expect(held('AI_ADMIN', 'admin.manage')).toBe(false);
        expect(held('READER', 'risks.edit')).toBe(false);
    });

    it('reads enum values in order, ignoring doc comments', () => {
        expect(enumValues('enum Role {\n  /// the top\n  OWNER\n  ADMIN // inline\n}\nenum Other {\n  X\n}', 'Role')).toEqual(['OWNER', 'ADMIN']);
    });
});

describe('the API route table', () => {
    it('reads each exported method and the key its requirePermission names', () => {
        const r = route(
            'src/app/api/t/[tenantSlug]/risks/route.ts',
            [
                "export const GET = withApiErrorHandling(requirePermission('risks.view', async () => ok()));",
                "const create = requirePermission(['risks.create', 'risks.edit'], async () => ok());",
                'export const POST = withApiErrorHandling(create);',
                'export async function DELETE() { return removeAll(); }',
                'const patch = withApiErrorHandling(async () => ok());',
                'export { patch as PATCH };',
            ].join('\n'),
        );
        expect(r.url).toBe('/api/t/[tenantSlug]/risks');
        expect(r.methods).toEqual({ GET: ['risks.view'], POST: ['risks.create', 'risks.edit'], DELETE: [], PATCH: [] });
    });

    it('reads the keys of the { keys, mode } form too (#5135)', () => {
        // Read as no keys, these routes were published as "checked in the use case".
        const r = route(
            'src/app/api/t/[tenantSlug]/admin/mcp/quarantine/route.ts',
            [
                'export const GET = withApiErrorHandling(',
                "    requirePermission({ keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' }, async () => ok()),",
                ');',
            ].join('\n'),
        );
        expect(r.methods).toEqual({ GET: ['admin.agent_registry_view', 'admin.agent_registry'] });
    });

    it('the real routes using the { keys, mode } form all publish their keys (#5135)', () => {
        const files = repoRelativeFiles()
            .filter((f) => f.startsWith('src/app/api/') && f.endsWith('/route.ts'))
            .filter((f) => /requirePermission\(\s*\{\s*keys:/.test(fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8')));
        expect(files.length).toBeGreaterThan(0);
        const unpublished = files.filter((f) => {
            const parsed = route(f, fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8'));
            return Object.values(parsed.methods).some((keys) => keys !== undefined && keys.length === 0)
                && !Object.values(parsed.methods).some((keys) => (keys ?? []).length > 0);
        });
        expect(unpublished).toEqual([]);
    });

    it('drops route groups from the URL', () => {
        expect(route('src/app/api/(internal)/health/route.ts', 'export const GET = h;').url).toBe('/api/health');
    });

    const table: ApiRoute[] = [
        route('src/app/api/t/[tenantSlug]/risks/[id]/route.ts', 'export const GET = a; export const PATCH = b;'),
        route('src/app/api/t/[tenantSlug]/risks/bulk/route.ts', 'export const POST = a;'),
        route('src/app/api/t/[tenantSlug]/proposals/[id]/accept/route.ts', 'export const POST = a;'),
        route('src/app/api/t/[tenantSlug]/proposals/[id]/reject/route.ts', 'export const POST = a;'),
        route('src/app/api/t/[tenantSlug]/files/[...path]/route.ts', 'export const GET = a;'),
    ];
    const urls = (segs: (string | null)[]) => matchRoutes(segs, table).map((r) => r.url);

    it('prefers a literal segment over a dynamic one, as Next.js does', () => {
        expect(urls(['api', 't', null, 'risks', 'bulk'])).toEqual(['/api/t/[tenantSlug]/risks/bulk']);
        expect(urls(['api', 't', null, 'risks', null])).toEqual(['/api/t/[tenantSlug]/risks/[id]']);
    });

    it('reads a run-time last segment as every action route under it, only when nothing else matches', () => {
        expect(urls(['api', 't', null, 'proposals', null, null])).toEqual([
            '/api/t/[tenantSlug]/proposals/[id]/accept',
            '/api/t/[tenantSlug]/proposals/[id]/reject',
        ]);
    });

    it('matches a catch-all, and nothing for a path no route serves', () => {
        expect(urls(['api', 't', null, 'files', 'a', 'b'])).toEqual(['/api/t/[tenantSlug]/files/[...path]']);
        expect(urls(['api', 't', null, 'nowhere'])).toEqual([]);
    });
});

describe('page actions — the calls a page makes', () => {
    const files: Record<string, string> = {
        'src/lib/swr-keys.ts': [
            'function makeResource(base: string) { return { list: () => `/${base}`, detail: (id: string) => `/${base}/${id}` }; }',
            'export const CACHE_KEYS = {',
            "    risks: { ...makeResource('risks'), staleness: () => '/risks/staleness' as const },",
            "    calendar: { range: (from: string) => { let key = `/calendar?from=${from}`; return key; } },",
            '} as const;',
        ].join('\n'),
        'src/app/t/[tenantSlug]/(app)/risks/endpoints.ts': "export const BULK = '/risks/bulk';",
        'src/app/t/[tenantSlug]/(app)/risks/page.tsx': "import { RisksClient } from './RisksClient';\nimport type { X } from './types';\nexport default function P() { return <RisksClient />; }",
        'src/app/t/[tenantSlug]/(app)/risks/types.ts': 'export type X = 1;',
        'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx': [
            "import { Button } from '@/components/ui/button';",
            "import { Panel } from '@/components/risks/Panel';",
            "import { BULK } from './endpoints';",
            'export function RisksClient({ endpoint, open, query }: Props) {',
            // BOUND, as real code binds it. This fixture used `apiUrl(…)` with
            // no binding anywhere and resolved through the legacy NAME test,
            // which #5707 deleted — so it was exercising the heuristic rather
            // than the resolver. Every one of the 147 real call sites writes
            // this line.
            '    const apiUrl = useTenantApiUrl();',
            '    useTenantSWR(CACHE_KEYS.risks.list());',
            "    useTenantSWR(open ? CACHE_KEYS.risks.detail('x') : null);",
            "    fetch(apiUrl(BULK), { method: 'POST' });",
            '    fetch(apiUrl(`/risks/${id}`), { method: editing ? \'PATCH\' : \'POST\' });',
            '    fetch(apiUrl(`/risks/${id}${query}`));',
            '    fetch(endpoint);',
            "    fetch('https://example.com/x');",
            '    const listKey = useMemo(() => { if (qs) return `${CACHE_KEYS.risks.list()}?${qs}`; return CACHE_KEYS.risks.list(); }, [qs]);',
            '    useTenantSWR(listKey);',
            "    useSWR(open ? '/api/risk-templates' : null, async (url: string) => (await fetch(url)).json());",
            '    return null;',
            '}',
        ].join('\n'),
        'src/components/ui/button.tsx': "export function Button() { fetch('/api/never'); return null; }",
        'src/components/risks/Panel.tsx': "export function Panel() { useTenantSWR(CACHE_KEYS.risks.staleness()); return null; }",
    };
    const src = memory(files);
    const table: ApiRoute[] = [
        route('src/app/api/t/[tenantSlug]/risks/route.ts', "export const GET = withApiErrorHandling(requirePermission('risks.view', h));"),
        route('src/app/api/t/[tenantSlug]/risks/[id]/route.ts', "export const GET = a; export const PATCH = withApiErrorHandling(requirePermission('risks.edit', h));"),
        route('src/app/api/t/[tenantSlug]/risks/bulk/route.ts', "export const POST = withApiErrorHandling(requirePermission('admin.manage', h));"),
        route('src/app/api/t/[tenantSlug]/risks/staleness/route.ts', 'export const GET = a;'),
        route('src/app/api/risk-templates/route.ts', 'export const GET = a;'),
    ];

    it('follows the page into its product files, and not into the shared primitives or a type-only import', () => {
        expect(pageReach('src/app/t/[tenantSlug]/(app)/risks/page.tsx', src).sort()).toEqual([
            'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
            'src/app/t/[tenantSlug]/(app)/risks/endpoints.ts',
            'src/app/t/[tenantSlug]/(app)/risks/page.tsx',
            'src/components/risks/Panel.tsx',
        ]);
        expect(inReach('src/components/ui/button.tsx')).toBe(false);
        expect(inReach('src/app/api/t/x/route.ts')).toBe(false);
    });

    it('matches each readable call to its route and key, and lists the one it cannot read', () => {
        const a = pageActions('src/app/t/[tenantSlug]/(app)/risks/page.tsx', src, table);
        expect(a.resolved.map((r) => `${r.method} ${r.route.url} ${r.permission.join(',') || '(use case)'}`)).toEqual([
            'GET /api/risk-templates (use case)',
            'GET /api/t/[tenantSlug]/risks risks.view',
            'GET /api/t/[tenantSlug]/risks/[id] (use case)',
            'PATCH /api/t/[tenantSlug]/risks/[id] risks.edit',
            'POST /api/t/[tenantSlug]/risks/bulk admin.manage',
            'GET /api/t/[tenantSlug]/risks/staleness (use case)',
        ]);
        expect(a.unresolved.map((u) => `${u.line} ${u.why} ${u.expression}`)).toEqual([
            '11 the URL is built in a way the scan cannot follow endpoint',
        ]);
        // The list key built in a useMemo is one call site, however many returns it has.
        expect(a.resolved.find((r) => r.method === 'GET' && r.route.url === '/api/t/[tenantSlug]/risks')!.sites.map((s) => s.line)).toEqual([6, 14]);
    });

    it('reads a template ending in a query-named value as the query string, and one after a slash as a segment', () => {
        const r = new UrlResolver(memory({ 'f.ts': 'fetch(`/api/x${query}`); fetch(`/api/x/${params.id}`);' }));
        const calls = apiCalls('f.ts', memory({ 'f.ts': 'fetch(`/api/x${query}`); fetch(`/api/x/${params.id}`);' }).parsed('f.ts'), r);
        expect(calls.map((c) => c.segments)).toEqual([['api', 'x'], ['api', 'x', null]]);
    });

    it('treats two run-time values in one segment as unreadable, not as a path', () => {
        expect(toSegments('/api/t/\u0000\u0000')).toBeNull();
        expect(toSegments('/api/t/\u0000/risks?x=1')).toEqual(['api', 't', null, 'risks']);
    });
});

/**
 * #5661. The resolver reads a name at ONE use site, so it may only answer from
 * declarations that site can see: a parameter, then an enclosing scope, then
 * the file's imports. It used to answer from a flat whole-file map of every
 * `const` by name — any scope, and on a miss a declaration AFTER the use — so
 * it reported routes a page does not call and left the real one uncounted.
 */
describe('page actions — a name resolves from the scopes its use site can see', () => {
    const file = 'src/app/t/[tenantSlug]/(app)/x/C.tsx';
    const segmentsOf = (text: string, files: Record<string, string> = {}) => {
        const src = memory({ ...files, [file]: text });
        return apiCalls(file, src.parsed(file), new UrlResolver(src)).map((c) => c.segments);
    };

    // The shape it was found in: a `postJson(url, …)` helper fetches its own
    // parameter, and the file's only `const url` is 800 lines below, inside an
    // unrelated callback. One name, two use sites, two different answers.
    const helperAndCallSite = [
        'async function postJson(url: string, body: unknown) {',
        "    return fetch(url, { method: 'POST', body: JSON.stringify(body) });",
        '}',
        'export default function P() {',
        "    const url = '/api/t/x/agent-samples/1';",
        '    return postJson(url, {});',
        '}',
    ].join('\n');

    it('reads a parameter as unresolvable, and the same name at a call site as that scope own const', () => {
        expect(segmentsOf(helperAndCallSite)).toEqual([null, ['api', 't', 'x', 'agent-samples', '1']]);
    });

    it('lists the parameter call rather than attributing it to the const route', () => {
        const page = 'src/app/t/[tenantSlug]/(app)/x/page.tsx';
        const a = pageActions(page, memory({ [page]: helperAndCallSite }), [
            route('src/app/api/t/[tenantSlug]/agent-samples/[sampleId]/route.ts', "export const POST = withApiErrorHandling(requirePermission('access_reviews.decide', h));"),
        ]);
        expect(a.resolved.map((x) => `${x.method} ${x.route.url} ${x.permission.join(',')} @${x.sites.map((y) => y.line).join(',')}`)).toEqual([
            'POST /api/t/[tenantSlug]/agent-samples/[sampleId] access_reviews.decide @6',
        ]);
        expect(a.unresolved.map((u) => `${u.line} ${u.expression} — ${u.why}`)).toEqual(['2 url — the URL is built in a way the scan cannot follow']);
    });

    // Without the parameter check this one still resolves: a top-level const is
    // in every use site chain, so the scope walk alone does not refuse a
    // parameter that SHADOWS one.
    it('reads a parameter that shadows a top-level const as unresolvable, not as that const', () => {
        expect(
            segmentsOf(
                [
                    "const url = '/api/t/x/fallback';",
                    'export function Direct() {',
                    '    return fetch(url);',
                    '}',
                    'export function Shadow(url: string) {',
                    '    return fetch(url);',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 't', 'x', 'fallback'], null]);
    });

    it('resolves a const an enclosing scope declares before the use', () => {
        expect(
            segmentsOf(
                [
                    'export function Enclosing() {',
                    "    const base = '/api/widgets';",
                    '    const load = () => fetch(base);',
                    '    return load;',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 'widgets']]);
    });

    it('does not reach into a sibling scope, nor forward to a declaration below the use', () => {
        // `G` has no `url` of its own — its prop is destructured, so it is not
        // even a named parameter — and the only one in the file belongs to
        // `other`, below. Answering from it attributes one component call to
        // another route.
        expect(
            segmentsOf(
                [
                    'export function G({ url }: { url: string }) {',
                    '    return fetch(url);',
                    '}',
                    "function other() { const url = '/api/other'; return fetch(url); }",
                ].join('\n'),
            ),
        ).toEqual([null, ['api', 'other']]);
    });

    it('does not resolve a const an enclosing scope declares BELOW the use site', () => {
        // Deliberate, and inherited from refusals.ts so there stays ONE
        // definition: a closure called after line 3 would see it, but the scan
        // reads source order, and an unresolved call is listed with its reason
        // while a guess is not retractable. Pinned because the scope walk alone
        // does not refuse this, so nothing else would notice the guard going.
        expect(
            segmentsOf(
                [
                    'export function P() {',
                    '    const load = () => fetch(url);',
                    "    const url = '/api/later';",
                    '    return load;',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([null]);
    });

    // A prop is the one name a use site cannot resolve on its own: its value is
    // written at the render site. This codebase hands `apiBase` to sibling
    // components in the same file, so the render site is where to read it.
    it('resolves a destructured prop from the render sites in the same file, including a renamed one', () => {
        expect(
            segmentsOf(
                [
                    'export function Panel() {',
                    "    const apiBase = '/api/exceptions';",
                    '    return <Child apiBase={apiBase} />;',
                    '}',
                    'function Child({ apiBase: base }: { apiBase: string }) {',
                    "    return <button onClick={() => fetch(base, { method: 'POST' })} />;",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 'exceptions']]);
    });

    it('unions the values when two render sites pass different ones', () => {
        expect(
            segmentsOf(
                [
                    'export function Panel() {',
                    "    return <><Child to={'/api/one'} /><Child to={'/api/two'} /></>;",
                    '}',
                    'function Child({ to }: { to: string }) {',
                    '    return <button onClick={() => fetch(to)} />;',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 'one'], ['api', 'two']]);
    });

    it('reports the call when a render site spreads its props, rather than answering from the others', () => {
        // One unknown member makes the union unknown. Answering from the rest
        // would report a route the page may not call and omit one it does.
        expect(
            segmentsOf(
                [
                    'export function Panel(props: Props) {',
                    "    return <><Child to={'/api/one'} /><Child {...props} /></>;",
                    '}',
                    'function Child({ to }: { to: string }) {',
                    '    return <button onClick={() => fetch(to)} />;',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([null]);
    });

    it('reports the call when the component is never rendered in this file', () => {
        expect(
            segmentsOf(
                [
                    'export function Child({ to }: { to: string }) {',
                    '    return <button onClick={() => fetch(to)} />;',
                    '}',
                ].join('\n'),
            ),
        ).toEqual([null]);
    });

    it('still resolves a top-level const and one the file imports by name', () => {
        expect(
            segmentsOf(
                [
                    "import { BULK } from './endpoints';",
                    "const LIST = '/api/list';",
                    'export function C() {',
                    '    fetch(LIST);',
                    '    fetch(BULK);',
                    '    return null;',
                    '}',
                ].join('\n'),
                { 'src/app/t/[tenantSlug]/(app)/x/endpoints.ts': "export const BULK = '/api/bulk';" },
            ),
        ).toEqual([
            ['api', 'list'],
            ['api', 'bulk'],
        ]);
    });
});

/**
 * #5662. A URL builder is recognised by what the callee is BOUND to, never by
 * its name. The retired name test (`apiUrl` / `buildApiUrl` / `tenantApiUrl`
 * -> always the tenant prefix) was right 144 times and wrong three: an
 * org-scoped builder published two live routes as "no API route matches", and
 * a slug-first helper had its FIRST argument read as the path.
 */
describe('page actions — a URL builder is read from its binding', () => {
    const file = 'src/app/t/[tenantSlug]/(app)/x/C.tsx';
    const run = (text: string) => {
        const src = memory({ [file]: text });
        const r = new UrlResolver(src);
        return { segments: apiCalls(file, src.parsed(file), r).map((c) => c.segments), resolver: r };
    };
    const segmentsOf = (text: string) => run(text).segments;

    it('gives an org-scoped builder the org prefix, not the tenant one', () => {
        expect(
            segmentsOf(
                [
                    'export function S() {',
                    '    const apiUrl = useOrgApiUrl();',
                    "    return fetch(apiUrl('/agent-switches'), { method: 'PUT' });",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 'org', null, 'agent-switches']]);
    });

    it('keeps the tenant prefix for a tenant-scoped builder', () => {
        expect(
            segmentsOf(
                [
                    'export function S() {',
                    '    const apiUrl = useTenantApiUrl();',
                    "    return fetch(apiUrl('/risks'));",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 't', null, 'risks']]);
    });

    // 17 of this repo's local builders are declared inside useCallback against
    // 10 bare arrows, so treating the wrapper as "not a builder" cost 42 route
    // rows — measured, which is why the unwrap exists.
    // Named OUTSIDE the legacy set on purpose. With `apiUrl` the name fallback
    // returns the same answer, so the case cannot tell the unwrap from the
    // fallback and stays green when the unwrap is removed — it proved nothing
    // until the name changed. It now also pins the claim that keying on the
    // hook is wider than the three names it replaced.
    it('unwraps a builder declared inside useCallback, whatever the local name', () => {
        expect(
            segmentsOf(
                [
                    'export function S({ tenantSlug }: Props) {',
                    '    const buildUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);',
                    "    return fetch(buildUrl('/assets/bulk/delete'), { method: 'POST' });",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 't', null, 'assets', 'bulk', 'delete']]);
    });

    // Reading the body beats any fixed prefix: this shape is live in
    // incidents/[incidentId]/page.tsx, and the name test emitted
    // `/api/t/<slug>` for it, silently dropping two segments.
    it('reads a local builder whose body carries more than the prefix', () => {
        expect(
            segmentsOf(
                [
                    'export function S({ tenantSlug, incidentId }: Props) {',
                    '    const apiUrl = (path: string) => `/api/t/${tenantSlug}/incidents/${incidentId}${path}`;',
                    "    return fetch(apiUrl('/timeline'));",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 't', null, 'incidents', null, 'timeline']]);
    });

    // The #5662 defect itself: argument 0 is the SLUG here. Binding each
    // parameter to the argument in its own position makes the arity irrelevant
    // and the answer exact, where reading argument 0 as the path built a URL
    // out of the workspace slug.
    it('binds a slug-first helper by position rather than reading argument 0 as the path', () => {
        expect(
            segmentsOf(
                [
                    'function apiUrl(tenantSlug: string, path: string) {',
                    '    return `/api/t/${tenantSlug}/onboarding/${path}`;',
                    '}',
                    'export function W({ tenantSlug }: Props) {',
                    "    return fetch(apiUrl(tenantSlug, 'step'), { method: 'POST' });",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([['api', 't', null, 'onboarding', 'step']]);
    });

    it('reports a call whose builder cannot be read and whose name is not a legacy one', () => {
        expect(
            segmentsOf(
                [
                    'export function U({ fetchUrl }: { fetchUrl: (p: string) => string }) {',
                    "    return fetch(fetchUrl('/widgets'));",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([null]);
    });

    // The legacy NAME test is GONE (#5707). It survived #5662 as a last
    // resort because deleting it then cost 14 route rows — builders reached a
    // call site through shapes the resolver could not yet read. #5688 taught it
    // the page's reach and #5707 the import binding, which took the count 19 ->
    // 3 -> 0, and at zero a name test is exactly what this resolver exists not
    // to have. A builder it cannot read is now REPORTED.
    it('reports a call whose builder cannot be read, even under a legacy builder name', () => {
        // `apiUrl` was one of the three privileged names. With no render site
        // for `L` anywhere, nothing says what it is bound to.
        expect(
            segmentsOf(
                [
                    'export function L({ apiUrl }: { apiUrl: (p: string) => string }) {',
                    "    return fetch(apiUrl('/widgets'));",
                    '}',
                ].join('\n'),
            ),
        ).toEqual([null]);
    });
});

/**
 * #5688. A builder handed down as a prop is resolved from the render sites in
 * the PAGE'S REACH, not the declaring file alone — #5661 read only the latter,
 * which left 19 calls answering from the callee's NAME.
 */
describe('page actions — a prop is resolved across the files of one page', () => {
    const page = 'src/app/t/[tenantSlug]/(app)/x/page.tsx';
    const child = 'src/app/t/[tenantSlug]/(app)/x/Child.tsx';
    const route = (f: string, t: string) => parseApiRoute(f, t);
    const table: ApiRoute[] = [route('src/app/api/t/[tenantSlug]/widgets/route.ts', 'export const GET = a;')];

    const act = (files: Record<string, string>) => pageActions(page, memory(files), table);

    // EVERY fixture here names the builder `buildUrl`, outside
    // LEGACY_BUILDER_NAMES, and that is load-bearing. Named `apiUrl`, the name
    // fallback resolves these to the same route and the cases pass with the
    // cross-file mechanism removed — they prove nothing. Mutation-proving
    // caught exactly that, twice (the first time in #5696's useCallback case).
    it('resolves a builder the parent passes from another file in the reach', () => {
        const a = act({
            [page]: "import { Child } from './Child';\nexport default function P() {\n    const buildUrl = useTenantApiUrl();\n    return <Child buildUrl={buildUrl} />;\n}",
            [child]: "export function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <button onClick={() => fetch(buildUrl('/widgets'))} />;\n}",
        });
        expect(a.resolved.map((r) => `${r.method} ${r.route.url}`)).toEqual(['GET /api/t/[tenantSlug]/widgets']);
        expect(a.unresolved).toEqual([]);
    });

    it('follows a builder FUNCTION the parent wrote, not just a context hook', () => {
        // Nine of the twelve fallbacks left after the cross-file read were this
        // shape: the parent writes `const buildUrl = useCallback((path) => …)`,
        // so the prefix is not a constant — it is the function's body.
        const a = act({
            [page]: "import { Child } from './Child';\nexport default function P({ tenantSlug }: Props) {\n    const buildUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);\n    return <Child buildUrl={buildUrl} />;\n}",
            [child]: "export function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <button onClick={() => fetch(buildUrl('/widgets'))} />;\n}",
        });
        expect(a.resolved.map((r) => `${r.method} ${r.route.url}`)).toEqual(['GET /api/t/[tenantSlug]/widgets']);
        expect(a.unresolved).toEqual([]);
    });

    it('a same-named component elsewhere is NOT a render site unless it imports the declaring one', () => {
        // The guard that makes a cross-file search sound. Two files can each
        // declare a `Child`; matching by name alone would read one component's
        // render site as another's — a wrong answer dressed as a resolution,
        // which is the class this whole thread is about.
        const other = 'src/app/t/[tenantSlug]/(app)/x/Other.tsx';
        const a = act({
            // The page IMPORTS the declaring Child (so it is in the reach) but
            // renders only Other. That matters: if the page rendered `<Child />`
            // with no attribute, fail-closed would return null on its own and
            // the import guard would never be the thing under test.
            [page]: "import { Child } from './Child';\nimport { Other } from './Other';\nexport default function P() {\n    return <Other />;\n}",
            // A BARE identifier callee. Written `buildUrl!(…)` the callee is a
            // NonNullExpression, the builder machinery never runs, and the call
            // is unresolvable whatever the guard does — vacuous.
            [child]: "export function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <button onClick={() => fetch(buildUrl('/widgets'))} />;\n}",
            [other]: "function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <i onClick={() => fetch(buildUrl('/widgets'))} />;\n}\nexport function Other() {\n    const buildUrl = useTenantApiUrl();\n    return <Child buildUrl={buildUrl} />;\n}",
        });
        // Other's `Child` is a DIFFERENT component that happens to share the
        // name, and it supplies the attribute. Without the import guard its
        // render site would answer for the declaring Child too, which is a
        // wrong answer dressed as a resolution.
        expect(a.unresolved.map((u) => u.expression)).toContain("buildUrl('/widgets')");
    });

    it('one render site that omits the attribute makes the value unknown, across files too', () => {
        const a = act({
            [page]: "import { Child } from './Child';\nexport default function P() {\n    const buildUrl = useTenantApiUrl();\n    return <><Child buildUrl={buildUrl} /><Child /></>;\n}",
            [child]: "export function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <button onClick={() => fetch(buildUrl('/widgets'))} />;\n}",
        });
        // A union missing a member is not a union — reported, not answered
        // from the site that does supply it.
        expect(a.resolved).toEqual([]);
    });
});

/**
 * #5707. A component is found at a render site by the name THAT FILE binds it
 * to, resolved from the import — never by the name it declares itself. For a
 * DEFAULT export the two need not match at all, and `next/dynamic` binds one
 * without an `ImportDeclaration` to read.
 */
describe('page actions — a render site is matched by the importer\'s own alias', () => {
    const page = 'src/app/t/[tenantSlug]/(app)/y/page.tsx';
    const child = 'src/app/t/[tenantSlug]/(app)/y/Child.tsx';
    const decoy = 'src/app/t/[tenantSlug]/(app)/y/Decoy.tsx';
    const other = 'src/app/t/[tenantSlug]/(app)/y/Other.tsx';
    const route = (f: string, t: string) => parseApiRoute(f, t);
    const table: ApiRoute[] = [
        route('src/app/api/t/[tenantSlug]/widgets/route.ts', 'export const GET = a;'),
        route('src/app/api/t/[tenantSlug]/gadgets/route.ts', 'export const GET = a;'),
    ];
    const act = (files: Record<string, string>) => pageActions(page, memory(files), table);
    const CHILD = "export default function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <button onClick={() => fetch(buildUrl('/widgets'))} />;\n}";

    it('follows a default export loaded through next/dynamic under a different local name', () => {
        // The shape that left PolicyTraceabilityPanel's three calls guessing.
        // CLAUDE.md requires `next/dynamic` for a component that must not be
        // server-rendered, so this is a recurring shape, not one file's quirk.
        const a = act({
            [page]: "const Panel = dynamic(() => import('./Child'), { ssr: false });\nexport default function P() {\n    const buildUrl = useTenantApiUrl();\n    return <Panel buildUrl={buildUrl} />;\n}",
            [child]: CHILD,
        });
        expect(a.resolved.map((r) => `${r.method} ${r.route.url}`)).toEqual(['GET /api/t/[tenantSlug]/widgets']);
    });

    it('follows a plain default import under a different local name', () => {
        const a = act({
            [page]: "import Panel from './Child';\nexport default function P() {\n    const buildUrl = useTenantApiUrl();\n    return <Panel buildUrl={buildUrl} />;\n}",
            [child]: CHILD,
        });
        expect(a.resolved.map((r) => `${r.method} ${r.route.url}`)).toEqual(['GET /api/t/[tenantSlug]/widgets']);
    });

    it('keys on the import SPECIFIER, so two default exports under one local name do not mix', () => {
        // The acceptance test for #5707, and the reason it is not done by
        // name: both files bind a DEFAULT export to the local name `Child`,
        // but to DIFFERENT files. Matching `<Child …>` by name would union the
        // decoy's render site into this one and report a route the declaring
        // component never calls — the exact failure #5662 removed.
        const a = act({
            [page]: "import Child from './Child';\nimport { Other } from './Other';\nexport default function P() {\n    const buildUrl = useTenantApiUrl();\n    return <><Child buildUrl={buildUrl} /><Other /></>;\n}",
            [child]: CHILD,
            [decoy]: "export default function Decoy({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <i onClick={() => fetch(buildUrl('/gadgets'))} />;\n}",
            // Binds the DECOY under the name `Child`.
            [other]: "import Child from './Decoy';\nexport function Other() {\n    const gadgetUrl = useTenantApiUrl();\n    return <Child buildUrl={gadgetUrl} />;\n}",
        });
        // `/widgets` from the real Child, `/gadgets` from the decoy — each from
        // its OWN render site. Neither call reports both.
        expect(a.resolved.map((r) => `${r.method} ${r.route.url}`).sort()).toEqual([
            'GET /api/t/[tenantSlug]/gadgets',
            'GET /api/t/[tenantSlug]/widgets',
        ]);
        expect(a.unresolved).toEqual([]);
    });

    it('does not look outside its own file for a component that is not exported', () => {
        // Nothing else can render it, so there is nothing to find — and a
        // same-named component elsewhere must not stand in for it.
        const a = act({
            [page]: "import { Other } from './Other';\nexport default function P() {\n    return <Other />;\n}",
            [other]: "function Child({ buildUrl }: { buildUrl: (p: string) => string }) {\n    return <i onClick={() => fetch(buildUrl('/gadgets'))} />;\n}\nexport function Other() {\n    return <div />;\n}",
        });
        expect(a.resolved).toEqual([]);
        expect(a.unresolved.map((u) => u.expression)).toContain("buildUrl('/gadgets')");
    });
});

describe('the page inventory', () => {
    const sidebar = parse(
        'SidebarNav.tsx',
        [
            'const sections = [',
            "    { items: [{ href: tenantHref('/dashboard'), label: t('dashboard') }] },",
            "    { title: t('govern'), items: [{ href: tenantHref('/risks'), label: t('risks') }] },",
            "    { title: t('comply'), items: [{ href: tenantHref('/agents/ask'), label: t('agentsAsk') }] },",
            "    { title: t('manage'), items: [{ href: tenantHref('/agents'), label: t('agents') }].filter(Boolean) },",
            '];',
        ].join('\n'),
    );
    const sections = sidebarSections(sidebar);

    it('reads each section and names an untitled one after its first item', () => {
        expect(sections).toEqual([
            { labelKey: 'dashboard', hrefs: ['/dashboard'] },
            { labelKey: 'govern', hrefs: ['/risks'] },
            { labelKey: 'comply', hrefs: ['/agents/ask'] },
            { labelKey: 'manage', hrefs: ['/agents'] },
        ]);
    });

    it('puts a page in the section of the longest matching item', () => {
        expect(areaOf('/t/[tenantSlug]/risks/[riskId]', sections)).toEqual({ kind: 'sidebar', labelKey: 'govern' });
        expect(areaOf('/t/[tenantSlug]/agents/ask', sections)).toEqual({ kind: 'sidebar', labelKey: 'comply' });
        expect(areaOf('/t/[tenantSlug]/agents/peers', sections)).toEqual({ kind: 'sidebar', labelKey: 'manage' });
        expect(areaOf('/t/[tenantSlug]/admin/sso', sections)).toEqual({ kind: 'admin' });
        expect(areaOf('/t/[tenantSlug]/frameworks', sections)).toEqual({ kind: 'other-tenant' });
        expect(areaOf('/org/[orgSlug]', sections)).toEqual({ kind: 'org' });
        expect(areaOf('/login', sections)).toEqual({ kind: 'outside' });
    });

    it('tells a redirect-only page from one that renders', () => {
        expect(isRedirectOnly(parse('a.tsx', "export default function P() { redirect('/x'); }"))).toBe(true);
        expect(isRedirectOnly(parse('b.tsx', "export default function P() { if (x) redirect('/x'); return <div />; }"))).toBe(false);
    });
});

describe('refusal codes', () => {
    const errors = [
        "export class AppError extends Error { constructor(m: string, public code: string, public status: number) { super(m); } }",
        "export class ConflictError extends AppError { constructor(m: string, d?: unknown) { super(m, 'CONFLICT', 409, true, d); } }",
        "export class ValidationError extends AppError { constructor(m: string, d?: unknown) { super(m, 'BAD_REQUEST', 400, true, d); } }",
        "export class ForbiddenError extends AppError { constructor(m: string, d?: unknown) { super(m, 'FORBIDDEN', 403, true, d); } }",
        'export const forbidden = (m: string, d?: unknown) => new ForbiddenError(m, d);',
        'export type DomainErrorCode =',
        "    | 'STALE_DATA'",
        '    /**',
        '     * A review over nobody.',
        '     */',
        "    | 'NO_SUBJECTS';",
    ].join('\n');
    const usecase = [
        "import { REASON } from './reasons';",
        "type Refusal = 'NAME_TAKEN' | 'NAME_INVALID';",
        'const STATUS = { NAME_TAKEN: 409, NAME_INVALID: 400 } as const;',
        'function refuse(reason: Refusal, message: string) {',
        '    const status = STATUS[reason];',
        '    if (status === 400) return new ValidationError(message, { reason });',
        '    return new ConflictError(message, { reason });',
        '}',
        "export function a() { throw refuse('NAME_TAKEN', 'That name is taken.'); }",
        "export function b() { throw refuse('NAME_INVALID', `Names are short: ${n}`); }",
        "export function c() { throw forbidden('Owners only.', { reason: REASON }); }",
    ].join('\n');
    const files: Record<string, string> = {
        'src/lib/errors/types.ts': errors,
        'src/app-layer/usecases/x.ts': usecase,
        'src/app-layer/usecases/reasons.ts': "export const REASON = 'OWNER_ONLY';",
    };
    const src = memory(files);
    const errorsSf = src.parsed('src/lib/errors/types.ts');

    it('reads each error class and the code and status it passes up', () => {
        expect([...errorClasses(errorsSf).entries()]).toEqual([
            ['ConflictError', { code: 'CONFLICT', status: 409 }],
            ['ValidationError', { code: 'BAD_REQUEST', status: 400 }],
            ['ForbiddenError', { code: 'FORBIDDEN', status: 403 }],
        ]);
    });

    it('reads the domain codes with the doc comment written above each', () => {
        expect(domainCodes(errorsSf)).toEqual([
            { code: 'STALE_DATA', description: '' },
            { code: 'NO_SUBJECTS', description: 'A review over nobody.' },
        ]);
    });

    it('gives each reason the one status its helper picks and the message its caller writes', () => {
        const r = refusals(Object.keys(files), errorsSf, src.exists, src.parsed);
        expect(r.map((x) => ({ reason: x.reason, answers: x.answers, messages: x.messages, lines: x.sites.map((s) => s.line) }))).toEqual([
            { reason: 'NAME_INVALID', answers: ['BAD_REQUEST 400'], messages: ['Names are short: …'], lines: [10] },
            { reason: 'NAME_TAKEN', answers: ['CONFLICT 409'], messages: ['That name is taken.'], lines: [9] },
            { reason: 'OWNER_ONLY', answers: ['FORBIDDEN 403'], messages: ['Owners only.'], lines: [11] },
        ]);
    });
});

describe('markdown', () => {
    it('keeps a pipe or a line break from ending a table cell', () => {
        expect(cell('a | b\nc')).toBe('a \\| b c');
    });

    it('escapes a link label so an input backslash cannot consume the bracket escape', () => {
        // The case `js/incomplete-sanitization` named (high, #4043): a literal
        // backslash immediately before a bracket. Escaping the bracket ALONE
        // emits `\[`, whose backslash the input's own backslash has already
        // claimed — so the bracket arrives unescaped and closes the label.
        // Backslash-first is what makes the second pass safe.
        expect(linkLabel(String.raw`a\[b`)).toBe(String.raw`a\\\[b`);
        // A label is also a cell, so the pipe and newline duties still hold.
        expect(linkLabel('a | b\nc]')).toBe('a \\| b c\\]');
    });

    it('encodes route-group parentheses in a source link', () => {
        expect(repoHref('src/app/t/[tenantSlug]/(app)/risks/page.tsx', 4)).toBe('/src/app/t/[tenantSlug]/%28app%29/risks/page.tsx#L4');
    });
});
