/**
 * Who a manually requested identity pass acts as, decided when it runs (#4400).
 *
 * The "Run now" routes assert `admin.tenant_lifecycle` when the pass is QUEUED.
 * The pass used to act on that alone, as an ADMIN-shaped context attributed to
 * the requester, so a pass queued by somebody since demoted or removed still
 * ran with full ADMIN under their name. `resolvePassActor` re-reads the
 * requester's membership at run time, through the REAL `context-system`
 * resolution (only Prisma is mocked here), and:
 *
 *   - acts with their real authority when they still hold the key;
 *   - otherwise falls back to the scheduled pass's own context, names nobody,
 *     and says why — never a fabricated ADMIN.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenantMembership: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import {
    PASS_REQUEST_PERMISSION,
    passRequestRecord,
    resolvePassActor,
} from '@/app-layer/usecases/identity-pass-requester';
import { SYSTEM_PRINCIPAL } from '@/app-layer/context-system';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { logger } from '@/lib/observability/logger';

const TENANT = 't1';
const JOB = 'identity-leaver-pass';

function membership(over: Record<string, unknown> = {}) {
    return { role: 'OWNER', status: 'ACTIVE', customRole: null, tenant: { slug: 'acme' }, ...over };
}

function resolve(requestedByUserId?: string) {
    return resolvePassActor({ tenantId: TENANT, job: JOB, requestedByUserId });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('a scheduled pass', () => {
    it('acts as the job, records scheduled, and reads no membership', async () => {
        const { ctx, trigger } = await resolve(undefined);
        expect(trigger).toEqual({ triggeredBy: 'scheduled' });
        expect(ctx.userId).toBe(SYSTEM_PRINCIPAL);
        expect(ctx.actorType).toBe('JOB');
        expect(findUnique).not.toHaveBeenCalled();
        expect(passRequestRecord(trigger)).toBeUndefined();
    });

    it('a blank requester is nobody, not a person called ""', async () => {
        const { ctx, trigger } = await resolve('');
        expect(trigger.triggeredBy).toBe('scheduled');
        expect(ctx.userId).toBe(SYSTEM_PRINCIPAL);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

describe('a requester who still holds the key', () => {
    it("acts with THEIR membership: their role, not a hard-coded ADMIN, and their name", async () => {
        findUnique.mockResolvedValue(membership({ role: 'OWNER' }));

        const { ctx, trigger } = await resolve('user-owner');

        expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId_userId: { tenantId: TENANT, userId: 'user-owner' } },
            }),
        );
        expect(ctx.userId).toBe('user-owner');
        // The fabricated context was ADMIN for everybody. An OWNER is an OWNER.
        expect(ctx.role).toBe('OWNER');
        expect(ctx.appPermissions).toEqual(getPermissionsForRole('OWNER'));
        expect(ctx.appPermissions.admin.tenant_lifecycle).toBe(true);
        // A job did this for them; the trail must not read it as a click.
        expect(ctx.actorType).toBe('JOB');
        expect(ctx.tenantSlug).toBe('acme');
        expect(trigger).toEqual({
            triggeredBy: 'manual',
            requestedByUserId: 'user-owner',
            authority: 'REQUESTER',
        });
        expect(passRequestRecord(trigger)).toEqual({
            requestedByUserId: 'user-owner',
            authority: 'REQUESTER',
        });
    });

    it('a custom role that grants the key is honoured, resolved as a request resolves it', async () => {
        // An ADMIN membership whose custom role grants the key could press the
        // button, so it may run the pass, with the custom role's authority and
        // its base role, not the built-in ADMIN set.
        findUnique.mockResolvedValue(
            membership({
                role: 'ADMIN',
                customRole: { baseRole: 'ADMIN', permissionsJson: { admin: { tenant_lifecycle: true } } },
            }),
        );
        const { ctx, trigger } = await resolve('user-custom');
        expect(ctx.userId).toBe('user-custom');
        expect(ctx.role).toBe('ADMIN');
        expect(ctx.appPermissions.admin.tenant_lifecycle).toBe(true);
        expect(trigger).toMatchObject({ authority: 'REQUESTER' });
    });
});

describe('a requester whose authority is refused at run time', () => {
    // Every refusal lands in the same place: the scheduled pass's own context,
    // which names nobody, and a trigger that still says a person asked.
    function expectJobAuthority(ctx: { userId: string; actorType?: string }) {
        expect(ctx.userId).toBe(SYSTEM_PRINCIPAL);
        expect(ctx.actorType).toBe('JOB');
    }

    it('removed from the tenant (no membership row)', async () => {
        findUnique.mockResolvedValue(null);
        const { ctx, trigger } = await resolve('user-gone');
        expectJobAuthority(ctx);
        expect(ctx.userId).not.toBe('user-gone');
        expect(passRequestRecord(trigger)).toEqual({
            requestedByUserId: 'user-gone',
            authority: 'JOB',
            refusal: 'REQUESTER_NOT_A_MEMBER',
        });
        expect(trigger.triggeredBy).toBe('manual');
    });

    it.each(['DEACTIVATED', 'INVITED', 'REMOVED'])('a %s membership, with the status recorded', async (status) => {
        // Still an OWNER on paper: the status alone refuses.
        findUnique.mockResolvedValue(membership({ role: 'OWNER', status }));
        const { ctx, trigger } = await resolve('user-inactive');
        expectJobAuthority(ctx);
        expect(passRequestRecord(trigger)).toEqual({
            requestedByUserId: 'user-inactive',
            authority: 'JOB',
            refusal: 'REQUESTER_NOT_ACTIVE',
            membershipStatus: status,
        });
    });

    it('demoted to ADMIN, which does not hold the key', async () => {
        // The case the fabricated context hid completely: an ADMIN-shaped
        // context was what the pass ran under for EVERY requester, so a
        // demoted OWNER and a current one were indistinguishable.
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
        findUnique.mockResolvedValue(membership({ role: 'ADMIN' }));
        const { ctx, trigger } = await resolve('user-demoted');
        expectJobAuthority(ctx);
        expect(passRequestRecord(trigger)).toEqual({
            requestedByUserId: 'user-demoted',
            authority: 'JOB',
            refusal: 'REQUESTER_LACKS_PERMISSION',
        });
    });

    it('a custom role that no longer grants the key refuses, as a request would', async () => {
        // The same membership as the custom-role case above, after the role
        // was edited to stop granting the key while the pass sat in the queue.
        findUnique.mockResolvedValue(
            membership({
                role: 'ADMIN',
                customRole: { baseRole: 'ADMIN', permissionsJson: { admin: { tenant_lifecycle: false } } },
            }),
        );
        const { ctx, trigger } = await resolve('user-custom');
        expectJobAuthority(ctx);
        expect(passRequestRecord(trigger)).toMatchObject({ refusal: 'REQUESTER_LACKS_PERMISSION' });
    });

    it('a membership that cannot be read is not authority, and does not throw', async () => {
        // The pass is contracted never to throw, and it resolves its actor
        // before its own try.
        findUnique.mockRejectedValue(new Error('connection reset'));
        const { ctx, trigger } = await resolve('user-x');
        expectJobAuthority(ctx);
        expect(passRequestRecord(trigger)).toEqual({
            requestedByUserId: 'user-x',
            authority: 'JOB',
            refusal: 'REQUESTER_UNRESOLVED',
        });
        expect(logger.error).toHaveBeenCalled();
    });

    it('logs the refusal, because the ladder refusals write no row to carry it', async () => {
        findUnique.mockResolvedValue(null);
        await resolve('user-gone');
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('refused at run time'),
            expect.objectContaining({ tenantId: TENANT, refusal: 'REQUESTER_NOT_A_MEMBER' }),
        );
    });
});

describe('the key asked at run time is the key the routes assert', () => {
    // The routes spell the key literally inside requirePermission, which is the
    // form the permission guardrail reads; the map is held equal to them by
    // that guardrail. Pinning the run-time key to the map closes the loop, so
    // the two checks of one decision cannot drift apart.
    it.each([
        '/api/t/acme/admin/identity-leaver-passes/run',
        '/api/t/acme/admin/identity-joiner-passes/run',
    ])('%s', (path) => {
        expect(resolveRoutePermission(path, 'POST')?.permission).toBe(PASS_REQUEST_PERMISSION);
    });
});
