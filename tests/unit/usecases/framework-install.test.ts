/**
 * Unit tests for src/app-layer/usecases/framework/install.ts
 *
 * Wave 4 of GAP-02. Framework pack install is the heaviest write
 * operation in the app — ISO27001 lands ~93 controls + ~470 tasks +
 * ~93 requirement links per tenant in a single transaction. The
 * critical invariants:
 *
 *   1. Idempotency: re-running installPack on a tenant that already
 *      has the pack produces zero new controls (skip-if-code-exists),
 *      but DOES upsert any missing requirement links so a partial
 *      previous install converges.
 *   2. assertCanInstallFrameworkPack gate (admin/editor only).
 *   3. installSingleTemplate is also idempotent and mirrors the
 *      same convergence semantics.
 *   4. bulkMapControls validates EVERY requirement id against the
 *      named framework AND every control id against the caller
 *      tenant — cross-tenant control ids are rejected before any
 *      mapping is written.
 *   5. bulkMapControls / bulkInstallTemplates enforce per-batch
 *      caps (200 / 100) so a hostile call cannot lock the table.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        frameworkPack: { findUnique: jest.fn(), findMany: jest.fn() },
        framework: { findFirst: jest.fn(), findUnique: jest.fn() },
        frameworkRequirement: { findMany: jest.fn() },
        controlTemplate: { findUnique: jest.fn(), findMany: jest.fn() },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    previewPackInstall,
    previewPacksInstall,
    installPack,
    installPacks,
    installSingleTemplate,
    bulkMapControls,
    bulkInstallTemplates,
    removeChosenPack,
} from '@/app-layer/usecases/framework/install';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockPackFind = prisma.frameworkPack.findUnique as jest.MockedFunction<typeof prisma.frameworkPack.findUnique>;
const mockPackFindMany = prisma.frameworkPack.findMany as jest.MockedFunction<typeof prisma.frameworkPack.findMany>;
const mockFrameworkFindFirst = prisma.framework.findFirst as jest.MockedFunction<typeof prisma.framework.findFirst>;
const mockFrameworkFindUnique = prisma.framework.findUnique as jest.MockedFunction<typeof prisma.framework.findUnique>;
const mockReqFindMany = prisma.frameworkRequirement.findMany as jest.MockedFunction<typeof prisma.frameworkRequirement.findMany>;
const mockTemplateFindUnique = prisma.controlTemplate.findUnique as jest.MockedFunction<typeof prisma.controlTemplate.findUnique>;
const mockTemplateFindMany = prisma.controlTemplate.findMany as jest.MockedFunction<typeof prisma.controlTemplate.findMany>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    // A pack install must touch ONLY the pack's own templates. This default
    // keeps `controlTemplate.findMany` harmless for the paths that do use it
    // (installSingleTemplate / bulkInstallTemplates); the pack-scope test below
    // deliberately makes it return a mapped internal control to prove installPack
    // ignores it.
    mockTemplateFindMany.mockResolvedValue([] as never);
});

describe('previewPackInstall', () => {
    it('rejects READER — wait, READER can VIEW frameworks per policy', async () => {
        // assertCanViewFrameworks allows everyone with canRead.
        mockPackFind.mockResolvedValueOnce({
            key: 'iso27001-2022',
            name: 'ISO 27001:2022',
            framework: { key: 'ISO27001', name: 'ISO', version: '2022' },
            templateLinks: [],
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );

        await expect(
            previewPackInstall(makeRequestContext('READER'), 'iso27001-2022'),
        ).resolves.toBeDefined();
    });

    it('throws notFound when pack does not exist', async () => {
        mockPackFind.mockResolvedValueOnce(null);

        await expect(
            previewPackInstall(makeRequestContext('ADMIN'), 'no-such-pack'),
        ).rejects.toThrow(/Pack not found/);
    });

    it('counts new vs already-installed controls correctly', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'iso27001-2022',
            name: 'ISO 27001:2022',
            framework: { key: 'ISO27001', name: 'ISO', version: '2022' },
            templateLinks: [
                { template: { code: 'A.5.1', title: 'X', tasks: [], requirementLinks: [] } },
                { template: { code: 'A.5.2', title: 'Y', tasks: [], requirementLinks: [] } },
                { template: { code: 'A.5.3', title: 'Z', tasks: [], requirementLinks: [] } },
            ],
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findMany: jest.fn().mockResolvedValue([
                        { code: 'A.5.1' }, // already installed
                    ]),
                },
            } as never),
        );

        const result = await previewPackInstall(
            makeRequestContext('ADMIN'),
            'iso27001-2022',
        );

        expect(result.totalTemplates).toBe(3);
        expect(result.newControls).toBe(2);
        expect(result.existingControls).toBe(1);
    });
});

describe('installPack — RBAC + idempotency + audit', () => {
    it('rejects READER (canInstallFrameworkPack gate)', async () => {
        await expect(
            installPack(makeRequestContext('READER'), 'iso27001-2022'),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR — auditors view but cannot install', async () => {
        await expect(
            installPack(makeRequestContext('AUDITOR'), 'iso27001-2022'),
        ).rejects.toThrow();
    });

    // #4125 — the gate follows the custom-role-aware `frameworks.install`
    // key the Install Pack button is shown on, not the membership's built-in
    // role. Both cases below went the other way under the old role check.
    it('refuses a custom role on an ADMIN base with install switched off — before any read', async () => {
        const admin = makeRequestContext('ADMIN');
        const ctx = makeRequestContext('ADMIN', {
            appPermissions: { ...admin.appPermissions, frameworks: { view: true, install: false } },
        });
        await expect(installPack(ctx, 'iso27001-2022')).rejects.toThrow(/permission to install frameworks/i);
        expect(mockPackFind).not.toHaveBeenCalled();
    });

    it('admits a custom role on an EDITOR base with install switched on', async () => {
        const editor = makeRequestContext('EDITOR');
        const ctx = makeRequestContext('EDITOR', {
            appPermissions: { ...editor.appPermissions, frameworks: { view: true, install: true } },
        });
        mockPackFind.mockResolvedValueOnce(null);
        // Past the gate: it reaches the pack lookup.
        await expect(installPack(ctx, 'no-such-pack')).rejects.toThrow(/Pack not found/);
    });

    it('throws notFound for missing pack', async () => {
        mockPackFind.mockResolvedValueOnce(null);

        await expect(
            installPack(makeRequestContext('ADMIN'), 'no-such-pack'),
        ).rejects.toThrow(/Pack not found/);
    });

    it('skips controls that already exist (idempotent) but still upserts requirement links', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'iso27001-2022',
            name: 'ISO',
            frameworkId: 'fw-1',
            framework: { key: 'ISO27001' },
            templateLinks: [{
                template: {
                    code: 'A.5.1',
                    title: 'X',
                    description: 'desc',
                    category: 'cat',
                    defaultFrequency: 'ANNUAL',
                    tasks: [{ title: 't1', description: 'd1' }],
                    requirementLinks: [{ requirementId: 'req-1' }],
                },
            }],
        } as never);

        const controlCreate = jest.fn();
        const taskCreate = jest.fn();
        const linkCreate = jest.fn();
        const linkUpsert = jest.fn();

        mockRunInTx.mockImplementationOnce(async (_ctx, fn, _opts) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'existing-c' }),
                    create: controlCreate,
                },
                task: { create: taskCreate },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: {
                    create: linkCreate,
                    upsert: linkUpsert,
                },
                policy: { findMany: jest.fn().mockResolvedValue([]) },
                policyControlLink: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
            } as never),
        );

        const result = await installPack(makeRequestContext('ADMIN'), 'iso27001-2022');

        // Regression: a refactor that re-created controls would
        // duplicate every row on a re-install. Idempotency lets
        // operators re-run installs to converge after a partial
        // failure (network blip, timeout).
        expect(controlCreate).not.toHaveBeenCalled();
        expect(taskCreate).not.toHaveBeenCalled();
        // BUT requirement links still upsert so a partial previous
        // install can converge.
        expect(linkUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                controlId_requirementId: {
                    controlId: 'existing-c', requirementId: 'req-1',
                },
            },
        }));
        expect(result.controlsCreated).toBe(0);
    });

    it('emits FRAMEWORK_PACK_INSTALLED audit', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'iso27001-2022', name: 'ISO',
            frameworkId: 'fw-1',
            framework: { key: 'ISO27001' },
            templateLinks: [],
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn, _opts) =>
            fn({
                control: { findFirst: jest.fn(), create: jest.fn() },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
                policy: { findMany: jest.fn().mockResolvedValue([]) },
                policyControlLink: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
            } as never),
        );

        await installPack(makeRequestContext('ADMIN'), 'iso27001-2022');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'FRAMEWORK_PACK_INSTALLED' }),
        );
    });
});

describe('installPacks / previewPacksInstall — choosing several packs of one framework', () => {
    // The EU drone framework ships one pack per operating subcategory, and
    // the packs share their core controls. A tenant chooses the subcategories
    // it flies; the install must refuse an empty choice and install a shared
    // control once.
    const tmpl = (code: string) => ({
        code, title: code, description: null, category: 'EU UAS', defaultFrequency: 'QUARTERLY',
        tasks: [{ title: `task ${code}`, description: 'd' }],
        requirementLinks: [{ requirementId: `req-${code}`, requirement: { code: `R-${code}`, title: code } }],
    });
    const A2 = { id: 'pack-a2', key: 'EU_UAS_OPEN_A2', name: 'A2', frameworkId: 'fw-uas', framework: { key: 'EU-UAS-OPS', name: 'EU UAS', version: '2025-05' }, templateLinks: [{ template: tmpl('UAS-CORE-01') }, { template: tmpl('UAS-A2-01') }] };
    const A3 = { id: 'pack-a3', key: 'EU_UAS_OPEN_A3', name: 'A3', frameworkId: 'fw-uas', framework: { key: 'EU-UAS-OPS', name: 'EU UAS', version: '2025-05' }, templateLinks: [{ template: tmpl('UAS-CORE-01') }, { template: tmpl('UAS-A3-01') }] };

    function tenantDb() {
        return {
            control: {
                findFirst: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                create: jest.fn(async ({ data }: { data: { code: string } }) => ({ id: `c-${data.code}` })),
            },
            task: { create: jest.fn() },
            tenantFrameworkPack: { upsert: jest.fn() },
            controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
            policy: { findMany: jest.fn().mockResolvedValue([]) },
            policyControlLink: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
        };
    }

    it('refuses an empty choice before reading anything', async () => {
        await expect(installPacks(makeRequestContext('ADMIN'), 'EU-UAS-OPS', [])).rejects.toThrow(/at least one pack/i);
        await expect(installPacks(makeRequestContext('ADMIN'), 'EU-UAS-OPS', ['  '])).rejects.toThrow(/at least one pack/i);
        await expect(previewPacksInstall(makeRequestContext('READER'), 'EU-UAS-OPS', [''])).rejects.toThrow(/at least one pack/i);
        expect(mockPackFindMany).not.toHaveBeenCalled();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('refuses a key that names no pack', async () => {
        mockPackFindMany.mockResolvedValueOnce([{ key: 'EU_UAS_OPEN_A2', framework: { key: 'EU-UAS-OPS' } }] as never);
        await expect(
            installPacks(makeRequestContext('ADMIN'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2', 'EU_UAS_NOPE']),
        ).rejects.toThrow(/Pack not found: EU_UAS_NOPE/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it("refuses a pack of another framework mixed into the choice", async () => {
        mockPackFindMany.mockResolvedValueOnce([
            { key: 'EU_UAS_OPEN_A2', framework: { key: 'EU-UAS-OPS' } },
            { key: 'ISO27001_2022_BASE', framework: { key: 'ISO27001' } },
        ] as never);
        await expect(
            installPacks(makeRequestContext('ADMIN'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2', 'ISO27001_2022_BASE']),
        ).rejects.toThrow(/Not a pack of EU-UAS-OPS: ISO27001_2022_BASE/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('refuses a member without frameworks.install before any read', async () => {
        await expect(installPacks(makeRequestContext('READER'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2'])).rejects.toThrow();
        expect(mockPackFindMany).not.toHaveBeenCalled();
    });

    it('installs a control the chosen packs share once, in one transaction, with an audit row per pack', async () => {
        mockPackFindMany
            .mockResolvedValueOnce([
                { key: 'EU_UAS_OPEN_A3', framework: { key: 'EU-UAS-OPS' } },
                { key: 'EU_UAS_OPEN_A2', framework: { key: 'EU-UAS-OPS' } },
            ] as never)
            // Returned out of order on purpose: the install follows the order chosen.
            .mockResolvedValueOnce([A3, A2] as never);
        const db = tenantDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await installPacks(makeRequestContext('ADMIN'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3', 'EU_UAS_OPEN_A2']);

        expect(mockRunInTx).toHaveBeenCalledTimes(1);
        const created = db.control.create.mock.calls.map((c) => (c[0] as { data: { code: string } }).data.code);
        expect(created).toEqual(['UAS-CORE-01', 'UAS-A2-01', 'UAS-A3-01']);
        expect(result.controlsCreated).toBe(3);
        expect(result.tasksCreated).toBe(3);
        expect(result.packKeys).toEqual(['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);
        // The shared core counts towards the pack that installed it.
        expect(result.packs.map((p) => [p.packKey, p.controlsCreated])).toEqual([
            ['EU_UAS_OPEN_A2', 2],
            ['EU_UAS_OPEN_A3', 1],
        ]);
        const audits = mockLog.mock.calls.map((c) => c[2] as unknown as { action: string; metadata: { packKey: string } });
        expect(audits.map((a) => [a.action, a.metadata.packKey])).toEqual([
            ['FRAMEWORK_PACK_INSTALLED', 'EU_UAS_OPEN_A2'],
            ['FRAMEWORK_PACK_INSTALLED', 'EU_UAS_OPEN_A3'],
        ]);
        // Each chosen pack is recorded once, in the same transaction: these
        // rows are the scope coverage is counted over (pack-scope.ts).
        expect(db.tenantFrameworkPack.upsert.mock.calls.map((c) => c[0])).toEqual(
            ['pack-a2', 'pack-a3'].map((packId) => ({
                where: { tenantId_packId: { tenantId: makeRequestContext('ADMIN').tenantId, packId } },
                create: { tenantId: makeRequestContext('ADMIN').tenantId, frameworkId: 'fw-uas', packId },
                update: {},
            })),
        );
    });

    it('previews the union of the chosen packs, each control once', async () => {
        mockPackFindMany
            .mockResolvedValueOnce([
                { key: 'EU_UAS_OPEN_A2', framework: { key: 'EU-UAS-OPS' } },
                { key: 'EU_UAS_OPEN_A3', framework: { key: 'EU-UAS-OPS' } },
            ] as never)
            .mockResolvedValueOnce([A2, A3] as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { findMany: jest.fn().mockResolvedValue([{ code: 'UAS-CORE-01' }]) } } as never),
        );

        const preview = await previewPacksInstall(makeRequestContext('READER'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);

        expect(preview.templates.map((t) => t.code)).toEqual(['UAS-CORE-01', 'UAS-A2-01', 'UAS-A3-01']);
        expect(preview.totalTemplates).toBe(3);
        expect(preview.existingControls).toBe(1);
        expect(preview.newControls).toBe(2);
        expect(preview.packKeys).toEqual(['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);
    });
});

describe('installSingleTemplate — idempotency', () => {
    it('returns alreadyExisted=true without recreating, but ensures requirement links', async () => {
        mockTemplateFindUnique.mockResolvedValueOnce({
            id: 'tpl-1', code: 'A.5.1', title: 'X', description: 'd',
            category: 'c', defaultFrequency: 'ANNUAL',
            tasks: [],
            requirementLinks: [{ requirementId: 'req-1' }, { requirementId: 'req-2' }],
        } as never);

        const linkUpsert = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'existing-c' }),
                },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { upsert: linkUpsert },
            } as never),
        );

        const result = await installSingleTemplate(
            makeRequestContext('ADMIN'),
            'A.5.1',
        );

        expect(result.alreadyExisted).toBe(true);
        expect(result.mappingsCreated).toBe(2);
    });
});

describe('bulkMapControls — cross-tenant + framework-bound validation', () => {
    it('rejects when ANY requirement id does not belong to the named framework', async () => {
        mockFrameworkFindFirst.mockResolvedValueOnce({ id: 'fw-1' } as never);
        mockReqFindMany.mockResolvedValueOnce([
            { id: 'req-valid' }, // only one of the two is valid
        ] as never);

        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'ISO27001', [
                { controlId: 'c1', requirementIds: ['req-valid', 'req-invalid'] },
            ]),
        ).rejects.toThrow(/Invalid requirement IDs/);
        // Regression: a refactor that skipped this check would let an
        // admin attach a control to a requirement from another
        // framework — coverage scores and audit packs misreport.
    });

    it('rejects when ANY control id does not belong to the caller tenant (cross-tenant)', async () => {
        mockFrameworkFindFirst.mockResolvedValueOnce({ id: 'fw-1' } as never);
        mockReqFindMany.mockResolvedValueOnce([{ id: 'req-1' }] as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findMany: jest.fn().mockResolvedValue([
                        // only c1 is mine; tenant-B-control was supplied but is not in the tenant
                        { id: 'c1' },
                    ]),
                },
            } as never),
        );

        await expect(
            bulkMapControls(
                makeRequestContext('ADMIN', { tenantId: 'tenant-A' }),
                'ISO27001',
                [
                    { controlId: 'c1', requirementIds: ['req-1'] },
                    { controlId: 'tenant-B-control', requirementIds: ['req-1'] },
                ],
            ),
        ).rejects.toThrow(/Invalid control IDs/);
    });

    it('enforces the per-batch cap (200 mappings)', async () => {
        const oversized = Array.from({ length: 201 }, (_, i) => ({
            controlId: `c${i}`, requirementIds: ['r1'],
        }));

        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'ISO27001', oversized),
        ).rejects.toThrow(/Max 200/);
        // Regression: the cap stops a hostile call from holding the
        // table-write lock long enough to cascade timeouts onto
        // legitimate traffic.
    });
});

describe('bulkInstallTemplates', () => {
    it('rejects READER (canInstallFrameworkPack)', async () => {
        await expect(
            bulkInstallTemplates(makeRequestContext('READER'), ['A.5.1']),
        ).rejects.toThrow();
    });

    it('enforces the per-batch cap (100 templates)', async () => {
        const oversized = Array.from({ length: 101 }, (_, i) => `T-${i}`);

        await expect(
            bulkInstallTemplates(makeRequestContext('ADMIN'), oversized),
        ).rejects.toThrow(/Max 100/);
    });

    it('rejects when any template code is unknown', async () => {
        mockTemplateFindMany.mockResolvedValueOnce([
            { code: 'A.5.1', tasks: [], requirementLinks: [] },
        ] as never);

        await expect(
            bulkInstallTemplates(makeRequestContext('ADMIN'), [
                'A.5.1', 'NO-SUCH',
            ]),
        ).rejects.toThrow(/Templates not found/);
    });

    it('rejects empty array (defensive null check)', async () => {
        await expect(
            bulkInstallTemplates(makeRequestContext('ADMIN'), []),
        ).rejects.toThrow(/at least one template code/i);
    });

    it('handles a MIX of skip-existing + happy-path templates in one call', async () => {
        // Stage-3c addition: existing tests covered the "all-error"
        // and "all-skip" branches separately; the mixed sweep covers
        // the inter-template state independence (the existing skip
        // doesn't poison the later happy-path).
        mockTemplateFindMany.mockResolvedValueOnce([
            { id: 't-1', code: 'A', title: 'X', description: 'd', category: 'G', defaultFrequency: 'Q',
              tasks: [], requirementLinks: [{ requirementId: 'r-1' }] },
            { id: 't-2', code: 'B', title: 'Y', description: 'd', category: 'G', defaultFrequency: 'Q',
              tasks: [{ title: 'T', description: 'd' }], requirementLinks: [] },
        ] as never);
        const findFirst = jest.fn()
            .mockResolvedValueOnce({ id: 'c-A-existing' })
            .mockResolvedValueOnce(null);
        const create = jest.fn().mockResolvedValueOnce({ id: 'c-B-new' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findFirst, create },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
            } as never),
        );

        const result = await bulkInstallTemplates(makeRequestContext('ADMIN'), ['A', 'B']);

        expect(result.controlsCreated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.tasksCreated).toBe(1);
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'BULK_TEMPLATES_INSTALLED' }),
        );
    });
});

// ──────────────────────────────────────────────────────────────────────
// Stage-3c additions: coverage of previously-untested functions +
// branches the existing wave-4 left uncovered.
// ──────────────────────────────────────────────────────────────────────

// `computeCoverage` + `listTemplates` describes removed with the dead
// clones they covered — the live implementations are in framework/
// coverage.ts and are exercised by framework-coverage.test.ts, which
// additionally pins the two soft-delete / deprecation filters this
// suite's fixtures asserted the ABSENCE of.

// ──────────────────────────────────────────────────────────────────────
// Stage-3c additions in existing describes: cover the branches the
// wave-4 tests missed.
// ──────────────────────────────────────────────────────────────────────

describe('installPack — stage-3c additions', () => {
    it('uses the 60s transaction-timeout opts (large-pack tolerance)', async () => {
        const observedOpts: any[] = [];
        (mockPackFind as jest.Mock).mockResolvedValueOnce({
            key: 'small', name: 'Small', frameworkId: 'fw-1',
            framework: { key: 'X' },
            templateLinks: [],
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn, opts) => {
            if (opts) observedOpts.push(opts);
            return fn({
                control: { findFirst: jest.fn(), create: jest.fn() },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
                policy: { findMany: jest.fn().mockResolvedValue([]) },
                policyControlLink: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
            } as never);
        });

        await installPack(makeRequestContext('ADMIN'), 'small');

        expect(observedOpts[0]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    });

    it('happy-path: creates control + tasks + mappings with correct counts', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'iso', name: 'ISO', frameworkId: 'fw-1',
            framework: { key: 'ISO27001' },
            templateLinks: [
                {
                    template: {
                        code: 'A.5.1', title: 'T', description: 'd', category: 'GOV',
                        defaultFrequency: 'QUARTERLY',
                        tasks: [{ title: 'task-1', description: 'd' }, { title: 'task-2', description: 'd' }],
                        requirementLinks: [{ requirementId: 'r-1' }, { requirementId: 'r-2' }, { requirementId: 'r-3' }],
                    },
                },
            ],
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'c-new' }),
                },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
                policy: { findMany: jest.fn().mockResolvedValue([]) },
                policyControlLink: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
            } as never),
        );

        const result = await installPack(makeRequestContext('ADMIN'), 'iso');

        expect(result.controlsCreated).toBe(1);
        expect(result.tasksCreated).toBe(2);
        expect(result.mappingsCreated).toBe(3);
    });

    it("installs ONLY the pack's own templates — never framework-mapped internal controls", async () => {
        // Regression: installing ISO 27001 created 233 controls, not 93. The pack's
        // own 93 Annex A templates, plus every global ControlTemplate that happened
        // to carry a requirement link into the same framework — 140 internal
        // controls reached policy-mediated. A pack installs the standard's controls
        // and nothing else, so the count a customer sees is the count in the standard.
        mockPackFind.mockResolvedValueOnce({
            key: 'iso', name: 'ISO', frameworkId: 'fw-1',
            framework: { key: 'ISO27001' },
            templateLinks: [
                {
                    template: {
                        id: 't-1', code: 'A.5.1', title: 'T', description: 'd', category: 'GOV',
                        defaultFrequency: 'ANNUAL',
                        relatedPolicies: null,
                        tasks: [],
                        requirementLinks: [{ requirementId: 'r-1' }],
                    },
                },
            ],
        } as never);
        // An internal control IS mapped to this framework. It must be ignored.
        mockTemplateFindMany.mockResolvedValue([
            {
                id: 'ic-1', code: 'ICN-001', title: 'Internal ctrl', description: 'd', category: 'GOV',
                defaultFrequency: 'ANNUAL',
                objective: 'obj', successCriteria: 'sc', testingMethodology: 'tm',
                relatedPolicies: 'Access Management Policy',
                tasks: [],
                requirementLinks: [{ requirementId: 'r-1' }],
            },
        ] as never);

        const controlCreate = jest.fn().mockResolvedValue({ id: 'c-1' });
        const policyCreateMany = jest.fn().mockResolvedValue({ count: 1 });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findFirst: jest.fn().mockResolvedValue(null), create: controlCreate },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn(), upsert: jest.fn() },
                policy: { findMany: jest.fn().mockResolvedValue([{ id: 'p-1', title: 'Access Management Policy' }]) },
                policyControlLink: { createMany: policyCreateMany },
            } as never),
        );

        const result = await installPack(makeRequestContext('ADMIN'), 'iso');

        // Exactly the pack's one template — the mapped internal control is absent.
        expect(result.controlsCreated).toBe(1);
        const createdCodes = controlCreate.mock.calls.map((c) => (c[0] as { data: { code: string } }).data.code);
        expect(createdCodes).toEqual(['A.5.1']);
        expect(createdCodes).not.toContain('ICN-001');

        // And it never even asks for framework-mapped templates: the old sweep is
        // gone rather than merely filtered afterwards.
        expect(mockTemplateFindMany).not.toHaveBeenCalled();
    });

});

describe('installSingleTemplate — stage-3c additions', () => {
    it('throws notFound for an unknown template code', async () => {
        mockTemplateFindUnique.mockResolvedValueOnce(null);
        await expect(
            installSingleTemplate(makeRequestContext('ADMIN'), 'T-missing'),
        ).rejects.toThrow(/template not found/i);
    });

    it('happy-path: creates control + tasks + mappings and fires TEMPLATE_INSTALLED audit', async () => {
        mockTemplateFindUnique.mockResolvedValueOnce({
            id: 't-1', code: 'A.5.1', title: 'X', description: 'd', category: 'GOV', defaultFrequency: 'Q',
            tasks: [{ title: 'T', description: 'd' }],
            requirementLinks: [{ requirementId: 'r-1' }],
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'c-new' }),
                },
                task: { create: jest.fn() },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: jest.fn() },
            } as never),
        );

        const result = await installSingleTemplate(makeRequestContext('ADMIN'), 'A.5.1');

        expect(result).toMatchObject({
            controlId: 'c-new',
            code: 'A.5.1',
            alreadyExisted: false,
            tasksCreated: 1,
            mappingsCreated: 1,
        });
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'TEMPLATE_INSTALLED' }),
        );
    });
});

describe('bulkMapControls — stage-3c additions', () => {
    it('rejects empty mappings array', async () => {
        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'iso', []),
        ).rejects.toThrow(/at least one mapping/i);
    });

    it('rejects null mappings (defensive)', async () => {
        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'iso', null as any),
        ).rejects.toThrow(/at least one mapping/i);
    });

    it('throws notFound when the framework lookup fails', async () => {
        mockFrameworkFindFirst.mockResolvedValueOnce(null);
        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'bogus', [
                { controlId: 'c-1', requirementIds: ['r-1'] },
            ]),
        ).rejects.toThrow(/framework not found/i);
    });

    it('counts created vs existing — unique-constraint violations land in "existing"', async () => {
        // The P2002 catch-and-account branch — covers idempotent
        // re-runs where a previously-attempted mapping survived.
        mockFrameworkFindFirst.mockResolvedValueOnce({ id: 'fw-1' } as never);
        mockReqFindMany.mockResolvedValueOnce([{ id: 'r-1' }, { id: 'r-2' }] as never);
        const linkCreate = jest.fn()
            .mockResolvedValueOnce({ id: 'link-1' })
            .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findMany: jest.fn().mockResolvedValue([{ id: 'c-1' }]) },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create: linkCreate },
            } as never),
        );

        const result = await bulkMapControls(makeRequestContext('ADMIN'), 'iso', [
            { controlId: 'c-1', requirementIds: ['r-1', 'r-2'] },
        ]);

        expect(result).toEqual({ frameworkKey: 'iso', created: 1, existing: 1, total: 2 });
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'BULK_REQUIREMENTS_MAPPED' }),
        );
    });

    it('rejects empty-mappings when array is undefined', async () => {
        await expect(
            bulkMapControls(makeRequestContext('ADMIN'), 'iso', undefined as any),
        ).rejects.toThrow(/at least one mapping/i);
    });
});

describe('removeChosenPack — taking a pack out of scope (#4372)', () => {
    const PACK = { id: 'pack-a3', key: 'EU_UAS_OPEN_A3', name: 'A3', frameworkId: 'fw-uas', framework: { key: 'EU-UAS-OPS' } };

    function scopeDb(opts: { chosen: boolean; count: number }) {
        const calls: string[] = [];
        const db = {
            $executeRawUnsafe: jest.fn(async (sql: string, key: string) => { calls.push(`lock ${key}`); return 1; }),
            tenantFrameworkPack: {
                findUnique: jest.fn(async () => { calls.push('find'); return opts.chosen ? { id: 'tfp-1' } : null; }),
                count: jest.fn(async () => { calls.push('count'); return opts.count; }),
                delete: jest.fn(async () => { calls.push('delete'); return { id: 'tfp-1' }; }),
            },
        };
        return { db, calls };
    }

    it('takes the install gate: READER and AUDITOR are refused before anything is read', async () => {
        for (const role of ['READER', 'AUDITOR'] as const) {
            await expect(removeChosenPack(makeRequestContext(role), 'EU-UAS-OPS', PACK.key)).rejects.toThrow();
        }
        expect(mockPackFind).not.toHaveBeenCalled();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('refuses a pack that does not exist, or belongs to another framework, as not found', async () => {
        mockPackFind.mockResolvedValueOnce(null);
        await expect(removeChosenPack(makeRequestContext('ADMIN'), 'EU-UAS-OPS', 'NOPE')).rejects.toThrow(/Pack not found/);
        mockPackFind.mockResolvedValueOnce({ ...PACK, framework: { key: 'ISO27001' } } as never);
        await expect(removeChosenPack(makeRequestContext('ADMIN'), 'EU-UAS-OPS', PACK.key)).rejects.toThrow(/Pack not found/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('refuses a pack this workspace did not choose (PACK_NOT_CHOSEN), deleting nothing', async () => {
        mockPackFind.mockResolvedValueOnce(PACK as never);
        const { db } = scopeDb({ chosen: false, count: 2 });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));
        await expect(removeChosenPack(makeRequestContext('ADMIN'), 'EU-UAS-OPS', PACK.key)).rejects.toMatchObject({
            status: 409, details: { reason: 'PACK_NOT_CHOSEN' },
        });
        expect(db.tenantFrameworkPack.delete).not.toHaveBeenCalled();
        expect(mockLog).not.toHaveBeenCalled();
    });

    it('refuses the last chosen pack (LAST_CHOSEN_PACK): none chosen would widen the scope', async () => {
        mockPackFind.mockResolvedValueOnce(PACK as never);
        const { db } = scopeDb({ chosen: true, count: 1 });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));
        await expect(removeChosenPack(makeRequestContext('ADMIN'), 'EU-UAS-OPS', PACK.key)).rejects.toMatchObject({
            status: 409, details: { reason: 'LAST_CHOSEN_PACK' },
        });
        expect(db.tenantFrameworkPack.delete).not.toHaveBeenCalled();
        expect(mockLog).not.toHaveBeenCalled();
    });

    it('locks first, deletes only the record, and audits FRAMEWORK_PACK_REMOVED', async () => {
        mockPackFind.mockResolvedValueOnce(PACK as never);
        const ctx = makeRequestContext('ADMIN');
        const { db, calls } = scopeDb({ chosen: true, count: 2 });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await removeChosenPack(ctx, 'EU-UAS-OPS', PACK.key);

        expect(result).toEqual({ packKey: PACK.key, framework: 'EU-UAS-OPS', remainingChosenPacks: 1 });
        // The lock is per (workspace, framework) and comes before the count it protects.
        expect(calls).toEqual([`lock framework-pack-scope:${ctx.tenantId}:fw-uas`, 'find', 'count', 'delete']);
        expect(db.tenantFrameworkPack.delete).toHaveBeenCalledWith({
            where: { tenantId_packId: { tenantId: ctx.tenantId, packId: PACK.id } },
        });
        expect(mockLog).toHaveBeenCalledWith(
            db,
            ctx,
            expect.objectContaining({
                action: 'FRAMEWORK_PACK_REMOVED',
                entityId: 'fw-uas',
                metadata: { packKey: PACK.key, remainingChosenPacks: 1 },
            }),
        );
    });
});
