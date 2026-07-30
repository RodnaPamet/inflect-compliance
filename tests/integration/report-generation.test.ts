/**
 * RQ-10 — report generation (DB-backed): lazy-seeded templates, a CSV run
 * reaches COMPLETED with a stored artefact, invalid template → not found.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { listTemplates, generateReport, getReport, deliverReportByEmail } from '@/app-layer/usecases/risk-report';
import { getStorageProvider } from '@/lib/storage';
import { setEmailProvider, StubEmailProvider } from '@/lib/mailer';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `rpt-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-10 — report generation (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1', fairAle: 300_000, rtoHours: 4, revenueAtRisk: 1_000_000 } });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['reportRun', 'reportSchedule', 'reportTemplate', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('lazy-seeds the 3 system templates', async () => {
        const templates = await listTemplates(ctx);
        const types = templates.filter((t) => t.isSystem).map((t) => t.type).sort();
        expect(types).toEqual(['BIA', 'PORTFOLIO_SUMMARY', 'RISK_DEEP_DIVE']);
    });

    it('generates a CSV report → COMPLETED with a stored artefact', async () => {
        const templates = await listTemplates(ctx);
        const portfolio = templates.find((t) => t.type === 'PORTFOLIO_SUMMARY')!;
        const run = await generateReport(ctx, portfolio.id, {}, 'CSV');
        expect(run.status).toBe('COMPLETED');
        expect(run.outputPath).toBeTruthy();
        expect(run.outputSizeBytes).toBeGreaterThan(0);

        // The stored artefact is readable + carries the KPI header.
        const stream = getStorageProvider().readStream(run.outputPath!);
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
        expect(Buffer.concat(chunks).toString('utf8')).toContain('Metric,Value');

        const reloaded = await getReport(ctx, run.id);
        expect(reloaded.status).toBe('COMPLETED');
    });

    it('an unknown template → not found', async () => {
        await expect(generateReport(ctx, 'does-not-exist', {}, 'CSV')).rejects.toThrow();
    });

    it('deliverReportByEmail emails the artefact as an attachment (RQ-10 delivery)', async () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);
        const templates = await listTemplates(ctx);
        const run = await generateReport(ctx, templates.find((t) => t.type === 'PORTFOLIO_SUMMARY')!.id, {}, 'CSV');

        const sent = await deliverReportByEmail(ctx, run, ['ciso@example.test', 'cfo@example.test'], 'Portfolio Risk Summary');
        expect(sent).toBe(2);
        expect(stub.sentMessages).toHaveLength(1);
        const msg = stub.sentMessages[0];
        expect(msg.to).toContain('ciso@example.test');
        expect(msg.to).toContain('cfo@example.test');
        expect(msg.attachments).toHaveLength(1);
        expect(msg.attachments![0].filename).toMatch(/\.csv$/);
        expect(msg.attachments![0].content.length).toBeGreaterThan(0);
        expect(msg.attachments![0].content.toString('utf8')).toContain('Metric,Value');
    });

    it('deliverReportByEmail is a no-op with no recipients', async () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);
        const run = { id: 'x', outputPath: 'whatever', format: 'CSV', status: 'COMPLETED' };
        expect(await deliverReportByEmail(ctx, run, [], 'X')).toBe(0);
        expect(stub.sentMessages).toHaveLength(0);
    });
});
