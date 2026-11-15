/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/unit/agent-ownership-transfer-edge-gate.test.ts (NextRequest
 * fixtures + mocked rate-limiters + getToken). */
/**
 * The edge admits an AI_ADMIN to the agent admin paths and to nothing else
 * under `/admin` (#3699).
 *
 * `AI_ADMIN_ADMIN_PATH_PREFIXES` is the whole allowlist. This file pins it by
 * exact set equality, proves each entry names something that exists, and then
 * asks the REAL middleware about every admin API route on disk — the
 * population is the filesystem (`repoFiles`), not a list in this file — so a
 * new admin root is refused for an AI_ADMIN by construction and an entry that
 * quietly covers a sibling turns this red.
 *
 * The edge only pre-filters; the handler's `requirePermission` is the authority
 * (`tests/unit/ai-admin-handler-authz.test.ts`).
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: jest.fn().mockReturnValue(null),
}));
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

import middleware from '../../src/middleware';
import { getToken } from 'next-auth/jwt';
import {
    AI_ADMIN_ADMIN_PATH_PREFIXES,
    checkAdminAccess,
    isAiAdminAdminPath,
} from '@/lib/auth/guard';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const mockGetToken = getToken as jest.Mock;

const API_ADMIN_DIR = 'src/app/api/t/[tenantSlug]/admin';
const PAGE_ADMIN_DIR = 'src/app/t/[tenantSlug]/(app)/admin';

/** A member of `acme` holding `role` there, and READER in `beta`. */
function tokenFor(role: string) {
    return {
        sub: 'user-1',
        userId: 'user-1',
        role,
        mfaPending: false,
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        memberships: [
            { slug: 'acme', role, tenantId: 'tenant-1' },
            { slug: 'beta', role: 'READER', tenantId: 'tenant-2' },
        ],
        orgMemberships: [],
    };
}

function req(method: string, pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
    });
}

async function refusedAtEdge(role: string, pathname: string, method = 'GET'): Promise<boolean> {
    mockGetToken.mockResolvedValue(tokenFor(role));
    const res = await middleware(req(method, pathname), {} as any);
    if (res.status !== 403) return false;
    const body = await res
        .clone()
        .json()
        .catch(() => ({}));
    return (body as { error?: string }).error === 'Admin access required';
}

/** `src/app/api/t/[tenantSlug]/admin/a/[id]/route.ts` → `/api/t/acme/admin/a/id-1`. */
function apiUrlOf(rel: string): string {
    return rel
        .replace(/^src\/app/, '')
        .replace(/\/route\.ts$/, '')
        .replace('[tenantSlug]', 'acme')
        .replace(/\[([^\]]+)\]/g, '$1-1');
}

/** `src/app/t/[tenantSlug]/(app)/admin/a/page.tsx` → `/t/acme/admin/a`. */
function pageUrlOf(rel: string): string {
    return rel
        .replace(/^src\/app/, '')
        .replace('/(app)', '')
        .replace(/\/page\.tsx$/, '')
        .replace('[tenantSlug]', 'acme')
        .replace(/\[([^\]]+)\]/g, '$1-1');
}

function templateOf(url: string): string {
    return url.replace(/^(\/api)?\/t\/acme/, (_m, api) => `${api ?? ''}/t/[slug]`);
}

function insideAllowlist(url: string): boolean {
    const t = templateOf(url);
    return AI_ADMIN_ADMIN_PATH_PREFIXES.some((p) => t === p || t.startsWith(`${p}/`));
}

const apiRoutes = repoFiles({ under: API_ADMIN_DIR, extensions: ['route.ts'] }).map(repoRelative);
const adminPages = repoFiles({ under: PAGE_ADMIN_DIR, extensions: ['page.tsx'] }).map(repoRelative);

beforeEach(() => jest.clearAllMocks());

describe('AI_ADMIN_ADMIN_PATH_PREFIXES — the whole allowlist, pinned', () => {
    it('is exactly these six subtrees (set equality, no duplicates)', () => {
        expect([...AI_ADMIN_ADMIN_PATH_PREFIXES].sort()).toEqual(
            [
                // #3861 — A2A host consumers. Added as the SIXTH, and the pin
                // is why: this list is a security surface, so growing it should
                // cost a deliberate edit here rather than ride along with a
                // route. The reason it is admissible at all is on the constant
                // itself — an AI_ADMIN already holds both keys these routes
                // name, and can already issue a peer credential that admits
                // another organisation's agent under the `admin/agents` entry
                // below. Same authority, same keys, a different subtree.
                '/api/t/[slug]/admin/a2a',
                '/api/t/[slug]/admin/agents',
                '/api/t/[slug]/admin/mcp/quarantine',
                '/t/[slug]/admin/agents',
                '/t/[slug]/admin/mcp/agent-receipts',
                '/t/[slug]/admin/mcp/quarantine',
            ].sort(),
        );
        expect(new Set(AI_ADMIN_ADMIN_PATH_PREFIXES).size).toBe(AI_ADMIN_ADMIN_PATH_PREFIXES.length);
    });

    it('every entry names a subtree that exists on disk', () => {
        const missing = AI_ADMIN_ADMIN_PATH_PREFIXES.filter((p) => {
            if (p.startsWith('/api/')) {
                const dir = p.replace('/api/t/[slug]', 'src/app/api/t/[tenantSlug]');
                return !apiRoutes.some((r) => r.startsWith(`${dir}/`));
            }
            const dir = p.replace('/t/[slug]', 'src/app/t/[tenantSlug]/(app)');
            return !adminPages.some((r) => r.startsWith(`${dir}/`));
        });
        expect(missing).toEqual([]);
    });

    it('the population read from disk is not empty (an empty one would pass everything below)', () => {
        expect(apiRoutes.length).toBeGreaterThan(80);
        expect(apiRoutes.filter((r) => insideAllowlist(apiUrlOf(r))).length).toBeGreaterThan(20);
        expect(adminPages.length).toBeGreaterThan(20);
    });
});

describe('the real middleware, for an AI_ADMIN in the URL tenant, on every admin API route on disk', () => {
    it.each(apiRoutes.map((r) => [r, apiUrlOf(r)] as const))(
        '%s',
        async (_rel, url) => {
            expect({ url, refused: await refusedAtEdge('AI_ADMIN', url) }).toEqual({
                url,
                refused: !insideAllowlist(url),
            });
        },
    );

    it('every admin ROOT outside the allowlist is refused (sampled from disk, one route each)', async () => {
        const roots = new Map<string, string>();
        for (const r of apiRoutes) {
            const url = apiUrlOf(r);
            const root = url.split('/').slice(0, 6).join('/'); // /api/t/acme/admin/<root>
            if (!insideAllowlist(url) && !roots.has(root)) roots.set(root, url);
        }
        expect(roots.size).toBeGreaterThan(30);
        const admitted: string[] = [];
        for (const url of roots.values()) {
            if (!(await refusedAtEdge('AI_ADMIN', url))) admitted.push(url);
        }
        expect(admitted).toEqual([]);
    });
});

describe('admin PAGES on disk, judged by the same gate', () => {
    it.each(adminPages.map((r) => [r, pageUrlOf(r)] as const))('%s', (_rel, url) => {
        const memberships = tokenFor('AI_ADMIN').memberships;
        expect({ url, verdict: checkAdminAccess(url, 'AI_ADMIN', memberships) }).toEqual({
            url,
            verdict: insideAllowlist(url) ? 'allow' : 'deny',
        });
    });
});

describe('segment boundaries and non-canonical paths fail closed', () => {
    const refused = [
        '/api/t/acme/admin/agents-evil',
        '/api/t/acme/admin/agentsX',
        '/api/t/acme/admin/Agents',
        '/api/t/acme/admin/agents%2F..%2Fmembers',
        '/api/t/acme/admin/agents/%2e%2e/members',
        '/api/t/acme/admin/agents%2fkill-switch',
        '/api/t/acme/admin//agents',
        '/api/t/acme/admin/agents//kill-switch',
        '/api/t/acme/admin/agents\\..\\members',
        '/api/t/acme/admin/mcp',
        '/api/t/acme/admin/mcp/',
        '/api/t/acme/admin/mcp/quarantine-export',
        '/api/t/acme/admin/mcp/quarantineX',
        '/api/t/acme/admin/members',
        '/api/t/acme/admin/members/agents',
        '/api/t/acme/admin/security-settings/agent-enforcement',
        '/api/t/acme/admin/agent-driver',
        '/api/t/acme/admin',
        '/api/t/acme/agents/admin/agents',
        '/t/acme/admin/mcp',
        '/t/acme/admin/members',
        '/t/acme/admin',
        '/admin/agents',
        '/api/admin/agents',
    ];
    const admitted = [
        '/api/t/acme/admin/agents',
        '/api/t/acme/admin/agents/',
        '/api/t/acme/admin/agents/agent-1',
        '/api/t/acme/admin/agents/agent-1/ownership-transfer/complete',
        '/api/t/acme/admin/agents/kill-switch',
        '/api/t/acme/admin/mcp/quarantine',
        '/t/acme/admin/agents',
        '/t/acme/admin/agents/agent-1',
        '/t/acme/admin/mcp/quarantine',
        '/t/acme/admin/mcp/agent-receipts',
    ];

    it.each(refused)('refuses %s', (p) => expect(isAiAdminAdminPath(p)).toBe(false));
    it.each(admitted)('admits %s', (p) => expect(isAiAdminAdminPath(p)).toBe(true));

    it('the real middleware refuses the API tricks that survive URL parsing', async () => {
        const survivors: string[] = [];
        for (const p of refused.filter((x) => x.startsWith('/api/t/acme/admin'))) {
            if (!(await refusedAtEdge('AI_ADMIN', p))) survivors.push(p);
        }
        expect(survivors).toEqual([]);
    });
});

describe('the role that counts is the one in the URL tenant', () => {
    it('AI_ADMIN in acme does not open the agent APIs of beta, where they are READER', async () => {
        expect(await refusedAtEdge('AI_ADMIN', '/api/t/beta/admin/agents')).toBe(true);
    });

    it('a flat admin path names no tenant: a primary AI_ADMIN is refused', () => {
        expect(checkAdminAccess('/admin', 'AI_ADMIN', tokenFor('AI_ADMIN').memberships)).toBe('deny');
    });

    it('a tenant missing from the claim still defers, as for every role', () => {
        expect(checkAdminAccess('/api/t/gamma/admin/agents', 'AI_ADMIN', tokenFor('AI_ADMIN').memberships)).toBe(
            'defer',
        );
    });
});

describe('the other roles are unchanged', () => {
    it.each(['READER', 'EDITOR'])('%s is still refused on the agent APIs', async (role) => {
        expect(await refusedAtEdge(role, '/api/t/acme/admin/agents')).toBe(true);
        expect(await refusedAtEdge(role, '/api/t/acme/admin/mcp/quarantine')).toBe(true);
    });

    // #3710 changed AUDITOR, deliberately and narrowly: it holds the inventory
    // view key, so the edge admits a GET of the agent inventory and nothing else
    // under `/admin` (`AUDITOR_ADMIN_READ_PATHS`, pinned in
    // `tests/unit/agent-registry-view-key.test.ts`).
    // #4898 added the quarantine read: the edge admits the GET, and the usecase
    // refuses an AUDITOR unless an owner has turned the switch on.
    it('AUDITOR reads the agent inventory and the quarantine, and is refused every other agent API', async () => {
        expect(await refusedAtEdge('AUDITOR', '/api/t/acme/admin/agents')).toBe(false);
        expect(await refusedAtEdge('AUDITOR', '/api/t/acme/admin/agents', 'POST')).toBe(true);
        expect(await refusedAtEdge('AUDITOR', '/api/t/acme/admin/mcp/quarantine')).toBe(false);
        expect(await refusedAtEdge('AUDITOR', '/api/t/acme/admin/agents/kill-switch')).toBe(true);
    });

    it.each(['ADMIN', 'OWNER'])('%s still reaches every admin root', async (role) => {
        expect(await refusedAtEdge(role, '/api/t/acme/admin/members')).toBe(false);
        expect(await refusedAtEdge(role, '/api/t/acme/admin/agents')).toBe(false);
    });
});
