/**
 * `AuditLogRepository.listPage` — one page of the tenant's audit log, for the
 * Audit log page (#4468).
 *
 * The page used to show the latest 100 entries and stop, with no sign that
 * more existed, so nothing in the product could show entry 101. This pins the
 * read that replaced it: tenant-scoped, ordered on `(createdAt, id)` so a
 * cursor is stable, reading ONE ROW PAST the page so "there is an older page"
 * is a fact the read holds, and continuing strictly after the cursor's row.
 */
import { AuditLogRepository } from '@/app-layer/repositories/AuditLogRepository';
import { decodeCursor, encodeCursor } from '@/lib/pagination';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('AUDITOR', { tenantId: 'tenant-1' });

function rowsFrom(count: number) {
    // Newest first, one second apart.
    return Array.from({ length: count }, (_, i) => ({
        id: `log-${String(count - i).padStart(3, '0')}`,
        createdAt: new Date(Date.UTC(2026, 9, 29, 12, 0, count - i)),
        action: 'RISK_CREATED',
        entity: 'Risk',
        details: null,
        detailsJson: null,
        user: null,
    }));
}

function dbReturning(rows: unknown[]) {
    const findMany = jest.fn(async (_args: Record<string, unknown>) => rows);
    return { db: { auditLog: { findMany } } as never, findMany };
}

describe('AuditLogRepository.listPage', () => {
    test('reads one row past the page, tenant-scoped, newest first on a stable order', async () => {
        const { db, findMany } = dbReturning(rowsFrom(3));
        await AuditLogRepository.listPage(db, ctx, { limit: 2 });
        const args = findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-1' });
        expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
        expect(args.take).toBe(3);
    });

    test('a read that came back with the extra row returns the page and the cursor of its last row', async () => {
        const rows = rowsFrom(3);
        const { db } = dbReturning(rows);
        const page = await AuditLogRepository.listPage(db, ctx, { limit: 2 });
        expect(page.rows.map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
        expect(page.nextCursor).not.toBeNull();
        expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: rows[1].createdAt.toISOString(), id: rows[1].id });
    });

    test('a read that came back at or under the page size is the oldest page: no cursor', async () => {
        for (const n of [0, 1, 2]) {
            const { db } = dbReturning(rowsFrom(n));
            const page = await AuditLogRepository.listPage(db, ctx, { limit: 2 });
            expect(page.rows).toHaveLength(n);
            expect(page.nextCursor).toBeNull();
        }
    });

    test('a cursor continues strictly after its own row', async () => {
        const at = { createdAt: '2026-10-29T12:00:05.000Z', id: 'log-005' };
        const { db, findMany } = dbReturning([]);
        await AuditLogRepository.listPage(db, ctx, { cursor: encodeCursor(at), limit: 2 });
        const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
        expect(where.tenantId).toBe('tenant-1');
        expect(where.OR).toEqual([
            { createdAt: { lt: new Date(at.createdAt) } },
            { AND: [{ createdAt: new Date(at.createdAt) }, { id: { lt: at.id } }] },
        ]);
    });

    test('a cursor that does not decode reads the newest page, still tenant-scoped', async () => {
        const { db, findMany } = dbReturning([]);
        await AuditLogRepository.listPage(db, ctx, { cursor: 'not-a-cursor', limit: 2 });
        expect(findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
    });

    test('reads only what the page shows', async () => {
        const { db, findMany } = dbReturning([]);
        await AuditLogRepository.listPage(db, ctx, { limit: 2 });
        expect(Object.keys(findMany.mock.calls[0][0].select as object).sort()).toEqual(
            ['action', 'createdAt', 'details', 'detailsJson', 'entity', 'id', 'user'],
        );
    });
});
