/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/unit/ai-admin-edge-allowlist.test.ts (NextRequest fixtures +
 * mocked rate-limiters + getToken). */
/**
 * #5695, owner decisions 2026-11-15: holding `identity_reconciliation.view` is
 * enough to open the legacy-access reconciliation queue, and the built-in
 * roles that hold it are OWNER, ADMIN and AUDITOR ("Auditors only"). Decisions
 * stay on their existing keys.
 *
 * What a view-key holder who is not an OWNER or ADMIN met before this change,
 * gate by gate, each asked of the REAL code:
 *
 *   1. the edge on the PAGE path — `checkAdminAccess` says `deny`, but the
 *      middleware lets a refused admin PAGE through to the App Router, so the
 *      edge never stopped the page itself;
 *   2. the client admin layout and the page's server gate — the page had no
 *      row in `ADMIN_PAGE_REQUIREMENTS`, so the layout rendered the forbidden
 *      page for any membership role but OWNER and ADMIN;
 *   3. the edge on the API paths — `/api/t/:slug/admin/**` answered 403
 *      "Admin access required" to the queue read;
 *   4. the route key — the run lookup (`executions/latest`) takes
 *      `admin.manage`, which none of those roles holds.
 *
 * This file pins the edge half: exactly two GET templates, segment-exact, for
 * exactly the built-in roles below the admin roles that hold the view key —
 * AUDITOR — and nothing else. EDITOR, READER and AI_ADMIN no longer hold the
 * key and are refused at the edge as before; a custom role granting the key
 * on one of those memberships is refused too, because the edge reads the
 * membership role.
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

import type { Role } from '@prisma/client';
import middleware from '../../src/middleware';
import { getToken } from 'next-auth/jwt';
import {
    EDGE_ADMIN_ROLES,
    RECONCILIATION_VIEW_EDGE_ROLES,
    RECONCILIATION_VIEW_READ_PATHS,
    checkAdminAccess,
    isReconciliationViewReadPath,
} from '@/lib/auth/guard';
import { getPermissionsForRole } from '@/lib/permissions';
import { readFileSync } from 'fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const mockGetToken = getToken as jest.Mock;

const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN' as Role];
/** Every built-in role below the edge's admin roles that holds the view key. */
const VIEW_HOLDERS_BELOW_ADMIN = ALL_ROLES.filter(
    (r) => !EDGE_ADMIN_ROLES.has(r) && getPermissionsForRole(r).identity_reconciliation.view,
);
/** The built-in roles below the admin roles that do NOT hold it. */
const NON_HOLDERS = ALL_ROLES.filter(
    (r) => !EDGE_ADMIN_ROLES.has(r) && !getPermissionsForRole(r).identity_reconciliation.view,
);

const PAGE = '/t/acme/admin/integrations/conn-1/reconciliation';
const QUEUE = '/api/t/acme/admin/legacy-access/queue';
const LATEST_RUN = '/api/t/acme/admin/legacy-access/queue/latest-run';
const DECIDE = '/api/t/acme/admin/legacy-access/queue/decide';
const BULK = '/api/t/acme/admin/legacy-access/queue/bulk-confirm';

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

async function edge(role: string, pathname: string, method = 'GET') {
    mockGetToken.mockResolvedValue(tokenFor(role));
    return middleware(req(method, pathname), {} as any);
}

async function refusedAtEdge(role: string, pathname: string, method = 'GET'): Promise<boolean> {
    const res = await edge(role, pathname, method);
    if (res.status !== 403) return false;
    const body = await res
        .clone()
        .json()
        .catch(() => ({}));
    return (body as { error?: string }).error === 'Admin access required';
}

beforeEach(() => jest.clearAllMocks());

describe('who holds the view key (the population this change admits)', () => {
    it('is OWNER, ADMIN and AUDITOR; AUDITOR is the one the edge newly admits (owner decision 2026-11-15)', () => {
        expect(ALL_ROLES.filter((r) => getPermissionsForRole(r).identity_reconciliation.view).sort()).toEqual(
            ['ADMIN', 'AUDITOR', 'OWNER'],
        );
        expect(VIEW_HOLDERS_BELOW_ADMIN).toEqual(['AUDITOR']);
        expect(NON_HOLDERS.sort()).toEqual(['AI_ADMIN', 'EDITOR', 'READER']);
    });

    it('the edge role set is exactly those holders — derived, not hand-copied', () => {
        expect([...RECONCILIATION_VIEW_EDGE_ROLES].sort()).toEqual([...VIEW_HOLDERS_BELOW_ADMIN].sort());
    });

    it('none of them holds the decision key, so admitting them to a read admits them to no write', () => {
        for (const r of VIEW_HOLDERS_BELOW_ADMIN) {
            expect({ r, confirm: getPermissionsForRole(r).identity_reconciliation.confirm }).toEqual({ r, confirm: false });
        }
    });
});

describe('RECONCILIATION_VIEW_READ_PATHS — the whole allowance, pinned', () => {
    it('is exactly the queue read and the run lookup', () => {
        expect([...RECONCILIATION_VIEW_READ_PATHS].sort()).toEqual(
            ['/api/t/[slug]/admin/legacy-access/queue', '/api/t/[slug]/admin/legacy-access/queue/latest-run'].sort(),
        );
    });

    it('each entry is a route on disk', () => {
        const onDisk = repoFiles({ under: 'src/app/api/t/[tenantSlug]/admin/legacy-access', extensions: ['route.ts'] })
            .map(repoRelative);
        for (const template of RECONCILIATION_VIEW_READ_PATHS) {
            expect(onDisk).toContain(`${template.replace('/api/t/[slug]', 'src/app/api/t/[tenantSlug]')}/route.ts`);
        }
    });

    it('both routes export only a GET, and it is a literal requirePermission on the view key', () => {
        const queue = codeOf(readFileSync('src/app/api/t/[tenantSlug]/admin/legacy-access/queue/route.ts', 'utf8'));
        const latestRun = codeOf(
            readFileSync('src/app/api/t/[tenantSlug]/admin/legacy-access/queue/latest-run/route.ts', 'utf8'),
        );
        expect(queue).toMatch(/requirePermission\('identity_reconciliation\.view'/);
        expect(latestRun).toMatch(/requirePermission\('identity_reconciliation\.view'/);
        // No write verb lives on an admitted path.
        expect(queue).not.toMatch(/export const (POST|PUT|PATCH|DELETE)\b/);
        expect(latestRun).not.toMatch(/export const (POST|PUT|PATCH|DELETE)\b/);
    });
});

describe('the real middleware, for each view-key holder in the URL tenant', () => {
    it.each(VIEW_HOLDERS_BELOW_ADMIN)('%s reaches the queue read and the run lookup (GET and HEAD)', async (role) => {
        for (const p of [QUEUE, LATEST_RUN, `${QUEUE}/`, `${LATEST_RUN}/`]) {
            expect({ p, refused: await refusedAtEdge(role, p) }).toEqual({ p, refused: false });
            expect({ p, refused: await refusedAtEdge(role, p, 'HEAD') }).toEqual({ p, refused: false });
        }
    });

    it.each(VIEW_HOLDERS_BELOW_ADMIN)('%s is let through to the page (the edge never answers an admin page)', async (role) => {
        const res = await edge(role, PAGE);
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
    });

    it.each(VIEW_HOLDERS_BELOW_ADMIN)('%s is still refused every decision POST', async (role) => {
        for (const p of [DECIDE, BULK]) {
            expect({ p, refused: await refusedAtEdge(role, p, 'POST') }).toEqual({ p, refused: true });
        }
    });

    it.each(VIEW_HOLDERS_BELOW_ADMIN)('%s is refused every other method on the admitted paths', async (role) => {
        for (const p of [QUEUE, LATEST_RUN]) {
            for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
                expect({ p, m, refused: await refusedAtEdge(role, p, m) }).toEqual({ p, m, refused: true });
            }
        }
    });

    it.each(VIEW_HOLDERS_BELOW_ADMIN)('%s is refused a GET of every other legacy-access route on disk', async (role) => {
        const others = repoFiles({ under: 'src/app/api/t/[tenantSlug]/admin/legacy-access', extensions: ['route.ts'] })
            .map(repoRelative)
            .map((rel) => rel.replace(/^src\/app/, '').replace(/\/route\.ts$/, '').replace('[tenantSlug]', 'acme'))
            .filter((u) => u !== QUEUE && u !== LATEST_RUN);
        expect(others.length).toBeGreaterThanOrEqual(6);
        const admitted: string[] = [];
        for (const u of others) if (!(await refusedAtEdge(role, u))) admitted.push(u);
        // AI_ADMIN's own agent allowlist does not reach legacy-access either.
        expect(admitted).toEqual([]);
    });

    it.each(['AUDITOR', 'READER', 'EDITOR', 'AI_ADMIN'])('%s is refused a GET of the admin connection routes the page used to call', async (role) => {
        for (const p of [
            '/api/t/acme/admin/integrations/conn-1/executions/latest',
            '/api/t/acme/admin/integrations/conn-1/executions',
            '/api/t/acme/admin/integrations/conn-1',
            '/api/t/acme/admin/integrations',
            '/api/t/acme/admin/members',
        ]) {
            expect({ p, refused: await refusedAtEdge(role, p) }).toEqual({ p, refused: true });
        }
    });

    it('the role that counts is the one in the URL tenant', async () => {
        // tokenFor() makes the caller READER in `beta`, which holds no view key.
        expect(await refusedAtEdge('AUDITOR', '/api/t/beta/admin/legacy-access/queue')).toBe(true);
        // A tenant missing from the claim defers, as for every role.
        expect(checkAdminAccess('/api/t/gamma/admin/legacy-access/queue', 'AUDITOR', tokenFor('AUDITOR').memberships, 'GET')).toBe(
            'defer',
        );
        // A flat admin path names no tenant: a primary READER is refused.
        expect(checkAdminAccess('/api/admin/legacy-access/queue', 'READER', tokenFor('READER').memberships, 'GET')).toBe('deny');
    });

    it.each(['ADMIN', 'OWNER'])('%s is unchanged: every path, every method', async (role) => {
        for (const [p, m] of [[QUEUE, 'GET'], [LATEST_RUN, 'GET'], [DECIDE, 'POST'], [BULK, 'POST']] as const) {
            expect({ p, refused: await refusedAtEdge(role, p, m) }).toEqual({ p, refused: false });
        }
    });
});

describe('the roles that do not hold the key are refused, at the edge and by the key', () => {
    it.each(['EDITOR', 'READER', 'AI_ADMIN'])('%s is refused the queue read and the run lookup at the edge', async (role) => {
        for (const p of [QUEUE, LATEST_RUN]) {
            expect({ p, refused: await refusedAtEdge(role, p) }).toEqual({ p, refused: true });
            expect({ p, refused: await refusedAtEdge(role, p, 'HEAD') }).toEqual({ p, refused: true });
        }
        expect(checkAdminAccess(QUEUE, role, tokenFor(role).memberships, 'GET')).toBe('deny');
    });

    it.each(['EDITOR', 'READER', 'AI_ADMIN'] as Role[])('%s does not hold the key the handlers ask for', (role) => {
        expect(getPermissionsForRole(role).identity_reconciliation).toEqual({ view: false, confirm: false });
    });

    it('a custom role granting the key on a READER membership is still refused at the edge: it reads the membership role', async () => {
        // The token carries the MEMBERSHIP role; a custom role's keys never
        // reach the edge, so this is a READER whatever its custom role grants.
        for (const p of [QUEUE, LATEST_RUN]) {
            expect({ p, refused: await refusedAtEdge('READER', p) }).toEqual({ p, refused: true });
        }
    });
});

describe('segment boundaries and non-canonical paths fail closed', () => {
    const refused = [
        '/api/t/acme/admin/legacy-access/queueX',
        '/api/t/acme/admin/legacy-access/queue-export',
        '/api/t/acme/admin/legacy-access/queue/latest-runX',
        '/api/t/acme/admin/legacy-access/queue/latest-run/x',
        '/api/t/acme/admin/legacy-access/queue/decide',
        '/api/t/acme/admin/legacy-access/queue/bulk-confirm',
        '/api/t/acme/admin/legacy-access/queue/..',
        '/api/t/acme/admin/legacy-access/queue/%2e%2e/mapping',
        '/api/t/acme/admin/legacy-access/queue%2Fdecide',
        '/api/t/acme/admin/legacy-access//queue',
        '/api/t/acme/admin/legacy-access/queue//latest-run',
        '/api/t/acme/admin/legacy-access/queue\\..\\mapping',
        '/api/t/acme/admin/Legacy-Access/queue',
        '/api/t/acme/admin/legacy-access',
        '/api/t/acme/admin/legacy-access/mapping',
        '/api/t/acme/legacy-access/queue',
        '/t/acme/admin/legacy-access/queue',
        '/api/admin/legacy-access/queue',
    ];

    it.each(refused)('refuses %s', (p) => expect(isReconciliationViewReadPath(p, 'GET')).toBe(false));

    it('admits the two templates on GET and HEAD only', () => {
        for (const p of [QUEUE, LATEST_RUN]) {
            expect(isReconciliationViewReadPath(p, 'GET')).toBe(true);
            expect(isReconciliationViewReadPath(p, 'head')).toBe(true);
            for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '', undefined, null]) {
                expect({ p, m, ok: isReconciliationViewReadPath(p, m) }).toEqual({ p, m, ok: false });
            }
        }
    });

    it('the real middleware refuses the API tricks that survive URL parsing', async () => {
        const survivors: string[] = [];
        for (const p of refused.filter((x) => x.startsWith('/api/t/acme/admin'))) {
            if (!(await refusedAtEdge('AUDITOR', p))) survivors.push(p);
        }
        expect(survivors).toEqual([]);
    });
});
