/**
 * D-EV-8 — `GET /api/t/:slug/agent-runs/:id/decisions` takes BOTH gates.
 *
 * The rows are addressed through a run, so the route takes the run detail
 * page's gate (`admin.view` OR `admin.agent_registry_view`). They are the
 * decision log's rows, so the usecase then asks the log's own read rule
 * (`mayReadOversightSurface`): the register key, or the view key while the
 * owner's switch lets Auditors read the log. Asserted against the real route
 * handler, the real `requirePermission` middleware and the real usecase, with
 * only the database answered by fakes:
 *
 *   1. EDITOR and READER are refused at the route, audited, and nothing is read;
 *   2. an AUDITOR passes the route and is refused by the log's rule, audited,
 *      while the switch is off, and reads the rows while it is on;
 *   3. a custom role holding `admin.view` without the register key is refused
 *      by the log's rule, as `/agents/decisions` refuses it;
 *   4. OWNER and ADMIN read, and the query selects five columns and no text;
 *   5. the declarative map records the route's gate.
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
        appendAuditEntry: (entry: unknown) => auditSpy(entry),
    }),
);

/** The tenant's oversight switches, as `readAgentOversightSettings` reads them. */
const settings = { auditorReadsAiDecisionLog: false };
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => ({ ...settings }) } }),
    ),
}));

const findRun = jest.fn();
const findRows = jest.fn();
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ workflowRun: { findFirst: findRun }, aiDecisionLog: { findMany: findRows } }),
    ),
}));

import { NextRequest } from 'next/server';

import * as decisionsRoute from '@/app/api/t/[tenantSlug]/agent-runs/[id]/decisions/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

const RUN = 'run-1';
const PATH = `/api/t/acme/agent-runs/${RUN}/decisions`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(ctx: RequestContext): Promise<Response> {
    getTenantCtxMock.mockResolvedValue(ctx);
    return (decisionsRoute.GET as unknown as Handler)(new NextRequest(`http://localhost${PATH}`), {
        params: Promise.resolve({ tenantSlug: 'acme', id: RUN }),
    });
}

const denials = () =>
    auditSpy.mock.calls
        .map(([entry]) => entry as { action?: string; entity?: string; detailsJson?: Record<string, unknown> })
        .filter((e) => e.action === 'AUTHZ_DENIED');

beforeEach(() => {
    jest.clearAllMocks();
    settings.auditorReadsAiDecisionLog = false;
    findRun.mockResolvedValue({ id: RUN });
    findRows.mockResolvedValue([
        {
            id: 'adl-1',
            inputDigest: DIGEST,
            agentId: 'agent-1',
            createdAt: new Date('2026-11-15T10:00:00.000Z'),
            humanOutcome: 'PENDING',
        },
    ]);
});

describe('the route’s gate: the run detail page’s', () => {
    it.each(['EDITOR', 'READER'] as const)('refuses %s at the route, audited, and reads nothing', async (role) => {
        const res = await call(makeRequestContext(role));
        expect(res.status).toBe(403);
        expect(findRun).not.toHaveBeenCalled();
        expect(findRows).not.toHaveBeenCalled();
        const [denial, ...more] = denials();
        expect(more).toEqual([]);
        expect(denial.entity).toBe('Permission');
        expect(denial.detailsJson?.permissionKeys).toEqual(['admin.view', 'admin.agent_registry_view']);
    });

    it('the declarative map records the same pair', () => {
        const r = resolveRoutePermission(PATH, 'GET');
        expect(r && { keys: ([] as string[]).concat(r.permission), mode: r.mode }).toEqual({
            keys: ['admin.view', 'admin.agent_registry_view'],
            mode: 'any',
        });
    });
});

describe('the decision log’s own rule, on top', () => {
    it('an AUDITOR passes the route and is refused by the log’s rule while the switch is off', async () => {
        const res = await call(makeRequestContext('AUDITOR'));
        expect(res.status).toBe(403);
        expect(findRows).not.toHaveBeenCalled();
        const [denial] = denials();
        expect(denial.detailsJson).toMatchObject({ reason: 'agent_oversight_surface', surface: 'decisions' });
    });

    it('an AUDITOR reads the rows while the owner lets Auditors read the log', async () => {
        settings.auditorReadsAiDecisionLog = true;
        const res = await call(makeRequestContext('AUDITOR'));
        expect(res.status).toBe(200);
        expect(denials()).toEqual([]);
    });

    it('admin.view without the register key passes the route and is refused by the log’s rule', async () => {
        const admin = getPermissionsForRole('ADMIN');
        const ctx = makeRequestContext('ADMIN', {
            appPermissions: { ...admin, admin: { ...admin.admin, agent_registry: false, agent_registry_view: false } },
        });
        const res = await call(ctx);
        expect(res.status).toBe(403);
        expect(findRows).not.toHaveBeenCalled();
        expect(denials()[0].detailsJson).toMatchObject({ surface: 'decisions' });
    });
});

describe('what a reader gets', () => {
    it.each(['OWNER', 'ADMIN'] as const)('%s reads the run’s rows: five fields, no text', async (role) => {
        const res = await call(makeRequestContext(role));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            runId: RUN,
            rows: [{ id: 'adl-1', inputDigest: DIGEST, agentId: 'agent-1', createdAt: '2026-11-15T10:00:00.000Z', humanOutcome: 'PENDING' }],
            truncated: false,
        });
        const [query] = findRows.mock.calls[0] as [{ where: Record<string, unknown>; select: Record<string, boolean> }];
        expect(Object.keys(query.select).sort()).toEqual(['agentId', 'createdAt', 'humanOutcome', 'id', 'inputDigest']);
        expect(query.where).toMatchObject({ sessionRef: RUN });
        expect(query.where.tenantId).toBe(makeRequestContext(role).tenantId);
    });

    it('a run the tenant does not hold is not found, and its rows are never read', async () => {
        findRun.mockResolvedValue(null);
        const res = await call(makeRequestContext('OWNER'));
        expect(res.status).toBe(404);
        expect(findRows).not.toHaveBeenCalled();
    });
});
