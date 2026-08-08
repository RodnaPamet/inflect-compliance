/**
 * RQ3-8 — control-roi integration: end-to-end ALE/ROI math via the
 * real DB. Verifies the FAIR + SLE×ARO fall-back chain and the
 * portfolio ranking.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getControlRoi, getBestValueControls } from '@/app-layer/usecases/control';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `roi-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ3-8 — control ROI (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskControl', 'control', 'risk', 'auditLog', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('returns ok with ALE × effectiveness / cost on a linked, FAIR-quantified risk', async () => {
        const risk = await globalPrisma.risk.create({
            data: { tenantId: TENANT_ID, title: 'Phishing exposure', fairAle: 200_000 },
        });
        const control = await globalPrisma.control.create({
            data: {
                tenantId: TENANT_ID, code: 'CTL-1', name: 'MFA',
                annualCost: 25_000, effectiveness: 50, applicability: 'APPLICABLE',
                status: 'IMPLEMENTED',
            },
        });
        await globalPrisma.riskControl.create({
            data: { tenantId: TENANT_ID, riskId: risk.id, controlId: control.id },
        });

        const payload = await getControlRoi(ctx, control.id);
        expect(payload.verdict.ok).toBe(true);
        if (!payload.verdict.ok) return;
        expect(payload.verdict.value.aleProtected).toBe(100_000); // 200k × 0.5
        expect(payload.verdict.value.roiMultiple).toBe(4);        // 100k / 25k
        expect(payload.verdict.value.quantifiedRiskCount).toBe(1);
    });

    it('falls back to SLE × ARO when fairAle is null (the legacy ALE path)', async () => {
        const risk = await globalPrisma.risk.create({
            data: { tenantId: TENANT_ID, title: 'Outage', sleAmount: 50_000, aroAmount: 2 },
        });
        const control = await globalPrisma.control.create({
            data: {
                tenantId: TENANT_ID, code: 'CTL-2', name: 'Backups',
                annualCost: 10_000, effectiveness: 80, applicability: 'APPLICABLE',
                status: 'IMPLEMENTED',
            },
        });
        await globalPrisma.riskControl.create({
            data: { tenantId: TENANT_ID, riskId: risk.id, controlId: control.id },
        });

        const payload = await getControlRoi(ctx, control.id);
        expect(payload.verdict.ok).toBe(true);
        if (!payload.verdict.ok) return;
        // ALE = 50k × 2 = 100k. Protected = 100k × 0.8 = 80k. ROI = 8.
        expect(payload.verdict.value.aleProtected).toBe(80_000);
        expect(payload.verdict.value.roiMultiple).toBe(8);
    });

    it('best-value ranks the portfolio and excludes un-priced rows', async () => {
        const ranked = await getBestValueControls(ctx, 10);
        // The two ok controls from the prior tests are present; the
        // ranking puts CTL-2 (ROI 8) ahead of CTL-1 (ROI 4).
        const codes = ranked.map((r) => r.code);
        expect(codes.indexOf('CTL-2')).toBeGreaterThan(-1);
        expect(codes.indexOf('CTL-1')).toBeGreaterThan(-1);
        expect(codes.indexOf('CTL-2')).toBeLessThan(codes.indexOf('CTL-1'));
    });

    it('each ranked row discloses its effectiveness provenance', async () => {
        const ranked = await getBestValueControls(ctx, 10);
        expect(ranked.length).toBeGreaterThan(0);
        // A rank must never hide whether it rests on measured tests or a
        // declared guess — the leaderboard renders this as a badge.
        for (const row of ranked) {
            expect(row).toHaveProperty('effectivenessSource');
        }
        // These controls carry a declared `effectiveness` with no test runs,
        // so the reconciliation falls back to DECLARED (not MEASURED).
        const ctl2 = ranked.find((r) => r.code === 'CTL-2');
        expect(ctl2?.effectivenessSource).toBe('DECLARED');
    });

    it('an un-priced control is excluded from the leaderboard (no synthetic zero)', async () => {
        const control = await globalPrisma.control.create({
            data: {
                tenantId: TENANT_ID, code: 'CTL-NOCOST', name: 'Unpriced',
                annualCost: null, effectiveness: 99, applicability: 'APPLICABLE',
                status: 'IMPLEMENTED',
            },
        });
        const ranked = await getBestValueControls(ctx, 10);
        expect(ranked.find((r) => r.controlId === control.id)).toBeUndefined();
    });
});
