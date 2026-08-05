/**
 * Round-trip regression test for the asset edit path.
 *
 * WHY THIS EXISTS: asset `status` has been lost TWICE, at two different
 * layers, and neither loss was visible to a test that reads one layer.
 *
 *   1. `UpdateAssetSchema` omitted `status`, so `.strip()` discarded it —
 *      PUT returned 200 and the edit vanished. Fixed by Item 29.
 *   2. The schema then accepted it and `updateAsset` still never forwarded
 *      it to `AssetRepository.update`, so the detail-page status control
 *      went on returning 200 and changing nothing. Fixed in #1788.
 *
 * Between those two fixes the only cover was
 * `tests/guards/item-29-status-buttons.test.ts` (since retired), which
 * asserted the schema MENTIONED `status` — and so was green for the whole
 * of (2). A structural guard proves a field is mentioned; only a round
 * trip proves a value survives one.
 *
 * The identical defect shape then reappeared on Risks — UpdateRiskSchema
 * omitting description/category/nextReviewAt. Same schema, same `.strip()`,
 * same silence. See tests/integration/risk-update-round-trip.test.ts.
 */

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { createAsset, updateAsset, getAsset } from '@/app-layer/usecases/asset';
import { UpdateAssetSchema } from '@/lib/schemas';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `asset-round-trip-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/** Through the SAME schema the PUT route uses — `.strip()` runs here. */
async function editViaRoutePath(ctx: RequestContext, id: string, body: Record<string, unknown>) {
    const parsed = UpdateAssetSchema.parse(body);
    return updateAsset(ctx, id, parsed as Parameters<typeof updateAsset>[2]);
}

describeFn('asset edit round-trip (write → read back)', () => {
    let testPrisma: PrismaClient;
    let tenantId: string;
    let ctx: RequestContext;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        const suffix = `asset-round-trip-${Date.now()}`;
        slugs.push(suffix);
        const t = await createTenantWithDek({ name: 'AssetRoundTrip', slug: suffix });
        tenantId = t.id;

        // Real user row — the usecases write FK-bearing audit entries.
        const email = `asset-rt-${suffix}@example.com`;
        emails.push(email);
        const user = await testPrisma.user.create({ data: { email, name: 'Asset Tripper' } });
        ctx = ctxFor(tenantId, user.id);
    });

    afterAll(async () => {
        for (const slug of slugs) {
            await testPrisma.tenant.deleteMany({ where: { slug } }).catch(() => {});
        }
        for (const email of emails) {
            await testPrisma.user.deleteMany({ where: { email } }).catch(() => {});
        }
        await testPrisma.$disconnect();
    });

    it('persists an edited status (the Item 29 regression)', async () => {
        const created = await createAsset(ctx, {
            name: 'Round-trip asset',
            type: 'APPLICATION',
        } as Parameters<typeof createAsset>[1]);

        await editViaRoutePath(ctx, created.id, { status: 'RETIRED' });

        const readBack = await getAsset(ctx, created.id);
        expect(readBack.status).toBe('RETIRED');
    });

    it('leaves untouched fields alone (undefined ≠ clear)', async () => {
        const created = await createAsset(ctx, {
            name: 'Partial edit asset',
            type: 'APPLICATION',
            location: 'eu-west-1',
        } as Parameters<typeof createAsset>[1]);

        await editViaRoutePath(ctx, created.id, { name: 'Renamed asset' });

        const readBack = await getAsset(ctx, created.id);
        expect({ name: readBack.name, location: readBack.location })
            .toEqual({ name: 'Renamed asset', location: 'eu-west-1' });
    });
});
