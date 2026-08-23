/**
 * Vendor continuous-monitoring (integration) — the posture-change → action
 * contract against a real DB with RLS live:
 *   - an EXPIRED parsed attestation flips the assessment stale
 *     (vendor.nextReviewAt → now) + records the timeline + triggers
 *     reassessment;
 *   - a NEW breach signal records the timeline + (opt-in) materialises an
 *     idempotent vendor Finding + notifies the owner;
 *   - re-running the monitor is idempotent (no duplicate events / findings /
 *     notifications).
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
import {
    runVendorMonitor,
    updateVendorMonitor,
    getVendorPosture,
    VENDOR_BREACH_KIND,
    VENDOR_ATTESTATION_EXPIRED_KIND,
} from '@/app-layer/usecases/vendor-monitoring';
import type { BreachSignal } from '@/app-layer/services/vendor-monitoring/types';

jest.setTimeout(30_000);
const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `vmon-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

const NOW = new Date('2026-07-01T00:00:00.000Z');
const breachSig: BreachSignal = {
    source: 'stub',
    breached: true,
    latestBreachAt: '2026-06-15',
    breaches: [{ name: 'Acme exposure', date: '2026-06-15' }],
};
const cleanTls = { source: 'stub', grade: 'A', checkedAt: NOW.toISOString(), presentHeaders: [], missingHeaders: [] };

describeFn('vendor continuous-monitoring (integration)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let userId: string;
    let ctx: RequestContext;
    let vendorId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const suffix = `vmon-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: 'VMon Co', slug: suffix });
        tenantId = tenant.id;
        const user = await prisma.user.create({ data: { email: `u-${suffix}@example.com`, name: 'Owner' } });
        userId = user.id;
        ctx = ctxFor(tenantId, userId);
        vendorId = (
            await prisma.vendor.create({
                data: { tenantId, name: `Acme ${suffix}`, domain: 'acme.example', ownerUserId: userId },
            })
        ).id;
        // A SOC 2 whose period has already ended → an expired attestation.
        await prisma.vendorDocExtraction.create({
            data: {
                tenantId, vendorId,
                documentId: (await prisma.vendorDocument.create({ data: { tenantId, vendorId, type: 'SOC2', uploadedByUserId: userId } })).id,
                status: 'EXTRACTED', reportType: 'SOC2_TYPE2',
                auditPeriodEnd: new Date('2026-05-01T00:00:00.000Z'),
                createdByUserId: userId,
            },
        });
        // Opt into findings so the breach/attestation escalation materialises.
        await updateVendorMonitor(ctx, vendorId, { materializeFindings: true });
    });

    afterAll(async () => {
        try {
            // Guarded: on a failed `beforeAll` this bare `let` is still
            // undefined, and Prisma DROPS an undefined filter value rather
            // than rejecting it, so the unguarded form is an unpredicated
            // DELETE — see the teardown note in ./db-helper.ts.
            if (tenantId) {
                await prisma.vendorPostureEvent.deleteMany({ where: { tenantId } });
                await prisma.vendorMonitor.deleteMany({ where: { tenantId } });
            }
        } catch { /* best-effort */ }
    });

    it('expired attestation flips the assessment stale + triggers reassessment + records timeline', async () => {
        const res = await runVendorMonitor(ctx, { vendorId, now: NOW, breachSignal: { source: 'stub', breached: false, breaches: [] }, tlsSignal: cleanTls });
        expect(res.ran).toBe(true);
        expect(res.attestationStatus).toBe('EXPIRED');
        expect(res.reassessmentTriggered).toBe(true);

        // Vendor flipped into reassessment-due (nextReviewAt === now).
        const vendor = await prisma.vendor.findFirst({ where: { id: vendorId } });
        expect(vendor!.nextReviewAt?.getTime()).toBe(NOW.getTime());

        // Timeline carries the attestation + reassessment events.
        const { events } = await getVendorPosture(ctx, vendorId);
        const types = events.map((e) => e.eventType);
        expect(types).toContain('ATTESTATION_EXPIRED');
        expect(types).toContain('REASSESSMENT_TRIGGERED');

        // Opt-in finding materialised with the vendor provenance tag.
        const finding = await prisma.finding.findFirst({ where: { tenantId, sourceKind: VENDOR_ATTESTATION_EXPIRED_KIND } });
        expect(finding).not.toBeNull();
    });

    it('a new breach records the timeline + materialises an idempotent finding + notifies the owner', async () => {
        const res = await runVendorMonitor(ctx, { vendorId, now: NOW, breachSignal: breachSig, tlsSignal: cleanTls });
        expect(res.breachDetected).toBe(true);

        const { events } = await getVendorPosture(ctx, vendorId);
        expect(events.map((e) => e.eventType)).toContain('BREACH_DETECTED');

        const breachFindings = await prisma.finding.count({ where: { tenantId, sourceKind: VENDOR_BREACH_KIND } });
        expect(breachFindings).toBe(1);

        const notifs = await prisma.notification.count({ where: { tenantId, userId, type: 'VENDOR_POSTURE_ALERT' } });
        expect(notifs).toBeGreaterThan(0);
    });

    it('re-running the monitor is idempotent (no duplicate events / findings / notifications)', async () => {
        const eventsBefore = await prisma.vendorPostureEvent.count({ where: { tenantId } });
        const findingsBefore = await prisma.finding.count({ where: { tenantId, sourceKind: { in: [VENDOR_BREACH_KIND, VENDOR_ATTESTATION_EXPIRED_KIND] } } });
        const notifsBefore = await prisma.notification.count({ where: { tenantId, type: 'VENDOR_POSTURE_ALERT' } });

        await runVendorMonitor(ctx, { vendorId, now: NOW, breachSignal: breachSig, tlsSignal: cleanTls });

        expect(await prisma.vendorPostureEvent.count({ where: { tenantId } })).toBe(eventsBefore);
        expect(await prisma.finding.count({ where: { tenantId, sourceKind: { in: [VENDOR_BREACH_KIND, VENDOR_ATTESTATION_EXPIRED_KIND] } } })).toBe(findingsBefore);
        expect(await prisma.notification.count({ where: { tenantId, type: 'VENDOR_POSTURE_ALERT' } })).toBe(notifsBefore);
    });

    it('disabling the monitor short-circuits the run', async () => {
        await updateVendorMonitor(ctx, vendorId, { enabled: false });
        const res = await runVendorMonitor(ctx, { vendorId, now: NOW, breachSignal: breachSig, tlsSignal: cleanTls });
        expect(res.ran).toBe(false);
        await updateVendorMonitor(ctx, vendorId, { enabled: true });
    });
});
