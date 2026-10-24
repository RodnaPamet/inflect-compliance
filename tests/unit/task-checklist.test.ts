/**
 * Ticking one step of a task's checklist — `usecases/task-checklist.ts`.
 *
 * The pure toggle carries the stamping rules; the usecase carries the gate,
 * the lock-then-write order, the refusals and the audit row. Both are tested
 * here because each has a way to be wrong that the other cannot see: a toggle
 * that moves `doneBy` on a re-tick, and a usecase that writes before it reads
 * under the lock, or writes an audit row for a click that changed nothing.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/repositories/TaskRepository', () => ({
    TaskRepository: {
        lockChecklist: jest.fn(),
        setChecklist: jest.fn(async () => true),
    },
}));

import { toggleChecklistItem, setTaskChecklistItem } from '@/app-layer/usecases/task-checklist';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import { logEvent } from '@/app-layer/events/audit';
import type { TaskChecklist } from '@/app-layer/schemas/task-checklist.schemas';
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {};
const lockChecklist = TaskRepository.lockChecklist as jest.Mock;
const setChecklist = TaskRepository.setChecklist as jest.Mock;
const mockLogEvent = logEvent as jest.Mock;

const NOW = new Date('2026-10-24T09:00:00.000Z');
const EARLIER = '2026-10-01T08:00:00.000Z';

function checklist(): TaskChecklist {
    return [
        { id: 'a', text: 'List every deployment able to act on its own', done: true, doneAt: EARLIER, doneByUserId: 'u-first' },
        { id: 'b', text: 'Record the authority limit for each one', hint: 'Spend, reach and change', done: false },
        { id: 'c', text: 'Have the accountable owner approve each record', done: false },
    ];
}

describe('toggleChecklistItem', () => {
    it('stamps who and when on the transition to done, and touches no other item', () => {
        const result = toggleChecklistItem(checklist(), 'b', true, 'u-editor', NOW);
        expect(result?.changed).toBe(true);
        expect(result?.checklist).toEqual([
            checklist()[0],
            {
                id: 'b',
                text: 'Record the authority limit for each one',
                hint: 'Spend, reach and change',
                done: true,
                doneAt: NOW.toISOString(),
                doneByUserId: 'u-editor',
            },
            checklist()[2],
        ]);
    });

    it('clears the stamps on the transition back, so an open step credits nobody', () => {
        const result = toggleChecklistItem(checklist(), 'a', false, 'u-editor', NOW);
        expect(result?.changed).toBe(true);
        expect(result?.checklist[0]).toEqual({
            id: 'a',
            text: 'List every deployment able to act on its own',
            done: false,
        });
    });

    it('changes nothing when the item is already in the asked state — the original ticker keeps the credit', () => {
        const before = checklist();
        const result = toggleChecklistItem(before, 'a', true, 'u-editor', NOW);
        expect(result).toEqual({ checklist: before, changed: false });
        expect(result?.checklist[0].doneByUserId).toBe('u-first');
        expect(result?.checklist[0].doneAt).toBe(EARLIER);
    });

    it('returns null for an id no item carries', () => {
        expect(toggleChecklistItem(checklist(), 'zzz', true, 'u-editor', NOW)).toBeNull();
    });
});

describe('setTaskChecklistItem', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => jest.useRealTimers());

    it('reads under the lock, writes the toggled list and audits the step it changed', async () => {
        lockChecklist.mockResolvedValue({ id: 'task-1', checklistJson: checklist() });
        const ctx = makeRequestContext('EDITOR');

        const result = await setTaskChecklistItem(ctx, 'task-1', 'b', true);

        expect(lockChecklist).toHaveBeenCalledWith(mockDb, ctx, 'task-1');
        expect(lockChecklist.mock.invocationCallOrder[0]).toBeLessThan(
            setChecklist.mock.invocationCallOrder[0],
        );
        expect(setChecklist).toHaveBeenCalledWith(mockDb, ctx, 'task-1', result);
        expect(result[1]).toMatchObject({ id: 'b', done: true, doneByUserId: ctx.userId, doneAt: NOW.toISOString() });

        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        expect(mockLogEvent.mock.calls[0][2]).toMatchObject({
            action: 'TASK_CHECKLIST_ITEM_UPDATED',
            entityType: 'Task',
            entityId: 'task-1',
            details: 'Checklist step 2 of 3 marked done',
            metadata: { itemId: 'b', done: true, position: 2, total: 3 },
        });
    });

    it('writes nothing and audits nothing for a click that changes nothing', async () => {
        lockChecklist.mockResolvedValue({ id: 'task-1', checklistJson: checklist() });
        const result = await setTaskChecklistItem(makeRequestContext('EDITOR'), 'task-1', 'a', true);
        expect(result).toEqual(checklist());
        expect(setChecklist).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('refuses a READER before reading anything', async () => {
        await expect(
            setTaskChecklistItem(makeRequestContext('READER'), 'task-1', 'b', true),
        ).rejects.toMatchObject({ status: 403 });
        expect(lockChecklist).not.toHaveBeenCalled();
    });

    it('is not found for a task the tenant does not hold', async () => {
        lockChecklist.mockResolvedValue(null);
        await expect(
            setTaskChecklistItem(makeRequestContext('EDITOR'), 'task-x', 'b', true),
        ).rejects.toMatchObject({ status: 404 });
        expect(setChecklist).not.toHaveBeenCalled();
    });

    it('is not found for a task with no checklist, and for an unknown step', async () => {
        lockChecklist.mockResolvedValue({ id: 'task-1', checklistJson: null });
        await expect(
            setTaskChecklistItem(makeRequestContext('EDITOR'), 'task-1', 'b', true),
        ).rejects.toMatchObject({ status: 404 });

        lockChecklist.mockResolvedValue({ id: 'task-1', checklistJson: checklist() });
        await expect(
            setTaskChecklistItem(makeRequestContext('EDITOR'), 'task-1', 'zzz', true),
        ).rejects.toMatchObject({ status: 404 });
        expect(setChecklist).not.toHaveBeenCalled();
    });

    it('refuses a stored checklist that fails the schema rather than rewriting it', async () => {
        lockChecklist.mockResolvedValue({ id: 'task-1', checklistJson: [{ id: 'b', text: '', done: 'no' }] });
        await expect(
            setTaskChecklistItem(makeRequestContext('EDITOR'), 'task-1', 'b', true),
        ).rejects.toMatchObject({ status: 400 });
        expect(setChecklist).not.toHaveBeenCalled();
    });
});
