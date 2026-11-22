/**
 * #5250 — a GitHub pull writes only columns Control actually has.
 *
 * The sync allowlist mapped the branch-protection fields to an
 * `automationResultJson` column that Control has never had, so Prisma refused
 * every pull's update and the control was never touched. The columns are read
 * from the generated client's model, not restated here.
 */
import { Prisma } from '@prisma/client';

const update = jest.fn(async () => ({}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({ control: { update } }),
}));

import { PrismaLocalStore } from '@/app-layer/integrations/prisma-local-store';
import { makeRequestContext } from '../../helpers/make-context';

const CONTROL_COLUMNS = new Set(
    Prisma.dmmf.datamodel.models.find((m) => m.name === 'Control')!.fields.map((f) => f.name),
);

const BRANCH_PROTECTION = {
    protectionEnabled: true,
    requiredReviewCount: 2,
    dismissStaleReviews: true,
    requireCodeOwnerReviews: false,
    enforceAdmins: true,
};

beforeEach(() => update.mockClear());

it('a pull carrying branch-protection fields and a status writes only real Control columns', async () => {
    const changed = await new PrismaLocalStore().applyChanges(makeRequestContext('ADMIN'), 'control', 'c1', {
        ...BRANCH_PROTECTION,
        status: 'IMPLEMENTED',
    });
    expect(update).toHaveBeenCalledTimes(1);
    const data = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toEqual({ status: 'IMPLEMENTED' });
    for (const key of Object.keys(data)) expect(CONTROL_COLUMNS.has(key)).toBe(true);
    expect(changed).toEqual(['status']);
});

it('branch-protection fields alone write nothing, rather than a column Prisma refuses', async () => {
    const changed = await new PrismaLocalStore().applyChanges(makeRequestContext('ADMIN'), 'control', 'c1', BRANCH_PROTECTION);
    expect(update).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
});
