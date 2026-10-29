/**
 * `GET /api/t/:slug/admin/agents/discovered` — the discovered-agent picker's
 * list (#4472) — takes the gate every discovered-agent read takes, and returns
 * a bounded, tenant-scoped list that says when it is cut.
 *
 * Asserted against the real route handler, the real `requirePermission`
 * middleware, the real edge gate (`checkAdminAccess`) and the real usecase:
 *
 *   1. the HANDLER admits exactly the holders of the inventory read
 *      (`admin.agent_registry_view` OR `admin.agent_registry`) and refuses
 *      everyone else with an `AUTHZ_DENIED` row, before the usecase runs;
 *   2. the EDGE admits OWNER, ADMIN and AI_ADMIN to the path and refuses
 *      AUDITOR, EDITOR and READER — `discovered` is a static segment, so an
 *      AUDITOR's GET is not mistaken for one agent's row;
 *   3. so, END TO END, OWNER, ADMIN and AI_ADMIN read it and no other built-in
 *      role does;
 *   4. the declarative map records the same keys, above the register's
 *      catch-all;
 *   5. the read is filtered by tenant, takes one past its cap, reports a cut
 *      list, and carries no owner reference.
 */
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const auditSpy = jest.fn(async (_entry: unknown) => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => auditSpy(entry),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

/** The discovered-agent table, as the tenant-bound transaction sees it. */
const findMany = jest.fn();
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ discoveredAgent: { findMany: (...a: unknown[]) => findMany(...a) } }),
    ),
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/t/[tenantSlug]/admin/agents/discovered/route';
import {
    DISCOVERED_AGENT_PICKER_CAP,
    listDiscoveredAgentOptions,
} from '@/app-layer/usecases/discovered-agent-list';
import { checkAdminAccess, isAuditorAdminReadPath } from '@/lib/auth/guard';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

const PATH = '/api/t/acme/admin/agents/discovered';
const BUILT_IN = ['OWNER', 'ADMIN', 'AI_ADMIN', 'AUDITOR', 'EDITOR', 'READER'] as const;
type BuiltIn = (typeof BUILT_IN)[number];

const row = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `da-${i}`,
    discoveredId: `entra:sp:${i}`,
    discoveredVia: ['entra-sp'],
    lastSeenAt: new Date(Date.UTC(2026, 9, 28, 0, 0, i)),
    registeredAgent: null,
    ...extra,
});

async function call(ctx: RequestContext): Promise<Response> {
    getTenantCtxMock.mockResolvedValue(ctx);
    return (GET as unknown as (req: NextRequest, a: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>)(
        new NextRequest(`http://localhost${PATH}`),
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );
}

const routeDenials = () =>
    auditSpy.mock.calls
        .map(([e]) => e as { action?: string; entity?: string })
        .filter((e) => e.action === 'AUTHZ_DENIED' && e.entity === 'Permission');

const edgeAdmits = (role: BuiltIn) =>
    checkAdminAccess(PATH, role, [{ slug: 'acme', role }], 'GET') !== 'deny';

beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([row(1)]);
});

describe('1. the handler takes the inventory read', () => {
    it.each(['OWNER', 'ADMIN', 'AI_ADMIN', 'AUDITOR'] as const)('admits %s, which holds it', async (role) => {
        const res = await call(makeRequestContext(role));
        expect(res.status).toBe(200);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(routeDenials()).toEqual([]);
    });

    it.each(['EDITOR', 'READER'] as const)('refuses %s at the route, with AUTHZ_DENIED, before the read', async (role) => {
        const res = await call(makeRequestContext(role));
        expect(res.status).toBe(403);
        expect(findMany).not.toHaveBeenCalled();
        expect(routeDenials()).toHaveLength(1);
    });

    it('refuses a custom role that holds neither key, whatever its base', async () => {
        const admin = getPermissionsForRole('ADMIN');
        const ctx = makeRequestContext('ADMIN', {
            appPermissions: { ...admin, admin: { ...admin.admin, agent_registry: false, agent_registry_view: false } },
        });
        const res = await call(ctx);
        expect(res.status).toBe(403);
        expect(findMany).not.toHaveBeenCalled();
    });

    it('admits a custom role holding the view key alone', async () => {
        const reader = getPermissionsForRole('READER');
        const ctx = makeRequestContext('READER', {
            appPermissions: { ...reader, admin: { ...reader.admin, agent_registry_view: true } },
        });
        expect((await call(ctx)).status).toBe(200);
    });
});

describe('2. the edge', () => {
    it('admits OWNER, ADMIN and AI_ADMIN, and no other built-in role', () => {
        expect(BUILT_IN.filter(edgeAdmits)).toEqual(['OWNER', 'ADMIN', 'AI_ADMIN']);
    });

    it('does not read `discovered` as an agent id for an AUDITOR', () => {
        // Were the segment missing from AGENT_ADMIN_API_STATIC_SEGMENTS, this
        // path would match the `[agentId]` inventory read the edge admits an
        // AUDITOR to.
        expect(isAuditorAdminReadPath(PATH, 'GET')).toBe(false);
    });
});

describe('3. end to end, by built-in role', () => {
    it('OWNER, ADMIN and AI_ADMIN read the list; AUDITOR, EDITOR and READER do not', async () => {
        const reads: Record<string, boolean> = {};
        for (const role of BUILT_IN) {
            const handler = (await call(makeRequestContext(role))).status === 200;
            reads[role] = edgeAdmits(role) && handler;
        }
        expect(reads).toEqual({ OWNER: true, ADMIN: true, AI_ADMIN: true, AUDITOR: false, EDITOR: false, READER: false });
    });
});

describe('4. the declarative map', () => {
    it('records the inventory read for a GET, not the register catch-all', () => {
        const r = resolveRoutePermission(PATH, 'GET');
        expect(r && { keys: ([] as string[]).concat(r.permission), mode: r.mode }).toEqual({
            keys: ['admin.agent_registry_view', 'admin.agent_registry'],
            mode: 'any',
        });
    });
});

describe('5. the read', () => {
    const ctx = () => makeRequestContext('ADMIN', { tenantId: 'tenant-acme' });

    it('is filtered by the tenant and reads one past its cap, newest seen first', async () => {
        await listDiscoveredAgentOptions(ctx());
        const args = findMany.mock.calls[0][0] as { where: unknown; take: number; orderBy: unknown; select: Record<string, unknown> };
        expect(args.where).toEqual({ tenantId: 'tenant-acme' });
        expect(args.take).toBe(DISCOVERED_AGENT_PICKER_CAP + 1);
        expect(args.orderBy).toEqual([{ lastSeenAt: 'desc' }, { id: 'asc' }]);
        // No owner reference leaves for a picker.
        expect(Object.keys(args.select)).not.toContain('ownerRef');
    });

    it('reports a cut list as truncated and returns no more than the cap', async () => {
        findMany.mockResolvedValue(Array.from({ length: DISCOVERED_AGENT_PICKER_CAP + 1 }, (_, i) => row(i)));
        const out = await listDiscoveredAgentOptions(ctx());
        expect(out.rows).toHaveLength(DISCOVERED_AGENT_PICKER_CAP);
        expect(out.truncated).toBe(true);
    });

    it('a list of exactly the cap is whole', async () => {
        findMany.mockResolvedValue(Array.from({ length: DISCOVERED_AGENT_PICKER_CAP }, (_, i) => row(i)));
        expect((await listDiscoveredAgentOptions(ctx())).truncated).toBe(false);
    });

    it('names a live register row, and not a deleted one', async () => {
        findMany.mockResolvedValue([
            row(1, { registeredAgent: { name: 'Reconciler', deletedAt: null } }),
            row(2, { registeredAgent: { name: 'Gone', deletedAt: new Date() } }),
        ]);
        const out = await listDiscoveredAgentOptions(ctx());
        expect(out.rows.map((r) => r.registeredAgentName)).toEqual(['Reconciler', null]);
    });

    it('refuses a caller without the inventory read, in the usecase too', async () => {
        await expect(listDiscoveredAgentOptions(makeRequestContext('EDITOR'))).rejects.toThrow(/agent_registry_view/);
        expect(findMany).not.toHaveBeenCalled();
    });
});
