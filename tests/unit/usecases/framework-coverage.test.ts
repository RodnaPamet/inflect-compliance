/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/framework/coverage.ts` —
 * framework coverage + readiness reporting.
 *
 * Wave-8a / stage-3f branch coverage (paired with control-queries
 * in the same PR). Compliance-critical surface: this is what the
 * Coverage page + audit-readiness reports render. A bug here:
 *   - misrenders the coverage% (auditor-visible)
 *   - mis-attributes missing-evidence / NOT_APPLICABLE controls
 *   - mis-scores readiness via the score formula
 *
 * Branch matrix covered:
 *   computeCoverage:        version vs latest, framework not-found,
 *                           total=0 NaN guard, section grouping,
 *                           section→category→Other fallback
 *   listTemplates:          no-filter / framework-key (with notFound) /
 *                           category / search / section in-memory /
 *                           installed merge
 *   exportCoverageData:     json vs csv shape + CSV escaping
 *   generateReadinessReport: framework not-found / mapped vs unmapped
 *                           / NOT_APPLICABLE filter / missingEvidence
 *                           filter / overdueTasks loop (3 terminal
 *                           statuses + 1 due-in-past condition) /
 *                           readinessScore formula
 *   exportReadinessReport:  json vs csv (with all 4 row types in csv)
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(() => policyCalls.push('view')),
}));

const mockPrisma: any = {
    framework: { findUnique: jest.fn(), findFirst: jest.fn() },
    frameworkRequirement: { findMany: jest.fn() },
    controlTemplate: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: mockPrisma,
    default: mockPrisma,
}));

const tenantDb: any = {
    controlRequirementLink: { findMany: jest.fn() },
    control: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import {
    computeCoverage,
    listTemplates,
    exportCoverageData,
    generateReadinessReport,
    exportReadinessReport,
} from '@/app-layer/usecases/framework/coverage';
import { assertCanViewFrameworks } from '@/app-layer/policies/framework.policies';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    [
        mockPrisma.framework.findUnique, mockPrisma.framework.findFirst,
        mockPrisma.frameworkRequirement.findMany,
        mockPrisma.controlTemplate.findMany,
        tenantDb.controlRequirementLink.findMany,
        tenantDb.control.findMany,
        assertCanViewFrameworks as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanViewFrameworks as jest.Mock).mockImplementation(() => policyCalls.push('view'));
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// computeCoverage
// ──────────────────────────────────────────────────────────────────────
describe('computeCoverage', () => {
    it('findUnique when version is given', async () => {
        mockPrisma.framework.findUnique.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'X', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        await computeCoverage(ctx, 'iso', '2022');

        expect(mockPrisma.framework.findUnique).toHaveBeenCalledWith({
            where: { key_version: { key: 'iso', version: '2022' } },
        });
        expect(mockPrisma.framework.findFirst).not.toHaveBeenCalled();
    });

    it('findFirst (latest) when no version', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'X', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        await computeCoverage(ctx, 'iso');

        expect(mockPrisma.framework.findFirst).toHaveBeenCalled();
        expect(mockPrisma.framework.findUnique).not.toHaveBeenCalled();
    });

    it('throws notFound for missing framework', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce(null);
        await expect(computeCoverage(ctx, 'bogus')).rejects.toThrow(/framework not found/i);
    });

    it('total=0 produces coveragePercent=0 (NaN guard)', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'X', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        const result = await computeCoverage(ctx, 'iso');

        expect(result.total).toBe(0);
        expect(result.coveragePercent).toBe(0);
    });

    it('groups by section with per-section coverage + section→category→Other fallback', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'X', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'B', title: 'Y', section: null, category: 'CatA', sortOrder: 2 },
            { id: 'r-3', code: 'C', title: 'Z', section: null, category: null, sortOrder: 3 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', requirement: { code: 'A', title: 'X' }, control: { code: 'CC1', name: 'M', status: 'ACTIVE' } },
        ]);

        const result = await computeCoverage(ctx, 'iso');

        expect(result.total).toBe(3);
        expect(result.mapped).toBe(1);
        expect(result.coveragePercent).toBe(33);
        const sections = result.bySection.map((s) => s.section);
        expect(sections).toContain('Org');
        expect(sections).toContain('CatA');
        expect(sections).toContain('Other');
    });

    it('excludes deprecated requirements, agreeing with readiness + the SoA', async () => {
        // `computeCoverage` returns a field named `coveragePercent`, computed
        // with the identical formula as `generateReadinessReport`'s — but over
        // a LARGER denominator, because this was the only one of the three
        // requirement reads in the report family without `deprecatedAt: null`.
        //
        // The drift is one-directional and permanent: a requirement dropped
        // from a re-imported library is stamped deprecated (library-importer
        // ships `deprecateMissing: true` by default) and can never be mapped
        // again, so it sat in this denominator forever. This surface is the
        // Frameworks list page, the JSON + CSV exports, and the MCP tools.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'X', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        await computeCoverage(ctx, 'iso');

        const where = mockPrisma.frameworkRequirement.findMany.mock.calls[0][0].where;
        expect(where.deprecatedAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// listTemplates — duplicate of framework/install.ts version
// ──────────────────────────────────────────────────────────────────────
describe('listTemplates (coverage.ts variant)', () => {
    it('applies no filter clauses when none provided', async () => {
        mockPrisma.controlTemplate.findMany.mockResolvedValueOnce([]);
        tenantDb.control.findMany.mockResolvedValueOnce([]);

        await listTemplates(ctx, {});

        const where = mockPrisma.controlTemplate.findMany.mock.calls[0][0].where;
        expect(where).toEqual({});
    });

    it('frameworkKey filter: throws notFound when framework missing', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce(null);
        await expect(listTemplates(ctx, { frameworkKey: 'bogus' })).rejects.toThrow(/framework not found/i);
    });

    it('frameworkKey filter: adds requirementLinks.some clause', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1' });
        mockPrisma.controlTemplate.findMany.mockResolvedValueOnce([]);
        tenantDb.control.findMany.mockResolvedValueOnce([]);

        await listTemplates(ctx, { frameworkKey: 'iso' });

        const where = mockPrisma.controlTemplate.findMany.mock.calls[0][0].where;
        expect(where.requirementLinks.some.requirement.frameworkId).toBe('fw-1');
    });

    it('category + search filters compose correctly', async () => {
        mockPrisma.controlTemplate.findMany.mockResolvedValueOnce([]);
        tenantDb.control.findMany.mockResolvedValueOnce([]);

        await listTemplates(ctx, { category: 'GOV', search: 'access' });

        const where = mockPrisma.controlTemplate.findMany.mock.calls[0][0].where;
        expect(where.category).toBe('GOV');
        expect(where.OR).toEqual([
            { code: { contains: 'access' } },
            { title: { contains: 'access' } },
        ]);
    });

    it('section filter applies in-memory post-query', async () => {
        mockPrisma.controlTemplate.findMany.mockResolvedValueOnce([
            { id: 't-1', code: 'A.5.1', title: 'X', tasks: [], packLinks: [],
              requirementLinks: [{ requirement: { code: 'r-1', title: 'X', section: 'People', framework: { key: 'iso', name: 'I' } } }] },
            { id: 't-2', code: 'A.6.1', title: 'Y', tasks: [], packLinks: [],
              requirementLinks: [{ requirement: { code: 'r-2', title: 'Y', section: 'Org', framework: { key: 'iso', name: 'I' } } }] },
        ]);
        tenantDb.control.findMany.mockResolvedValueOnce([]);

        const result = await listTemplates(ctx, { section: 'People' });

        expect(result).toHaveLength(1);
        expect(result[0].code).toBe('A.5.1');
    });

    it('installed-status merge based on tenant control intersection', async () => {
        mockPrisma.controlTemplate.findMany.mockResolvedValueOnce([
            { id: 't-1', code: 'A.5.1', title: 'X', tasks: [], packLinks: [], requirementLinks: [] },
            { id: 't-2', code: 'A.5.2', title: 'Y', tasks: [], packLinks: [], requirementLinks: [] },
        ]);
        tenantDb.control.findMany.mockResolvedValueOnce([{ code: 'A.5.1' }]);

        const result = await listTemplates(ctx, {});

        expect(result.find((t: any) => t.code === 'A.5.1')!.installed).toBe(true);
        expect(result.find((t: any) => t.code === 'A.5.2')!.installed).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────────────
// exportCoverageData
// ──────────────────────────────────────────────────────────────────────
describe('exportCoverageData', () => {
    function stubCoverage() {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A.5.1', title: 'Control X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'A.5.2', title: 'Unmapped Y', section: 'Org', sortOrder: 2 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', requirement: { code: 'A.5.1', title: 'Control X' }, control: { code: 'CC1', name: 'My Ctrl', status: 'ACTIVE' } },
        ]);
    }

    it('returns full coverage object on json format', async () => {
        stubCoverage();
        const result = await exportCoverageData(ctx, 'iso', 'json') as any;
        expect(result.framework.key).toBe('iso');
        expect(result.controlMappings).toHaveLength(1);
    });

    it('returns CSV with header + Mapped row + Unmapped row + filename', async () => {
        stubCoverage();
        const result = await exportCoverageData(ctx, 'iso', 'csv') as any;

        expect(result.csv).toContain('"Status","Requirement Code"');
        expect(result.csv).toContain('"Mapped","A.5.1"');
        expect(result.csv).toContain('"Unmapped","A.5.2"');
        expect(result.filename).toBe('iso-coverage.csv');
    });

    it('CSV escapes embedded double-quotes', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'Has "quotes"', section: null, sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        const result = await exportCoverageData(ctx, 'iso', 'csv') as any;
        // Embedded `"` becomes `""` per CSV spec.
        expect(result.csv).toMatch(/Has ""quotes""/);
    });
});

// ──────────────────────────────────────────────────────────────────────
// generateReadinessReport — the readiness-score formula + classifiers
// ──────────────────────────────────────────────────────────────────────
describe('generateReadinessReport', () => {
    it('throws notFound for missing framework', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce(null);
        await expect(generateReadinessReport(ctx, 'bogus')).rejects.toThrow(/framework not found/i);
    });

    it('filters to active (deprecatedAt: null) requirements', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([]);

        await generateReadinessReport(ctx, 'iso');

        const where = mockPrisma.frameworkRequirement.findMany.mock.calls[0][0].where;
        expect(where.deprecatedAt).toBeNull();
    });

    it('NOT_APPLICABLE controls are classified separately + carry justification', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            // The state a real N/A decision produces: `setApplicability` writes
            // `applicability` + justification + decided-by/at and NEVER touches
            // `status` — every status-write schema excludes NOT_APPLICABLE on
            // purpose. This fixture used to say `status: 'NOT_APPLICABLE'` with
            // no `applicability` at all, which no write path can produce; it
            // held the assertion green over an unreachable state while every
            // real N/A control fell through to `controlsMissingEvidence`.
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'NA Ctrl', status: 'NOT_STARTED', applicability: 'NOT_APPLICABLE', applicabilityJustification: 'Justified because X', tasks: [], evidenceControlLinks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.notApplicableControls).toEqual([
            { code: 'CC1', name: 'NA Ctrl', justification: 'Justified because X' },
        ]);
        expect(result.controlsMissingEvidence).toEqual([]);
    });

    it('honours the per-framework applicability override, as the SoA does', async () => {
        // `getSoA` resolves `l.applicability ?? l.control.applicability` — a
        // control can be globally applicable but scoped out of ONE framework.
        // Readiness read the control column only (via `status`), so it could
        // not see the override at all.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', applicability: 'NOT_APPLICABLE', control: { id: 'c-1', code: 'CC1', name: 'Scoped Out', status: 'NOT_STARTED', applicability: 'APPLICABLE', applicabilityJustification: 'Out of scope here', tasks: [], evidenceControlLinks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.notApplicableControls).toEqual([
            { code: 'CC1', name: 'Scoped Out', justification: 'Out of scope here' },
        ]);
        expect(result.controlsMissingEvidence).toEqual([]);
    });

    it('a legacy status-only NOT_APPLICABLE still owes evidence, as the SoA says', async () => {
        // Pins the DIRECTION of the fix. Rows written before the status-write
        // schemas excluded NOT_APPLICABLE may carry it with the `applicability`
        // column left at its APPLICABLE default — i.e. no recorded decision:
        // no justification, no decided-by, no decided-at.
        //
        // The SoA counts such a control as applicable, so readiness must too.
        // Reading it as N/A here is what made the two reports disagree.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'Legacy', status: 'NOT_APPLICABLE', applicability: 'APPLICABLE', applicabilityJustification: null, tasks: [], evidenceControlLinks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.notApplicableControls).toEqual([]);
        expect(result.controlsMissingEvidence).toEqual([
            { code: 'CC1', name: 'Legacy', status: 'NOT_APPLICABLE' },
        ]);
    });

    it('a control scoped out of one requirement but not another still owes evidence', async () => {
        // The "every link says N/A" rule. Applicability is per-link, but these
        // two lists are per-CONTROL, so a control reachable as applicable
        // anywhere in the framework must stay in the evidence-owing set.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'B', title: 'Y', section: 'Org', sortOrder: 2 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', applicability: 'NOT_APPLICABLE', control: { id: 'c-1', code: 'CC1', name: 'Mixed', status: 'IMPLEMENTED', applicability: 'APPLICABLE', applicabilityJustification: null, tasks: [], evidenceControlLinks: [] } },
            { requirementId: 'r-2', applicability: null, control: { id: 'c-1', code: 'CC1', name: 'Mixed', status: 'IMPLEMENTED', applicability: 'APPLICABLE', applicabilityJustification: null, tasks: [], evidenceControlLinks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.notApplicableControls).toEqual([]);
        expect(result.controlsMissingEvidence).toEqual([
            { code: 'CC1', name: 'Mixed', status: 'IMPLEMENTED' },
        ]);
    });

    it('NOT_APPLICABLE control with null justification uses default justification', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'NA', status: 'NOT_STARTED', applicability: 'NOT_APPLICABLE', applicabilityJustification: null, tasks: [], evidenceControlLinks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.notApplicableControls[0].justification).toBe('No justification provided');
    });

    it('flags controls with empty evidence array as missingEvidence (excludes NOT_APPLICABLE)', async () => {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'B', title: 'Y', section: 'Org', sortOrder: 2 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'No-Evidence', status: 'IMPLEMENTED', description: '', tasks: [], evidenceControlLinks: [] } },
            { requirementId: 'r-2', control: { id: 'c-2', code: 'CC2', name: 'Has-Evidence', status: 'IMPLEMENTED', description: '', tasks: [], evidenceControlLinks: [{ evidenceId: 'e-1', evidence: { id: 'e-1', status: 'APPROVED', expiredAt: null, isArchived: false, deletedAt: null, title: 'E1' } }] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.controlsMissingEvidence).toEqual([
            { code: 'CC1', name: 'No-Evidence', status: 'IMPLEMENTED' },
        ]);
    });

    it('overdueTasks loop excludes the 3 terminal statuses', async () => {
        // RESOLVED, CLOSED, CANCELED tasks past dueAt should NOT
        // count as overdue. Only OPEN / IN_PROGRESS etc. do.
        const past = new Date('2020-01-01');
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'X', status: 'IMPLEMENTED', description: '', evidenceControlLinks: [{ evidenceId: 'e-1', evidence: { id: 'e-1' } }],
              tasks: [
                  { id: 't-1', status: 'OPEN', dueAt: past, title: 'Open Overdue' },
                  { id: 't-2', status: 'RESOLVED', dueAt: past, title: 'Resolved Past Due' },
                  { id: 't-3', status: 'CLOSED', dueAt: past, title: 'Closed Past Due' },
                  { id: 't-4', status: 'CANCELED', dueAt: past, title: 'Canceled Past Due' },
                  { id: 't-5', status: 'IN_PROGRESS', dueAt: past, title: 'In-Progress Overdue' },
              ] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        // Only OPEN and IN_PROGRESS land in overdueTasks.
        expect(result.overdueTasks).toHaveLength(2);
        const titles = result.overdueTasks.map((t: any) => t.taskTitle).sort();
        expect(titles).toEqual(['In-Progress Overdue', 'Open Overdue']);
    });

    it('readinessScore formula: implementedPercent - missing×2 - overdue×3 (floored at 0)', async () => {
        // PR-I — the score is now IMPLEMENTATION-based. 1 of 1 requirement
        // implemented → implementedPercent = 100. 1 missing-evidence, 2 overdue
        // → score = 100 - 2 - 6 = 92.
        const past = new Date('2020-01-01');
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'X', status: 'IMPLEMENTED', applicability: 'APPLICABLE', description: '', evidenceControlLinks: [],
              tasks: [
                  { id: 't-1', status: 'OPEN', dueAt: past, title: 'A' },
                  { id: 't-2', status: 'OPEN', dueAt: past, title: 'B' },
              ] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        // 100 (implemented) - 2 (1 missing × 2) - 6 (2 overdue × 3) = 92
        expect(result.summary.readinessScore).toBe(92);
    });

    it('PR-I — readiness rewards implementation, not mapping density', async () => {
        // A requirement fully MAPPED but the control is NOT implemented:
        // coveragePercent = 100 (mapping density) but readinessScore ≈ 0.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'X', status: 'NOT_STARTED', applicability: 'APPLICABLE', description: '',
              evidenceControlLinks: [{ evidenceId: 'e-1', evidence: { id: 'e-1', status: 'APPROVED', expiredAt: null, isArchived: false, deletedAt: null, title: 'E1' } }],
              tasks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.coverage.coveragePercent).toBe(100); // mapping density
        expect(result.summary.implementedRequirements).toBe(0);
        expect(result.summary.readinessScore).toBe(0); // rewards implementation
    });

    it('PR-I — soft-deleted evidence is excluded (control reads as missing evidence)', async () => {
        // A control whose ONLY evidence link points at a soft-deleted row must
        // count as missing evidence in readiness — agreeing with the SoA rollup
        // which filters evidence deletedAt:null.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-1', code: 'CC1', name: 'Deleted-Ev', status: 'IMPLEMENTED', applicability: 'APPLICABLE', description: '',
              evidenceControlLinks: [{ evidenceId: 'e-1', evidence: { id: 'e-1', status: 'APPROVED', expiredAt: null, isArchived: false, deletedAt: new Date('2026-01-01'), title: 'Deleted' } }],
              tasks: [] } },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.controlsMissingEvidence).toEqual([
            { code: 'CC1', name: 'Deleted-Ev', status: 'IMPLEMENTED' },
        ]);
    });

    it('readinessScore floors at 0 (Math.max guard)', async () => {
        // High failure surface → would compute negative without floor.
        const past = new Date('2020-01-01');
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
        ]);
        // 50 missing-evidence + 50 overdue = -150 -50 -150 = -300 raw
        const tasks = Array.from({ length: 50 }, (_, i) => ({
            id: `t-${i}`, status: 'OPEN', dueAt: past, title: `T${i}`,
        }));
        const evidenceMissing = Array.from({ length: 50 }, (_, i) => ({
            id: `c-${i}`, code: `C${i}`, name: `Ctrl${i}`, status: 'IMPLEMENTED', description: '', evidenceControlLinks: [], tasks: [],
        }));
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: { id: 'c-with-tasks', code: 'C', name: 'C', status: 'IMPLEMENTED', description: '', evidenceControlLinks: [], tasks } },
            ...evidenceMissing.map((c) => ({ requirementId: 'r-X', control: c })),
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        expect(result.summary.readinessScore).toBe(0);
    });

    it('deduplicates controls by id when the same control maps to multiple requirements', async () => {
        // The controlsMap fold ensures one control attached to N
        // requirements doesn't get counted N times in notApplicable
        // or missingEvidence sets.
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'B', title: 'Y', section: 'Org', sortOrder: 2 },
        ]);
        // Same control on both links.
        const oneControl = { id: 'c-1', code: 'CC1', name: 'X', status: 'IMPLEMENTED', description: '', evidenceControlLinks: [], tasks: [] };
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: oneControl },
            { requirementId: 'r-2', control: oneControl },
        ]);

        const result = await generateReadinessReport(ctx, 'iso');

        // One physical control → at most one entry in missingEvidence.
        expect(result.controlsMissingEvidence).toHaveLength(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// exportReadinessReport
// ──────────────────────────────────────────────────────────────────────
describe('exportReadinessReport', () => {
    function stubReport() {
        mockPrisma.framework.findFirst.mockResolvedValueOnce({ id: 'fw-1', key: 'iso', name: 'ISO', version: '2022' });
        mockPrisma.frameworkRequirement.findMany.mockResolvedValueOnce([
            { id: 'r-1', code: 'A', title: 'X', section: 'Org', sortOrder: 1 },
            { id: 'r-2', code: 'B', title: 'Unmapped', section: 'Org', sortOrder: 2 },
        ]);
        const past = new Date('2020-01-01');
        tenantDb.controlRequirementLink.findMany.mockResolvedValueOnce([
            { requirementId: 'r-1', control: {
                id: 'c-na', code: 'NA1', name: 'NotAppl', status: 'NOT_STARTED', applicability: 'NOT_APPLICABLE', description: 'why',
                evidenceControlLinks: [], tasks: [],
            }},
            { requirementId: 'r-1', control: {
                id: 'c-missing', code: 'M1', name: 'NoEv', status: 'IMPLEMENTED', description: '',
                evidenceControlLinks: [], tasks: [{ id: 't-1', status: 'OPEN', dueAt: past, title: 'Late' }],
            }},
        ]);
    }

    it('returns the report shape in json format', async () => {
        stubReport();
        const result = await exportReadinessReport(ctx, 'iso', 'json') as any;
        expect(result.framework.key).toBe('iso');
        expect(result.summary).toBeDefined();
    });

    it('CSV includes all 4 row types + summary metadata', async () => {
        stubReport();
        const result = await exportReadinessReport(ctx, 'iso', 'csv') as any;

        expect(result.csv).toContain('"Unmapped Requirement"');
        expect(result.csv).toContain('"Not Applicable Control"');
        expect(result.csv).toContain('"Missing Evidence"');
        expect(result.csv).toContain('"Overdue Task"');
        expect(result.filename).toBe('iso-readiness-report.csv');
        expect(result.summary).toBeDefined();
    });
});
