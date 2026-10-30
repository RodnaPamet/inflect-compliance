/**
 * Reads that serve only admin surfaces assert the key their API route holds.
 *
 * The admin pages render these reads server-side, past no `requirePermission`,
 * so the route gate is not in front of them there. Each page gates itself now
 * (`gateAdminPage`); this is the second layer, in the usecase, so a future
 * caller that skips both the route and the page gate still cannot read:
 *
 *   listEmployees / listDevices / listTrainingAssignments → `personnel.view`
 *       (`GET /personnel`, `/devices`, `/training`)
 *   getTrustCenter → `admin.manage` (`GET /admin/trust-center`)
 *
 * `personnel.view` is held by OWNER and ADMIN only (owner decision,
 * 2026-10-29), so the three people-layer reads refuse every other built-in
 * role, and a custom role that switches the key off. `admin.manage` is OWNER
 * and ADMIN.
 *
 * Each refusal must come BEFORE the database is touched.
 */
const runInTenantContextMock = jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (ctx: unknown, fn: (db: unknown) => unknown) => runInTenantContextMock(ctx, fn),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const mockDb = {
    employee: { findMany: jest.fn(async () => []) },
    device: { findMany: jest.fn(async () => []) },
    trainingAssignment: { findMany: jest.fn(async () => []) },
    trustCenter: { findUnique: jest.fn(async () => null) },
};

import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { listEmployees } from '@/app-layer/usecases/personnel';
import { listDevices } from '@/app-layer/usecases/device';
import { listTrainingAssignments } from '@/app-layer/usecases/training';
import { getTrustCenter } from '@/app-layer/usecases/trust-center';

/** A built-in ADMIN whose stored custom role switched `personnel.view` off. */
function adminWithoutPersonnelView(): RequestContext {
    const set = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', { appPermissions: { ...set, personnel: { ...set.personnel, view: false } } });
}

beforeEach(() => {
    runInTenantContextMock.mockClear();
    for (const model of Object.values(mockDb)) {
        for (const fn of Object.values(model)) fn.mockClear();
    }
});

describe.each([
    ['listEmployees', (ctx: RequestContext) => listEmployees(ctx), mockDb.employee.findMany],
    ['listDevices', (ctx: RequestContext) => listDevices(ctx), mockDb.device.findMany],
    ['listTrainingAssignments', (ctx: RequestContext) => listTrainingAssignments(ctx), mockDb.trainingAssignment.findMany],
])('%s asserts personnel.view', (_name, read, query) => {
    test('without the key it refuses before any query', async () => {
        await expect(read(adminWithoutPersonnelView())).rejects.toMatchObject({ status: 403 });
        expect(runInTenantContextMock).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });

    test.each(['OWNER', 'ADMIN'])(
        'a built-in %s holds it and reads, as through the route',
        async (role) => {
            await read(makeRequestContext(role));
            expect(query).toHaveBeenCalledTimes(1);
        },
    );

    test.each(['EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'])(
        'a built-in %s does not hold it and is refused before any query',
        async (role) => {
            await expect(read(makeRequestContext(role))).rejects.toMatchObject({ status: 403 });
            expect(runInTenantContextMock).not.toHaveBeenCalled();
            expect(query).not.toHaveBeenCalled();
        },
    );
});

describe('getTrustCenter asserts admin.manage', () => {
    test.each(['EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'])('a %s is refused before any query', async (role) => {
        await expect(getTrustCenter(makeRequestContext(role))).rejects.toMatchObject({ status: 403 });
        expect(runInTenantContextMock).not.toHaveBeenCalled();
        expect(mockDb.trustCenter.findUnique).not.toHaveBeenCalled();
    });

    test.each(['OWNER', 'ADMIN'])('an %s reads the compose row', async (role) => {
        await getTrustCenter(makeRequestContext(role));
        expect(mockDb.trustCenter.findUnique).toHaveBeenCalledTimes(1);
    });
});
