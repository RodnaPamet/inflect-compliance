/**
 * `VendorRepository.findLiveByName` asks the partial unique index's question
 * (#4462).
 *
 * `Vendor_tenantId_name_live_key` is `UNIQUE ("tenantId", "name") WHERE
 * "deletedAt" IS NULL`. `createVendor` and a rename in `updateVendor` refuse a
 * taken name by asking this method first, so it must refuse exactly what the
 * index would: a LIVE vendor in the SAME tenant with the SAME (case-sensitive)
 * name. Counting a deleted vendor would refuse a name the index lets a new
 * vendor reuse; leaving the tenant out would refuse a name because another
 * tenant holds it.
 */
import type { PrismaTx } from '@/lib/db-context';
import { VendorRepository } from '@/app-layer/repositories/VendorRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR');

it("filters on the index's columns and predicate, nothing looser", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { vendor: { findFirst } } as unknown as PrismaTx;

    await VendorRepository.findLiveByName(db, ctx, 'Acme Cloud');

    expect(findFirst).toHaveBeenCalledWith({
        where: { tenantId: ctx.tenantId, name: 'Acme Cloud', deletedAt: null },
        select: { id: true },
    });
});

it('excludes the vendor being renamed, by id, when one is named', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { vendor: { findFirst } } as unknown as PrismaTx;

    await VendorRepository.findLiveByName(db, ctx, 'Acme Cloud', 'v-1');

    expect(findFirst).toHaveBeenCalledWith({
        where: {
            tenantId: ctx.tenantId,
            name: 'Acme Cloud',
            deletedAt: null,
            id: { not: 'v-1' },
        },
        select: { id: true },
    });
});
