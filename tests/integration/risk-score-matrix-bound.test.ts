/**
 * A risk's stored score is bounded by the tenant's OWN matrix (#5080).
 *
 * Every write used to clamp each axis to `Tenant.maxRiskScale`, which nothing
 * in the product sets, so a 6x6 tenant's L6 x I6 risk was stored as 25 while
 * the form showed 36. This writes through the real usecases into a tenant with
 * a saved 6x6 matrix and reads the stored row back, beside a tenant that saved
 * none and therefore keeps the default 5x5.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { createRisk, updateRisk } from '@/app-layer/usecases/risk';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `risk-matrix-bound-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describeFn('risk score is bounded by the tenant matrix (#5080)', () => {
    let db: PrismaClient;
    let sixBySix: RequestContext;
    let defaultMatrix: RequestContext;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        db = prismaTestClient();
        await db.$connect();
        const suffix = `risk-matrix-bound-${Date.now()}`;
        const email = `${suffix}@example.com`;
        emails.push(email);
        const user = await db.user.create({ data: { email, name: 'Matrix Bound' } });

        slugs.push(`${suffix}-6x6`, `${suffix}-default`);
        const t6 = await createTenantWithDek({ name: 'Six by six', slug: slugs[0] });
        const t5 = await createTenantWithDek({ name: 'Default matrix', slug: slugs[1] });
        await db.riskMatrixConfig.create({
            data: { tenantId: t6.id, likelihoodLevels: 6, impactLevels: 6 },
        });
        sixBySix = ctxFor(t6.id, user.id);
        defaultMatrix = ctxFor(t5.id, user.id);
    });

    afterAll(async () => {
        const tenantIds = (
            await db.tenant.findMany({ where: { slug: { in: slugs } }, select: { id: true } })
        ).map((t) => t.id);
        const userIds = (
            await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
        ).map((u) => u.id);
        if (tenantIds.length > 0) {
            await db.risk.deleteMany({ where: { tenantId: { in: tenantIds } } });
            await db.riskMatrixConfig.deleteMany({ where: { tenantId: { in: tenantIds } } });
            await deleteAuditRowsForTenants(db, tenantIds);
        }
        if (userIds.length > 0) await deleteAuditRowsForUsers(db, userIds);
        await db.tenant.deleteMany({ where: { slug: { in: slugs } } });
        await db.user.deleteMany({ where: { email: { in: emails } } });
        await db.$disconnect();
    });

    const stored = (id: string) =>
        db.risk.findUniqueOrThrow({
            where: { id },
            select: { likelihood: true, impact: true, inherentScore: true, score: true },
        });

    it('stores L6 x I6 as 36 on a 6x6 matrix', async () => {
        const risk = await createRisk(sixBySix, { title: 'Top cell', likelihood: 6, impact: 6 });
        expect(await stored(risk.id)).toEqual({ likelihood: 6, impact: 6, inherentScore: 36, score: 36 });
    });

    it('re-assessing to L6 x I1 stores 6, not 5', async () => {
        const risk = await createRisk(sixBySix, { title: 'Re-assessed', likelihood: 2, impact: 2 });
        await updateRisk(sixBySix, risk.id, { likelihood: 6, impact: 1 });
        expect((await stored(risk.id)).inherentScore).toBe(6);
    });

    it('still bounds each axis at 5 for a tenant that saved no matrix', async () => {
        const risk = await createRisk(defaultMatrix, { title: 'Default bound', likelihood: 6, impact: 6 });
        expect((await stored(risk.id)).inherentScore).toBe(25);
    });
});
