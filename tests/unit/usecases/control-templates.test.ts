/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/control/mappings.ts` —
 * the control-template install + framework-mapping surface.
 *
 * Wave-3 branch coverage. The file is decision-dense:
 *   - 5 distinct policy gates (assertCanReadControls / Create / MapFramework)
 *   - per-template loop with 3 outcome branches in
 *     `installControlsFromTemplate` (template missing → skip,
 *      control already exists → idempotent skip, happy-path create)
 *   - 3 `notFound` branches (`listFrameworkRequirements`,
 *     `mapRequirementToControl`, `unmapRequirementFromControl`,
 *     `listControlMappings`)
 *   - audit emission gated on the happy-path branch only
 *
 * Each test isolates ONE decision so a regression points at the
 * exact branch that drifted.
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];

jest.mock('@/app-layer/policies/control.policies', () => ({
    assertCanReadControls: jest.fn(() => policyCalls.push('read')),
    assertCanCreateControl: jest.fn(() => policyCalls.push('create')),
    assertCanMapFramework: jest.fn(() => policyCalls.push('map')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

jest.mock('@/app-layer/repositories/ControlTemplateRepository', () => ({
    ControlTemplateRepository: {
        list: jest.fn(),
        getById: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        listControlRequirementLinks: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/FrameworkRepository', () => ({
    FrameworkRepository: {
        listFrameworks: jest.fn(),
        listRequirements: jest.fn(),
    },
}));

const mockDb: any = {
    control: { findFirst: jest.fn(), create: jest.fn() },
    // Unified Task + canonical controlRequirementLink (R2-P1 link unification).
    // The install path batches into task.createMany + controlRequirementLink.createMany;
    // map/unmap still use the canonical upsert/findFirst/delete.
    task: { create: jest.fn(), createMany: jest.fn() },
    controlRequirementLink: { upsert: jest.fn(), findFirst: jest.fn(), delete: jest.fn(), createMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, callback: any) => callback(mockDb)),
    };
});

import {
    listControlTemplates,
    installControlsFromTemplate,
    listFrameworks,
    listFrameworkRequirements,
    mapRequirementToControl,
    unmapRequirementFromControl,
    listControlMappings,
} from '@/app-layer/usecases/control/mappings';
import { ControlTemplateRepository } from '@/app-layer/repositories/ControlTemplateRepository';
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { FrameworkRepository } from '@/app-layer/repositories/FrameworkRepository';
import {
    assertCanReadControls,
    assertCanCreateControl,
    assertCanMapFramework,
} from '@/app-layer/policies/control.policies';
import { makeRequestContext } from '../../helpers/make-context';

const mockTplList = ControlTemplateRepository.list as jest.MockedFunction<typeof ControlTemplateRepository.list>;
const mockTplGetById = ControlTemplateRepository.getById as jest.MockedFunction<typeof ControlTemplateRepository.getById>;
const mockListFw = FrameworkRepository.listFrameworks as jest.MockedFunction<typeof FrameworkRepository.listFrameworks>;
const mockListReqs = FrameworkRepository.listRequirements as jest.MockedFunction<typeof FrameworkRepository.listRequirements>;
const mockListMappings = ControlRepository.listControlRequirementLinks as jest.MockedFunction<typeof ControlRepository.listControlRequirementLinks>;

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    [
        mockDb.control.findFirst, mockDb.control.create,
        mockDb.task.create, mockDb.task.createMany,
        mockDb.controlRequirementLink.upsert, mockDb.controlRequirementLink.findFirst, mockDb.controlRequirementLink.delete, mockDb.controlRequirementLink.createMany,
        mockTplList, mockTplGetById,
        mockListFw, mockListReqs, mockListMappings,
        assertCanReadControls as jest.Mock,
        assertCanCreateControl as jest.Mock,
        assertCanMapFramework as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());

    // Re-arm policy spies so the call-order tracking keeps working
    // after `mockReset` blew away the inline mockImplementation.
    (assertCanReadControls as jest.Mock).mockImplementation(() => policyCalls.push('read'));
    (assertCanCreateControl as jest.Mock).mockImplementation(() => policyCalls.push('create'));
    (assertCanMapFramework as jest.Mock).mockImplementation(() => policyCalls.push('map'));
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// listControlTemplates — single-branch authz pass-through
// ──────────────────────────────────────────────────────────────────────
describe('listControlTemplates', () => {
    it('asserts read permission BEFORE the repo call', async () => {
        mockTplList.mockResolvedValueOnce([{ id: 't-1' } as any]);

        await listControlTemplates(ctx);

        // Policy gate ran before any DB work.
        expect(policyCalls).toEqual(['read']);
        expect(mockTplList).toHaveBeenCalledTimes(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// installControlsFromTemplate — three per-template branches
// ──────────────────────────────────────────────────────────────────────
describe('installControlsFromTemplate', () => {
    it('asserts CREATE permission first; an empty templateIds array is a clean no-op', async () => {
        const result = await installControlsFromTemplate(ctx, []);

        expect(policyCalls).toEqual(['create']);
        expect(result).toEqual([]);
        expect(mockTplGetById).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('surfaces an unresolved-templateId row when the repo cannot resolve a template (does not silently drop)', async () => {
        mockTplGetById.mockResolvedValueOnce(null);

        const result = await installControlsFromTemplate(ctx, ['t-missing']);

        expect(result).toEqual([
            { templateCode: '', controlId: '', tasksCreated: 0, requirementsLinked: 0, skipped: true, unresolvedTemplateId: 't-missing' },
        ]);
        expect(mockDb.control.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('SKIPS idempotently when a control with the template code already exists', async () => {
        // Idempotency contract — re-running `installControlsFromTemplate`
        // with the same payload after a partial failure must NOT
        // duplicate controls. The skipped row still appears in the
        // results so the caller knows the post-state matches.
        mockTplGetById.mockResolvedValueOnce({
            id: 't-1', code: 'CC1', title: 'Existing', description: 'x',
            category: 'GOVERNANCE', defaultFrequency: 'QUARTERLY',
            tasks: [], requirementLinks: [],
        } as any);
        mockDb.control.findFirst.mockResolvedValueOnce({ id: 'ctrl-existing' });

        const result = await installControlsFromTemplate(ctx, ['t-1']);

        expect(result).toEqual([
            { templateCode: 'CC1', controlId: 'ctrl-existing', tasksCreated: 0, requirementsLinked: 0, skipped: true },
        ]);
        expect(mockDb.control.create).not.toHaveBeenCalled();
        // No audit on the idempotent-skip branch — only happy-path
        // creates fire the CONTROL_INSTALLED_FROM_TEMPLATE event.
        expect(auditCalls).toHaveLength(0);
    });

    it('creates the control + tasks + framework mappings + fires the audit on happy-path', async () => {
        mockTplGetById.mockResolvedValueOnce({
            id: 't-1', code: 'CC1', title: 'Control Env', description: 'd',
            category: 'GOVERNANCE', defaultFrequency: 'QUARTERLY',
            tasks: [
                { title: 'Task 1', description: 'desc-1' },
                { title: 'Task 2', description: 'desc-2' },
            ],
            requirementLinks: [
                { requirementId: 'req-1' },
                { requirementId: 'req-2' },
                { requirementId: 'req-3' },
            ],
        } as any);
        mockDb.control.findFirst.mockResolvedValueOnce(null);
        mockDb.control.create.mockResolvedValueOnce({ id: 'ctrl-new' });

        const result = await installControlsFromTemplate(ctx, ['t-1']);

        expect(result).toEqual([
            { templateCode: 'CC1', controlId: 'ctrl-new', tasksCreated: 2, requirementsLinked: 3, skipped: false },
        ]);
        // Batched: a single createMany per table (was a per-task create + per-link upsert loop).
        expect(mockDb.task.create).not.toHaveBeenCalled();
        expect(mockDb.task.createMany).toHaveBeenCalledTimes(1);
        expect(mockDb.task.createMany.mock.calls[0][0].data).toHaveLength(2);
        expect(mockDb.controlRequirementLink.upsert).not.toHaveBeenCalled();
        expect(mockDb.controlRequirementLink.createMany).toHaveBeenCalledTimes(1);
        expect(mockDb.controlRequirementLink.createMany.mock.calls[0][0].data).toHaveLength(3);
        expect(mockDb.controlRequirementLink.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0].action).toBe('CONTROL_INSTALLED_FROM_TEMPLATE');
        expect(auditCalls[0].metadata).toMatchObject({
            templateId: 't-1', tasksCreated: 2, requirementsLinked: 3,
        });
    });

    it('handles a MIX of skip + happy-path templates in one call (independent branch state per row)', async () => {
        // template-1 → missing (unresolved result row, no audit)
        // template-2 → already-exists (idempotent skip + result row, no audit)
        // template-3 → happy-path (full create + audit)
        mockTplGetById
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 't-2', code: 'CC2', title: 'Existing', description: 'x',
                category: 'GOVERNANCE', defaultFrequency: 'QUARTERLY',
                tasks: [], requirementLinks: [],
            } as any)
            .mockResolvedValueOnce({
                id: 't-3', code: 'CC3', title: 'New', description: 'y',
                category: 'OPERATIONS', defaultFrequency: 'MONTHLY',
                tasks: [{ title: 'T', description: null }],
                requirementLinks: [],
            } as any);
        mockDb.control.findFirst
            .mockResolvedValueOnce({ id: 'ctrl-existing' })
            .mockResolvedValueOnce(null);
        mockDb.control.create.mockResolvedValueOnce({ id: 'ctrl-new' });

        const result = await installControlsFromTemplate(ctx, ['t-1', 't-2', 't-3']);

        expect(result).toHaveLength(3); // t-1 now surfaces an unresolved row; t-2 + t-3 as before
        expect(result[0]).toMatchObject({ skipped: true, unresolvedTemplateId: 't-1', templateCode: '', controlId: '' });
        expect(result[1]).toMatchObject({ templateCode: 'CC2', controlId: 'ctrl-existing', tasksCreated: 0 });
        expect(result[2]).toMatchObject({ templateCode: 'CC3', controlId: 'ctrl-new', tasksCreated: 1 });
        expect(auditCalls).toHaveLength(1); // only t-3 fires audit
        expect(auditCalls[0].metadata.templateId).toBe('t-3');
    });
});

// ──────────────────────────────────────────────────────────────────────
// listFrameworks / listFrameworkRequirements — read + notFound branches
// ──────────────────────────────────────────────────────────────────────
describe('framework reads', () => {
    it('listFrameworks asserts read permission and delegates to the repo', async () => {
        mockListFw.mockResolvedValueOnce([{ id: 'fw-1' }] as any);
        const result = await listFrameworks(ctx);
        expect(policyCalls).toEqual(['read']);
        expect(result).toEqual([{ id: 'fw-1' }]);
    });

    it('listFrameworkRequirements throws notFound when the framework key is unknown', async () => {
        mockListReqs.mockResolvedValueOnce(null);
        await expect(listFrameworkRequirements(ctx, 'fw-bogus')).rejects.toThrow(/not found/i);
    });

    it('listFrameworkRequirements returns the repo payload on the happy-path', async () => {
        mockListReqs.mockResolvedValueOnce({ framework: { key: 'iso-27001' }, requirements: [] } as any);
        const result = await listFrameworkRequirements(ctx, 'iso-27001');
        expect(result).toEqual({ framework: { key: 'iso-27001' }, requirements: [] });
    });
});

// ──────────────────────────────────────────────────────────────────────
// mapRequirementToControl / unmapRequirementFromControl — write branches
// ──────────────────────────────────────────────────────────────────────
describe('mapRequirementToControl', () => {
    it('asserts MAP permission BEFORE any DB lookup', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockDb.controlRequirementLink.upsert.mockResolvedValueOnce({ id: 'm-1' });

        await mapRequirementToControl(ctx, 'c-1', 'r-1');

        // Policy first; then DB.
        expect(policyCalls).toEqual(['map']);
        expect(mockDb.control.findFirst).toHaveBeenCalled();
    });

    it('throws notFound when the control id is foreign to the tenant', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce(null);
        await expect(
            mapRequirementToControl(ctx, 'c-foreign', 'r-1'),
        ).rejects.toThrow(/control not found/i);
        // Critical: the cross-tenant id MUST NOT result in a create.
        expect(mockDb.controlRequirementLink.upsert).not.toHaveBeenCalled();
    });
});

describe('unmapRequirementFromControl', () => {
    it('throws notFound when the control id is foreign to the tenant', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce(null);
        await expect(
            unmapRequirementFromControl(ctx, 'c-foreign', 'r-1'),
        ).rejects.toThrow(/control not found/i);
        expect(mockDb.controlRequirementLink.delete).not.toHaveBeenCalled();
    });

    it('throws notFound when the mapping itself does not exist (control was found)', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockDb.controlRequirementLink.findFirst.mockResolvedValueOnce(null);

        await expect(
            unmapRequirementFromControl(ctx, 'c-1', 'r-1'),
        ).rejects.toThrow(/mapping not found/i);
        expect(mockDb.controlRequirementLink.delete).not.toHaveBeenCalled();
    });

    it('deletes the mapping row on the happy-path and returns {success: true}', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockDb.controlRequirementLink.findFirst.mockResolvedValueOnce({ id: 'm-1' });
        mockDb.controlRequirementLink.delete.mockResolvedValueOnce({ id: 'm-1' });

        const result = await unmapRequirementFromControl(ctx, 'c-1', 'r-1');

        expect(result).toEqual({ success: true });
        expect(mockDb.controlRequirementLink.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    });
});

// ──────────────────────────────────────────────────────────────────────
// listControlMappings — read permission + cross-tenant 404
// ──────────────────────────────────────────────────────────────────────
describe('listControlMappings', () => {
    it('throws notFound for a control id that is foreign to the tenant', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce(null);
        await expect(listControlMappings(ctx, 'c-foreign')).rejects.toThrow(/control not found/i);
        expect(mockListMappings).not.toHaveBeenCalled();
    });

    it('delegates to the repo on the happy-path', async () => {
        mockDb.control.findFirst.mockResolvedValueOnce({ id: 'c-1' });
        mockListMappings.mockResolvedValueOnce([{ id: 'm-1' }] as any);

        const result = await listControlMappings(ctx, 'c-1');

        expect(result).toEqual([{ id: 'm-1' }]);
        expect(policyCalls).toEqual(['read']);
    });
});
