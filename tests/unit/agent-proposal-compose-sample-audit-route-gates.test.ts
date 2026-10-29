/**
 * COMPOSE AND THE SAMPLE AUDITS TAKE THEIR PAGES' GATES.
 *
 * The two directories filed under `/agent-proposals` beside the queue answer to
 * different pages from the queue's:
 *
 *   · `/agents/compose` renders only for `admin.view` and enables Send on the
 *     role-tier write. `GET/POST /agent-proposals/compose` had only the
 *     usecases' `assertCanRead` / `assertCanWrite`, so an EDITOR — refused the
 *     page — could compose an external-write proposal through the API, and
 *     every member could read a template's open fields and candidates.
 *   · `/agents/review-quality` renders only for `admin.agent_registry`.
 *     `GET /agent-proposals/sample-audits` and `POST …/sample-audits/:id` had
 *     only the read and write tiers.
 *
 * Every claim is asserted against the real route handler, the real
 * `requirePermission` middleware and — for the writes — the real usecase's own
 * first-line `assertCanWrite`:
 *
 *   1. the reads admit whom the page admits and refuse everybody else at the
 *      route, with an `AUTHZ_DENIED` row and before the usecase;
 *   2. the writes are the page's two layers: refused at the route without the
 *      key, refused by the usecase without the write tier, through to the work
 *      with both;
 *   3. the declarative map records each gate.
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
// may reach a real one.
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
// result, so the second layer of each write gate is the real `assertCanWrite`.
// The factories reach the spies lazily: a factory runs when the route under
// test is imported, before this file's own declarations are evaluated.
jest.mock('@/app-layer/usecases/external-write-compose', () => {
    const actual = jest.requireActual('@/app-layer/usecases/external-write-compose');
    return {
        ...actual,
        listComposeOffer: (...a: unknown[]) => composeSpies.listComposeOffer(...a),
        composeExternalWriteProposal: (...a: unknown[]) => composeSpies.composeExternalWriteProposal(...a),
    };
});
jest.mock('@/app-layer/usecases/agent-proposal-sample-audit', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-proposal-sample-audit');
    return {
        ...actual,
        listAgentProposalSampleAudits: (...a: unknown[]) => sampleSpies.listAgentProposalSampleAudits(...a),
        getSampleAuditDisagreementRate: (...a: unknown[]) => sampleSpies.getSampleAuditDisagreementRate(...a),
        recordSampleAuditOutcome: (...a: unknown[]) => sampleSpies.recordSampleAuditOutcome(...a),
    };
});

import { NextRequest } from 'next/server';

import * as composeRoute from '@/app/api/t/[tenantSlug]/agent-proposals/compose/route';
import * as sampleAuditsRoute from '@/app/api/t/[tenantSlug]/agent-proposals/sample-audits/route';
import * as sampleAuditRoute from '@/app/api/t/[tenantSlug]/agent-proposals/sample-audits/[id]/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

/** A spy that runs the real function until a test gives it something else. */
const passThrough = (fn: unknown): jest.Mock => jest.fn(fn as (...a: unknown[]) => unknown);

const composeActual = jest.requireActual('@/app-layer/usecases/external-write-compose');
const composeSpies = {
    listComposeOffer: passThrough(composeActual.listComposeOffer),
    composeExternalWriteProposal: passThrough(composeActual.composeExternalWriteProposal),
};
const sampleActual = jest.requireActual('@/app-layer/usecases/agent-proposal-sample-audit');
const sampleSpies = {
    listAgentProposalSampleAudits: passThrough(sampleActual.listAgentProposalSampleAudits),
    getSampleAuditDisagreementRate: passThrough(sampleActual.getSampleAuditDisagreementRate),
    recordSampleAuditOutcome: passThrough(sampleActual.recordSampleAuditOutcome),
};

type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;
type BuiltInRole = 'OWNER' | 'ADMIN' | 'AI_ADMIN' | 'AUDITOR' | 'EDITOR' | 'READER';

interface RouteCase {
    name: string;
    method: 'GET' | 'POST';
    path: string;
    handler: Handler;
    params: Record<string, string>;
    body?: unknown;
    /** The usecase spy the handler calls once it is past the route gate. */
    usecase: jest.Mock;
    /** The key the route takes — its page's gate. */
    gate: string;
    /** The built-in roles whose page admits them. */
    admits: readonly BuiltInRole[];
}

const ALL_ROLES: readonly BuiltInRole[] = ['OWNER', 'ADMIN', 'AI_ADMIN', 'AUDITOR', 'EDITOR', 'READER'];
const AUDIT = 'audit-1';

const COMPOSE_GET: RouteCase = {
    name: 'GET /agent-proposals/compose',
    method: 'GET',
    path: '/api/t/acme/agent-proposals/compose?parameterSetId=set-1',
    handler: composeRoute.GET as unknown as Handler,
    params: { tenantSlug: 'acme' },
    usecase: composeSpies.listComposeOffer,
    gate: 'admin.view',
    admits: ['OWNER', 'ADMIN'],
};
const COMPOSE_POST: RouteCase = {
    name: 'POST /agent-proposals/compose',
    method: 'POST',
    path: '/api/t/acme/agent-proposals/compose',
    handler: composeRoute.POST as unknown as Handler,
    params: { tenantSlug: 'acme' },
    body: { parameterSetId: 'set-1', openFieldValues: {} },
    usecase: composeSpies.composeExternalWriteProposal,
    gate: 'admin.view',
    admits: ['OWNER', 'ADMIN'],
};
const SAMPLE_GET: RouteCase = {
    name: 'GET /agent-proposals/sample-audits',
    method: 'GET',
    path: '/api/t/acme/agent-proposals/sample-audits',
    handler: sampleAuditsRoute.GET as unknown as Handler,
    params: { tenantSlug: 'acme' },
    usecase: sampleSpies.listAgentProposalSampleAudits,
    gate: 'admin.agent_registry',
    admits: ['OWNER', 'ADMIN', 'AI_ADMIN'],
};
const SAMPLE_POST: RouteCase = {
    name: 'POST /agent-proposals/sample-audits/:id',
    method: 'POST',
    path: `/api/t/acme/agent-proposals/sample-audits/${AUDIT}`,
    handler: sampleAuditRoute.POST as unknown as Handler,
    params: { tenantSlug: 'acme', id: AUDIT },
    body: { outcome: 'CONCURRED' },
    usecase: sampleSpies.recordSampleAuditOutcome,
    gate: 'admin.agent_registry',
    admits: ['OWNER', 'ADMIN', 'AI_ADMIN'],
};

const READS = [COMPOSE_GET, SAMPLE_GET];
const WRITES = [COMPOSE_POST, SAMPLE_POST];

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

const refused = (c: RouteCase) => ALL_ROLES.filter((r) => !c.admits.includes(r));

beforeEach(() => {
    jest.clearAllMocks();
    // The reads answer with fixtures; the gate is the claim, not the query.
    composeSpies.listComposeOffer.mockResolvedValue({ ok: true, label: 'Template', toolName: 'mcp:c1:tool', fields: [] });
    sampleSpies.listAgentProposalSampleAudits.mockResolvedValue([]);
    sampleSpies.getSampleAuditDisagreementRate.mockResolvedValue({
        sampled: 0,
        answered: 0,
        pending: 0,
        concurred: 0,
        dissented: 0,
        indeterminate: 0,
        disagreementRate: null,
    });
});

// ─── 0. the population the matrix stands on ─────────────────────────────────

describe('the built-in roles each page admits', () => {
    // The `admits` lists above are this table read off the real permission
    // resolver, so a change to a role's keys moves the matrix rather than
    // leaving it asserting a stale population.
    it.each([...READS, ...WRITES].map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const [domain, action] = c.gate.split('.') as ['admin', string];
        const holders = ALL_ROLES.filter(
            (r) => (getPermissionsForRole(r)[domain] as Record<string, boolean>)[action] === true,
        );
        expect(holders).toEqual([...c.admits]);
    });
});

// ─── 1. the reads ───────────────────────────────────────────────────────────

describe('the READS take their pages’ gate', () => {
    describe.each(READS.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        it.each(c.admits.map((r) => [r] as const))('admits %s', async (role) => {
            const res = await call(c, makeRequestContext(role));
            expect(res.status).toBe(200);
            expect(c.usecase).toHaveBeenCalledTimes(1);
            expect(routeDenials()).toEqual([]);
        });

        it.each(refused(c).map((r) => [r] as const))(
            'refuses %s at the route, audited, before the usecase runs',
            async (role) => {
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBe(403);
                expect(c.usecase).not.toHaveBeenCalled();
                const denials = routeDenials();
                expect(denials).toHaveLength(1);
                expect(denials[0].detailsJson?.permissionKeys).toEqual([c.gate]);
                // The key is never echoed to the caller.
                expect(JSON.stringify(await res.json())).not.toContain(c.gate);
            },
        );
    });
});

// ─── 2. the writes ──────────────────────────────────────────────────────────

describe('the WRITES take their page’s two layers', () => {
    describe.each(WRITES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        it.each(refused(c).map((r) => [r] as const))(
            'refuses %s at the route, audited, before the usecase runs',
            async (role) => {
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBe(403);
                expect(c.usecase).not.toHaveBeenCalled();
                const denials = routeDenials();
                expect(denials).toHaveLength(1);
                expect(denials[0].detailsJson?.permissionKeys).toEqual([c.gate]);
            },
        );

        it('a holder of the key WITHOUT the write tier passes the route and the usecase refuses it', async () => {
            // A custom role on a READER base granted the page's key: the page
            // shows it and disables the action, and the usecase is what refuses.
            const reader = getPermissionsForRole('READER');
            const [, action] = c.gate.split('.');
            const ctx = makeRequestContext('READER', {
                appPermissions: { ...reader, admin: { ...reader.admin, [action]: true } },
            });
            const res = await call(c, ctx);
            expect(res.status).toBe(403);
            expect(c.usecase).toHaveBeenCalledTimes(1);
            expect(routeDenials()).toEqual([]);
        });

        it.each((['OWNER', 'ADMIN'] as const).map((r) => [r] as const))(
            'lets %s through both layers to the work',
            async (role) => {
                c.usecase.mockResolvedValueOnce(
                    c === COMPOSE_POST
                        ? { ok: true, proposalId: 'prop-1', status: 'PENDING', guardVerdict: 'CLEAN' }
                        : { id: AUDIT, outcome: 'CONCURRED' },
                );
                const res = await call(c, makeRequestContext(role));
                expect(res.status).toBeLessThan(300);
                expect(c.usecase).toHaveBeenCalledTimes(1);
                expect(routeDenials()).toEqual([]);
            },
        );
    });

    it('AI_ADMIN holds the register key, so it passes the sample-audit answer route and the usecase refuses it', async () => {
        const res = await call(SAMPLE_POST, makeRequestContext('AI_ADMIN'));
        expect(res.status).toBe(403);
        expect(SAMPLE_POST.usecase).toHaveBeenCalledTimes(1);
        expect(routeDenials()).toEqual([]);
    });
});

// ─── 3. the declarative map ─────────────────────────────────────────────────

describe('the route-permission map records each route’s gate', () => {
    it.each([...READS, ...WRITES].map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const r = resolveRoutePermission(new URL(`http://localhost${c.path}`).pathname, c.method);
        expect(r && { keys: ([] as string[]).concat(r.permission), mode: r.mode }).toEqual({
            keys: [c.gate],
            mode: 'all',
        });
    });
});
