/**
 * `updateControl` — two defects that shared a root cause: the usecase drew
 * conclusions from the REQUEST BODY instead of from the data.
 *
 * 1. `changedFields` was `Object.keys(data)`, so the audit trail recorded
 *    which UI the user opened rather than what they changed. The detail page
 *    PATCHes 10 fields and ControlEditPanel PATCHes 3 — so editing one field
 *    through the detail page logged nine unchanged fields as "changed", and
 *    the same edit through the panel logged a different set entirely.
 *
 * 2. `nextDueAt` is computed from `frequency` at attest time only. Editing
 *    the frequency left the stored due date derived from the SUPERSEDED
 *    value, so [nextDueAt]-driven scheduling and the controlsDueSoon
 *    dashboard count ran on a stale date until the next test completed.
 */

const mockDb = {
    control: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
} as unknown as Record<string, Record<string, jest.Mock>>;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn() }));

const repoUpdate = jest.fn();
const repoGetById = jest.fn();
jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        update: (...a: unknown[]) => repoUpdate(...a),
        getById: (...a: unknown[]) => repoGetById(...a),
    },
}));
jest.mock('@/app-layer/policies/control.policies', () => ({
    assertCanUpdateControl: jest.fn(),
    assertCanReadControl: jest.fn(),
    assertCanCreateControl: jest.fn(),
    assertCanDeleteControl: jest.fn(),
}));
jest.mock('@/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('@/lib/billing/entitlements', () => ({ assertWithinLimit: jest.fn() }));
jest.mock('@/app-layer/notifications/assignment', () => ({ createAssignmentNotification: jest.fn() }));
jest.mock('@/lib/observability/business-metrics', () => ({ recordControlCreated: jest.fn() }));

import { logEvent } from '@/app-layer/events/audit';
import { updateControl } from '@/app-layer/usecases/control/mutations';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** The audit row's changedFields for the last logEvent call. */
function loggedChangedFields(): string[] {
    const calls = (logEvent as jest.Mock).mock.calls;
    const last = calls[calls.length - 1];
    return last[2].detailsJson.changedFields;
}

beforeEach(() => {
    jest.clearAllMocks();
    repoUpdate.mockResolvedValue({ id: 'c-1', tenantId: ctx.tenantId });
});

describe('changedFields is diffed, not read off the request body', () => {
    it('records only the field that actually changed', async () => {
        repoGetById.mockResolvedValue({
            id: 'c-1',
            name: 'Old name',
            category: 'Access',
            frequency: 'QUARTERLY',
        });

        // A detail-page-shaped body: many fields, one of them different.
        await updateControl(ctx, 'c-1', {
            name: 'New name',
            category: 'Access',
            frequency: 'QUARTERLY',
        } as never);

        expect(loggedChangedFields()).toEqual(['name']);
    });

    it('records nothing when a wide body changes nothing', async () => {
        // The clearest statement of the defect: opening the detail page,
        // touching nothing, and saving used to log ten changed fields.
        repoGetById.mockResolvedValue({
            id: 'c-1',
            name: 'Same',
            category: 'Access',
            frequency: 'QUARTERLY',
        });

        await updateControl(ctx, 'c-1', {
            name: 'Same',
            category: 'Access',
            frequency: 'QUARTERLY',
        } as never);

        expect(loggedChangedFields()).toEqual([]);
    });

    it('is independent of which UI sent the body', async () => {
        // Same real change, two body shapes → the same audit record.
        repoGetById.mockResolvedValue({ id: 'c-1', name: 'Old', category: 'A', frequency: 'MONTHLY' });
        await updateControl(ctx, 'c-1', { name: 'New' } as never);
        const fromPanel = loggedChangedFields();

        jest.clearAllMocks();
        repoUpdate.mockResolvedValue({ id: 'c-1', tenantId: ctx.tenantId });
        repoGetById.mockResolvedValue({ id: 'c-1', name: 'Old', category: 'A', frequency: 'MONTHLY' });
        await updateControl(ctx, 'c-1', {
            name: 'New',
            category: 'A',
            frequency: 'MONTHLY',
        } as never);
        const fromDetailPage = loggedChangedFields();

        expect(fromDetailPage).toEqual(fromPanel);
    });
});

describe('nextDueAt is recomputed when frequency changes', () => {
    it('recomputes on a frequency change', async () => {
        repoGetById.mockResolvedValue({ id: 'c-1', frequency: 'ANNUALLY' });

        await updateControl(ctx, 'c-1', { frequency: 'MONTHLY' } as never);

        // A second update call carrying the recomputed date.
        const cadenceWrite = repoUpdate.mock.calls.find(
            (c) => c[3] && Object.prototype.hasOwnProperty.call(c[3], 'nextDueAt'),
        );
        expect(cadenceWrite).toBeDefined();
        expect(cadenceWrite![3].nextDueAt).toBeInstanceOf(Date);
    });

    it('does NOT recompute when frequency is unchanged', async () => {
        // Rewriting nextDueAt on an unrelated edit would silently push the
        // due date forward every time someone renamed a control.
        repoGetById.mockResolvedValue({ id: 'c-1', frequency: 'MONTHLY' });

        await updateControl(ctx, 'c-1', { name: 'Renamed', frequency: 'MONTHLY' } as never);

        const cadenceWrite = repoUpdate.mock.calls.find(
            (c) => c[3] && Object.prototype.hasOwnProperty.call(c[3], 'nextDueAt'),
        );
        expect(cadenceWrite).toBeUndefined();
    });

    it('does NOT recompute when frequency is absent from the body', async () => {
        repoGetById.mockResolvedValue({ id: 'c-1', frequency: 'MONTHLY' });

        await updateControl(ctx, 'c-1', { name: 'Renamed' } as never);

        const cadenceWrite = repoUpdate.mock.calls.find(
            (c) => c[3] && Object.prototype.hasOwnProperty.call(c[3], 'nextDueAt'),
        );
        expect(cadenceWrite).toBeUndefined();
    });
});
