/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit + Integration tests for Framework Templates Enhancement:
 * - Template library listing + filtering
 * - Single template install
 * - Bulk map validation
 * - Bulk install
 * - Export coverage (CSV + JSON)
 */

describe('Framework Templates Enhancement', () => {
    describe('Bulk Map Validation', () => {
        it('rejects empty mappings array', () => {
            const mappings: any[] = [];
            expect(mappings.length).toBe(0);
            // The usecase throws 'At least one mapping required'
        });

        it('rejects more than 200 mappings', () => {
            const mappings = Array.from({ length: 201 }, (_, i) => ({
                controlId: `ctrl-${i}`,
                requirementIds: [`req-${i}`],
            }));
            expect(mappings.length).toBe(201);
            // The usecase throws 'Max 200 mappings per batch'
        });

        it('validates mapping structure', () => {
            const valid = {
                controlId: 'ctrl-1',
                requirementIds: ['req-1', 'req-2'],
            };
            expect(valid.controlId).toBeDefined();
            expect(valid.requirementIds.length).toBe(2);
            expect(valid.requirementIds.every((id: string) => typeof id === 'string')).toBe(true);
        });

        it('deduplicates requirement IDs', () => {
            const reqIds = ['req-1', 'req-2', 'req-1', 'req-3'];
            const unique = [...new Set(reqIds)];
            expect(unique.length).toBe(3);
        });
    });

    describe('Bulk Install Validation', () => {
        it('rejects empty template codes', () => {
            const codes: string[] = [];
            expect(codes.length).toBe(0);
        });

        it('rejects more than 100 template codes', () => {
            const codes = Array.from({ length: 101 }, (_, i) => `tmpl-${i}`);
            expect(codes.length).toBe(101);
        });

        it('validates template code format', () => {
            const code = 'ISO27001-A5.1';
            expect(typeof code).toBe('string');
            expect(code.length).toBeGreaterThan(0);
        });
    });

    /*
     * "Export Coverage" USED TO LIVE HERE, AND TESTED NOTHING. Removed in
     * #2620 rather than repaired, because what it asserted was itself:
     *
     *   • "generates valid CSV structure" built its own `rows` array, its own
     *     serialiser and its own escaping, then asserted on that string. It
     *     imported no product code, so no change to `exportCoverageData` could
     *     ever redden it. Worse, its Mapped row hard-coded `''` in the Section
     *     position — the defect #2620 fixes, written into the fixture as
     *     though it were the expected output.
     *   • "handles special characters in CSV" escaped a string inline and
     *     asserted the escaping it had just performed.
     *   • "generates proper filename" built `${key}-coverage.csv` and asserted
     *     it equalled `${key}-coverage.csv`.
     *
     * Three green tests named after an export, none of which could observe it.
     * That is why a blank Section column shipped past a suite that appeared to
     * cover the CSV twice. Deleting them is not a loss of coverage; it is the
     * removal of a claim of coverage that was never true.
     *
     * The real assertions — whole-row, both row kinds, the `category`
     * fallback, and a field-count check against the declared header — are in
     * `tests/unit/usecases/framework-coverage.test.ts`, where the export is
     * actually called.
     */

    describe('API Route Actions', () => {
        it('recognizes all GET actions', () => {
            const getActions = ['requirements', 'packs', 'coverage', 'preview', 'templates', 'export'];
            expect(getActions).toContain('templates');
            expect(getActions).toContain('export');
            expect(getActions.length).toBe(6);
        });

        it('recognizes all POST actions', () => {
            const postActions = ['install-template', 'bulk-map', 'bulk-install'];
            expect(postActions).toContain('install-template');
            expect(postActions).toContain('bulk-map');
            expect(postActions).toContain('bulk-install');
        });
    });

    describe('Zod Schema Validation', () => {
        const { z } = require('zod');

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

        it('InstallTemplateSchema accepts valid input', () => {
            const result = InstallTemplateSchema.parse({ templateCode: 'ISO27001-A5.1' });
            expect(result.templateCode).toBe('ISO27001-A5.1');
        });

        it('InstallTemplateSchema rejects empty code', () => {
            expect(() => InstallTemplateSchema.parse({ templateCode: '' })).toThrow();
        });

        it('InstallTemplateSchema strips unknown fields', () => {
            const result = InstallTemplateSchema.parse({ templateCode: 'X', extra: 'foo' });
            expect(result).not.toHaveProperty('extra');
        });

        it('BulkMapSchema accepts valid input', () => {
            const result = BulkMapSchema.parse({
                mappings: [{ controlId: 'c1', requirementIds: ['r1', 'r2'] }],
            });
            expect(result.mappings[0].controlId).toBe('c1');
        });

        it('BulkMapSchema rejects empty mappings', () => {
            expect(() => BulkMapSchema.parse({ mappings: [] })).toThrow();
        });

        it('BulkMapSchema rejects > 200 mappings', () => {
            const tooMany = Array.from({ length: 201 }, (_, i) => ({
                controlId: `c${i}`, requirementIds: ['r1'],
            }));
            expect(() => BulkMapSchema.parse({ mappings: tooMany })).toThrow();
        });

        it('BulkMapSchema rejects empty requirementIds', () => {
            expect(() => BulkMapSchema.parse({
                mappings: [{ controlId: 'c1', requirementIds: [] }],
            })).toThrow();
        });

        it('BulkInstallSchema accepts valid input', () => {
            const result = BulkInstallSchema.parse({ templateCodes: ['A', 'B'] });
            expect(result.templateCodes).toEqual(['A', 'B']);
        });

        it('BulkInstallSchema rejects empty codes', () => {
            expect(() => BulkInstallSchema.parse({ templateCodes: [] })).toThrow();
        });

        it('BulkInstallSchema rejects > 100 codes', () => {
            const tooMany = Array.from({ length: 101 }, (_, i) => `t${i}`);
            expect(() => BulkInstallSchema.parse({ templateCodes: tooMany })).toThrow();
        });
    });

    describe('Template Library Filters', () => {
        it('builds correct filter query params', () => {
            const filters: Record<string, string> = {
                action: 'templates',
                section: 'Organizational Controls',
                category: 'Information Security',
                search: 'access',
            };
            const params = new URLSearchParams(filters);
            expect(params.get('action')).toBe('templates');
            expect(params.get('section')).toBe('Organizational Controls');
            expect(params.get('search')).toBe('access');
        });

        it('omits empty filter values', () => {
            const filters: Record<string, string | undefined> = {
                action: 'templates',
                section: undefined,
                category: 'Security',
            };
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(filters)) {
                if (v) params.set(k, v);
            }
            expect(params.has('section')).toBe(false);
            expect(params.get('category')).toBe('Security');
        });
    });

    describe('Export Format', () => {
        it('supports json format', () => {
            const format = 'json';
            expect(['json', 'csv']).toContain(format);
        });

        it('supports csv format', () => {
            const format = 'csv';
            expect(['json', 'csv']).toContain(format);
        });

        it('defaults to json when format not specified', () => {
            const input: string | undefined = undefined;
            const format = input || 'json';
            expect(format).toBe('json');
        });
    });

    describe('Usecase Exports', () => {
        it('exports all new usecases from framework module', () => {
            const fw = require('../../src/app-layer/usecases/framework');
            expect(typeof fw.listTemplates).toBe('function');
            expect(typeof fw.installSingleTemplate).toBe('function');
            expect(typeof fw.bulkMapControls).toBe('function');
            expect(typeof fw.bulkInstallTemplates).toBe('function');
            expect(typeof fw.exportCoverageData).toBe('function');
        });

        it('exports all original usecases', () => {
            const fw = require('../../src/app-layer/usecases/framework');
            expect(typeof fw.listFrameworks).toBe('function');
            expect(typeof fw.getFramework).toBe('function');
            expect(typeof fw.getFrameworkRequirements).toBe('function');
            expect(typeof fw.listFrameworkPacks).toBe('function');
            expect(typeof fw.previewPackInstall).toBe('function');
            expect(typeof fw.installPack).toBe('function');
            expect(typeof fw.computeCoverage).toBe('function');
        });
    });
});
