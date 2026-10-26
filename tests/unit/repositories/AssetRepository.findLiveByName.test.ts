/**
 * `AssetRepository.findLiveByName` asks the partial unique index's question
 * (#4324).
 *
 * `Asset_tenantId_name_key` is `UNIQUE ("tenantId", "name") WHERE "deletedAt"
 * IS NULL`. `createAsset` refuses a taken name by asking this method first, so
 * it must refuse exactly what the index would: a LIVE asset in the SAME tenant
 * with the SAME (case-sensitive) name. Counting a deleted asset would refuse a
 * name the index allows to be reused; leaving the tenant out would refuse a
 * name because another tenant holds it.
 */
import type { PrismaTx } from '@/lib/db-context';
import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { makeRequestContext } from '../../helpers/make-context';

it("filters on the index's columns and predicate, nothing looser", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { asset: { findFirst } } as unknown as PrismaTx;
    const ctx = makeRequestContext('EDITOR');

    await AssetRepository.findLiveByName(db, ctx, 'Payroll DB');

    expect(findFirst).toHaveBeenCalledWith({
        where: { tenantId: ctx.tenantId, name: 'Payroll DB', deletedAt: null },
        select: { id: true },
    });
});
