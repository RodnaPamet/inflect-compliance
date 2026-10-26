/**
 * A queued workflow run started with an API KEY runs as the key and its
 * principal, not as the principal with the key's scopes carried beside it
 * (#4386).
 *
 * `rebuildRunContext` re-read `triggeredViaKeyId` and stopped on a revoked or
 * expired key, but built the run's role and permissions from the MEMBER alone.
 * The scopes bound only where something called `enforceApiKeyScope`; every
 * permission key, coarse policy and redaction rule the tool funnel applies on
 * the `ctx` basis, and every usecase a tool calls, read the member's whole
 * authority. The funnel did not narrow it — it intersects with the principal,
 * and the member ∧ the member is the member — and the run did not carry the
 * key's own autonomy ceiling at all.
 *
 * Now the key is resolved by `resolveKeyInitiatorContext` (#4382): the request
 * tail, intersected with the member. These tests hold the run to what a REST
 * request and an `/api/mcp` request with the same key hold, by building those
 * contexts with the request's own resolvers and comparing.
 */
const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findUnique: jest.fn() },
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

// The run row, the agent check and the session path's membership read go
// through `runInGlobalContext`; the key path reads through `@/lib/prisma`, as
// a request does.
const db = {
    workflowRun: { findFirst: jest.fn() },
    registeredAgent: { findFirst: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
};
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInGlobalContext: (fn: (d: unknown) => unknown) => fn(db),
}));

const failRunMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/lib/agentic/drivers/run-settlement', () => ({
    ...jest.requireActual('@/lib/agentic/drivers/run-settlement'),
    failRun: (...a: unknown[]) => failRunMock(...a),
}));

jest.mock('@/lib/agentic/workflow-registry', () => ({
    ...jest.requireActual('@/lib/agentic/workflow-registry'),
    getWorkflowDefinition: () => ({ key: 'posture-review', steps: [] }),
}));

// The AUTHZ_DENIED row an agent-bound key whose principal left writes.
const mockAppendAuditEntry = jest.fn(async (_entry: unknown) => undefined);
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntry: (entry: unknown) => mockAppendAuditEntry(entry),
}));

import { executeQueuedWorkflowRun, rebuildRunContext } from '@/app-layer/usecases/workflow-runs';
import { resolveApiKeyById } from '@/lib/auth/api-key-auth';
import { resolveAgentAuthority } from '@/lib/agentic/agent-authority';
import { getPermissionsForRole, PERMISSION_SCHEMA, type PermissionSet } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const RUN = { tenantId: 'tenant-A', startedByUserId: 'user-1', triggeredViaKeyId: 'key-1', agentId: 'agent-1' };

/** A Flue agent's key: it may drive a run and read risks, and nothing else. */
const AGENT_SCOPES = ['mcp:orchestrate', 'mcp:read', 'mcp:propose', 'risks:read'];

function keyRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'key-1',
        tenantId: 'tenant-A',
        name: 'agent key',
        keyPrefix: 'iflk_abcd',
        keyHash: 'h'.repeat(64),
        scopes: AGENT_SCOPES,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'user-1',
        agentId: 'agent-1',
        maxAutonomyLevel: 2,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        tenant: { id: 'tenant-A', slug: 'acme', deletedAt: null },
        ...overrides,
    };
}

/** Membership rows in the shapes each reader selects. */
function asMember(role: string) {
    prismaMock.tenantMembership.findFirst.mockResolvedValue({ role, customRole: null });
    prismaMock.tenantMembership.findUnique.mockResolvedValue({ role, status: 'ACTIVE', customRole: null });
    db.tenantMembership.findFirst.mockResolvedValue({ role, customRole: null });
}

function okCtx(r: Awaited<ReturnType<typeof rebuildRunContext>>): RequestContext {
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.ctx;
}

/** Every granular flag the set holds. */
function granted(set: PermissionSet): string[] {
    const out: string[] = [];
    for (const [domain, actions] of Object.entries(PERMISSION_SCHEMA)) {
        for (const action of actions) {
            if ((set as unknown as Record<string, Record<string, boolean>>)[domain]?.[action]) out.push(`${domain}.${action}`);
        }
    }
    return out;
}

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
    prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow());
    prismaMock.tenantApiKey.update.mockResolvedValue({});
    // The principal is an OWNER, so every narrowing below is the KEY's.
    asMember('OWNER');
});

describe('the key bounds the run: what the key lacks, the run lacks', () => {
    it('an OWNER\'s risks:read agent key runs as a READER that can read risks and edit nothing', async () => {
        const ctx = okCtx(await rebuildRunContext(RUN));

        expect(ctx.role).toBe('READER');
        expect(ctx.permissions.canWrite).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(ctx.appPermissions.risks.view).toBe(true);
        // The member may do all of these; the key may not, so the run may not.
        expect(ctx.appPermissions.risks.edit).toBe(false);
        expect(ctx.appPermissions.controls.view).toBe(false);
        expect(ctx.appPermissions.admin.manage).toBe(false);
    });

    it('carries the key\'s own autonomy ceiling, which the run used to drop', async () => {
        const ctx = okCtx(await rebuildRunContext(RUN));
        expect(ctx.apiKeyMaxAutonomy).toBe(2);
    });

    it('a member narrower than the key narrows it too: a READER\'s `*` key runs as a READER', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['*'], agentId: null }));
        asMember('READER');

        const ctx = okCtx(await rebuildRunContext({ ...RUN, agentId: null }));

        expect(ctx.role).toBe('READER');
        expect(ctx.appPermissions).toEqual(getPermissionsForRole('READER'));
    });
});

describe('the run never holds more than a request with the same key', () => {
    it.each([
        ['an agent-bound key of an OWNER', keyRow(), 'OWNER'],
        ['an agent-bound key of an EDITOR', keyRow(), 'EDITOR'],
        ['an agent-bound `*` key of a READER', keyRow({ scopes: ['*'] }), 'READER'],
        ['a plain `*` key of an EDITOR', keyRow({ scopes: ['*'], agentId: null }), 'EDITOR'],
        ['a plain evidence key of an ADMIN', keyRow({ scopes: ['evidence:write', 'mcp:orchestrate'], agentId: null }), 'ADMIN'],
    ])('%s', async (_label, row, role) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);
        asMember(role);
        const runCtx = okCtx(await rebuildRunContext({ ...RUN, agentId: (row as { agentId: string | null }).agentId }));

        // A REST request with the key: the request's own resolver.
        const request = await resolveApiKeyById('key-1');
        if (!request.valid) throw new Error('request refused');
        const requestGrants = new Set(granted(request.ctx.appPermissions));
        for (const g of granted(runCtx.appPermissions)) expect(requestGrants).toContain(g);
        for (const flag of ['canRead', 'canWrite', 'canAdmin', 'canAudit', 'canExport'] as const) {
            if (runCtx.permissions[flag]) expect(request.ctx.permissions[flag]).toBe(true);
        }

        // An `/api/mcp` request with the key: what its tool calls run on is
        // the principal ∧ the request context, and the run's tool calls are
        // the same intersection over the run's context. Equal, not merely
        // narrower — the funnel now sees what it sees for a live call.
        const live = (await resolveAgentAuthority(request.ctx)).ctx;
        const run = (await resolveAgentAuthority(runCtx)).ctx;
        expect(run.role).toBe(live.role);
        expect(run.permissions).toEqual(live.permissions);
        expect(run.appPermissions).toEqual(live.appPermissions);
        expect(run.apiKeyScopes).toEqual(live.apiKeyScopes);
        expect(run.apiKeyMaxAutonomy).toBe(live.apiKeyMaxAutonomy);
    });
});

describe('a key that no longer authorises a request stops the run, by name', () => {
    it.each([
        ['revoked', keyRow({ revokedAt: new Date('2026-10-01') })],
        ['expired', keyRow({ expiresAt: new Date('2020-01-01') })],
        ['not_found', null],
        ['tenant_deleted', keyRow({ tenant: { id: 'tenant-A', slug: 'acme', deletedAt: new Date('2026-10-01') } })],
        ['other_tenant', keyRow({ tenantId: 'tenant-B', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } })],
        ['other_user', keyRow({ createdById: 'someone-else' })],
    ])('%s', async (reason, row) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);
        await expect(rebuildRunContext(RUN)).resolves.toEqual({ ok: false, reason });
        // The key is read by id, through the request's tail.
        expect(prismaMock.tenantApiKey.findUnique).toHaveBeenCalledWith({
            where: { id: 'key-1' },
            include: { tenant: true },
        });
    });

    it('an agent-bound key whose principal left keeps the membership refusal, with the denial a request writes', async () => {
        prismaMock.tenantMembership.findUnique.mockResolvedValue(null);
        await expect(rebuildRunContext(RUN)).resolves.toEqual({ ok: false, reason: 'principal_not_a_member' });
        // The request tail refused it as `principal_unresolved`, and wrote the
        // row a request with this key would.
        expect(mockAppendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'AUTHZ_DENIED', entityId: 'key-1' }),
        );
    });

    it('a plain key whose principal left keeps the membership refusal and its message', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ agentId: null }));
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(rebuildRunContext({ ...RUN, agentId: null })).resolves.toEqual({
            ok: false,
            reason: 'principal_not_a_member',
        });
    });

    describe('the worker settles the run FAILED with the reason', () => {
        beforeEach(() => {
            db.workflowRun.findFirst.mockResolvedValue({
                id: 'run-1', tenantId: 'tenant-A', workflowKey: 'posture-review', status: 'RUNNING',
                startedByUserId: 'user-1', triggeredViaKeyId: 'key-1', agentId: 'agent-1',
                stepCount: 0, startedAt: new Date('2026-10-26T10:00:00Z'),
            });
            db.registeredAgent.findFirst.mockResolvedValue({ id: 'agent-1' });
        });

        it('a revoked key', async () => {
            prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: new Date('2026-10-01') }));

            await expect(executeQueuedWorkflowRun('tenant-A', 'run-1')).resolves.toEqual({
                skipped: 'API_KEY_REFUSED:revoked',
            });
            expect(failRunMock).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-A', userId: 'user-1' }),
                'run-1',
                'run_api_key_no_longer_authorised: the API key this run was started with is refused (revoked), so the run does not continue on it.',
            );
        });

        it('an expired key', async () => {
            prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ expiresAt: new Date('2020-01-01') }));

            await expect(executeQueuedWorkflowRun('tenant-A', 'run-1')).resolves.toEqual({
                skipped: 'API_KEY_REFUSED:expired',
            });
            expect(failRunMock.mock.calls[0][2]).toMatch(/refused \(expired\)/);
        });

        it('the agent-in-service check still comes first', async () => {
            db.registeredAgent.findFirst.mockResolvedValue(null);

            await expect(executeQueuedWorkflowRun('tenant-A', 'run-1')).resolves.toEqual({ skipped: 'AGENT_NOT_ACTIVE' });
            expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        });

        it('a key-started run whose member left keeps the membership message and code', async () => {
            prismaMock.tenantMembership.findUnique.mockResolvedValue(null);

            await expect(executeQueuedWorkflowRun('tenant-A', 'run-1')).resolves.toEqual({ skipped: 'PRINCIPAL_REVOKED' });
            expect(failRunMock.mock.calls[0][2]).toBe(
                'run_principal_no_longer_authorised: the principal that started this run ' +
                    'no longer holds an active membership in this workspace.',
            );
        });

        it('a session-started run whose member left keeps its message and code', async () => {
            db.workflowRun.findFirst.mockResolvedValue({
                id: 'run-1', tenantId: 'tenant-A', workflowKey: 'posture-review', status: 'RUNNING',
                startedByUserId: 'user-1', triggeredViaKeyId: null, agentId: 'agent-1',
                stepCount: 0, startedAt: new Date('2026-10-26T10:00:00Z'),
            });
            db.tenantMembership.findFirst.mockResolvedValue(null);

            await expect(executeQueuedWorkflowRun('tenant-A', 'run-1')).resolves.toEqual({ skipped: 'PRINCIPAL_REVOKED' });
            expect(failRunMock.mock.calls[0][2]).toBe(
                'run_principal_no_longer_authorised: the principal that started this run ' +
                    'no longer holds an active membership in this workspace.',
            );
            expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        });
    });
});

describe('a key with what the run needs runs it', () => {
    it('as the key and its principal, on the run\'s own agent binding, without stamping the key as used', async () => {
        const ctx = okCtx(await rebuildRunContext(RUN));

        expect(ctx).toMatchObject({
            requestId: 'agent-run-tenant-A-user-1',
            userId: 'user-1',
            tenantId: 'tenant-A',
            apiKeyId: 'key-1',
            apiKeyScopes: AGENT_SCOPES,
            agentId: 'agent-1',
        });
        expect(ctx).not.toHaveProperty('actorType');
        expect(prismaMock.tenantApiKey.update).not.toHaveBeenCalled();
    });

    it('keeps the RUN\'s agent, not the key\'s, when the two differ', async () => {
        // An interactive run binds the designated agent over the caller's key.
        const ctx = okCtx(await rebuildRunContext({ ...RUN, agentId: 'interactive-agent' }));
        expect(ctx.agentId).toBe('interactive-agent');
    });
});

describe('a run with no key id is rebuilt exactly as before', () => {
    it('never reads a key and holds the member\'s whole authority', async () => {
        const ctx = okCtx(await rebuildRunContext({ ...RUN, triggeredViaKeyId: null }));

        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(ctx).toEqual({
            requestId: 'agent-run-tenant-A-user-1',
            userId: 'user-1',
            tenantId: 'tenant-A',
            role: 'OWNER',
            permissions: computePermissions('OWNER'),
            appPermissions: getPermissionsForRole('OWNER'),
            agentId: 'agent-1',
        });
    });
});
