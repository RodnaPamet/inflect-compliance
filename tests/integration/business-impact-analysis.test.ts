/**
 * BIA usecase (integration) — the brief's verification against a real DB
 * with RLS + encryption live:
 *   - create a BIA + list it with a derived recovery-priority rank;
 *   - link it to a continuity control (Art.21(2)(c)) → the control's BIA
 *     surface resolves to 'continuity' with the linked BIA as evidence;
 *   - a plain, unrelated control resolves to 'none' — the no-dead-tab lock.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { createBia, listBias, linkBiaToControl, getControlBiaSurface } from '@/app-layer/usecases/business-impact-analysis';
import { createControl } from '@/app-layer/usecases/control';

jest.setTimeout(30_000);
const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `bia-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describeFn('business impact analysis (integration)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let ctx: RequestContext;
    let continuityControlId: string;
    let plainControlId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const suffix = `bia-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: 'BIA Co', slug: suffix });
        tenantId = tenant.id;
        const user = await prisma.user.create({ data: { email: `u-${suffix}@example.com`, name: 'Continuity Owner' } });
        ctx = ctxFor(tenantId, user.id);

        continuityControlId = (await createControl(ctx, { name: 'Business continuity plan' })).id;
        plainControlId = (await createControl(ctx, { name: 'Unrelated access control' })).id;

        // A global framework + a business-continuity requirement, linked to
        // the continuity control (makes it a "continuity control" — case 4a).
        const framework = await prisma.framework.create({
            data: { key: `fw-${suffix}`, name: 'NIS2', version: '2024' },
        });
        const requirement = await prisma.frameworkRequirement.create({
            data: { frameworkId: framework.id, code: 'Art.21(2)(c)', title: 'Business continuity and crisis management' },
        });
        await prisma.controlRequirementLink.create({
            data: { tenantId, controlId: continuityControlId, requirementId: requirement.id },
        });
    });

    afterAll(async () => {
        try {
            // Guarded: on a failed `beforeAll` this bare `let` is still
            // undefined, and Prisma DROPS an undefined filter value rather
            // than rejecting it, so the unguarded form is an unpredicated
            // DELETE — see the teardown note in ./db-helper.ts.
            if (tenantId) {
                await prisma.biaDependency.deleteMany({ where: { tenantId } });
                await prisma.businessImpactAnalysis.deleteMany({ where: { tenantId } });
            }
        } catch {
            /* best-effort */
        }
    });

    it('creates a BIA and lists it with a derived recovery-priority rank', async () => {
        await createBia(ctx, { name: 'Payment Processing', criticality: 'CRITICAL', mtpdHours: 4, rtoHours: 2 });
        await createBia(ctx, { name: 'Internal Wiki', criticality: 'LOW', mtpdHours: 240 });

        const rows = await listBias(ctx);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const critical = rows.find((r) => r.name === 'Payment Processing')!;
        const low = rows.find((r) => r.name === 'Internal Wiki')!;
        expect(critical.recovery!.rank).toBe(1); // recovers first
        expect(low.recovery!.rank).toBeGreaterThan(critical.recovery!.rank);
        expect(critical.recovery!.rationale).toMatch(/CRITICAL/);
    });

    it('a continuity control shows the linked BIA as continuity evidence (case 4a)', async () => {
        const bia = await createBia(ctx, { name: 'Order Management', criticality: 'HIGH', mtpdHours: 8 });
        await linkBiaToControl(ctx, bia.id, continuityControlId);

        const surface = await getControlBiaSurface(ctx, continuityControlId);
        expect(surface.kind).toBe('continuity');
        if (surface.kind === 'continuity') {
            expect(surface.bias.map((b) => b.id)).toContain(bia.id);
        }
    });

    it('a plain control with no continuity/process link shows NO BIA surface (no-dead-tab, case 4c)', async () => {
        const surface = await getControlBiaSurface(ctx, plainControlId);
        expect(surface.kind).toBe('none');
    });
});
