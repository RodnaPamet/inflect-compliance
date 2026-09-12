/**
 * RQ-6 — KRI readings (DB-backed): RAG persistence, worsening-crossing
 * breach flag, batch, system readings.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createKri, recordReading, batchRecordReadings, getReadings, getRiskKriBreaches } from '@/app-layer/usecases/key-risk-indicator';
import { getRiskStaleness } from '@/app-layer/usecases/risk-staleness';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `kri-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-6 — KRI readings (integration)', () => {
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
        for (const m of ['taskLink', 'task', 'kriReading', 'keyRiskIndicator', 'riskScoreEvent', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('stores RAG status + flags a worsening (GREEN→AMBER→RED) crossing, not improvements', async () => {
        const kri = await createKri(ctx, { name: 'Phishing rate', direction: 'HIGHER_IS_WORSE', greenMax: 5, amberMax: 10 });

        const r1 = await recordReading(ctx, kri.id, { value: 3 }); // GREEN, first reading → not a breach
        expect(r1.rag).toBe('GREEN');
        expect(r1.breached).toBe(false);
        expect(r1.reading.ragStatus).toBe('GREEN');

        const r2 = await recordReading(ctx, kri.id, { value: 7 }); // GREEN→AMBER worsening
        expect(r2.rag).toBe('AMBER');
        expect(r2.breached).toBe(true);

        const r3 = await recordReading(ctx, kri.id, { value: 12 }); // AMBER→RED worsening
        expect(r3.breached).toBe(true);

        const r4 = await recordReading(ctx, kri.id, { value: 2 }); // RED→GREEN improvement → NOT a breach
        expect(r4.rag).toBe('GREEN');
        expect(r4.breached).toBe(false);

        // Breach audit rows only on the two worsening crossings.
        const breaches = await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'KRI_THRESHOLD_BREACH' } });
        expect(breaches).toBe(2);
    });

    it('a RED transition on a risk-linked KRI spawns a real remediation task (no silent swallow)', async () => {
        const risk = await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'Vendor concentration' } });
        const kri = await createKri(ctx, { name: 'Concentration %', riskId: risk.id, direction: 'HIGHER_IS_WORSE', greenMax: 5, amberMax: 10 });
        await recordReading(ctx, kri.id, { value: 3 });          // GREEN
        const red = await recordReading(ctx, kri.id, { value: 12 }); // → RED transition

        // Before the fix this task was created with source:'kri_breach' —
        // an invalid enum member — so the write threw and was swallowed by
        // the surrounding try/catch: remediationTaskId came back null and no
        // task existed. Now it is a real RISK_MONITOR task.
        expect(red.remediationTaskId).toBeTruthy();

        const task = await globalPrisma.task.findFirstOrThrow({
            where: { id: red.remediationTaskId!, tenantId: TENANT_ID },
        });
        expect(task.source).toBe('RISK_MONITOR');
        expect(task.key).toMatch(/^TSK-\d+$/);

        // The breaching reading is pinned to the task for reconciliation.
        const reading = await globalPrisma.kriReading.findFirstOrThrow({ where: { id: red.reading.id } });
        expect(reading.remediationTaskId).toBe(task.id);

        // And it is linked to the originating risk.
        const link = await globalPrisma.taskLink.findFirst({
            where: { taskId: task.id, entityType: 'RISK', entityId: risk.id },
        });
        expect(link).not.toBeNull();
    });

    it('batch records system readings', async () => {
        const a = await createKri(ctx, { name: 'A', greenMax: 5, amberMax: 10 });
        const b = await createKri(ctx, { name: 'B', greenMax: 5, amberMax: 10 });
        const out = await batchRecordReadings(ctx, [{ kriId: a.id, value: 1 }, { kriId: b.id, value: 1 }]);
        expect(out).toHaveLength(2);
        const reads = await getReadings(ctx, a.id);
        expect(reads[0].recordedBy).toBe('system');
    });

    // ── RQ3-7 — the KRI ⇄ staleness loop ──────────────────────────

    it('getRiskKriBreaches returns a risk-linked KRI whose latest reading is RED, and clears on recovery', async () => {
        const risk = await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'Phishing exposure' } });
        const kri = await createKri(ctx, { name: 'Click rate', riskId: risk.id, direction: 'HIGHER_IS_WORSE', greenMax: 5, amberMax: 10 });
        await recordReading(ctx, kri.id, { value: 3 });   // GREEN
        await recordReading(ctx, kri.id, { value: 12 });  // → RED

        const breached = await getRiskKriBreaches(ctx, risk.id);
        expect(breached).toHaveLength(1);
        expect(breached[0]).toMatchObject({ kriId: kri.id, ragStatus: 'RED', value: 12 });

        // Recovery: a later GREEN reading flips the latest band → no breach.
        await recordReading(ctx, kri.id, { value: 1 });
        const recovered = await getRiskKriBreaches(ctx, risk.id);
        expect(recovered).toHaveLength(0);
    });

    it('a RED KRI surfaces SIGNAL_MOVED on the risk staleness report (loop closed)', async () => {
        const risk = await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'Vendor outage exposure' } });
        // Seed an assessment event in the past so the breach is "newer".
        await globalPrisma.riskScoreEvent.create({
            data: {
                tenantId: TENANT_ID, riskId: risk.id, kind: 'INHERENT', source: 'USER',
                likelihood: 3, impact: 3, score: 9,
                createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
        });
        const kri = await createKri(ctx, { name: 'Uptime', riskId: risk.id, direction: 'HIGHER_IS_WORSE', greenMax: 5, amberMax: 10 });
        await recordReading(ctx, kri.id, { value: 3 });
        await recordReading(ctx, kri.id, { value: 15 }); // → RED, now

        const report = await getRiskStaleness(ctx);
        const row = report.staleRisks.find((r) => r.riskId === risk.id);
        expect(row).toBeDefined();
        expect(row!.reasons).toContain('SIGNAL_MOVED');
        expect(row!.description).toMatch(/key risk indicator breached/);
    });
});
