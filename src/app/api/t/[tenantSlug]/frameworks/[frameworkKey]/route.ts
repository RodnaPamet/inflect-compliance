import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getFramework, getFrameworkRequirements, listFrameworkPacks,
    installPack, installPacks, computeCoverage, computeInheritedCoverage,
    previewPackInstall, previewPacksInstall,
    listTemplates, installSingleTemplate, bulkMapControls,
    bulkInstallTemplates, exportCoverageData,
    computeRequirementsDiff, exportReadinessReport,
} from '@/app-layer/usecases/framework';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { contentDispositionHeader } from '@/lib/http/content-disposition';

// One pack (`packKey`), or several packs of THIS framework (`packKeys`) —
// the subcategories a tenant chose. At least one is required either way.
const InstallSchema = z.union([
    z.object({ packKeys: z.array(z.string().min(1)).min(1).max(20) }).strip(),
    z.object({ packKey: z.string().min(1) }).strip(),
]);

const InstallTemplateSchema = z.object({
    templateCode: z.string().min(1),
}).strip();

const BulkMapSchema = z.object({
    mappings: z.array(z.object({
        controlId: z.string().min(1),
        requirementIds: z.array(z.string().min(1)).min(1),
    })).min(1).max(200),
}).strip();

const BulkInstallSchema = z.object({
    templateCodes: z.array(z.string().min(1)).min(1).max(100),
}).strip();

// GET /api/t/[tenantSlug]/frameworks/[frameworkKey]?action=...
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; frameworkKey: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const version = url.searchParams.get('version') || undefined;
    const action = url.searchParams.get('action');

    if (action === 'requirements') {
        return jsonResponse(await getFrameworkRequirements(ctx, params.frameworkKey, version));
    }
    if (action === 'packs') {
        return jsonResponse(await listFrameworkPacks(ctx, params.frameworkKey, version));
    }
    if (action === 'coverage') {
        return jsonResponse(await computeCoverage(ctx, params.frameworkKey, version));
    }
    if (action === 'inherited-coverage') {
        return jsonResponse(await computeInheritedCoverage(ctx, params.frameworkKey));
    }
    if (action === 'preview') {
        const packKeys = url.searchParams.get('packKeys');
        if (packKeys !== null) {
            return jsonResponse(await previewPacksInstall(ctx, params.frameworkKey, packKeys.split(',')));
        }
        const packKey = url.searchParams.get('packKey');
        if (!packKey) return jsonResponse({ error: 'packKey required' }, { status: 400 });
        return jsonResponse(await previewPackInstall(ctx, packKey));
    }
    if (action === 'templates') {
        const filters = {
            frameworkKey: params.frameworkKey,
            section: url.searchParams.get('section') || undefined,
            category: url.searchParams.get('category') || undefined,
            search: url.searchParams.get('search') || undefined,
        };
        return jsonResponse(await listTemplates(ctx, filters));
    }
    if (action === 'export') {
        const format = (url.searchParams.get('format') as 'json' | 'csv') || 'json';
        const data = await exportCoverageData(ctx, params.frameworkKey, format);
        if (format === 'csv' && 'csv' in data) {
            return new NextResponse(data.csv, {
                headers: {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': contentDispositionHeader(data.filename),
                },
            });
        }
        return jsonResponse(data);
    }
    if (action === 'diff') {
        const from = url.searchParams.get('from');
        if (!from) return jsonResponse({ error: 'from required' }, { status: 400 });
        return jsonResponse(await computeRequirementsDiff(ctx, from, params.frameworkKey));
    }
    if (action === 'readiness') {
        const format = (url.searchParams.get('format') as 'json' | 'csv') || 'json';
        const data = await exportReadinessReport(ctx, params.frameworkKey, format);
        if (format === 'csv' && 'csv' in data) {
            return new NextResponse(data.csv, {
                headers: {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': contentDispositionHeader(data.filename),
                },
            });
        }
        return jsonResponse(data);
    }

    return jsonResponse(await getFramework(ctx, params.frameworkKey, version));
});

// POST /api/t/[tenantSlug]/frameworks/[frameworkKey]
export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; frameworkKey: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const raw = await req.json();

    if (action === 'install-template') {
        const body = InstallTemplateSchema.parse(raw);
        return jsonResponse(await installSingleTemplate(ctx, body.templateCode), { status: 201 });
    }
    if (action === 'bulk-map') {
        const body = BulkMapSchema.parse(raw);
        return jsonResponse(await bulkMapControls(ctx, params.frameworkKey, body.mappings), { status: 200 });
    }
    if (action === 'bulk-install') {
        const body = BulkInstallSchema.parse(raw);
        return jsonResponse(await bulkInstallTemplates(ctx, body.templateCodes), { status: 201 });
    }
    // There is no action that edits a framework's requirements. They are one
    // catalogue every workspace reads, kept by the deploy-time seeding and
    // import scripts (`scripts/seed-framework-catalogs.ts`,
    // `scripts/framework-import.ts`). `?action=upsert-requirements` let any
    // workspace's Owner or Admin rewrite, add or retire requirements of any
    // framework for every other workspace, unaudited, and no screen called it
    // (#4125 follow-up). It now falls through like any unknown action.

    // Default: install the chosen pack(s)
    const body = InstallSchema.parse(raw);
    if ('packKeys' in body) {
        return jsonResponse(await installPacks(ctx, params.frameworkKey, body.packKeys), { status: 201 });
    }
    return jsonResponse(await installPack(ctx, body.packKey), { status: 201 });
});
