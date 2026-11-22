/**
 * A tenant's residency region defaults to where production runs (#5288).
 *
 * Production is one GCP VM in europe-west1 (Belgium). Every tenant read
 * US_EAST_1 ("United States (East)") because that was the column default.
 * Deploy 2 of #5288 made EUROPE_WEST1 the default of the column, and of the
 * creation usecase, and moved every stored row.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Tenant.region default (#5288)', () => {
    let db: PrismaClient;
    const slug = `region-default-${Date.now()}`;

    beforeAll(async () => {
        db = prismaTestClient();
        await db.$connect();
    });

    afterAll(async () => {
        await db.tenant.deleteMany({ where: { slug } });
        await db.$disconnect();
    });

    it('is EUROPE_WEST1 in the database', async () => {
        const rows = await db.$queryRaw<{ column_default: string }[]>`
            SELECT column_default FROM information_schema.columns
            WHERE table_name = 'Tenant' AND column_name = 'region'`;
        expect(rows[0]?.column_default).toContain('EUROPE_WEST1');
    });

    it('is what a tenant created without a region reads', async () => {
        const t = await createTenantWithDek({ name: 'Region default', slug });
        const row = await db.tenant.findUniqueOrThrow({ where: { id: t.id }, select: { region: true } });
        expect(row.region).toBe('EUROPE_WEST1');
    });
});
