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
            '10 the URL is built in a way the scan cannot follow endpoint',
        ]);
        // The list key built in a useMemo is one call site, however many returns it has.
        expect(a.resolved.find((r) => r.method === 'GET' && r.route.url === '/api/t/[tenantSlug]/risks')!.sites.map((s) => s.line)).toEqual([5, 13]);
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
