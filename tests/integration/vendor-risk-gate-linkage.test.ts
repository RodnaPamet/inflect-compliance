/**
 * Integration tests (P2.2 + P2.4) over a live Postgres connection:
 *
 *  - Activation gate: a vendor cannot be flipped to ACTIVE (via the plain
 *    edit path `updateVendor` OR `bulkSetVendorStatus`) unless its latest
 *    assessment is a COMPLETED review (REVIEWED/CLOSED) carrying a rating.
 *    Previously the gate keyed on the legacy APPROVED status and wasn't
 *    wired to any mutation, so activation was ungated.
 *  - Reverse "where-used": `listVendorsLinkedToEntity(entityType, entityId)`
 *    returns the vendors linked to an entity (backs the LinkedVendorsPanel).
 *
 * RUN: npx jest tests/integration/vendor-risk-gate-linkage.test.ts
 */
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    updateVendor,
    bulkSetVendorStatus,
    addVendorLink,
    listVendorsLinkedToEntity,
} from '@/app-layer/usecases/vendor';

const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('vendor activation gate + reverse linkage (integration)', () => {
    const runId = randomUUID().slice(0, 12);
    let tenantId = '';
    let userId = '';
    let ctx: ReturnType<typeof makeRequestContext>;
    const created = { vendorIds: [] as string[], riskIds: [] as string[] };

    beforeAll(async () => {
        const tenant = await prisma.tenant.create({
            data: { name: `gate-${runId}`, slug: `gate-${runId}` },
        });
        tenantId = tenant.id;
        const user = await prisma.user.create({
            data: { email: `gate-${runId}@test.com`, name: 'Gate User' },
        });
        userId = user.id;
        ctx = makeRequestContext(Role.ADMIN, { userId, tenantId, tenantSlug: tenant.slug });
    });

    afterAll(async () => {
        // Best-effort — AuditLog is append-only (DELETE forbidden) and the
        // Tenant row FK-references it, so we leave those; the per-worker /
        // throwaway test DB is discarded anyway.
        for (const del of [
            () => prisma.vendorLink.deleteMany({ where: { tenantId } }),
            () => prisma.vendorAssessment.deleteMany({ where: { tenantId } }),
            () => prisma.vendor.deleteMany({ where: { tenantId } }),
            () => prisma.risk.deleteMany({ where: { tenantId } }),
        ]) {
            try { await del(); } catch { /* best effort */ }
        }
    });

    async function makeVendor(name: string) {
        const v = await prisma.vendor.create({
            data: { tenantId, name: `${name}-${runId}`, status: 'ONBOARDING', criticality: 'MEDIUM' },
        });
        created.vendorIds.push(v.id);
        return v.id;
    }

    it('blocks activation of a vendor with no completed assessment (edit path)', async () => {
        const vendorId = await makeVendor('no-assessment');
        await expect(updateVendor(ctx, vendorId, { status: 'ACTIVE' })).rejects.toMatchObject({ status: 400 });
        const after = await prisma.vendor.findUnique({ where: { id: vendorId } });
        expect(after?.status).toBe('ONBOARDING');
    });

    it('allows activation once the latest assessment is a completed review with a rating', async () => {
        const vendorId = await makeVendor('reviewed');
        await prisma.vendorAssessment.create({
            data: { tenantId, vendorId, status: 'REVIEWED', riskRating: 'LOW', requestedByUserId: userId },
        });
        const updated = await updateVendor(ctx, vendorId, { status: 'ACTIVE' });
        expect(updated.status).toBe('ACTIVE');
    });

    it('bulk activation gates each vendor — eligible activate, ineligible are reported blocked', async () => {
        const eligible = await makeVendor('bulk-ok');
        await prisma.vendorAssessment.create({
            data: { tenantId, vendorId: eligible, status: 'CLOSED', riskRating: 'MEDIUM', requestedByUserId: userId },
        });
        const blockedVendor = await makeVendor('bulk-blocked');

        const res = await bulkSetVendorStatus(ctx, [eligible, blockedVendor], 'ACTIVE');
        expect(res.updated).toBe(1);
        expect(res.blocked.map((b) => b.id)).toEqual([blockedVendor]);

        expect((await prisma.vendor.findUnique({ where: { id: eligible } }))?.status).toBe('ACTIVE');
        expect((await prisma.vendor.findUnique({ where: { id: blockedVendor } }))?.status).toBe('ONBOARDING');
    });

    // #5318 item 31, owner decision 2026-11-14: the gate stays strict on the
    // LATEST assessment, so a reassessment in flight still blocks a vendor
    // whose earlier review completed, and the refusal names the reassessment.
    it('a reassessment in progress blocks activation, with its own reason, on both paths', async () => {
        const single = await makeVendor('reassess-single');
        const bulk = await makeVendor('reassess-bulk');
        const fresh = await makeVendor('first-open');
        for (const vendorId of [single, bulk]) {
            await prisma.vendorAssessment.create({
                data: {
                    tenantId,
                    vendorId,
                    status: 'REVIEWED',
                    riskRating: 'LOW',
                    requestedByUserId: userId,
                    createdAt: new Date(Date.now() - 60_000),
                },
            });
            await prisma.vendorAssessment.create({
                data: { tenantId, vendorId, status: 'SENT', requestedByUserId: userId },
            });
        }
        await prisma.vendorAssessment.create({
            data: { tenantId, vendorId: fresh, status: 'SENT', requestedByUserId: userId },
        });

        await expect(updateVendor(ctx, single, { status: 'ACTIVE' })).rejects.toMatchObject({
            status: 400,
            details: { reason: 'VENDOR_REASSESSMENT_IN_PROGRESS' },
        });
        expect((await prisma.vendor.findUnique({ where: { id: single } }))?.status).toBe('ONBOARDING');

        const res = await bulkSetVendorStatus(ctx, [bulk, fresh], 'ACTIVE');
        expect(res.updated).toBe(0);
        expect(Object.fromEntries(res.blocked.map((b) => [b.id, b.reason]))).toEqual({
            [bulk]: 'VENDOR_REASSESSMENT_IN_PROGRESS',
            [fresh]: 'VENDOR_ACTIVATION_NEEDS_REVIEW',
        });
    });

    it('reverse where-used: listVendorsLinkedToEntity returns vendors linked to a risk', async () => {
        const vendorId = await makeVendor('linked');
        const risk = await prisma.risk.create({
            data: { tenantId, title: `Reverse risk ${runId}`, likelihood: 3, impact: 3, score: 9 },
        });
        created.riskIds.push(risk.id);

        await addVendorLink(ctx, vendorId, { entityType: 'RISK', entityId: risk.id, relation: 'RELATED' });

        const linked = await listVendorsLinkedToEntity(ctx, 'RISK', risk.id);
        expect(linked).toHaveLength(1);
        expect(linked[0]).toMatchObject({ vendorId, relation: 'RELATED' });
        expect(linked[0].vendorName).toContain('linked');

        // A different entity id returns nothing.
        expect(await listVendorsLinkedToEntity(ctx, 'RISK', 'nonexistent')).toHaveLength(0);
    });
});
