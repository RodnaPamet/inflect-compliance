/**
 * `updateClauseProgress` and its body schema (#4738).
 *
 *   - The status is the ClauseStatus enum: anything else is a validation
 *     error, not a value handed to Prisma to fail as a 500.
 *   - Notes are sanitised as plain text, and an absent `notes` reaches the
 *     repository as `undefined`, so a status-only save keeps the stored notes.
 *   - The audit row does not carry the notes: they are free text, and an
 *     audit row's details stream to the tenant's SIEM.
 */
const mockDb = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const updateProgress = jest.fn();
jest.mock('@/app-layer/repositories/ClauseRepository', () => ({
    ClauseRepository: { updateProgress: (...a: unknown[]) => updateProgress(...a), list: jest.fn() },
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { updateClauseProgress } from '@/app-layer/usecases/clause';
import { UpdateClauseProgressSchema } from '@/lib/schemas';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR');

beforeEach(() => {
    updateProgress.mockReset().mockResolvedValue({ id: 'cp_1', status: 'READY', notes: 'kept' });
    logEvent.mockReset();
});

describe('UpdateClauseProgressSchema', () => {
    it('takes the four clause statuses and refuses anything else', () => {
        for (const status of ['NOT_STARTED', 'IN_PROGRESS', 'READY', 'NEEDS_REVIEW']) {
            expect(UpdateClauseProgressSchema.safeParse({ status }).success).toBe(true);
        }
        expect(UpdateClauseProgressSchema.safeParse({ status: 'DONE' }).success).toBe(false);
        expect(UpdateClauseProgressSchema.safeParse({}).success).toBe(false);
    });
});

describe('updateClauseProgress', () => {
    it('passes absent notes through as undefined, so the stored notes stay', async () => {
        await updateClauseProgress(ctx, 'cl_4', { status: 'READY' });
        expect(updateProgress).toHaveBeenCalledWith(mockDb, ctx, 'cl_4', { status: 'READY', notes: undefined });
    });

    it('sanitises notes before they are stored', async () => {
        await updateClauseProgress(ctx, 'cl_4', { status: 'READY', notes: 'Scope <script>alert(1)</script>agreed' });
        const stored = updateProgress.mock.calls[0][3].notes as string;
        expect(stored).not.toContain('<script>');
        expect(stored).toContain('agreed');
    });

    it('keeps the notes out of the audit row', async () => {
        await updateClauseProgress(ctx, 'cl_4', { status: 'READY', notes: 'Board minutes 2026-10' });
        const row = logEvent.mock.calls[0][2];
        expect(JSON.stringify(row)).not.toContain('Board minutes');
        expect(row.detailsJson).toMatchObject({ category: 'status_change', toStatus: 'READY' });
    });

    it('refuses a role that cannot write', async () => {
        await expect(updateClauseProgress(makeRequestContext('READER'), 'cl_4', { status: 'READY' })).rejects.toThrow();
        expect(updateProgress).not.toHaveBeenCalled();
    });
});
