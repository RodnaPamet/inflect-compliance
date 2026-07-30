/**
 * RQ-10 — executive risk reporting (capstone).
 *
 * Assembles data from across the risk-quantification surfaces (portfolio
 * ALE + top risks + Monte Carlo VaR + appetite + BIA) and renders a
 * board-ready PDF/CSV, stored via the file provider with a ReportRun
 * lifecycle row. Plus template + schedule management.
 *
 * @module usecases/risk-report
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { notFound, badRequest } from '@/lib/errors/types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { resolveALE } from './fair-calculator';
import { getLatestSimulation } from './monte-carlo';
import { getAppetiteStatus } from './risk-appetite';
import { renderCsv, renderPdf, renderPptx, type ReportData } from '../reports/risk-report-render';
import { getStorageProvider, generatePathKey, assertTenantKey } from '@/lib/storage';
import { sendEmail } from '@/lib/mailer';
import { getSharePointClient, listSharePointConnections } from '../integrations/providers/sharepoint';
import {
    resolveScheduleRecipients,
    MAX_EMAIL_ATTACHMENT_BYTES,
} from './report-recipients';

export type ReportFormat = 'PDF' | 'CSV' | 'PPTX';

export const FORMAT_META: Record<ReportFormat, { ext: string; mime: string }> = {
    PDF: { ext: 'pdf', mime: 'application/pdf' },
    CSV: { ext: 'csv', mime: 'text/csv' },
    PPTX: { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

export interface ReportParameters {
    confidenceLevel?: number;
    riskId?: string;
}

// ── Data assembly ─────────────────────────────────────────────────────

export async function assembleReportData(
    ctx: RequestContext,
    title: string,
    opts: { riskId?: string } = {},
): Promise<ReportData> {
    const [risks, latestSim, appetite, tenant] = await Promise.all([
        runInTenantContext(ctx, (db) =>
            db.risk.findMany({
                // PR-L — RISK_DEEP_DIVE scopes to a single risk when a riskId
                // is supplied; otherwise the report is portfolio-wide.
                where: { tenantId: ctx.tenantId, deletedAt: null, ...(opts.riskId ? { id: opts.riskId } : {}) },
                select: { id: true, title: true, category: true, fairAle: true, sleAmount: true, aroAmount: true, rtoHours: true, rpoHours: true, revenueAtRisk: true },
                take: 10000,
            }),
        ),
        getLatestSimulation(ctx),
        getAppetiteStatus(ctx),
        // Tenant is global (no RLS) — resolve the display name for the report header.
        runInTenantContext(ctx, (db) => db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true, currencySymbol: true } })),
    ]);

    // RQ3-4 — per-risk P90s from the latest run's cached results.
    const tailByRisk = new Map<string, number>();
    if (Array.isArray(latestSim?.perRiskResultsJson)) {
        for (const e of latestSim.perRiskResultsJson as Array<Record<string, unknown>>) {
            if (typeof e?.riskId === 'string' && typeof e?.aleP90 === 'number') {
                tailByRisk.set(e.riskId, e.aleP90);
            }
        }
    }

    let totalAle = 0, quantifiedCount = 0, maxAle = 0, withRto = 0, withRpo = 0, totalRevenueAtRisk = 0;
    const quantified: Array<{ title: string; category: string | null; ale: number; aleP90: number | null }> = [];
    for (const r of risks) {
        const ale = resolveALE({ fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount });
        if (ale != null) { totalAle += ale; quantifiedCount++; if (ale > maxAle) maxAle = ale; quantified.push({ title: r.title, category: r.category, ale, aleP90: tailByRisk.get(r.id) ?? null }); }
        if (r.rtoHours != null) withRto++;
        if (r.rpoHours != null) withRpo++;
        if (r.revenueAtRisk != null) totalRevenueAtRisk += r.revenueAtRisk;
    }
    const topRisks = quantified.sort((a, b) => b.ale - a.ale).slice(0, 10);

    return {
        title,
        tenantName: tenant?.name ?? ctx.tenantId,
        currencySymbol: tenant?.currencySymbol ?? '€',
        generatedAt: new Date().toISOString(),
        totals: { totalRiskCount: risks.length, quantifiedCount, totalAle, avgAle: quantifiedCount > 0 ? totalAle / quantifiedCount : null, maxAle: quantifiedCount > 0 ? maxAle : null },
        var: latestSim ? { mean: latestSim.portfolioMean, p95: latestSim.portfolioP95, p99: latestSim.portfolioP99 } : null,
        appetite: appetite.status === 'NONE' ? null : { status: appetite.status, portfolioAle: appetite.portfolioAle },
        topRisks,
        bia: { withRto, withRpo, totalRevenueAtRisk },
    };
}

// ── Templates ─────────────────────────────────────────────────────────

const SYSTEM_TEMPLATES = [
    { name: 'Portfolio Risk Summary', type: 'PORTFOLIO_SUMMARY', description: 'Executive VaR + top risks + appetite + BIA.' },
    { name: 'Risk Deep Dive', type: 'RISK_DEEP_DIVE', description: 'Single-risk FAIR decomposition + history.' },
    { name: 'Business Impact Analysis', type: 'BIA', description: 'RTO/RPO/MTPD + impact + revenue at risk.' },
];

/** List templates, lazily seeding the 3 system templates for the tenant. */
export async function listTemplates(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.reportTemplate.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' }, take: 200 });
        const haveSystem = new Set(existing.filter((t) => t.isSystem).map((t) => t.type));
        const missing = SYSTEM_TEMPLATES.filter((t) => !haveSystem.has(t.type));
        if (missing.length === 0) return existing;
        await db.reportTemplate.createMany({
            data: missing.map((t) => ({ tenantId: ctx.tenantId, name: t.name, description: t.description, type: t.type, configJson: {} as Prisma.InputJsonValue, isSystem: true })),
        });
        return db.reportTemplate.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' }, take: 200 });
    });
}

export async function createTemplate(ctx: RequestContext, input: { name: string; type: string; description?: string; configJson?: Record<string, unknown> }) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, (db) =>
        db.reportTemplate.create({ data: { tenantId: ctx.tenantId, name: input.name, type: input.type, description: input.description ?? null, configJson: (input.configJson ?? {}) as Prisma.InputJsonValue, isSystem: false } }),
    );
}

// ── Generation ────────────────────────────────────────────────────────

export async function generateReport(
    ctx: RequestContext,
    templateId: string,
    parameters: ReportParameters,
    format: ReportFormat,
    /**
     * Who to record as having requested this run.
     *
     * Defaults to `ctx.userId`, which is right for an interactive request. The
     * scheduled-delivery cron passes the SCHEDULE'S AUTHOR instead: it executes
     * as a synthetic system principal, and stamping that principal here would
     * lose the only record of who set the recurring export up. Explicit `null`
     * is honest for a pre-existing schedule whose authorship was never captured.
     */
    opts: { requestedBy?: string | null } = {},
) {
    assertCanWrite(ctx);
    const template = await runInTenantContext(ctx, (db) => db.reportTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId } }));
    if (!template) throw notFound('Report template not found');

    const run = await runInTenantContext(ctx, (db) =>
        db.reportRun.create({ data: { tenantId: ctx.tenantId, templateId, parametersJson: parameters as unknown as Prisma.InputJsonValue, format, status: 'GENERATING', requestedBy: opts.requestedBy !== undefined ? opts.requestedBy : ctx.userId, startedAt: new Date() } }),
    );

    try {
        // RISK_DEEP_DIVE honours parameters.riskId to scope to one risk.
        const scopeRiskId = template.type === 'RISK_DEEP_DIVE' ? parameters.riskId : undefined;
        const data = await assembleReportData(ctx, template.name, { riskId: scopeRiskId });
        const buffer = format === 'CSV' ? renderCsv(data) : format === 'PPTX' ? await renderPptx(data) : await renderPdf(data);
        const { ext, mime } = FORMAT_META[format];
        const pathKey = generatePathKey(ctx.tenantId, `report-${run.id}.${ext}`);
        await getStorageProvider().write(pathKey, buffer, { mimeType: mime });
        return runInTenantContext(ctx, (db) =>
            db.reportRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', outputPath: pathKey, outputSizeBytes: buffer.length, completedAt: new Date() } }),
        );
    } catch (err) {
        await runInTenantContext(ctx, (db) =>
            db.reportRun.update({ where: { id: run.id }, data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : String(err), completedAt: new Date() } }),
        );
        throw err;
    }
}

export async function getReport(ctx: RequestContext, reportRunId: string) {
    assertCanRead(ctx);
    const r = await runInTenantContext(ctx, (db) => db.reportRun.findFirst({ where: { id: reportRunId, tenantId: ctx.tenantId } }));
    if (!r) throw notFound('Report run not found');
    return r;
}

/**
 * Open a COMPLETED report's stored artefact as a stream, asserting the storage
 * key belongs to this tenant first.
 *
 * ── Why ctx is a parameter ──────────────────────────────────────────
 *
 * This took a bare `outputPath` with no ctx, which made the tenant assertion
 * structurally impossible to write — the function had nothing to compare
 * against. Not exploitable today (`outputPath` is only ever produced by
 * `generatePathKey(ctx.tenantId, …)` and the ReportRun row is read
 * tenant-scoped), but that is a property of the current callers, not of this
 * function, and it is exactly the missing guard that made the cross-tenant read
 * in audit-hardening possible elsewhere. Matches `evidence.ts`'s
 * `assertTenantKey` usage.
 *
 * Returns the stream, NOT a Buffer: the download route used to Buffer.concat
 * the whole artefact into memory before writing a byte to the client.
 */
export function openReportArtefact(ctx: RequestContext, outputPath: string) {
    assertTenantKey(outputPath, ctx.tenantId);
    return getStorageProvider().readStream(outputPath);
}

/**
 * Read a COMPLETED report's artefact fully into memory.
 *
 * Only for paths that genuinely need the bytes at once — an email attachment
 * (which must be sized and encoded) and the SharePoint upload primitive. Prefer
 * `openReportArtefact` anywhere the destination is a stream.
 */
export async function readReportArtefact(ctx: RequestContext, outputPath: string): Promise<Buffer> {
    const stream = openReportArtefact(ctx, outputPath);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
}

/**
 * RQ-10 delivery — email a generated report to its schedule recipients as an
 * attachment. No-op if the run isn't COMPLETED or there are no recipients.
 * Returns the number of recipients the email was addressed to.
 */
export async function deliverReportByEmail(
    ctx: RequestContext,
    run: { id: string; outputPath: string | null; format: string; status: string },
    recipients: string[],
    label: string,
): Promise<number> {
    if (run.status !== 'COMPLETED' || !run.outputPath || recipients.length === 0) return 0;
    const meta = FORMAT_META[run.format as ReportFormat] ?? FORMAT_META.PDF;
    const content = await readReportArtefact(ctx, run.outputPath);
    // mailer.ts has no size logic, so without this an oversized artefact was
    // handed straight to the transport — failing the delivery opaquely, or
    // succeeding and mailing tens of megabytes to every recipient. Refuse
    // loudly instead: the run itself is COMPLETED and downloadable.
    if (content.length > MAX_EMAIL_ATTACHMENT_BYTES) {
        throw badRequest(
            `Report is ${Math.round(content.length / 1024 / 1024)} MB, over the ` +
                `${Math.round(MAX_EMAIL_ATTACHMENT_BYTES / 1024 / 1024)} MB email attachment limit. ` +
                'Deliver it to SharePoint or download it directly.',
        );
    }
    await sendEmail({
        to: recipients.join(', '),
        subject: `Scheduled risk report — ${label}`,
        text: `Your scheduled risk report "${label}" is attached (report-${run.id}.${meta.ext}).`,
        attachments: [{ filename: `risk-report-${run.id}.${meta.ext}`, content, contentType: meta.mime }],
    });
    return recipients.length;
}

/**
 * RQ-10 delivery — push a generated report to a SharePoint drive folder via the
 * SP-3 Graph client (`uploadNewFile`). No-op if the run isn't COMPLETED, no
 * driveId is configured, or the tenant has no SharePoint connection. Returns the
 * created drive-item id, or null if nothing was pushed.
 */
export async function deliverReportToSharePoint(
    ctx: RequestContext,
    run: { id: string; outputPath: string | null; format: string; status: string },
    driveId: string | null,
    folderId: string | null,
    label: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
    if (run.status !== 'COMPLETED' || !run.outputPath || !driveId) return null;
    // Two fixes in one line. `[0]` picked whichever connection the query
    // happened to return first — with `orderBy: createdAt desc` that is the
    // NEWEST, which is neither documented nor stable across a re-connect — and
    // it did not test `isEnabled`, which was selected and never read, so a
    // DISABLED integration still received pushed reports. Filter, then take the
    // oldest ENABLED one so the choice is deterministic and stable.
    const connections = await listSharePointConnections(ctx);
    const enabled = connections
        .filter((c: { isEnabled: boolean }) => c.isEnabled)
        .sort((a: { createdAt: Date }, b: { createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime());
    const connectionId = enabled[0]?.id;
    if (!connectionId) return null;
    const client = await getSharePointClient(ctx, connectionId, deps);
    const meta = FORMAT_META[run.format as ReportFormat] ?? FORMAT_META.PDF;
    const content = await readReportArtefact(ctx, run.outputPath);
    const safe = label.replace(/[^\w.-]+/g, '-');
    const item = await client.uploadNewFile(driveId, folderId ?? 'root', `${safe}-${run.id}.${meta.ext}`, content, meta.mime);
    return item.id;
}

export async function listReports(ctx: RequestContext, opts: { limit?: number } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => db.reportRun.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: Math.min(opts.limit ?? 50, 200) }));
}

// ── Schedules ─────────────────────────────────────────────────────────

/** Next run instant for a cadence (pure). */
export function computeNextRun(cadence: string, from: Date): Date {
    const d = new Date(from);
    if (cadence === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
    else if (cadence === 'QUARTERLY') d.setUTCMonth(d.getUTCMonth() + 3);
    else d.setUTCMonth(d.getUTCMonth() + 1); // MONTHLY default
    return d;
}

export interface CreateScheduleInput { templateId: string; cadence: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'; format?: ReportFormat; recipients: string[]; parameters?: ReportParameters; deliveryDay?: number; sharePointDriveId?: string | null; sharePointFolderId?: string | null }

export async function createSchedule(ctx: RequestContext, input: CreateScheduleInput) {
    assertCanWrite(ctx);
    if (!input.recipients?.length && !input.sharePointDriveId) throw badRequest('A schedule needs at least one recipient or a SharePoint destination');

    // A schedule is a STANDING outbound feed, so its destination is validated
    // here rather than trusted from the request: every recipient must be an
    // ACTIVE member or allowlisted, and aiming off-tenant needs
    // `reports.schedule_external`. See report-recipients.ts.
    const { recipients } = await resolveScheduleRecipients(ctx, input.recipients ?? []);

    // Mirror generateReport's check (:128). Without it a cross-tenant id was
    // stamped with THIS tenant's tenantId, producing a schedule whose FK points
    // at another tenant's template — permanently broken, and a tenant/FK
    // inconsistency that no later read can repair.
    const template = await runInTenantContext(ctx, (db) =>
        db.reportTemplate.findFirst({ where: { id: input.templateId, tenantId: ctx.tenantId }, select: { id: true } }),
    );
    if (!template) throw notFound('Report template not found');

    return runInTenantContext(ctx, (db) =>
        db.reportSchedule.create({
            data: {
                tenantId: ctx.tenantId, templateId: input.templateId, cadence: input.cadence, format: input.format ?? 'PDF',
                recipientsJson: recipients as unknown as Prisma.InputJsonValue, parametersJson: (input.parameters ?? {}) as unknown as Prisma.InputJsonValue,
                deliveryDay: input.deliveryDay ?? null, isActive: true, nextRunAt: computeNextRun(input.cadence, new Date()),
                sharePointDriveId: input.sharePointDriveId ?? null, sharePointFolderId: input.sharePointFolderId ?? null,
                // Attribution, so the delivery cron never has to borrow an
                // admin identity to explain who set this up.
                createdByUserId: ctx.userId,
            },
        }),
    );
}

export async function updateSchedule(
    ctx: RequestContext,
    scheduleId: string,
    patch: {
        isActive?: boolean;
        cadence?: string;
        recipients?: string[];
        format?: ReportFormat;
        parameters?: ReportParameters;
    },
) {
    assertCanWrite(ctx);
    // The edit path is the same exfiltration channel as create — gating only
    // create would let a writer save an innocuous schedule and then re-point it.
    const resolved = patch.recipients
        ? (await resolveScheduleRecipients(ctx, patch.recipients)).recipients
        : undefined;
    await runInTenantContext(ctx, (db) =>
        db.reportSchedule.updateMany({
            where: { id: scheduleId, tenantId: ctx.tenantId },
            data: {
                ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
                // Changing the cadence MUST move the next run with it.
                //
                // It did not, so switching MONTHLY → WEEKLY left the stored
                // `nextRunAt` a month out and the row went on rendering that
                // date — the UI stated a schedule the system was not keeping.
                // `computeNextRun` was already right here in this file.
                //
                // Recomputed from NOW rather than from the old nextRunAt: the
                // user has just re-declared how often they want this, and
                // anchoring to a date chosen under the previous cadence would
                // make the first run of the new one arbitrary.
                ...(patch.cadence
                    ? { cadence: patch.cadence, nextRunAt: computeNextRun(patch.cadence, new Date()) }
                    : {}),
                ...(resolved ? { recipientsJson: resolved as unknown as Prisma.InputJsonValue } : {}),
                ...(patch.format ? { format: patch.format } : {}),
                ...(patch.parameters
                    ? { parametersJson: patch.parameters as unknown as Prisma.InputJsonValue }
                    : {}),
            },
        }),
    );
}

export async function deleteSchedule(ctx: RequestContext, scheduleId: string) {
    assertCanWrite(ctx);
    await runInTenantContext(ctx, (db) => db.reportSchedule.deleteMany({ where: { id: scheduleId, tenantId: ctx.tenantId } }));
}

export async function listSchedules(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => db.reportSchedule.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: 200 }));
}
