/**
 * A queued workflow run is rebuilt with its principal's CUSTOM role (#4362).
 *
 * `rebuildRunContext` re-reads the principal's membership so a revoked one
 * stops the run, and then built the run's authority from
 * `getPermissionsForRole(membership.role)` — so a custom role was ignored by
 * every segment the worker executed. A request from that principal is built
 * from the custom role, and so is the run that request started, which is the
 * principal's term of every tool call's intersection.
 */
const db = {
    tenantMembership: { findFirst: jest.fn() },
};
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInGlobalContext: (fn: (d: unknown) => unknown) => fn(db),
}));

import { rebuildRunContext } from '@/app-layer/usecases/workflow-runs';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';

const EDITOR = getPermissionsForRole('EDITOR');

const RUN = { tenantId: 'tenant-A', startedByUserId: 'user-1', triggeredViaKeyId: null, agentId: 'agent-1' };

/** The rebuilt context, or `undefined` when the rebuild refused. */
async function rebuild(row: Parameters<typeof rebuildRunContext>[0]) {
    const r = await rebuildRunContext(row);
    return r.ok ? r.ctx : undefined;
}

beforeEach(() => jest.clearAllMocks());

describe('the run carries the custom role a request from its principal carries', () => {
    it('a custom role withholding risks.edit withholds it from the run', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { risks: { ...EDITOR.risks, edit: false } } },
        });

        const ctx = await rebuild(RUN);

        expect(ctx?.appPermissions.risks.edit).toBe(false);
        expect(ctx?.appPermissions.risks.view).toBe(true);
        expect(ctx?.role).toBe('EDITOR');
        expect(ctx?.permissions).toEqual(computePermissions('EDITOR'));
        expect(ctx?.agentId).toBe('agent-1');
    });

    it('an ADMIN membership carrying a READER-based custom role runs as that READER base', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({
            role: 'ADMIN',
            customRole: { baseRole: 'READER', permissionsJson: {} },
        });

        const ctx = await rebuild(RUN);

        expect(ctx?.role).toBe('READER');
        expect(ctx?.appPermissions).toEqual(getPermissionsForRole('READER'));
        expect(ctx?.permissions).toEqual(computePermissions('READER'));
    });
});

describe('a built-in role is rebuilt as a request resolves it', () => {
    it('EDITOR gets exactly what a request from it gets', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });

        const ctx = await rebuild(RUN);

        expect(ctx).toEqual({
            requestId: 'agent-run-tenant-A-user-1',
            userId: 'user-1',
            tenantId: 'tenant-A',
            role: 'EDITOR',
            // A request's coarse flags (owner decision, 2026-10-26): the run
            // used to project them from the granular set, which gave EDITOR a
            // `canAudit` its own request does not hold.
            permissions: computePermissions('EDITOR'),
            appPermissions: EDITOR,
            agentId: 'agent-1',
        });
    });
});

describe('the refusals are unchanged', () => {
    it('no ACTIVE membership, no context', async () => {
        db.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(rebuildRunContext(RUN)).resolves.toEqual({ ok: false, reason: 'principal_not_a_member' });
        expect(db.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-A', userId: 'user-1', status: 'ACTIVE' } }),
        );
    });

    // A revoked or lapsed key, and every other key refusal, is held in
    // `agent-run-api-key-authority.test.ts`: since #4386 the key is resolved
    // through the request's own tail rather than read here.
});
