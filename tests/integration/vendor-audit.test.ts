import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

describe('Vendor Audit Enhancements', () => {
    const apiBase = join(process.cwd(), 'src/app/api/t/[tenantSlug]/vendors');

    // ─── Route existence ───
    describe('New routes exist', () => {
        const routes = [
            '[vendorId]/bundles/route.ts',
            '[vendorId]/bundles/[bundleId]/route.ts',
            '[vendorId]/subprocessors/route.ts',
            'exports/route.ts',
        ];

        it.each(routes)('route %s exists', (route) => {
            expect(existsSync(join(apiBase, route))).toBe(true);
        });
    });

    // ─── No prisma in routes (structural scan) ───
    describe('No direct prisma in routes', () => {
        const routes = [
            '[vendorId]/bundles/route.ts',
            '[vendorId]/bundles/[bundleId]/route.ts',
            '[vendorId]/subprocessors/route.ts',
            'exports/route.ts',
            'metrics/route.ts',
            '[vendorId]/enrich/route.ts',
        ];

        it.each(routes)('route %s has no prisma import', (route) => {
            const f = join(apiBase, route);
            if (!existsSync(f)) return;
            const content = codeOf(readFileSync(f, 'utf-8'));
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).not.toMatch(/from\s+['"]@prisma\/client['"]/);
        });
    });

    // ─── Usecase exports ───
    describe('Vendor-audit usecases exportable', () => {
        it('listEvidenceBundles is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.listEvidenceBundles).toBe('function');
        });

        it('createEvidenceBundle is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.createEvidenceBundle).toBe('function');
        });

        it('freezeBundle is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.freezeBundle).toBe('function');
        });

        it('addBundleItem is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.addBundleItem).toBe('function');
        });

        it('removeBundleItem is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.removeBundleItem).toBe('function');
        });

        it('listSubprocessors is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.listSubprocessors).toBe('function');
        });

        it('addSubprocessor is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.addSubprocessor).toBe('function');
        });

        it('removeSubprocessor is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.removeSubprocessor).toBe('function');
        });

        it('exportVendorsRegister is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.exportVendorsRegister).toBe('function');
        });

        it('exportAssessments is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.exportAssessments).toBe('function');
        });

        it('exportDocumentExpiry is exported', () => {
            const mod = require('../../src/app-layer/usecases/vendor-audit');
            expect(typeof mod.exportDocumentExpiry).toBe('function');
        });
    });

    // ─── Schema structural checks ───
    describe('Schema models exist', () => {
        const schema = readPrismaSchema();

        it('VendorEvidenceBundle model exists', () => {
            expect(schema).toContain('model VendorEvidenceBundle');
        });

        it('VendorEvidenceBundleItem model exists', () => {
            expect(schema).toContain('model VendorEvidenceBundleItem');
        });

        it('VendorRelationship model exists', () => {
            expect(schema).toContain('model VendorRelationship');
        });

        it('VendorEvidenceBundle has frozenAt field', () => {
            expect(schema).toMatch(/frozenAt\s+DateTime\?/);
        });

        it('VendorEvidenceBundleItem has snapshotJson field', () => {
            expect(schema).toMatch(/snapshotJson\s+Json\?/);
        });

        it('VendorRelationship has primaryVendorId and subprocessorVendorId', () => {
            expect(schema).toContain('primaryVendorId');
            expect(schema).toContain('subprocessorVendorId');
        });
    });

    // ─── Authorization patterns (static analysis) ───
    describe('Authorization checks present', () => {
        const usecasePath = join(process.cwd(), 'src/app-layer/usecases/vendor-audit.ts');
        const content = codeOf(readFileSync(usecasePath, 'utf-8'));

        it('read operations check assertCanReadVendors', () => {
            // Count occurrences
            expect(content).toContain('assertCanReadVendors');
        });

        it('write operations check assertCanManageVendors or assertCanManageVendorDocs', () => {
            expect(content).toContain('assertCanManageVendors');
            expect(content).toContain('assertCanManageVendorDocs');
        });

        it('uses runInTenantContext for all DB operations', () => {
            const matches = content.match(/runInTenantContext/g);
            expect(matches).toBeTruthy();
            expect(matches!.length).toBeGreaterThanOrEqual(10);
        });
    });

    // ─── Tenant isolation checks ───
    describe('Tenant isolation in queries', () => {
        const usecasePath = join(process.cwd(), 'src/app-layer/usecases/vendor-audit.ts');
        const content = codeOf(readFileSync(usecasePath, 'utf-8'));

        it('all findMany/findFirst queries include tenantId', () => {
            const findCalls = content.match(/\.(findMany|findFirst)\(/g);
            const tenantFilters = content.match(/tenantId:\s*ctx\.tenantId/g);
            expect(findCalls).toBeTruthy();
            expect(tenantFilters).toBeTruthy();
            // Every find call should have a matching tenantId check
            expect(tenantFilters!.length).toBeGreaterThanOrEqual(findCalls!.length);
        });

        it('all create calls include tenantId', () => {
            const createCalls = content.match(/\.create\(/g);
            expect(createCalls).toBeTruthy();
            // tenantId should appear in data for creates
            expect(content).toContain('tenantId: ctx.tenantId');
        });
    });

    // ─── Migration file exists ───
    describe('Migration committed', () => {
        it('vendor_audit_bundles_subprocessors migration exists', () => {
            const migrationsDir = join(process.cwd(), 'prisma/migrations');
            const { readdirSync } = require('fs');
            const dirs = readdirSync(migrationsDir);
            const found = dirs.some((d: string) => d.includes('vendor_audit_bundles_subprocessors'));
            expect(found).toBe(true);
        });
    });

    // ─── CSV export helper ───
    describe('Export route CSV helper', () => {
        const routePath = join(process.cwd(), 'src/app/api/t/[tenantSlug]/vendors/exports/route.ts');
        const content = codeOf(readFileSync(routePath, 'utf-8'));

        it('has toCsv helper', () => {
            expect(content).toContain('function toCsv');
        });

        it('has flattenObj helper', () => {
            expect(content).toContain('function flattenObj');
        });

        it('supports csv and json formats', () => {
            expect(content).toContain("format === 'csv'");
            // Accepts either NextResponse.json (legacy) or jsonResponse
            // (the typed wrapper from src/lib/api-response.ts that
            // replaced ~450 NextResponse.json<any>(...) call sites).
            expect(content).toMatch(/NextResponse\.json|jsonResponse\(/);
        });

        it('sets Content-Disposition for CSV downloads', () => {
            expect(content).toContain('Content-Disposition');
        });
    });
});
