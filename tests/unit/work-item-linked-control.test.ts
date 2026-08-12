/**
 * Unit test — tasks linked to a control surface via controlId too.
 *
 * Bug: installing a framework pack creates tasks with the direct
 * `Task.controlId` FK (no generic TaskLink row). The control detail
 * page's "Tasks" tab lists tasks via `linkedEntityType=CONTROL`, which
 * the repository previously translated to a TaskLink-only filter — so
 * pack-installed tasks (controlId set, no TaskLink) never appeared,
 * even though the task's OWN view shows the control.
 *
 * Fix: for `linkedEntityType === 'CONTROL'`, match via TaskLink OR the
 * `controlId` FK. This test locks the where-clause shape (the
 * repository's filter is the single source of truth for "tasks linked
 * to a control").
 */

import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 'tenant-1' } as RequestContext;

function mockDb() {
    const findMany = jest.fn().mockResolvedValue([]);
    return { db: { task: { findMany } } as never, findMany };
}

function whereOf(findMany: jest.Mock) {
    return findMany.mock.calls[0][0].where;
}

describe('TaskRepository — control-linked tasks', () => {
    it('CONTROL link matches via TaskLink OR the controlId FK', async () => {
        const { db, findMany } = mockDb();
        await TaskRepository.list(db, ctx, {
            linkedEntityType: 'CONTROL',
            linkedEntityId: 'ctrl-1',
        });
        const where = whereOf(findMany);
        const orClause = (where.AND as any[]).find((c) => Array.isArray(c.OR));
        expect(orClause).toBeTruthy();
        // one branch is the TaskLink join, the other is the direct FK
        expect(orClause.OR).toEqual(
            expect.arrayContaining([
                { controlId: 'ctrl-1' },
                {
                    links: {
                        some: { entityType: 'CONTROL', entityId: 'ctrl-1' },
                    },
                },
            ]),
        );
    });

    it('non-control links stay TaskLink-only (no controlId branch)', async () => {
        const { db, findMany } = mockDb();
        await TaskRepository.list(db, ctx, {
            linkedEntityType: 'ASSET',
            linkedEntityId: 'asset-1',
        });
        const where = whereOf(findMany);
        const serialized = JSON.stringify(where);
        expect(serialized).toContain('"entityType":"ASSET"');
        // No controlId match for asset/risk/etc. — those have no FK on Task.
        expect(serialized).not.toContain('controlId');
    });
});

describe('TaskRepository.countLinkedToControl', () => {
    function mockCountDb() {
        // Promise.all order: total query first, done query second.
        const count = jest
            .fn()
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(2);
        return { db: { task: { count } } as never, count };
    }

    it('counts via the SAME TaskLink-OR-controlId where the panel lists', async () => {
        const { db, count } = mockCountDb();
        const result = await TaskRepository.countLinkedToControl(
            db,
            ctx,
            'ctrl-1',
        );
        expect(result).toEqual({ total: 5, done: 2 });

        // total query — the control-link OR clause, no status filter.
        const totalOr = (count.mock.calls[0][0].where.AND as any[]).find(
            (c) => Array.isArray(c.OR),
        );
        expect(totalOr.OR).toEqual(
            expect.arrayContaining([
                { controlId: 'ctrl-1' },
                { links: { some: { entityType: 'CONTROL', entityId: 'ctrl-1' } } },
            ]),
        );

        // done query — same where AND status in the completed set
        // (RESOLVED/CLOSED — CANCELED is terminal but not completed).
        expect(count.mock.calls[1][0].where.AND).toEqual(
            expect.arrayContaining([
                { status: { in: ['RESOLVED', 'CLOSED'] } },
            ]),
        );
    });
});

describe('TaskRepository.countLinkedToControls (batched)', () => {
    it('dedupes a task linked via BOTH the FK and a TaskLink, per control', async () => {
        const taskFindMany = jest.fn().mockResolvedValue([
            // ctrl-1: two direct-FK tasks (one RESOLVED → done)
            { id: 't1', controlId: 'ctrl-1', status: 'OPEN' },
            { id: 't2', controlId: 'ctrl-1', status: 'RESOLVED' },
        ]);
        const taskLinkFindMany = jest.fn().mockResolvedValue([
            // t2 ALSO linked via TaskLink to ctrl-1 → must count once
            { entityId: 'ctrl-1', taskId: 't2', task: { status: 'RESOLVED' } },
            // t3 linked to ctrl-2 via TaskLink only (CLOSED → done)
            { entityId: 'ctrl-2', taskId: 't3', task: { status: 'CLOSED' } },
        ]);
        const db = {
            task: { findMany: taskFindMany },
            taskLink: { findMany: taskLinkFindMany },
        } as never;

        const result = await TaskRepository.countLinkedToControls(db, ctx, [
            'ctrl-1',
            'ctrl-2',
        ]);

        // ctrl-1: t1 + t2 (t2 not double-counted) → total 2, done 1.
        expect(result.get('ctrl-1')).toEqual({ total: 2, done: 1 });
        // ctrl-2: t3 → total 1, done 1.
        expect(result.get('ctrl-2')).toEqual({ total: 1, done: 1 });
    });

    it('returns an empty map for no control ids (no queries)', async () => {
        const taskFindMany = jest.fn();
        const taskLinkFindMany = jest.fn();
        const db = {
            task: { findMany: taskFindMany },
            taskLink: { findMany: taskLinkFindMany },
        } as never;
        const result = await TaskRepository.countLinkedToControls(db, ctx, []);
        expect(result.size).toBe(0);
        expect(taskFindMany).not.toHaveBeenCalled();
        expect(taskLinkFindMany).not.toHaveBeenCalled();
    });
});
