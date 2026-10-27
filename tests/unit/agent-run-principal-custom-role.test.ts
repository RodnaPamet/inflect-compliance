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
    tenantApiKey: { findFirst: jest.fn() },
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

beforeEach(() => jest.clearAllMocks());

describe('the run carries the custom role a request from its principal carries', () => {
    it('a custom role withholding risks.edit withholds it from the run', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { risks: { ...EDITOR.risks, edit: false } } },
        });

        const ctx = await rebuildRunContext(RUN);

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

        const ctx = await rebuildRunContext(RUN);

        expect(ctx?.role).toBe('READER');
        expect(ctx?.appPermissions).toEqual(getPermissionsForRole('READER'));
        expect(ctx?.permissions).toEqual(computePermissions('READER'));
    });
});

describe('a built-in role is rebuilt as a request resolves it', () => {
    it('EDITOR gets exactly what a request from it gets', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });

        const ctx = await rebuildRunContext(RUN);

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
        await expect(rebuildRunContext(RUN)).resolves.toBeNull();
        expect(db.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-A', userId: 'user-1', status: 'ACTIVE' } }),
        );
    });

    it('a revoked or lapsed key, no context', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });
        db.tenantApiKey.findFirst.mockResolvedValue(null);
        await expect(rebuildRunContext({ ...RUN, triggeredViaKeyId: 'key-1' })).resolves.toBeNull();
    });
});

/**
 * A run a KEY started is narrowed by that key, not merely tagged with it
 * (#4386).
 *
 * `rebuildRunContext` already re-read the key and failed closed on a revoked or
 * lapsed one — that half was right. What it did not do was make the scopes
 * AUTHORITY: role, coarse flags and granular set all came from the membership,
 * and `apiKeyScopes` rode along on the context. So the key bound only where
 * something happened to read that array, and a step calling a usecase directly
 * ran with everything the member may do.
 */
describe('a run started with a key holds the key AND the membership', () => {
    const KEY_RUN = { ...RUN, triggeredViaKeyId: 'key-1' };
    const liveKey = (scopes: string[]) => ({ scopes });

    it('withholds what the KEY does not carry, though the member does', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });
        db.tenantApiKey.findFirst.mockResolvedValue(liveKey(['risks:read']));

        const ctx = await rebuildRunContext(KEY_RUN);

        // The member is a full EDITOR and may edit risks; this key may not.
        expect(EDITOR.risks.edit).toBe(true);
        expect(ctx?.appPermissions.risks.edit).toBe(false);
        expect(ctx?.appPermissions.risks.view).toBe(true);
        // A read-only key implies READER, which is lower than EDITOR.
        expect(ctx?.role).toBe('READER');
        expect(ctx?.permissions.canWrite).toBe(false);
        // Still says which key, as it did before.
        expect(ctx?.apiKeyId).toBe('key-1');
        expect(ctx?.apiKeyScopes).toEqual(['risks:read']);
    });

    it('withholds what the MEMBER does not carry, though the key is wide open', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({
            role: 'EDITOR',
            customRole: { baseRole: 'EDITOR', permissionsJson: { risks: { ...EDITOR.risks, edit: false } } },
        });
        db.tenantApiKey.findFirst.mockResolvedValue(liveKey(['*']));

        const ctx = await rebuildRunContext(KEY_RUN);

        expect(ctx?.appPermissions.risks.edit).toBe(false);
    });

    it('keeps what BOTH carry', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });
        db.tenantApiKey.findFirst.mockResolvedValue(liveKey(['risks:write']));

        const ctx = await rebuildRunContext(KEY_RUN);

        expect(ctx?.appPermissions.risks.edit).toBe(true);
        expect(ctx?.role).toBe('EDITOR');
    });

    it('treats malformed scopes as none, so a bad value narrows rather than widens', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });
        db.tenantApiKey.findFirst.mockResolvedValue({ scopes: 'not-an-array' });

        const ctx = await rebuildRunContext(KEY_RUN);

        expect(ctx?.apiKeyScopes).toEqual([]);
        expect(ctx?.role).toBe('READER');
        expect(ctx?.appPermissions.risks.view).toBe(false);
    });

    it('requires the key\'s TENANT to be live, which the query did not check', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });
        db.tenantApiKey.findFirst.mockResolvedValue(liveKey(['risks:write']));

        await rebuildRunContext(KEY_RUN);

        // A soft-deleted tenant does NOT revoke its keys, so the predicate is
        // the only thing standing between an offboarded customer and a queued
        // run resuming on their credential.
        expect(db.tenantApiKey.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenant: { deletedAt: null } }),
            }),
        );
    });

    it('leaves a run with no key exactly as it was', async () => {
        db.tenantMembership.findFirst.mockResolvedValue({ role: 'EDITOR', customRole: null });

        const ctx = await rebuildRunContext(RUN);

        expect(db.tenantApiKey.findFirst).not.toHaveBeenCalled();
        expect(ctx?.appPermissions).toEqual(EDITOR);
        expect(ctx).not.toHaveProperty('apiKeyId');
    });
});
