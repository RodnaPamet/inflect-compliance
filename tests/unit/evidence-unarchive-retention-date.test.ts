/**
 * Evidence its retention date archived comes back only through a new date
 * (#4277, option B).
 *
 * `unarchiveEvidence` cleared `isArchived` and nothing else, so `expiredAt`
 * stayed set: the row stayed in the Archived view (the Active view requires
 * `expiredAt: null`) marked Expired, and the nightly sweep archived it again
 * while its retention date was still past. Setting a new retention date did not
 * clear `expiredAt` either, so there was no way back at all.
 *
 *   - saving an empty or future retention date clears `expiredAt`;
 *   - unarchive refuses while the retention date has passed, with a typed
 *     409 the page shows ("set a new retention date first");
 *   - otherwise unarchive clears `expiredAt` too, so the row returns to the
 *     active list.
 *
 * Mocks mirror tests/unit/evidence-retention-usecase.test.ts.
 */
type Row = Record<string, unknown>;
const mockDb = {
    evidence: {
        findFirst: jest.fn<Promise<Row | null>, [unknown]>(),
        update: jest.fn<Promise<Row>, [{ where: unknown; data: Row }]>(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/jobs/retention', () => ({ runEvidenceRetentionSweep: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn() }));

import { unarchiveEvidence, updateEvidenceRetention } from '@/app-layer/usecases/evidence-retention';
import { ConflictError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

const editor = makeRequestContext('EDITOR');
const DAY = 86_400_000;
const past = () => new Date(Date.now() - 10 * DAY);
const future = () => new Date(Date.now() + 10 * DAY);

function written(): Row {
    const call = mockDb.evidence.update.mock.calls[0];
    if (!call) throw new Error('nothing was written');
    return call[0].data;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.evidence.update.mockImplementation(async ({ data }) => ({ id: 'ev-1', ...data }));
});

describe('setting a retention date', () => {
    const expiredRow = () => ({
        id: 'ev-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        retentionPolicy: 'FIXED_DATE',
        retentionDays: null,
        retentionUntil: past(),
        expiredAt: past(),
        isArchived: true,
    });

    it('a future date clears the expiry stamp', async () => {
        mockDb.evidence.findFirst.mockResolvedValue(expiredRow());
        await updateEvidenceRetention(editor, 'ev-1', { retentionUntil: future().toISOString() });
        expect(written().expiredAt).toBeNull();
    });

    it('clearing the date clears the expiry stamp', async () => {
        mockDb.evidence.findFirst.mockResolvedValue(expiredRow());
        await updateEvidenceRetention(editor, 'ev-1', { retentionUntil: null, retentionPolicy: 'NONE' });
        expect(written().expiredAt).toBeNull();
    });

    it('a past date leaves it — the row has expired', async () => {
        mockDb.evidence.findFirst.mockResolvedValue(expiredRow());
        await updateEvidenceRetention(editor, 'ev-1', { retentionUntil: past().toISOString() });
        expect('expiredAt' in written()).toBe(false);
    });

    it('a change that sets no date leaves it', async () => {
        mockDb.evidence.findFirst.mockResolvedValue(expiredRow());
        await updateEvidenceRetention(editor, 'ev-1', { retentionPolicy: 'FIXED_DATE' });
        expect('expiredAt' in written()).toBe(false);
    });
});

describe('unarchiving', () => {
    it('refuses while the retention date has passed, with a typed 409 naming the way back', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({
            id: 'ev-1', title: 'X', isArchived: true, retentionUntil: past(), expiredAt: past(),
        });
        const err = await unarchiveEvidence(editor, 'ev-1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).status).toBe(409);
        expect((err as ConflictError).message).toMatch(/set a new retention date first/i);
        expect((err as ConflictError).details).toEqual({ reason: 'RETENTION_DATE_PASSED' });
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
    });

    it('with the date moved ahead, unarchives and clears the expiry stamp', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({
            id: 'ev-1', title: 'X', isArchived: true, retentionUntil: future(), expiredAt: past(),
        });
        await unarchiveEvidence(editor, 'ev-1');
        expect(written()).toEqual({ isArchived: false, expiredAt: null });
    });

    it('evidence archived by hand, with no retention date, still unarchives', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({
            id: 'ev-1', title: 'X', isArchived: true, retentionUntil: null, expiredAt: null,
        });
        await unarchiveEvidence(editor, 'ev-1');
        expect(written()).toEqual({ isArchived: false, expiredAt: null });
    });
});
