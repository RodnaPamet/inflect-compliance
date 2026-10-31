/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/clause.ts`.
 *
 * Tiny file — two functions over ClauseRepository. The Q1 Compliance
 * core EXEMPTION can shrink by one after this lands.
 *
 * Covers:
 *   - listClauses — repository delegation under the read gate.
 *   - updateClauseProgress — repository delegation, status_change
 *     audit shape (fromStatus: null + toStatus: data.status + reason
 *     fallback from notes), write gate.
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ClauseRepository', () => ({
    ClauseRepository: {
        list: jest.fn(),
        updateProgress: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { ClauseRepository } from '@/app-layer/repositories/ClauseRepository';
import { logEvent } from '@/app-layer/events/audit';
import { listClauses, updateClauseProgress } from '@/app-layer/usecases/clause';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── listClauses ───────────────────────────────────────────────────

describe('listClauses', () => {
    it('returns rows from ClauseRepository.list', async () => {
        (ClauseRepository.list as jest.Mock).mockResolvedValue([{ id: 'cl-1' }]);
        const rows = await listClauses(readerCtx);
        expect(rows).toEqual([{ id: 'cl-1' }]);
        expect(ClauseRepository.list).toHaveBeenCalledWith(mockDb, readerCtx);
    });
});

// ─── updateClauseProgress ──────────────────────────────────────────

describe('updateClauseProgress', () => {
    it('forwards status + notes to the repository and emits status_change audit', async () => {
        (ClauseRepository.updateProgress as jest.Mock).mockResolvedValue({ id: 'cp-1' });

        const res = await updateClauseProgress(editorCtx, 'cl-1', {
            status: 'IN_PROGRESS', notes: 'work started',
        } as any);

        expect(res).toEqual({ id: 'cp-1' });
        expect(ClauseRepository.updateProgress).toHaveBeenCalledWith(
            mockDb, editorCtx, 'cl-1', { status: 'IN_PROGRESS', notes: 'work started' },
        );

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('UPDATE');
        expect(payload.entityType).toBe('ClauseProgress');
        expect(payload.entityId).toBe('cp-1');
        expect(payload.detailsJson.category).toBe('status_change');
        expect(payload.detailsJson.fromStatus).toBeNull();
        expect(payload.detailsJson.toStatus).toBe('IN_PROGRESS');
        // #4738 — the notes are free text, and an audit row's details stream
        // to the tenant's SIEM, so they no longer ride in the audit row.
        expect(payload.detailsJson.reason).toBeUndefined();
        expect(JSON.stringify(payload)).not.toContain('work started');
    });

    it('audit reason is undefined when notes is empty/null (no falsy leak)', async () => {
        (ClauseRepository.updateProgress as jest.Mock).mockResolvedValue({ id: 'cp-1' });

        await updateClauseProgress(editorCtx, 'cl-1', {
            status: 'IMPLEMENTED', notes: '',
        } as any);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.reason).toBeUndefined();
    });

    it('audit details carries the status (not the notes)', async () => {
        (ClauseRepository.updateProgress as jest.Mock).mockResolvedValue({ id: 'cp-1' });

        await updateClauseProgress(editorCtx, 'cl-1', {
            status: 'IMPLEMENTED', notes: 'done',
        } as any);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.details).toBe('Status: IMPLEMENTED');
    });

    it('rejects READER (write gate)', async () => {
        await expect(updateClauseProgress(readerCtx, 'cl-1', { status: 'IN_PROGRESS' } as any))
            .rejects.toBeDefined();
        expect(ClauseRepository.updateProgress).not.toHaveBeenCalled();
    });
});
