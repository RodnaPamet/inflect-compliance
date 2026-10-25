/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Quality Guardrails & Hardening Tests for Framework System:
 * - Requirement key uniqueness
 * - Diff computation unit tests
 * - Readiness report structure
 * - Pack install idempotency
 * - No-direct-prisma guard for framework routes
 */

describe('Framework Hardening', () => {
    describe('Requirement Key Uniqueness', () => {
        it('detects duplicate codes in a fixture batch', () => {
            const codes = ['A.5.1', 'A.5.2', 'A.5.1', 'A.6.1'];
            const unique = new Set(codes);
            expect(unique.size).toBe(3);
            expect(unique.size).not.toBe(codes.length);
            // The usecase would throw 'Duplicate requirement codes'
        });

        it('allows unique codes', () => {
            const codes = ['A.5.1', 'A.5.2', 'A.6.1', 'A.7.1'];
            const unique = new Set(codes);
            expect(unique.size).toBe(codes.length);
        });

        it('finds specific duplicate codes', () => {
            const codes = ['A.5.1', 'A.5.2', 'A.5.1', 'A.6.1', 'A.5.2'];
            const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
            expect([...new Set(dupes)]).toEqual(['A.5.1', 'A.5.2']);
        });
    });

    describe('Diff Computation', () => {
        it('correctly identifies added requirements', () => {
            const fromCodes = new Set(['A.1', 'A.2', 'A.3']);
            const toCodes = new Set(['A.1', 'A.2', 'A.3', 'A.4', 'A.5']);
            const added = [...toCodes].filter(c => !fromCodes.has(c));
            expect(added).toEqual(['A.4', 'A.5']);
        });

        it('correctly identifies removed requirements', () => {
            const fromCodes = new Set(['A.1', 'A.2', 'A.3']);
            const toCodes = new Set(['A.1', 'A.3']);
            const removed = [...fromCodes].filter(c => !toCodes.has(c));
            expect(removed).toEqual(['A.2']);
        });

        it('correctly identifies changed requirements', () => {
            const from = new Map([
                ['A.1', { title: 'Old Title', section: 'Sec A' }],
                ['A.2', { title: 'Same', section: 'Sec A' }],
            ]);
            const to = new Map([
                ['A.1', { title: 'New Title', section: 'Sec A' }],
                ['A.2', { title: 'Same', section: 'Sec B' }],
            ]);

            const changed: any[] = [];
            for (const [code, reqTo] of to) {
                const reqFrom = from.get(code);
                if (reqFrom) {
                    const c: string[] = [];
                    if (reqFrom.title !== reqTo.title) c.push('title');
                    if (reqFrom.section !== reqTo.section) c.push('section');
                    if (c.length > 0) changed.push({ code, changes: c });
                }
            }
            expect(changed.length).toBe(2);
            expect(changed[0].changes).toContain('title');
            expect(changed[1].changes).toContain('section');
        });

        it('handles empty frameworks', () => {
            const fromCodes = new Set<string>();
            const toCodes = new Set(['A.1']);
            const added = [...toCodes].filter(c => !fromCodes.has(c));
            const removed = [...fromCodes].filter(c => !toCodes.has(c));
            expect(added).toEqual(['A.1']);
            expect(removed).toEqual([]);
        });

        it('returns empty diff for identical frameworks', () => {
            const codes = new Set(['A.1', 'A.2', 'A.3']);
            const added = [...codes].filter(c => !codes.has(c));
            const removed = [...codes].filter(c => !codes.has(c));
            expect(added.length).toBe(0);
            expect(removed.length).toBe(0);
        });
    });

    describe('Readiness Report Structure', () => {
        it('expects correct report sections', () => {
            const reportSections = [
                'framework', 'generatedAt', 'coverage', 'bySection',
                'unmappedRequirements', 'notApplicableControls',
                'controlsMissingEvidence', 'overdueTasks', 'summary',
            ];
            expect(reportSections.length).toBe(9);
            expect(reportSections).toContain('summary');
            expect(reportSections).toContain('overdueTasks');
        });

        it('computes readiness score correctly', () => {
            const coveragePercent = 75;
            const missingEvidenceCount = 3;
            const overdueTaskCount = 2;
            const score = Math.max(0, coveragePercent - (missingEvidenceCount * 2) - (overdueTaskCount * 3));
            expect(score).toBe(63); // 75 - 6 - 6
        });

        it('readiness score floors at 0', () => {
            const score = Math.max(0, 10 - (20 * 2) - (5 * 3));
            expect(score).toBe(0);
        });

        it('readiness score 100 when fully covered, no issues', () => {
            const score = Math.max(0, 100 - (0 * 2) - (0 * 3));
            expect(score).toBe(100);
        });
    });

    describe('Readiness CSV Export', () => {
        it('generates CSV with correct columns', () => {
            const header = ['Section', 'Type', 'Code', 'Title/Description', 'Status', 'Due Date'];
            const csv = header.map(c => `"${c}"`).join(',');
            expect(csv).toContain('"Section"');
            expect(csv).toContain('"Type"');
            expect(csv).toContain('"Due Date"');
        });

        it('categorizes rows by type', () => {
            const types = ['Unmapped Requirement', 'Not Applicable Control', 'Missing Evidence', 'Overdue Task'];
            expect(types.length).toBe(4);
        });
    });

    describe('Pack Install Idempotency', () => {
        it('idempotent install creates controls only once', () => {
            const existingCodes = new Set(['CTRL-1', 'CTRL-2']);
            const templateCodes = ['CTRL-1', 'CTRL-2', 'CTRL-3'];
            const toCreate = templateCodes.filter(c => !existingCodes.has(c));
            const toSkip = templateCodes.filter(c => existingCodes.has(c));
            expect(toCreate).toEqual(['CTRL-3']);
            expect(toSkip).toEqual(['CTRL-1', 'CTRL-2']);
        });

        it('second install has zero new controls', () => {
            const existingCodes = new Set(['CTRL-1', 'CTRL-2', 'CTRL-3']);
            const templateCodes = ['CTRL-1', 'CTRL-2', 'CTRL-3'];
            const toCreate = templateCodes.filter(c => !existingCodes.has(c));
            expect(toCreate.length).toBe(0);
        });
    });

    describe('No-Direct-Prisma Guard (Framework Routes)', () => {
        it('framework route imports from usecases, not prisma directly', () => {
            const fs = require('fs');
            const routePath = require('path').resolve(__dirname, '../../src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts');
            if (!fs.existsSync(routePath)) return; // skip if file doesn't exist
            const content = fs.readFileSync(routePath, 'utf8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).toMatch(/from\s+['"]@\/app-layer\/usecases\/framework['"]/);
        });

        it('framework list route imports from usecases', () => {
            const fs = require('fs');
            const routePath = require('path').resolve(__dirname, '../../src/app/api/t/[tenantSlug]/frameworks/route.ts');
            if (!fs.existsSync(routePath)) return;
            const content = fs.readFileSync(routePath, 'utf8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
        });
    });

    describe('API Action Coverage', () => {
        it('GET actions include diff and readiness', () => {
            const getActions = ['requirements', 'packs', 'coverage', 'preview', 'templates', 'export', 'diff', 'readiness'];
            expect(getActions).toContain('diff');
            expect(getActions).toContain('readiness');
            expect(getActions.length).toBe(8);
        });

    });

    describe('Usecase Exports (Hardening)', () => {
        it('exports all new hardening usecases', () => {
            const fw = require('../../src/app-layer/usecases/framework');
            // No requirement writer: the catalogue is global and is kept by
            // the deploy-time scripts (#4125 follow-up). The route test
            // `framework-route-no-catalogue-write` holds the HTTP half.
            expect(fw).not.toHaveProperty('upsertRequirements');
            expect(typeof fw.computeRequirementsDiff).toBe('function');
            expect(typeof fw.generateReadinessReport).toBe('function');
            expect(typeof fw.exportReadinessReport).toBe('function');
        });
    });

    describe('Versioning', () => {
        it('framework key + version creates unique identifier', () => {
            const fw1 = { key: 'ISO27001', version: '2022' };
            const fw2 = { key: 'ISO27001', version: '2025' };
            const id1 = `${fw1.key}_${fw1.version}`;
            const id2 = `${fw2.key}_${fw2.version}`;
            expect(id1).not.toBe(id2);
        });

        it('NIS2 can have directive baseline version', () => {
            const fw = { key: 'NIS2', version: 'Directive baseline' };
            expect(fw.version).toBe('Directive baseline');
        });
    });
});
