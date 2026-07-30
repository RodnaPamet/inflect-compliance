/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage wave — branch coverage for usecases/risk-report.
 *
 * The existing unit suites (report-renderer, report-sharepoint-delivery,
 * jobs/report-delivery-jobs) cover the renderer + the SharePoint delivery
 * no-op guards. This file targets the UNCOVERED decision branches in the
 * usecase itself:
 *   - assembleReportData aggregation/grouping (ALE present vs null, P90 map
 *     parse, RTO/RPO/revenue accumulation, top-risk sort/slice, empty-data
 *     defaults, sim present vs null, appetite NONE vs set, tenant null
 *     fallbacks)
 *   - listTemplates lazy-seed (all present vs some missing)
 *   - createTemplate optional-field defaults
 *   - generateReport per-format render + COMPLETED vs FAILED paths +
 *     template-not-found
 *   - getReport / listReports found/limit clamps
 *   - deliverReportByEmail no-op guards + happy path + format-meta fallback
 *   - computeNextRun cadence branches
 *   - createSchedule recipient/SharePoint validation
 *   - updateSchedule conditional-spread branches
 *
 * Pure unit test: db-context, prisma, storage, mailer, renderer, and the
 * sibling usecases are mocked at the boundary. No DB.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
}));

// Sibling usecases — controlled per-test so we can drive each branch.
const getLatestSimulation = jest.fn();
const getAppetiteStatus = jest.fn();
jest.mock('@/app-layer/usecases/monte-carlo', () => ({ getLatestSimulation: (...a: any[]) => getLatestSimulation(...a) }));
jest.mock('@/app-layer/usecases/risk-appetite', () => ({ getAppetiteStatus: (...a: any[]) => getAppetiteStatus(...a) }));

// resolveALE: keep the real-ish contract — fairAle wins, else null.
jest.mock('@/app-layer/usecases/fair-calculator', () => ({
    resolveALE: (r: { fairAle: number | null; sleAmount: number | null; aroAmount: number | null }) =>
        r.fairAle != null ? r.fairAle : r.sleAmount != null && r.aroAmount != null ? r.sleAmount * r.aroAmount : null,
}));

const renderCsv = jest.fn((..._a: any[]) => Buffer.from('csv'));
const renderPdf = jest.fn(async (..._a: any[]) => Buffer.from('pdf-bytes'));
const renderPptx = jest.fn(async (..._a: any[]) => Buffer.from('pptx-bytes'));
jest.mock('@/app-layer/reports/risk-report-render', () => ({
    renderCsv: (...a: any[]) => renderCsv(...a),
    renderPdf: (...a: any[]) => renderPdf(...a),
    renderPptx: (...a: any[]) => renderPptx(...a),
}));

const storageWrite = jest.fn(async (..._a: any[]) => undefined);
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({
        write: (...a: any[]) => storageWrite(...a),
        readStream: () => (async function* () { yield Buffer.from('ARTEFACT'); })(),
    }),
    // Keep the REAL key shape so assertTenantKey below is a real check rather
    // than a formality — `${t}/${n}` would not start with `tenants/`.
    generatePathKey: (t: string, n: string) => `tenants/${t}/reports/2026/07/aaaaaaaa-${n}`,
    assertTenantKey: (pathKey: string, tenantId: string) => {
        if (!pathKey.startsWith(`tenants/${tenantId}/`)) {
            throw new Error(`Tenant isolation violation: "${pathKey}" is not in tenant "${tenantId}"`);
        }
    },
}));

const sendEmail = jest.fn(async (..._a: any[]) => undefined);
jest.mock('@/lib/mailer', () => ({ sendEmail: (...a: any[]) => sendEmail(...a) }));

jest.mock('@/app-layer/integrations/providers/sharepoint', () => ({
    listSharePointConnections: jest.fn().mockResolvedValue([]),
    getSharePointClient: jest.fn(),
}));

import {
    assembleReportData,
    listTemplates,
    createTemplate,
    generateReport,
    getReport,
    listReports,
    deliverReportByEmail,
    computeNextRun,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    listSchedules,
    FORMAT_META,
} from '@/app-layer/usecases/risk-report';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb() {
    return {
        risk: { findMany: jest.fn().mockResolvedValue([]) },
        tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme', currencySymbol: '$' }) },
        reportTemplate: {
            findMany: jest.fn().mockResolvedValue([]),
            createMany: jest.fn().mockResolvedValue({ count: 3 }),
            create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'tpl-1', ...data })),
            findFirst: jest.fn(),
        },
        reportRun: {
            create: jest.fn().mockResolvedValue({ id: 'run-1' }),
            update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'run-1', ...data })),
            findFirst: jest.fn(),
            findMany: jest.fn().mockResolvedValue([{ id: 'run-1' }]),
        },
        // resolveScheduleRecipients resolves each recipient against ACTIVE
        // membership, then the tenant's external allowlist.
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue([
                { user: { email: 'a@b.com' } },
                { user: { email: 'c@d.com' } },
            ]),
        },
        tenantSecuritySettings: {
            findUnique: jest.fn().mockResolvedValue({ reportRecipientAllowlistJson: null }),
        },
        reportSchedule: {
            create: jest.fn().mockResolvedValue({ id: 'sch-1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = freshDb();
    // createSchedule now mirrors generateReport's in-tenant template check, so
    // the happy path needs a template to exist.
    mockDbHolder.db.reportTemplate.findFirst.mockResolvedValue({ id: 'tpl-1' });
    // Default sibling-usecase returns; individual tests override.
    getLatestSimulation.mockResolvedValue(null);
    getAppetiteStatus.mockResolvedValue({ status: 'NONE', portfolioAle: 0 });
});

// ── assembleReportData: empty-data defaults ──────────────────────────────
describe('assembleReportData — empty data', () => {
    it('returns null avg/max + no var/appetite when there are no risks', async () => {
        const data = await assembleReportData(ctx, 'My Report');
        expect(data.title).toBe('My Report');
        expect(data.tenantName).toBe('Acme');
        expect(data.currencySymbol).toBe('$');
        expect(data.totals.totalRiskCount).toBe(0);
        expect(data.totals.quantifiedCount).toBe(0);
        expect(data.totals.totalAle).toBe(0);
        expect(data.totals.avgAle).toBeNull(); // quantifiedCount === 0 branch
        expect(data.totals.maxAle).toBeNull(); // quantifiedCount === 0 branch
        expect(data.var).toBeNull(); // latestSim null branch
        expect(data.appetite).toBeNull(); // appetite NONE branch
        expect(data.topRisks).toEqual([]);
        expect(data.bia).toEqual({ withRto: 0, withRpo: 0, totalRevenueAtRisk: 0 });
    });

    it('falls back to tenantId + € when tenant row is null', async () => {
        mockDbHolder.db.tenant.findUnique.mockResolvedValue(null);
        const data = await assembleReportData(ctx, 'T');
        expect(data.tenantName).toBe(ctx.tenantId); // tenant?.name ?? tenantId
        expect(data.currencySymbol).toBe('€'); // ?? '€'
    });
});

// ── assembleReportData: aggregation + grouping + sim + appetite present ───
describe('assembleReportData — populated aggregation', () => {
    it('aggregates ALE, RTO/RPO/revenue, P90 tail map, sim VaR, appetite, top-risk sort/slice', async () => {
        // 12 risks: enough to exercise the slice(0,10), the maxAle update, the
        // null-ALE skip, and the rto/rpo/revenue accumulation independently.
        const risks: any[] = [];
        for (let i = 0; i < 12; i++) {
            risks.push({
                id: `r${i}`,
                title: `Risk ${i}`,
                category: i % 2 === 0 ? 'CYBER' : null,
                fairAle: i === 5 ? null : (i + 1) * 100, // r5 has no fairAle...
                sleAmount: i === 5 ? null : null, // ...and no legacy -> null ALE (skipped)
                aroAmount: null,
                rtoHours: i < 3 ? 4 : null, // 3 with RTO
                rpoHours: i < 2 ? 2 : null, // 2 with RPO
                revenueAtRisk: i < 4 ? 1000 : null, // 4 with revenue
            });
        }
        mockDbHolder.db.risk.findMany.mockResolvedValue(risks);

        getLatestSimulation.mockResolvedValue({
            portfolioMean: 50,
            portfolioP95: 95,
            portfolioP99: 99,
            perRiskResultsJson: [
                { riskId: 'r11', aleP90: 111 }, // valid entry -> mapped (r11 = top ALE, survives slice)
                { riskId: 'r1', aleP90: 'nope' }, // aleP90 not a number -> skipped
                { riskId: 42, aleP90: 7 }, // riskId not a string -> skipped
                { nope: true }, // missing fields -> skipped
            ],
        });
        getAppetiteStatus.mockResolvedValue({ status: 'BREACHED', portfolioAle: 1234 });

        const data = await assembleReportData(ctx, 'Big');

        expect(data.totals.totalRiskCount).toBe(12);
        // r5 produces null ALE so it's skipped: 11 quantified.
        expect(data.totals.quantifiedCount).toBe(11);
        expect(data.totals.avgAle).not.toBeNull();
        expect(data.totals.maxAle).toBe(1200); // r11 = 12*100
        expect(data.bia).toEqual({ withRto: 3, withRpo: 2, totalRevenueAtRisk: 4000 });

        // var present branch
        expect(data.var).toEqual({ mean: 50, p95: 95, p99: 99 });
        // appetite non-NONE branch
        expect(data.appetite).toEqual({ status: 'BREACHED', portfolioAle: 1234 });

        // top risks sorted desc + sliced to 10
        expect(data.topRisks).toHaveLength(10);
        expect(data.topRisks[0].ale).toBe(1200);
        // r11's P90 came from the map; everyone else null
        const r11 = data.topRisks.find((t) => t.title === 'Risk 11');
        expect(r11?.aleP90).toBe(111);
        const r2 = data.topRisks.find((t) => t.title === 'Risk 2');
        expect(r2?.aleP90).toBeNull(); // tailByRisk.get(...) ?? null branch
    });

    it('ignores perRiskResultsJson when it is not an array', async () => {
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'r0', title: 'R0', category: 'X', fairAle: 10, sleAmount: null, aroAmount: null, rtoHours: null, rpoHours: null, revenueAtRisk: null },
        ]);
        getLatestSimulation.mockResolvedValue({ portfolioMean: 1, portfolioP95: 2, portfolioP99: 3, perRiskResultsJson: 'not-an-array' });
        const data = await assembleReportData(ctx, 'T');
        expect(data.topRisks[0].aleP90).toBeNull();
        expect(data.var).not.toBeNull();
    });

    it('uses legacy SLE×ARO when fairAle is absent', async () => {
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'r0', title: 'R0', category: null, fairAle: null, sleAmount: 5, aroAmount: 3, rtoHours: null, rpoHours: null, revenueAtRisk: null },
        ]);
        const data = await assembleReportData(ctx, 'T');
        expect(data.totals.quantifiedCount).toBe(1);
        expect(data.totals.totalAle).toBe(15); // 5 * 3 via mocked resolveALE
    });
});

// ── listTemplates: lazy-seed branches ────────────────────────────────────
describe('listTemplates', () => {
    it('seeds all 3 system templates when none exist, then returns the refetch', async () => {
        const seeded = [{ id: 't1', type: 'PORTFOLIO_SUMMARY', isSystem: true }];
        mockDbHolder.db.reportTemplate.findMany
            .mockResolvedValueOnce([]) // initial: nothing
            .mockResolvedValueOnce(seeded); // post-seed refetch
        const out = await listTemplates(ctx);
        expect(mockDbHolder.db.reportTemplate.createMany).toHaveBeenCalledTimes(1);
        const createdRows = mockDbHolder.db.reportTemplate.createMany.mock.calls[0][0].data;
        expect(createdRows).toHaveLength(3); // all missing
        expect(out).toBe(seeded);
    });

    it('returns existing without seeding when all system templates are present', async () => {
        const existing = [
            { id: 'a', type: 'PORTFOLIO_SUMMARY', isSystem: true },
            { id: 'b', type: 'RISK_DEEP_DIVE', isSystem: true },
            { id: 'c', type: 'BIA', isSystem: true },
            { id: 'd', type: 'CUSTOM', isSystem: false }, // non-system, filtered out of haveSystem
        ];
        mockDbHolder.db.reportTemplate.findMany.mockResolvedValueOnce(existing);
        const out = await listTemplates(ctx);
        expect(mockDbHolder.db.reportTemplate.createMany).not.toHaveBeenCalled(); // missing.length === 0
        expect(out).toBe(existing);
    });

    it('seeds only the missing subset', async () => {
        mockDbHolder.db.reportTemplate.findMany
            .mockResolvedValueOnce([{ id: 'a', type: 'BIA', isSystem: true }]) // only BIA present
            .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        await listTemplates(ctx);
        const createdRows = mockDbHolder.db.reportTemplate.createMany.mock.calls[0][0].data;
        expect(createdRows.map((r: any) => r.type).sort()).toEqual(['PORTFOLIO_SUMMARY', 'RISK_DEEP_DIVE']);
    });
});

// ── createTemplate: optional-field defaulting ────────────────────────────
describe('createTemplate', () => {
    it('defaults description to null and configJson to {} when omitted', async () => {
        await createTemplate(ctx, { name: 'X', type: 'BIA' });
        const data = mockDbHolder.db.reportTemplate.create.mock.calls[0][0].data;
        expect(data.description).toBeNull();
        expect(data.configJson).toEqual({});
        expect(data.isSystem).toBe(false);
    });

    it('passes through provided description + configJson', async () => {
        await createTemplate(ctx, { name: 'X', type: 'BIA', description: 'd', configJson: { a: 1 } });
        const data = mockDbHolder.db.reportTemplate.create.mock.calls[0][0].data;
        expect(data.description).toBe('d');
        expect(data.configJson).toEqual({ a: 1 });
    });
});

// ── generateReport: format dispatch + success/failure ────────────────────
describe('generateReport', () => {
    beforeEach(() => {
        mockDbHolder.db.reportTemplate.findFirst.mockResolvedValue({ id: 'tpl-1', name: 'Portfolio' });
    });

    it('throws notFound when the template is missing', async () => {
        mockDbHolder.db.reportTemplate.findFirst.mockResolvedValue(null);
        await expect(generateReport(ctx, 'missing', {}, 'PDF')).rejects.toThrow(/not found/i);
        expect(mockDbHolder.db.reportRun.create).not.toHaveBeenCalled();
    });

    it('renders CSV and marks the run COMPLETED', async () => {
        const out = await generateReport(ctx, 'tpl-1', {}, 'CSV');
        expect(renderCsv).toHaveBeenCalledTimes(1);
        expect(renderPdf).not.toHaveBeenCalled();
        expect(storageWrite).toHaveBeenCalledTimes(1);
        expect(out.status).toBe('COMPLETED');
        expect(out.outputPath).toContain('report-run-1.csv');
    });

    it('renders PPTX via the async renderer', async () => {
        await generateReport(ctx, 'tpl-1', {}, 'PPTX');
        expect(renderPptx).toHaveBeenCalledTimes(1);
        expect(renderCsv).not.toHaveBeenCalled();
    });

    it('renders PDF by default (neither CSV nor PPTX)', async () => {
        await generateReport(ctx, 'tpl-1', {}, 'PDF');
        expect(renderPdf).toHaveBeenCalledTimes(1);
    });

    it('marks the run FAILED with an Error message when render throws an Error', async () => {
        renderPdf.mockRejectedValueOnce(new Error('boom'));
        await expect(generateReport(ctx, 'tpl-1', {}, 'PDF')).rejects.toThrow('boom');
        const updates = mockDbHolder.db.reportRun.update.mock.calls;
        const failData = updates[updates.length - 1][0].data;
        expect(failData.status).toBe('FAILED');
        expect(failData.errorMessage).toBe('boom'); // err instanceof Error branch
    });

    it('stringifies a non-Error throw into errorMessage', async () => {
        renderPdf.mockImplementationOnce(() => { throw 'stringy'; });
        await expect(generateReport(ctx, 'tpl-1', {}, 'PDF')).rejects.toBe('stringy');
        const updates = mockDbHolder.db.reportRun.update.mock.calls;
        const failData = updates[updates.length - 1][0].data;
        expect(failData.errorMessage).toBe('stringy'); // String(err) branch
    });
});

// ── getReport ────────────────────────────────────────────────────────────
describe('getReport', () => {
    it('returns the run when found', async () => {
        mockDbHolder.db.reportRun.findFirst.mockResolvedValue({ id: 'run-1' });
        expect(await getReport(ctx, 'run-1')).toEqual({ id: 'run-1' });
    });
    it('throws notFound when absent', async () => {
        mockDbHolder.db.reportRun.findFirst.mockResolvedValue(null);
        await expect(getReport(ctx, 'x')).rejects.toThrow(/not found/i);
    });
});

// ── listReports: limit clamps ────────────────────────────────────────────
describe('listReports', () => {
    it('defaults the limit to 50 when none given', async () => {
        await listReports(ctx);
        expect(mockDbHolder.db.reportRun.findMany.mock.calls[0][0].take).toBe(50);
    });
    it('uses a smaller provided limit', async () => {
        await listReports(ctx, { limit: 10 });
        expect(mockDbHolder.db.reportRun.findMany.mock.calls[0][0].take).toBe(10);
    });
    it('clamps a too-large limit to 200', async () => {
        await listReports(ctx, { limit: 9999 });
        expect(mockDbHolder.db.reportRun.findMany.mock.calls[0][0].take).toBe(200);
    });
});

// ── deliverReportByEmail: no-op guards + happy + format fallback ──────────
describe('deliverReportByEmail', () => {
    // `openReportArtefact` now asserts the storage key belongs to the ctx
    // tenant, so the stub key must be a real tenant-scoped key rather than the
    // previous arbitrary 'tenant/report.pdf'.
    const completed = {
        id: 'r1',
        outputPath: `tenants/${ctx.tenantId}/reports/2026/07/aaaaaaaa-report_r1.pdf`,
        format: 'PDF',
        status: 'COMPLETED',
    };

    it('no-ops (0) when the run is not COMPLETED', async () => {
        expect(await deliverReportByEmail(ctx, { ...completed, status: 'FAILED' }, ['a@b.com'], 'L')).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it('no-ops (0) when there is no outputPath', async () => {
        expect(await deliverReportByEmail(ctx, { ...completed, outputPath: null }, ['a@b.com'], 'L')).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it('no-ops (0) when there are no recipients', async () => {
        expect(await deliverReportByEmail(ctx, completed, [], 'L')).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it('sends with PDF meta + returns recipient count', async () => {
        const n = await deliverReportByEmail(ctx, completed, ['a@b.com', 'c@d.com'], 'Q2 Report');
        expect(n).toBe(2);
        const arg = sendEmail.mock.calls[0][0];
        expect(arg.to).toBe('a@b.com, c@d.com');
        expect(arg.attachments[0].contentType).toBe('application/pdf');
        expect(arg.attachments[0].filename).toBe('risk-report-r1.pdf');
    });
    it('falls back to PDF meta when the run format is unknown', async () => {
        const n = await deliverReportByEmail(ctx, { ...completed, format: 'WEIRD' }, ['a@b.com'], 'L');
        expect(n).toBe(1);
        const arg = sendEmail.mock.calls[0][0];
        expect(arg.attachments[0].contentType).toBe(FORMAT_META.PDF.mime); // ?? FORMAT_META.PDF branch
    });
    it('uses CSV meta for a CSV run', async () => {
        await deliverReportByEmail(ctx, { ...completed, format: 'CSV' }, ['a@b.com'], 'L');
        expect(sendEmail.mock.calls[0][0].attachments[0].contentType).toBe('text/csv');
    });
});

// ── computeNextRun: cadence branches ─────────────────────────────────────
describe('computeNextRun', () => {
    const from = new Date('2026-01-15T00:00:00.000Z');
    it('adds 7 days for WEEKLY', () => {
        expect(computeNextRun('WEEKLY', from).toISOString()).toBe('2026-01-22T00:00:00.000Z');
    });
    it('adds 3 months for QUARTERLY', () => {
        expect(computeNextRun('QUARTERLY', from).toISOString()).toBe('2026-04-15T00:00:00.000Z');
    });
    it('adds 1 month for MONTHLY (default branch)', () => {
        expect(computeNextRun('MONTHLY', from).toISOString()).toBe('2026-02-15T00:00:00.000Z');
    });
    it('adds 1 month for any unrecognised cadence (else default)', () => {
        expect(computeNextRun('NONSENSE', from).toISOString()).toBe('2026-02-15T00:00:00.000Z');
    });
});

// ── createSchedule: validation + defaulting ──────────────────────────────
describe('createSchedule', () => {
    it('throws badRequest when there is no recipient and no SharePoint destination', async () => {
        await expect(createSchedule(ctx, { templateId: 't', cadence: 'MONTHLY', recipients: [] }))
            .rejects.toThrow(/at least one recipient/i);
        expect(mockDbHolder.db.reportSchedule.create).not.toHaveBeenCalled();
    });

    it('creates when recipients are present (defaults format/parameters/deliveryDay/SP)', async () => {
        await createSchedule(ctx, { templateId: 't', cadence: 'WEEKLY', recipients: ['a@b.com'] });
        const data = mockDbHolder.db.reportSchedule.create.mock.calls[0][0].data;
        expect(data.format).toBe('PDF'); // ?? 'PDF'
        expect(data.parametersJson).toEqual({}); // ?? {}
        expect(data.deliveryDay).toBeNull(); // ?? null
        expect(data.sharePointDriveId).toBeNull();
        expect(data.sharePointFolderId).toBeNull();
        expect(data.isActive).toBe(true);
    });

    it('creates when only a SharePoint destination is present (no recipients)', async () => {
        await createSchedule(ctx, { templateId: 't', cadence: 'MONTHLY', recipients: [], sharePointDriveId: 'drive-1' });
        expect(mockDbHolder.db.reportSchedule.create).toHaveBeenCalledTimes(1);
    });

    it('passes through provided format/parameters/deliveryDay/SP folder', async () => {
        await createSchedule(ctx, {
            templateId: 't', cadence: 'QUARTERLY', recipients: ['a@b.com'],
            format: 'CSV', parameters: { confidenceLevel: 0.95 }, deliveryDay: 3,
            sharePointDriveId: 'd', sharePointFolderId: 'f',
        });
        const data = mockDbHolder.db.reportSchedule.create.mock.calls[0][0].data;
        expect(data.format).toBe('CSV');
        expect(data.parametersJson).toEqual({ confidenceLevel: 0.95 });
        expect(data.deliveryDay).toBe(3);
        expect(data.sharePointDriveId).toBe('d');
        expect(data.sharePointFolderId).toBe('f');
    });
});

// ── updateSchedule: conditional-spread branches ──────────────────────────
describe('updateSchedule', () => {
    it('updates nothing extra when patch is empty', async () => {
        await updateSchedule(ctx, 's1', {});
        expect(mockDbHolder.db.reportSchedule.updateMany.mock.calls[0][0].data).toEqual({});
    });
    it('includes isActive even when false (undefined-check branch)', async () => {
        await updateSchedule(ctx, 's1', { isActive: false });
        expect(mockDbHolder.db.reportSchedule.updateMany.mock.calls[0][0].data).toEqual({ isActive: false });
    });
    it('includes cadence + recipients when provided', async () => {
        // Recipients must resolve on the EDIT path too — gating only create
        // would let a writer save an innocuous schedule and re-point it after.
        await updateSchedule(ctx, 's1', { cadence: 'WEEKLY', recipients: ['a@b.com'] });
        const data = mockDbHolder.db.reportSchedule.updateMany.mock.calls[0][0].data;
        expect(data.cadence).toBe('WEEKLY');
        expect(data.recipientsJson).toEqual(['a@b.com']);
        expect('isActive' in data).toBe(false);
    });

    it('rejects a non-member recipient on the edit path', async () => {
        await expect(
            updateSchedule(ctx, 's1', { recipients: ['attacker@example.com'] }),
        ).rejects.toThrow(/not a member of this tenant/);
        expect(mockDbHolder.db.reportSchedule.updateMany).not.toHaveBeenCalled();
    });
});

// ── Recipient validation — the exfiltration channel itself ───────────────
describe('scheduled delivery cannot be aimed at an arbitrary address', () => {
    it('refuses a schedule whose recipient is neither a member nor allowlisted', async () => {
        // The headline attack: an EDITOR points the tenant's portfolio-risk PDF
        // at an address they control, weekly, forever.
        await expect(
            createSchedule(ctx, {
                templateId: 'tpl-1',
                cadence: 'WEEKLY',
                recipients: ['attacker@example.com'],
            }),
        ).rejects.toThrow(/not a member of this tenant/);
        expect(mockDbHolder.db.reportSchedule.create).not.toHaveBeenCalled();
    });

    it('accepts an allowlisted external recipient when the caller may schedule externally', async () => {
        mockDbHolder.db.tenantSecuritySettings.findUnique.mockResolvedValue({
            reportRecipientAllowlistJson: ['@kpmg.com'],
        });
        await createSchedule(ctx, {
            templateId: 'tpl-1',
            cadence: 'WEEKLY',
            recipients: ['auditor@kpmg.com'],
        });
        expect(mockDbHolder.db.reportSchedule.create).toHaveBeenCalled();
    });

    it('refuses an allowlisted external recipient WITHOUT reports.schedule_external', async () => {
        // Two independent gates: the allowlist says the address is acceptable,
        // the permission says who may aim a standing feed at it.
        mockDbHolder.db.tenantSecuritySettings.findUnique.mockResolvedValue({
            reportRecipientAllowlistJson: ['@kpmg.com'],
        });
        const editorCtx = {
            ...ctx,
            appPermissions: {
                ...ctx.appPermissions,
                reports: { ...ctx.appPermissions.reports, schedule_external: false },
            },
        };
        await expect(
            createSchedule(editorCtx, {
                templateId: 'tpl-1',
                cadence: 'WEEKLY',
                recipients: ['auditor@kpmg.com'],
            }),
        ).rejects.toThrow(/requires an administrator/);
        expect(mockDbHolder.db.reportSchedule.create).not.toHaveBeenCalled();
    });

    it('caps the recipient count', async () => {
        const many = Array.from({ length: 25 }, (_, i) => `p${i}@acme.test`);
        await expect(
            createSchedule(ctx, { templateId: 'tpl-1', cadence: 'WEEKLY', recipients: many }),
        ).rejects.toThrow(/at most 20 recipients/);
    });

    it('records the schedule author, so the cron need not borrow an identity', async () => {
        await createSchedule(ctx, {
            templateId: 'tpl-1',
            cadence: 'WEEKLY',
            recipients: ['a@b.com'],
        });
        const data = mockDbHolder.db.reportSchedule.create.mock.calls[0][0].data;
        expect(data.createdByUserId).toBe(ctx.userId);
    });

    it('refuses a cross-tenant templateId instead of persisting a broken FK', async () => {
        // generateReport verified the template; createSchedule did not, so a
        // foreign id was stamped with THIS tenant's tenantId.
        mockDbHolder.db.reportTemplate.findFirst.mockResolvedValue(null);
        await expect(
            createSchedule(ctx, {
                templateId: 'tpl-from-another-tenant',
                cadence: 'WEEKLY',
                recipients: ['a@b.com'],
            }),
        ).rejects.toThrow(/Report template not found/);
        expect(mockDbHolder.db.reportSchedule.create).not.toHaveBeenCalled();
    });
});

// ── deleteSchedule / listSchedules ───────────────────────────────────────
describe('deleteSchedule + listSchedules', () => {
    it('deletes by id + tenant', async () => {
        await deleteSchedule(ctx, 's1');
        expect(mockDbHolder.db.reportSchedule.deleteMany).toHaveBeenCalledWith({ where: { id: 's1', tenantId: ctx.tenantId } });
    });
    it('lists schedules', async () => {
        mockDbHolder.db.reportSchedule.findMany.mockResolvedValue([{ id: 's1' }]);
        expect(await listSchedules(ctx)).toEqual([{ id: 's1' }]);
    });
});
