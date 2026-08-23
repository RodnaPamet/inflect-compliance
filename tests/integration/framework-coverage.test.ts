/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

describe('Framework Coverage & Templates', () => {
    const basePath = process.cwd();

    // ─── Fixture files exist ───
    describe('Fixture files', () => {
        const fixtures = [
            { file: 'iso27001_2022_annexA.json', minEntries: 90 },
            { file: 'nis2_requirements.json', minEntries: 15 },
            { file: 'iso9001_clauses.json', minEntries: 30 },
            { file: 'iso28000_clauses.json', minEntries: 15 },
            { file: 'iso39001_clauses.json', minEntries: 15 },
        ];

        it.each(fixtures)('fixture $file exists with enough entries', ({ file, minEntries }) => {
            const path = join(basePath, 'prisma/fixtures', file);
            expect(existsSync(path)).toBe(true);
            const data = JSON.parse(readFileSync(path, 'utf-8'));
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBeGreaterThanOrEqual(minEntries);
        });

        it.each(fixtures)('fixture $file entries have required fields', ({ file }) => {
            const data = JSON.parse(readFileSync(join(basePath, 'prisma/fixtures', file), 'utf-8'));
            for (const entry of data) {
                expect(entry).toHaveProperty('key');
                expect(entry).toHaveProperty('title');
                expect(entry).toHaveProperty('sortOrder');
                expect(typeof entry.key).toBe('string');
                expect(typeof entry.title).toBe('string');
                expect(typeof entry.sortOrder).toBe('number');
            }
        });

        it('ISO 27001 fixture has 93 Annex A controls', () => {
            const data = JSON.parse(readFileSync(join(basePath, 'prisma/fixtures/iso27001_2022_annexA.json'), 'utf-8'));
            expect(data.length).toBe(93);
        });

        it('NIS2 fixture covers Article 21 security measures', () => {
            const data = JSON.parse(readFileSync(join(basePath, 'prisma/fixtures/nis2_requirements.json'), 'utf-8'));
            const art21 = data.filter((d: any) => d.key.startsWith('Art.21'));
            expect(art21.length).toBeGreaterThanOrEqual(10);
        });
    });

    // ─── Schema structural checks ───
    describe('Schema models', () => {
        const schema = readPrismaSchema();

        it('Framework model has kind field', () => {
            // Whitespace-tolerant: prisma format re-aligns columns
            // when sibling fields change. Match the field declaration
            // shape, not the exact gap.
            expect(schema).toMatch(/\bkind\s+FrameworkKind\b/);
        });

        it('FrameworkKind enum exists', () => {
            expect(schema).toContain('enum FrameworkKind');
            expect(schema).toContain('ISO_STANDARD');
            expect(schema).toContain('EU_DIRECTIVE');
        });

        it('FrameworkRequirement has section field', () => {
            expect(schema).toMatch(/section\s+String\?/);
        });

        it('ControlRequirementLink model exists with tenant', () => {
            expect(schema).toContain('model ControlRequirementLink');
            expect(schema).toMatch(/ControlRequirementLink[\s\S]*?tenantId/);
        });

        it('ControlRequirementLink has unique constraint', () => {
            expect(schema).toMatch(/ControlRequirementLink[\s\S]*?@@unique\(\[controlId, requirementId\]\)/);
        });

        it('Framework has key_version composite unique', () => {
            expect(schema).toContain('@@unique([key, version])');
        });
    });

    // ─── Migration exists ───
    describe('Migrations', () => {
        it('framework_coverage_templates migration exists', () => {
            const dirs = require('fs').readdirSync(join(basePath, 'prisma/migrations'));
            expect(dirs.some((d: string) => d.includes('framework_coverage_templates'))).toBe(true);
        });
    });

    // ─── Usecase exports ───
    describe('Framework usecases exportable', () => {
        const usecaseFunctions = [
            'listFrameworks',
            'getFramework',
            'getFrameworkRequirements',
            'listFrameworkPacks',
            'previewPackInstall',
            'installPack',
            'computeCoverage',
        ];

        it.each(usecaseFunctions)('%s is exported', (fn) => {
            const mod = require('../../src/app-layer/usecases/framework');
            expect(typeof mod[fn]).toBe('function');
        });
    });

    // ─── Policy exports ───
    describe('Framework policies exportable', () => {
        it('assertCanViewFrameworks is exported', () => {
            const mod = require('../../src/app-layer/policies/framework.policies');
            expect(typeof mod.assertCanViewFrameworks).toBe('function');
        });

        it('assertCanInstallFrameworkPack is exported', () => {
            const mod = require('../../src/app-layer/policies/framework.policies');
            expect(typeof mod.assertCanInstallFrameworkPack).toBe('function');
        });

        it('assertCanViewFrameworks admits every built-in role, via the permission', () => {
            // Renamed from "allows any role", which stopped being true on
            // 2026-08-23. The outcome for these four is unchanged — all built-in
            // roles carry `frameworks.view: true` — but the AUTHORITY moved from
            // the role's existence to the permission flag, so the context has to
            // be a real one. The previous version passed `{ role: 'READER' }`
            // with no `appPermissions` at all, which is not a shape any caller
            // produces.
            const { assertCanViewFrameworks } = require('../../src/app-layer/policies/framework.policies');
            const { getPermissionsForRole } = require('../../src/lib/permissions');
            for (const role of ['READER', 'EDITOR', 'ADMIN', 'AUDITOR'] as const) {
                const ctx = { role, appPermissions: getPermissionsForRole(role) };
                expect(() => assertCanViewFrameworks(ctx as any)).not.toThrow();
            }
            // The behaviour that is actually new — see
            // tests/unit/policies/framework-view-permission.test.ts for the
            // full contract.
            const denied = {
                role: 'READER',
                appPermissions: {
                    ...getPermissionsForRole('READER'),
                    frameworks: { view: false, install: false },
                },
            };
            expect(() => assertCanViewFrameworks(denied as any)).toThrow();
        });

        it('assertCanInstallFrameworkPack rejects non-ADMIN', () => {
            const { assertCanInstallFrameworkPack } = require('../../src/app-layer/policies/framework.policies');
            expect(() => assertCanInstallFrameworkPack({ role: 'READER' } as any)).toThrow();
            expect(() => assertCanInstallFrameworkPack({ role: 'EDITOR' } as any)).toThrow();
            expect(() => assertCanInstallFrameworkPack({ role: 'AUDITOR' } as any)).toThrow();
            expect(() => assertCanInstallFrameworkPack({ role: 'ADMIN' } as any)).not.toThrow();
        });
    });

    // ─── Route structural checks ───
    describe('API routes exist', () => {
        const baseApi = join(basePath, 'src/app/api/t/[tenantSlug]/frameworks');

        it('list route exists', () => {
            expect(existsSync(join(baseApi, 'route.ts'))).toBe(true);
        });

        it('[frameworkKey] detail route exists', () => {
            expect(existsSync(join(baseApi, '[frameworkKey]/route.ts'))).toBe(true);
        });
    });

    // ─── No prisma in routes ───
    describe('No direct prisma in framework routes', () => {
        const routes = [
            'route.ts',
            '[frameworkKey]/route.ts',
        ];
        const baseApi = join(basePath, 'src/app/api/t/[tenantSlug]/frameworks');

        it.each(routes)('route %s has no prisma import', (route) => {
            const f = join(baseApi, route);
            if (!existsSync(f)) return;
            const content = readFileSync(f, 'utf-8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).not.toMatch(/from\s+['"]@prisma\/client['"]/);
        });
    });

    // ─── Usecase structural analysis ───
    describe('Framework usecase structure', () => {
        const flatPath = join(basePath, 'src/app-layer/usecases/framework.ts');
        const dirPath = join(basePath, 'src/app-layer/usecases/framework');
        let content: string;
        if (existsSync(flatPath)) {
            content = readFileSync(flatPath, 'utf-8');
        } else if (existsSync(dirPath)) {
            const files = require('fs').readdirSync(dirPath).filter((f: string) => f.endsWith('.ts'));
            content = files.map((f: string) => readFileSync(join(dirPath, f), 'utf-8')).join('\n');
        } else {
            throw new Error('Framework usecase not found');
        }

        it('imports assertCanViewFrameworks', () => {
            expect(content).toContain('assertCanViewFrameworks');
        });

        it('imports assertCanInstallFrameworkPack', () => {
            expect(content).toContain('assertCanInstallFrameworkPack');
        });

        it('installPack uses runInTenantContext', () => {
            expect(content).toContain('runInTenantContext');
        });

        it('computeCoverage computes coverage percent', () => {
            expect(content).toContain('coveragePercent');
        });

        it('installPack is idempotent (checks existing code)', () => {
            expect(content).toMatch(/findFirst[\s\S]*?tenantId.*code:\s*tmpl\.code/);
        });

        it('installPack emits FRAMEWORK_PACK_INSTALLED event', () => {
            expect(content).toContain('FRAMEWORK_PACK_INSTALLED');
        });

        it('coverage returns bySection breakdown', () => {
            expect(content).toContain('bySection');
        });

        it('coverage returns unmappedRequirements', () => {
            expect(content).toContain('unmappedRequirements');
        });
    });

    // ─── Seed file has all 5 frameworks ───
    describe('Seed covers all frameworks', () => {
        const seed = readFileSync(join(basePath, 'prisma/seed.ts'), 'utf-8');

        it.each(['ISO27001', 'NIS2', 'ISO9001', 'ISO28000', 'ISO39001'])('seed references %s', (key) => {
            expect(seed).toContain(key);
        });

        it.each(['ISO27001_2022_BASE', 'NIS2_BASELINE', 'ISO9001_CORE', 'ISO28000_CORE', 'ISO39001_CORE'])('seed creates pack %s', (packKey) => {
            expect(seed).toContain(packKey);
        });

        it.each(['NIS2-', 'QMS-', 'SCS-', 'RTS-'])('seed creates templates with prefix %s', (prefix) => {
            expect(seed).toContain(`code: '${prefix}`);
        });
    });

    // ─── Template fixtures quality checks ───
    describe('Template coverage', () => {
        const seed = readFileSync(join(basePath, 'prisma/seed.ts'), 'utf-8');

        it('NIS2 has >= 15 templates', () => {
            const matches = seed.match(/code: 'NIS2-/g);
            expect(matches).toBeTruthy();
            expect(matches!.length).toBeGreaterThanOrEqual(15);
        });

        it('ISO 9001 has >= 15 templates', () => {
            const matches = seed.match(/code: 'QMS-/g);
            expect(matches).toBeTruthy();
            expect(matches!.length).toBeGreaterThanOrEqual(15);
        });

        it('ISO 28000 has >= 10 templates', () => {
            const matches = seed.match(/code: 'SCS-/g);
            expect(matches).toBeTruthy();
            expect(matches!.length).toBeGreaterThanOrEqual(10);
        });

        it('ISO 39001 has >= 10 templates', () => {
            const matches = seed.match(/code: 'RTS-/g);
            expect(matches).toBeTruthy();
            expect(matches!.length).toBeGreaterThanOrEqual(10);
        });
    });

    // ─── Coverage computation unit test ───
    describe('Coverage computation logic', () => {
        it('empty mappings yields 0% coverage', () => {
            const requirements = [{ id: '1' }, { id: '2' }, { id: '3' }];
            const mappedReqIds = new Set<string>();
            const mapped = requirements.filter(r => mappedReqIds.has(r.id));
            const total = requirements.length;
            const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;
            expect(coveragePercent).toBe(0);
            expect(mapped.length).toBe(0);
        });

        it('partial mapping yields correct percentage', () => {
            const requirements = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
            const mappedReqIds = new Set(['1', '3']);
            const mapped = requirements.filter(r => mappedReqIds.has(r.id));
            const total = requirements.length;
            const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;
            expect(coveragePercent).toBe(50);
            expect(mapped.length).toBe(2);
        });

        it('full mapping yields 100% coverage', () => {
            const requirements = [{ id: '1' }, { id: '2' }];
            const mappedReqIds = new Set(['1', '2']);
            const mapped = requirements.filter(r => mappedReqIds.has(r.id));
            const total = requirements.length;
            const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;
            expect(coveragePercent).toBe(100);
        });

        it('no requirements yields 0% coverage', () => {
            const requirements: { id: string }[] = [];
            const mappedReqIds = new Set<string>();
            const mapped = requirements.filter(r => mappedReqIds.has(r.id));
            const total = requirements.length;
            const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;
            expect(coveragePercent).toBe(0);
        });
    });

    // ─── Install idempotency logic test ───
    describe('Install idempotency logic', () => {
        it('second install should not create duplicate controls', () => {
            // Simulates the idempotency check
            const existingCodes = new Set(['NIS2-RA', 'NIS2-IH']);
            const templates = [
                { code: 'NIS2-RA', title: 'Risk analysis' },
                { code: 'NIS2-IH', title: 'Incident handling' },
                { code: 'NIS2-BC', title: 'Business continuity' },
            ];
            const newControls = templates.filter(t => !existingCodes.has(t.code));
            const existingControls = templates.filter(t => existingCodes.has(t.code));
            expect(newControls.length).toBe(1);
            expect(existingControls.length).toBe(2);
            expect(newControls[0].code).toBe('NIS2-BC');
        });
    });
});
