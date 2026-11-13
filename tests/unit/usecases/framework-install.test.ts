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

// The plan's control limit (#5263). Mocked so a test can see the count each
// install asks for, and refuse it.
jest.mock('@/lib/billing/entitlements', () => ({
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    getEffectivePlan: jest.fn().mockResolvedValue('ENTERPRISE'),
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
import { assertWithinLimit } from '@/lib/billing/entitlements';
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
const mockAssertWithinLimit = assertWithinLimit as jest.MockedFunction<typeof assertWithinLimit>;

/**
 * Every install first reads which of its template codes already have a
 * control, to ask the plan's limit for the number it would create (#5263).
 * That read is its own short transaction, queued ahead of the install's.
 */
function primeControlCount(existingCodes: string[] = []) {
    mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
        fn({ control: { findMany: jest.fn().mockResolvedValue(existingCodes.map((code) => ({ code }))) } } as never),
    );
}

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

    it('throws notFound when pack does not exist, naming the reason', async () => {
        mockPackFind.mockResolvedValueOnce(null);

        await expect(
            previewPackInstall(makeRequestContext('ADMIN'), 'no-such-pack'),
        ).rejects.toMatchObject({ message: expect.stringMatching(/Pack not found/), details: { reason: 'PACK_NOT_FOUND' } });
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
                        { id: 'c-1', code: 'A.5.1' }, // already installed
                    ]),
                },
                controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
            } as never),
        );

        const result = await previewPackInstall(
            makeRequestContext('ADMIN'),
            'iso27001-2022',
        );

        expect(result.totalTemplates).toBe(3);
        expect(result.newControls).toBe(2);
        expect(result.existingControls).toBe(1);
        expect(result.missingMappings).toBe(0);
    });

    // #4731 — a re-install restores the mappings an existing control lost,
    // so the preview says how many, and the wizard offers the install.
    it('counts the requirement mappings missing from controls that already exist', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'iso27001-2022',
            name: 'ISO 27001:2022',
            framework: { key: 'ISO27001', name: 'ISO', version: '2022' },
            templateLinks: [
                {
                    template: {
                        code: 'A.5.1', title: 'X', tasks: [],
                        requirementLinks: [
                            { requirementId: 'r-1', requirement: { code: '5.1', title: 'a' } },
                            { requirementId: 'r-2', requirement: { code: '5.2', title: 'b' } },
                        ],
                    },
                },
                {
                    template: {
                        code: 'A.5.9', title: 'New', tasks: [],
                        requirementLinks: [{ requirementId: 'r-9', requirement: { code: '5.9', title: 'c' } }],
                    },
                },
            ],
        } as never);
        const linkFindMany = jest.fn().mockResolvedValue([{ controlId: 'c-1', requirementId: 'r-1' }]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findMany: jest.fn().mockResolvedValue([{ id: 'c-1', code: 'A.5.1' }]) },
                controlRequirementLink: { findMany: linkFindMany },
            } as never),
        );

        const result = await previewPackInstall(makeRequestContext('ADMIN'), 'iso27001-2022');

        // r-2 is missing from A.5.1; A.5.9 is a new control, whose mappings
        // are created rather than restored, so it does not count here.
        expect(result.missingMappings).toBe(1);
        expect(result.templates.find((t) => t.code === 'A.5.1')?.missingMappings).toBe(1);
        expect(result.templates.find((t) => t.code === 'A.5.9')?.missingMappings).toBe(0);
        expect(linkFindMany.mock.calls[0][0].where.controlId).toEqual({ in: ['c-1'] });
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

    it('skips controls that already exist (idempotent) but restores their missing requirement links, and counts them', async () => {
        primeControlCount();
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
        const linkCreateMany = jest.fn().mockResolvedValue({ count: 1 });

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
                    createMany: linkCreateMany,
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
        // BUT a missing requirement link is restored, so a partial previous
        // install, or a mapping removed since, converges — and the result
        // counts it (#4731), since that is what a re-install is for.
        expect(linkCreateMany).toHaveBeenCalledWith({
            data: [{ tenantId: expect.any(String), controlId: 'existing-c', requirementId: 'req-1' }],
            skipDuplicates: true,
        });
        expect(linkCreate).not.toHaveBeenCalled();
        expect(result.controlsCreated).toBe(0);
        expect(result.mappingsCreated).toBe(1);
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
        primeControlCount();
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

        // The limit read, then ONE write transaction for every pack.
        expect(mockRunInTx).toHaveBeenCalledTimes(2);
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
            fn({
                control: { findMany: jest.fn().mockResolvedValue([{ id: 'c-core', code: 'UAS-CORE-01' }]) },
                controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
                // A2 is already in scope; A3 is not (#5277).
                tenantFrameworkPack: { findMany: jest.fn().mockResolvedValue([{ packId: A2.id }]) },
            } as never),
        );

        const preview = await previewPacksInstall(makeRequestContext('READER'), 'EU-UAS-OPS', ['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);
        expect(preview.packsToAdd).toEqual(['EU_UAS_OPEN_A3']);

        expect(preview.templates.map((t) => t.code)).toEqual(['UAS-CORE-01', 'UAS-A2-01', 'UAS-A3-01']);
        expect(preview.totalTemplates).toBe(3);
        expect(preview.existingControls).toBe(1);
        expect(preview.newControls).toBe(2);
        expect(preview.packKeys).toEqual(['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);
    });
});

describe('installSingleTemplate — idempotency', () => {
    it('returns alreadyExisted=true without recreating, but ensures requirement links', async () => {
        primeControlCount();
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
        primeControlCount();
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
        primeControlCount();
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
        primeControlCount();
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
        primeControlCount();
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

    it('counts created vs existing from ONE insert that skips the pairs already linked (#5264)', async () => {
        // It used to create each link and catch the unique violation inside
        // the interactive transaction. Postgres aborts the transaction at the
        // first failed statement, so one existing mapping failed the batch.
        mockFrameworkFindFirst.mockResolvedValueOnce({ id: 'fw-1' } as never);
        mockReqFindMany.mockResolvedValueOnce([{ id: 'r-1' }, { id: 'r-2' }] as never);
        const createMany = jest.fn().mockResolvedValue({ count: 1 });
        const create = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findMany: jest.fn().mockResolvedValue([{ id: 'c-1' }]) },
                tenantFrameworkPack: { upsert: jest.fn() },
                controlRequirementLink: { create, createMany },
            } as never),
        );

        const result = await bulkMapControls(makeRequestContext('ADMIN'), 'iso', [
            // r-1 twice: a pair named twice is one pair.
            { controlId: 'c-1', requirementIds: ['r-1', 'r-2', 'r-1'] },
        ]);

        expect(create).not.toHaveBeenCalled();
        expect(createMany).toHaveBeenCalledTimes(1);
        expect(createMany.mock.calls[0][0]).toEqual({
            data: [
                { tenantId: makeRequestContext('ADMIN').tenantId, controlId: 'c-1', requirementId: 'r-1' },
                { tenantId: makeRequestContext('ADMIN').tenantId, controlId: 'c-1', requirementId: 'r-2' },
            ],
            skipDuplicates: true,
        });
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

describe('every install is held to the plan control limit (#5263)', () => {
    const TEMPLATE = {
        id: 't-1', code: 'A.5.1', title: 'Policies', description: null, category: 'GOV', defaultFrequency: 'QUARTERLY',
        objective: 'Have policies', successCriteria: 'Approved annually', testingMethodology: 'Inspect',
        relatedPolicies: null, tasks: [], requirementLinks: [],
    };

    it('installPack asks for the controls it would create, and a refusal writes nothing', async () => {
        mockPackFind.mockResolvedValueOnce({
            key: 'p', name: 'P', framework: { key: 'F' }, frameworkId: 'fw',
            templateLinks: [{ template: { ...TEMPLATE, code: 'A' } }, { template: { ...TEMPLATE, code: 'B' } }, { template: { ...TEMPLATE, code: 'C' } }],
        } as never);
        primeControlCount(['B']); // B already exists
        mockAssertWithinLimit.mockRejectedValueOnce(new Error('plan_limit_exceeded: control'));

        await expect(installPack(makeRequestContext('ADMIN'), 'p')).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockAssertWithinLimit).toHaveBeenCalledWith(expect.anything(), 'control', 2);
        // Only the count read ran: the install's own transaction never opened.
        expect(mockRunInTx).toHaveBeenCalledTimes(1);
    });

    it('installPacks counts a control shared by several packs once', async () => {
        mockPackFindMany
            .mockResolvedValueOnce([{ key: 'a', framework: { key: 'F' } }, { key: 'b', framework: { key: 'F' } }] as never)
            .mockResolvedValueOnce([
                { key: 'a', name: 'A', frameworkId: 'fw', templateLinks: [{ template: { ...TEMPLATE, code: 'CORE' } }, { template: { ...TEMPLATE, code: 'A1' } }] },
                { key: 'b', name: 'B', frameworkId: 'fw', templateLinks: [{ template: { ...TEMPLATE, code: 'CORE' } }] },
            ] as never);
        primeControlCount();
        mockAssertWithinLimit.mockRejectedValueOnce(new Error('plan_limit_exceeded: control'));

        await expect(installPacks(makeRequestContext('ADMIN'), 'F', ['a', 'b'])).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockAssertWithinLimit).toHaveBeenCalledWith(expect.anything(), 'control', 2);
    });

    it('installSingleTemplate asks for one control, and none once it exists', async () => {
        mockTemplateFindUnique.mockResolvedValueOnce(TEMPLATE as never);
        primeControlCount();
        mockAssertWithinLimit.mockRejectedValueOnce(new Error('plan_limit_exceeded: control'));
        await expect(installSingleTemplate(makeRequestContext('ADMIN'), 'A.5.1')).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockAssertWithinLimit).toHaveBeenLastCalledWith(expect.anything(), 'control', 1);
    });

    it('bulkInstallTemplates asks for the templates without a control', async () => {
        mockTemplateFindMany.mockResolvedValueOnce([{ ...TEMPLATE, code: 'X' }, { ...TEMPLATE, code: 'Y' }] as never);
        primeControlCount(['X']);
        mockAssertWithinLimit.mockRejectedValueOnce(new Error('plan_limit_exceeded: control'));
        await expect(bulkInstallTemplates(makeRequestContext('ADMIN'), ['X', 'Y'])).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockAssertWithinLimit).toHaveBeenCalledWith(expect.anything(), 'control', 1);
        expect(mockRunInTx).toHaveBeenCalledTimes(1);
    });
});

describe('the single and bulk template installs write the shared projection (#5265)', () => {
    const TEMPLATE = {
        id: 't-1', code: 'IC-01', title: 'Access reviews', description: null, category: 'IAM', defaultFrequency: 'QUARTERLY',
        objective: 'Review access', successCriteria: 'Every account reviewed', testingMethodology: 'Sample 25 accounts',
        relatedPolicies: 'Access Control Policy', tasks: [], requirementLinks: [],
    };
    const txWithCreate = () => {
        const create = jest.fn().mockResolvedValue({ id: 'c-new' });
        const linkMany = jest.fn().mockResolvedValue({ count: 1 });
        const tx = {
            control: { findFirst: jest.fn().mockResolvedValue(null), create },
            task: { create: jest.fn() },
            controlRequirementLink: { create: jest.fn() },
            policy: { findMany: jest.fn().mockResolvedValue([{ id: 'pol-1', title: 'Access Control Policy' }]) },
            policyControlLink: { createMany: linkMany },
        };
        return { tx, create, linkMany };
    };

    it.each([
        ['installSingleTemplate', () => installSingleTemplate(makeRequestContext('ADMIN'), 'IC-01'), () => mockTemplateFindUnique.mockResolvedValueOnce(TEMPLATE as never)],
        ['bulkInstallTemplates', () => bulkInstallTemplates(makeRequestContext('ADMIN'), ['IC-01']), () => mockTemplateFindMany.mockResolvedValueOnce([TEMPLATE] as never)],
    ])('%s carries the objective, success criteria and testing method, and links the related policy', async (_name, run, prime) => {
        prime();
        primeControlCount();
        const { tx, create, linkMany } = txWithCreate();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(tx as never));

        await run();

        expect(create.mock.calls[0][0].data).toMatchObject({
            code: 'IC-01',
            name: 'Access reviews',
            objective: 'Review access',
            successCriteria: 'Every account reviewed',
            testingMethodology: 'Sample 25 accounts',
        });
        expect(linkMany).toHaveBeenCalledWith({
            data: [{ tenantId: makeRequestContext('ADMIN').tenantId, policyId: 'pol-1', controlId: 'c-new' }],
            skipDuplicates: true,
        });
    });
});
