/**
 * Unit test — TP-4 task-link entity resolution.
 *
 * `TaskLinkRepository.listByTaskResolved` turns each raw TaskLink
 * (entityType + bare entityId cuid) into a display name + tenant-
 * relative detail path so the task-detail Links tab renders a real
 * link instead of a raw cuid. This locks:
 *   - the batch shape: ONE `findMany({ where: { id: { in: [...] } } })`
 *     per entity TYPE (never per row — no N+1),
 *   - the per-type name + path mapping,
 *   - the graceful fall-back to `{ name: null, path: null }` when the
 *     linked entity no longer exists (UI shows the raw id).
 */

import { TaskLinkRepository } from '@/app-layer/repositories/TaskRepository';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 'tenant-1' } as RequestContext;

function mockDb(overrides: Record<string, unknown[]>) {
    const findMany = (rows: unknown[]) => jest.fn().mockResolvedValue(rows);
    const db = {
        taskLink: { findMany: findMany(overrides.taskLink ?? []) },
        control: { findMany: findMany(overrides.control ?? []) },
        risk: { findMany: findMany(overrides.risk ?? []) },
        asset: { findMany: findMany(overrides.asset ?? []) },
        policy: { findMany: findMany(overrides.policy ?? []) },
        vendor: { findMany: findMany(overrides.vendor ?? []) },
        evidence: { findMany: findMany(overrides.evidence ?? []) },
        frameworkRequirement: { findMany: findMany(overrides.frameworkRequirement ?? []) },
    };
    return db as never;
}

describe('TaskLinkRepository.listByTaskResolved — TP-4', () => {
    it('resolves each link type to a name + detail path, batched by type', async () => {
        const db = mockDb({
            taskLink: [
                { id: 'l1', entityType: 'CONTROL', entityId: 'c1', relation: 'RELATES_TO', createdAt: new Date() },
                { id: 'l2', entityType: 'RISK', entityId: 'r1', relation: null, createdAt: new Date() },
                { id: 'l3', entityType: 'EVIDENCE', entityId: 'e1', relation: null, createdAt: new Date() },
            ],
            control: [{ id: 'c1', code: 'AC-1', name: 'Access policy' }],
            risk: [{ id: 'r1', key: 'RSK-2', title: 'Data loss' }],
            evidence: [{ id: 'e1', title: 'Q3 report' }],
        });

        const out = await TaskLinkRepository.listByTaskResolved(db, ctx, 'task-1');

        const byId = Object.fromEntries(out.map((l) => [l.id, l]));
        expect(byId.l1).toMatchObject({ name: 'AC-1 — Access policy', path: '/controls/c1' });
        expect(byId.l2).toMatchObject({ name: 'RSK-2 — Data loss', path: '/risks/r1' });
        // Evidence has no per-item detail route — name only, no path.
        expect(byId.l3).toMatchObject({ name: 'Q3 report', path: null });

        // One query per TYPE, keyed by primary id `in:` — never per row.
        expect((db as never as { control: { findMany: jest.Mock } }).control.findMany).toHaveBeenCalledTimes(1);
        const controlWhere = (db as never as { control: { findMany: jest.Mock } }).control.findMany.mock.calls[0][0].where;
        expect(controlWhere.id).toEqual({ in: ['c1'] });
        expect(controlWhere.tenantId).toBe('tenant-1');
    });

    it('falls back to null name/path when the linked entity is gone', async () => {
        const db = mockDb({
            taskLink: [
                { id: 'l9', entityType: 'ASSET', entityId: 'missing', relation: null, createdAt: new Date() },
            ],
            asset: [], // the asset was deleted
        });

        const out = await TaskLinkRepository.listByTaskResolved(db, ctx, 'task-1');
        expect(out[0]).toMatchObject({ entityId: 'missing', name: null, path: null });
    });

    it('returns [] without touching the DB for a task with no links', async () => {
        const db = mockDb({ taskLink: [] });
        const out = await TaskLinkRepository.listByTaskResolved(db, ctx, 'task-1');
        expect(out).toEqual([]);
        expect((db as never as { control: { findMany: jest.Mock } }).control.findMany).not.toHaveBeenCalled();
    });
});
