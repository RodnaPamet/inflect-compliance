/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `RiskRepository.listDeleted` — the read behind `GET /risks?includeDeleted=true`.
 *
 * It replaced `withDeleted({ where: { tenantId } })` in the usecase, which
 * returned every risk, live and deleted alike (`withDeleted` only lifts the
 * soft-delete read filter), applied none of the list's filters, and returned
 * full rows. The Controls twin had the same defect (#4275).
 *
 * A mock `db` records what `findMany` receives, so these fail if the WHERE,
 * the opt-out marker or the select regress.
 */
import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1'

function freshDb(rows: unknown[] = []) {
    return { risk: { findMany: jest.fn(async (_args: any) => rows) } } as any;
}

describe('RiskRepository.listDeleted', () => {
    it('reads ONLY soft-deleted risks of this tenant, newest deletion first, capped', async () => {
        const db = freshDb();
        await RiskRepository.listDeleted(db, ctx, {}, { take: 5000 });
        const args = db.risk.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 'tenant-1', deletedAt: { not: null } });
        // The marker the soft-delete extension honours to skip `deletedAt: null`.
        expect(args.__includeDeleted).toBe(true);
        expect(args.orderBy).toEqual({ deletedAt: 'desc' });
        expect(args.take).toBe(5000);
    });

    it('applies the same filters and search as the live list', async () => {
        const db = freshDb();
        await RiskRepository.listDeleted(
            db,
            ctx,
            { status: 'OPEN,MITIGATING', category: 'Operational', ownerUserId: 'u-1', q: 'phishing', idIn: ['r-1'] },
            { take: 5000 },
        );
        const live = freshDb();
        await RiskRepository.list(
            live,
            ctx,
            { status: 'OPEN,MITIGATING', category: 'Operational', ownerUserId: 'u-1', q: 'phishing', idIn: ['r-1'] },
        );
        const deletedWhere = db.risk.findMany.mock.calls[0][0].where;
        const liveWhere = live.risk.findMany.mock.calls[0][0].where;
        // Exactly the live list's predicate, plus the deleted-only narrowing.
        expect(deletedWhere).toEqual({ ...liveWhere, deletedAt: { not: null } });
        expect(deletedWhere.status).toEqual({ in: ['OPEN', 'MITIGATING'] });
        expect(deletedWhere.OR).toHaveLength(3); // the search
    });

    it("selects the live list's row shape plus who deleted it and when", async () => {
        const db = freshDb();
        await RiskRepository.listDeleted(db, ctx, {}, { take: 10 });
        const live = freshDb();
        await RiskRepository.list(live, ctx, {});
        const select = db.risk.findMany.mock.calls[0][0].select;
        expect(select).toEqual({
            ...live.risk.findMany.mock.calls[0][0].select,
            deletedAt: true,
            deletedByUserId: true,
        });
        // Not full rows: the encrypted free-text columns are not read.
        expect(select.treatmentNotes).toBeUndefined();
        expect(select.description).toBeUndefined();
    });
});
