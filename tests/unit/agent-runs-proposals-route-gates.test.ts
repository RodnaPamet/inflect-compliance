/**
 * THE AGENT RUN AND AGENT PROPOSAL ROUTES TAKE THE GATE THEIR PAGES TAKE.
 *
 * The runs, run detail and proposals pages render only for `admin.view` OR the
 * inventory view key (`mayReadAgentActivity`, #3710), and enable Start, Resume,
 * Abort, Approve and Reject on the role-tier write. The API routes behind them
 * had only the usecases' coarse `assertCanRead` / `assertCanWrite`, so a READER
 * could read every run's steps and every proposal, and an EDITOR could also
 * start, resume and abort runs and approve and reject proposals, through the
 * API, while the pages refused both.
 *
 * Every claim is asserted against the real route handler, the real
 * `requirePermission` middleware and — for the writes — the real usecase's own
 * first-line assert:
 *
 *   1. the reads admit OWNER, ADMIN, AI_ADMIN and AUDITOR and refuse EDITOR and
 *      READER at the route, with an `AUTHZ_DENIED` row and before the usecase;
 *   2. the writes are the page's two layers: EDITOR and READER are refused at the
 *      route, AUDITOR and AI_ADMIN pass it and are refused by the usecase, OWNER
 *      and ADMIN reach the work;
 *   3. starting a run with a bearer API key keeps its own gate, the
 *      `mcp:orchestrate` scope, and anything that is not a key gets the person's;
 *   4. the proposals list never returns `payloadJson`, which the page withholds
 *      from every reader;
 *   5. the declarative map records the gate each route takes.
 */
import { strictMock } from '../helpers/strict-mock';

const DB_REACHED = 'test: a usecase reached the database';

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

// A usecase that passes its own assert goes on to the database; nothing here
// may reach a real one, and a test that expects a refusal must see the refusal
// rather than this.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async () => {
        throw new Error(DB_REACHED);
    }),
}));
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async () => {
        throw new Error(DB_REACHED);
    }),
}));

// Each usecase is a spy that runs the REAL function unless a test supplies a
// result. The reads are given fixtures; the writes run for real, so the second
// layer of the page's gate — the usecase's own `assertCanWrite` — is the real
// one, not a copy of it. The factories reach the spies lazily, because a
// factory runs when the route under test is imported, before this file's own
// declarations below have been evaluated.
jest.mock('@/app-layer/usecases/workflow-runs', () => {
    const actual = jest.requireActual('@/app-layer/usecases/workflow-runs');
    return {
        ...actual,
        listWorkflowRuns: (...a: unknown[]) => runsSpies.listWorkflowRuns(...a),
        getWorkflowRun: (...a: unknown[]) => runsSpies.getWorkflowRun(...a),
        startWorkflowRun: (...a: unknown[]) => runsSpies.startWorkflowRun(...a),
        resumeWorkflowRun: (...a: unknown[]) => runsSpies.resumeWorkflowRun(...a),
        abortWorkflowRun: (...a: unknown[]) => runsSpies.abortWorkflowRun(...a),
    };
});
jest.mock('@/app-layer/usecases/workflow-run-steps', () => {
    const actual = jest.requireActual('@/app-layer/usecases/workflow-run-steps');
    return { ...actual, getRunStepFeed: (...a: unknown[]) => stepsSpy(...a) };
});
jest.mock('@/app-layer/usecases/agent-proposals', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-proposals');
    return {
        ...actual,
        listAgentProposals: (...a: unknown[]) => proposalSpies.listAgentProposals(...a),
        approveAgentProposal: (...a: unknown[]) => proposalSpies.approveAgentProposal(...a),
        rejectAgentProposal: (...a: unknown[]) => proposalSpies.rejectAgentProposal(...a),
        bulkRejectAgentProposals: (...a: unknown[]) => proposalSpies.bulkRejectAgentProposals(...a),
    };
});

import { NextRequest } from 'next/server';

import * as listRoute from '@/app/api/t/[tenantSlug]/agent-runs/route';
import * as runRoute from '@/app/api/t/[tenantSlug]/agent-runs/[id]/route';
import * as stepsRoute from '@/app/api/t/[tenantSlug]/agent-runs/[id]/steps/route';
import * as resumeRoute from '@/app/api/t/[tenantSlug]/agent-runs/[id]/resume/route';
import * as abortRoute from '@/app/api/t/[tenantSlug]/agent-runs/[id]/abort/route';
import * as proposalsRoute from '@/app/api/t/[tenantSlug]/agent-proposals/route';
import * as approveRoute from '@/app/api/t/[tenantSlug]/agent-proposals/[id]/approve/route';
import * as rejectRoute from '@/app/api/t/[tenantSlug]/agent-proposals/[id]/reject/route';
import * as bulkRejectRoute from '@/app/api/t/[tenantSlug]/agent-proposals/bulk/reject/route';
import { getPermissionsForRole, mayReadAgentActivity } from '@/lib/permissions';
import { scopesToPermissions } from '@/lib/auth/api-key-auth';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

/** A spy that runs the real function until a test gives it something else. */
const passThrough = (fn: unknown): jest.Mock => jest.fn(fn as (...a: unknown[]) => unknown);

const workflowRunsActual = jest.requireActual('@/app-layer/usecases/workflow-runs');
const runsSpies = {
    listWorkflowRuns: passThrough(workflowRunsActual.listWorkflowRuns),
    getWorkflowRun: passThrough(workflowRunsActual.getWorkflowRun),
    startWorkflowRun: passThrough(workflowRunsActual.startWorkflowRun),
    resumeWorkflowRun: passThrough(workflowRunsActual.resumeWorkflowRun),
    abortWorkflowRun: passThrough(workflowRunsActual.abortWorkflowRun),
};
const stepsSpy = passThrough(jest.requireActual('@/app-layer/usecases/workflow-run-steps').getRunStepFeed);
const proposalsActual = jest.requireActual('@/app-layer/usecases/agent-proposals');
const proposalSpies = {
    listAgentProposals: passThrough(proposalsActual.listAgentProposals),
    approveAgentProposal: passThrough(proposalsActual.approveAgentProposal),
    rejectAgentProposal: passThrough(proposalsActual.rejectAgentProposal),
    bulkRejectAgentProposals: passThrough(proposalsActual.bulkRejectAgentProposals),
};

type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface RouteCase {
    name: string;
    method: 'GET' | 'POST';
    path: string;
    handler: Handler;
    params: Record<string, string>;
    body?: unknown;
    /** The usecase spy the handler calls once it is past the route gate. */
    usecase: jest.Mock;
}

const RUN = 'run-1';
const PROP = 'prop-1';

const READS: RouteCase[] = [
    { name: 'GET /agent-runs', method: 'GET', path: '/api/t/acme/agent-runs', handler: listRoute.GET as unknown as Handler, params: { tenantSlug: 'acme' }, usecase: runsSpies.listWorkflowRuns },
    { name: 'GET /agent-runs/:id', method: 'GET', path: `/api/t/acme/agent-runs/${RUN}`, handler: runRoute.GET as unknown as Handler, params: { tenantSlug: 'acme', id: RUN }, usecase: runsSpies.getWorkflowRun },
    { name: 'GET /agent-runs/:id/steps', method: 'GET', path: `/api/t/acme/agent-runs/${RUN}/steps`, handler: stepsRoute.GET as unknown as Handler, params: { tenantSlug: 'acme', id: RUN }, usecase: stepsSpy },
    { name: 'GET /agent-proposals', method: 'GET', path: '/api/t/acme/agent-proposals', handler: proposalsRoute.GET as unknown as Handler, params: { tenantSlug: 'acme' }, usecase: proposalSpies.listAgentProposals },
];

const WRITES: RouteCase[] = [
    { name: 'POST /agent-runs', method: 'POST', path: '/api/t/acme/agent-runs', handler: listRoute.POST as unknown as Handler, params: { tenantSlug: 'acme' }, body: { workflowKey: 'diagnostic' }, usecase: runsSpies.startWorkflowRun },
    { name: 'POST /agent-runs/:id/resume', method: 'POST', path: `/api/t/acme/agent-runs/${RUN}/resume`, handler: resumeRoute.POST as unknown as Handler, params: { tenantSlug: 'acme', id: RUN }, usecase: runsSpies.resumeWorkflowRun },
    { name: 'POST /agent-runs/:id/abort', method: 'POST', path: `/api/t/acme/agent-runs/${RUN}/abort`, handler: abortRoute.POST as unknown as Handler, params: { tenantSlug: 'acme', id: RUN }, usecase: runsSpies.abortWorkflowRun },
    { name: 'POST /agent-proposals/:id/approve', method: 'POST', path: `/api/t/acme/agent-proposals/${PROP}/approve`, handler: approveRoute.POST as unknown as Handler, params: { tenantSlug: 'acme', id: PROP }, body: {}, usecase: proposalSpies.approveAgentProposal },
    { name: 'POST /agent-proposals/:id/reject', method: 'POST', path: `/api/t/acme/agent-proposals/${PROP}/reject`, handler: rejectRoute.POST as unknown as Handler, params: { tenantSlug: 'acme', id: PROP }, usecase: proposalSpies.rejectAgentProposal },
    { name: 'POST /agent-proposals/bulk/reject', method: 'POST', path: '/api/t/acme/agent-proposals/bulk/reject', handler: bulkRejectRoute.POST as unknown as Handler, params: { tenantSlug: 'acme' }, body: { proposalIds: [PROP] }, usecase: proposalSpies.bulkRejectAgentProposals },
];

async function call(c: RouteCase, ctx: RequestContext): Promise<Response> {
    getTenantCtxMock.mockResolvedValue(ctx);
    const req = new NextRequest(`http://localhost${c.path}`, {
        method: c.method,
        ...(c.method === 'POST'
            ? { headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify(c.body ?? {}) }
            : {}),
    });
    return c.handler(req, { params: Promise.resolve(c.params) });
}

/** The `AUTHZ_DENIED` rows the permission middleware wrote. */
const routeDenials = () =>
    auditSpy.mock.calls
        .map(([entry]) => entry as { action?: string; entity?: string; detailsJson?: { permissionKeys?: string[] } })
        .filter((e) => e.action === 'AUTHZ_DENIED' && e.entity === 'Permission');

const GATE = ['admin.view', 'admin.agent_registry_view'];

/** A row in the shape `listAgentProposals` returns — the whole model. */
function storedProposal() {
    return {
        id: PROP,
        tenantId: 'tenant-1',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        payloadJson: '{"title":"Unpatched edge router","likelihood":4}',
        targetEntityId: null,
        rationale: 'Seen in the last scan.',
        proposedViaKeyId: 'key-1',
        proposedBySessionRef: null,
        reviewedByUserId: null,
        reviewedAt: null,
        createdEntityId: null,
        agentId: 'agent-1',
        policyCardVersion: 1,
        runId: RUN,
        stepSeq: 2,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:abc',
        guardProvenance: 'THIRD_PARTY_INGESTED',
        requiredApprovals: 1,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        createdAt: new Date('2026-10-29T00:00:00.000Z'),
        updatedAt: new Date('2026-10-29T00:00:00.000Z'),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // The reads answer with fixtures; the gate is the claim, not the query.
    runsSpies.listWorkflowRuns.mockResolvedValue([]);
    runsSpies.getWorkflowRun.mockResolvedValue({ id: RUN, steps: [], proposals: [] });
    stepsSpy.mockResolvedValue({ runId: RUN, steps: [], cursor: -1, hasMore: false, live: false });
    proposalSpies.listAgentProposals.mockResolvedValue([storedProposal()]);
});

// ─── 1. the reads ───────────────────────────────────────────────────────────

describe('the run and proposal READS take the pages’ gate', () => {
    describe.each(READS.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        it.each(['OWNER', 'ADMIN', 'AI_ADMIN', 'AUDITOR'] as const)('admits %s', async (role) => {
            const res = await call(c, makeRequestContext(role));
            expect(res.status).toBe(200);
            expect(c.usecase).toHaveBeenCalledTimes(1);
            expect(routeDenials()).toEqual([]);
        });

        it.each(['EDITOR', 'READER'] as const)(
            'refuses %s at the route, audited, before the usecase runs',
            async (role) => {
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBe(403);
                expect(c.usecase).not.toHaveBeenCalled();
                const denials = routeDenials();
                expect(denials).toHaveLength(1);
                expect(denials[0].detailsJson?.permissionKeys).toEqual(GATE);
                // The key is never echoed to the caller.
                expect(JSON.stringify(await res.json())).not.toContain('agent_registry_view');
            },
        );
    });

    it('admits exactly whom the page admits, including a custom role holding only the view key', async () => {
        const reader = getPermissionsForRole('READER');
        const viewKeyOnly = makeRequestContext('READER', {
            appPermissions: { ...reader, admin: { ...reader.admin, agent_registry_view: true } },
        });
        expect(mayReadAgentActivity(viewKeyOnly.appPermissions.admin)).toBe(true);
        for (const c of READS) {
            expect({ route: c.name, status: (await call(c, viewKeyOnly)).status }).toEqual({ route: c.name, status: 200 });
        }
    });
});

// ─── 2. the writes ──────────────────────────────────────────────────────────

describe('the run and proposal WRITES take the page’s two layers', () => {
    describe.each(WRITES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        it.each(['EDITOR', 'READER'] as const)(
            'refuses %s at the route, audited, before the usecase runs',
            async (role) => {
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBe(403);
                expect(c.usecase).not.toHaveBeenCalled();
                const denials = routeDenials();
                expect(denials).toHaveLength(1);
                expect(denials[0].detailsJson?.permissionKeys).toEqual(GATE);
            },
        );

        it.each(['AUDITOR', 'AI_ADMIN'] as const)(
            'lets %s past the route and the usecase refuses it, as the page disables the button',
            async (role) => {
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBe(403);
                expect(c.usecase).toHaveBeenCalledTimes(1);
                expect(routeDenials()).toEqual([]);
            },
        );

        it.each(['OWNER', 'ADMIN'] as const)('lets %s through both layers to the work', async (role) => {
            c.usecase.mockResolvedValueOnce({ ok: true });
            const res = await call(c, makeRequestContext(role));
            expect(res.status).toBeLessThan(300);
            expect(c.usecase).toHaveBeenCalledTimes(1);
            expect(routeDenials()).toEqual([]);
        });
    });
});

// ─── 3. starting a run with an API key ──────────────────────────────────────

describe('POST /agent-runs with a bearer API key keeps the key’s own gate', () => {
    const start = WRITES[0];
    const keyCtx = (scopes: string[]): RequestContext =>
        makeRequestContext('READER', {
            apiKeyId: 'key-1',
            apiKeyScopes: scopes,
            appPermissions: scopesToPermissions(scopes),
        });

    it('a runner key — mcp:orchestrate and domain reads, no admin scope — still starts a run', async () => {
        const ctx = keyCtx(['mcp:read', 'mcp:orchestrate', 'controls:read']);
        expect(mayReadAgentActivity(ctx.appPermissions.admin)).toBe(false);
        runsSpies.startWorkflowRun.mockResolvedValueOnce({ runId: RUN, status: 'COMPLETED' });
        const res = await call(start, ctx);
        expect(res.status).toBe(201);
        expect(runsSpies.startWorkflowRun).toHaveBeenCalledWith(ctx, 'diagnostic', {});
        expect(routeDenials()).toEqual([]);
    });

    it('a key without mcp:orchestrate is still refused, by the usecase’s scope check', async () => {
        const res = await call(start, keyCtx(['controls:read', 'risks:write']));
        expect(res.status).toBe(403);
        expect(runsSpies.startWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it('fails closed: a context that did not authenticate as a key gets the person’s gate, whatever scopes it names', async () => {
        const notAKey = makeRequestContext('EDITOR', { apiKeyScopes: ['mcp:orchestrate'] });
        const res = await call(start, notAKey);
        expect(res.status).toBe(403);
        expect(runsSpies.startWorkflowRun).not.toHaveBeenCalled();
        expect(routeDenials()).toHaveLength(1);
    });

    it('resuming and aborting are a person’s acts: a key is held to the person’s gate there', async () => {
        const ctx = keyCtx(['mcp:read', 'mcp:orchestrate', 'risks:write']);
        for (const c of [WRITES[1], WRITES[2]]) {
            const res = await call(c, ctx);
            expect({ route: c.name, status: res.status }).toEqual({ route: c.name, status: 403 });
            expect(c.usecase).not.toHaveBeenCalled();
        }
    });
});

// ─── 4. the field the page withholds ────────────────────────────────────────

describe('GET /agent-proposals never returns payloadJson', () => {
    it('returns every other stored column and not the raw payload', async () => {
        const res = await call(READS[3], makeRequestContext('OWNER'));
        expect(res.status).toBe(200);
        const [row] = (await res.json()) as Array<Record<string, unknown>>;
        expect(row).not.toHaveProperty('payloadJson');
        const { payloadJson: _withheld, ...rest } = storedProposal();
        expect(row).toEqual(JSON.parse(JSON.stringify(rest)));
    });

    it('a column added to the model later is not published until somebody names it', async () => {
        proposalSpies.listAgentProposals.mockResolvedValueOnce([{ ...storedProposal(), someNewEncryptedColumn: 'secret' }]);
        const res = await call(READS[3], makeRequestContext('OWNER'));
        const [row] = (await res.json()) as Array<Record<string, unknown>>;
        expect(row).not.toHaveProperty('someNewEncryptedColumn');
        expect(row).not.toHaveProperty('payloadJson');
    });
});

// ─── 5. the declarative map ─────────────────────────────────────────────────

describe('the route-permission map records each route’s gate', () => {
    it.each([...READS, ...WRITES].map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const r = resolveRoutePermission(c.path, c.method);
        expect(r && { keys: ([] as string[]).concat(r.permission), mode: r.mode }).toEqual({ keys: GATE, mode: 'any' });
    });
});
