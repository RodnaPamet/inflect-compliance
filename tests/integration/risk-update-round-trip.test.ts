/**
 * Round-trip integration test for the risk edit path.
 *
 * WHY A ROUND-TRIP AND NOT A SCHEMA-SHAPE ASSERTION: the defect this
 * covers was invisible to every layer read in isolation. `updateRisk`
 * wrote description/category/nextReviewAt, the edit modal sent them, and
 * the route returned 200 — but `UpdateRiskSchema` omitted all three and
 * ended in `.strip()`, so the values evaporated in between. A test that
 * asserted the schema's shape, or that the usecase writes the column,
 * would have passed while the product silently discarded every edit.
 * Only writing THROUGH the real request path and reading back catches it.
 *
 * The schema is exercised deliberately (parse → usecase), because the
 * schema is where the bug lived.
 */

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { createRisk, updateRisk, getRisk } from '@/app-layer/usecases/risk';
import { UpdateRiskSchema } from '@/lib/schemas';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `risk-round-trip-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Push a payload through the SAME schema the PUT route uses, then the
 * usecase. `.strip()` runs here — which is exactly the step that used to
 * eat these fields.
 */
async function editViaRoutePath(
    ctx: RequestContext,
    id: string,
    body: Record<string, unknown>,
) {
    const parsed = UpdateRiskSchema.parse(body);
    return updateRisk(ctx, id, parsed as Parameters<typeof updateRisk>[2]);
}

describeFn('risk edit round-trip (write → read back)', () => {
    let testPrisma: PrismaClient;
    let tenantId: string;
    let ctx: RequestContext;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        const suffix = `risk-round-trip-${Date.now()}`;
        const slug = suffix;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'RoundTrip', slug });
        tenantId = t.id;

        // A REAL user row: createRisk/updateRisk write hash-chained audit
        // entries whose userId is a foreign key, so a synthetic id fails
        // the insert rather than the assertion.
        const email = `round-trip-${suffix}@example.com`;
        emails.push(email);
        const user = await testPrisma.user.create({ data: { email, name: 'Round Tripper' } });
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

    it('persists an edited description, category and nextReviewAt', async () => {
        const created = await createRisk(ctx, {
            title: 'Round-trip subject',
            description: 'original description',
            category: 'Original Category',
        });

        await editViaRoutePath(ctx, created.id, {
            description: 'EDITED description',
            category: 'Edited Category',
            nextReviewAt: '2027-03-01T00:00:00.000Z',
        });

        const readBack = await getRisk(ctx, created.id);
        expect({
            description: readBack.description,
            category: readBack.category,
            nextReviewAt: readBack.nextReviewAt?.toISOString().slice(0, 10) ?? null,
        }).toEqual({
            description: 'EDITED description',
            category: 'Edited Category',
            nextReviewAt: '2027-03-01',
        });
    });

    it('leaves untouched fields alone (undefined ≠ clear)', async () => {
        const created = await createRisk(ctx, {
            title: 'Partial edit subject',
            description: 'keep me',
            category: 'Keep Category',
        });

        // Edit ONLY the title. The three-state contract says the other
        // columns must survive untouched, not be nulled by omission.
        await editViaRoutePath(ctx, created.id, { title: 'Retitled' });

        const readBack = await getRisk(ctx, created.id);
        expect({
            title: readBack.title,
            description: readBack.description,
            category: readBack.category,
        }).toEqual({
            title: 'Retitled',
            description: 'keep me',
            category: 'Keep Category',
        });
    });

    it('clears threat and vulnerability when sent an explicit null', async () => {
        const created = await createRisk(ctx, {
            title: 'Clearable subject',
            threat: 'some threat',
            vulnerability: 'some vulnerability',
        });

        await editViaRoutePath(ctx, created.id, { threat: null, vulnerability: null });

        const readBack = await getRisk(ctx, created.id);
        expect({ threat: readBack.threat, vulnerability: readBack.vulnerability })
            .toEqual({ threat: null, vulnerability: null });
    });

    it('stores NULL rather than empty string when a text field is cleared', async () => {
        // A cleared form input sends '' — which renders blank but sorts,
        // filters and compares differently from NULL. ownerUserId already
        // guarded this; category and treatmentOwner did not.
        const created = await createRisk(ctx, {
            title: 'Empty-string subject',
            category: 'Has Category',
        });

        await editViaRoutePath(ctx, created.id, { category: '', treatmentOwner: '' });

        const readBack = await getRisk(ctx, created.id);
        expect({ category: readBack.category, treatmentOwner: readBack.treatmentOwner })
            .toEqual({ category: null, treatmentOwner: null });
    });

    it('creates threat/vulnerability as NULL, not empty string, when omitted', async () => {
        const created = await createRisk(ctx, { title: 'Omitted-fields subject' });
        const readBack = await getRisk(ctx, created.id);
        expect({ threat: readBack.threat, vulnerability: readBack.vulnerability })
            .toEqual({ threat: null, vulnerability: null });
    });
});
