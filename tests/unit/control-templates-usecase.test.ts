/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/control/mappings.ts`.
 *
 * Roadmap Q1 — Compliance core. Mocks ControlTemplateRepository,
 * ControlRepository, FrameworkRepository, Prisma db, audit emitter,
 * and runInTenantContext.
 *
 * Covers:
 *   - listControlTemplates / listFrameworks / listFrameworkRequirements
 *     read paths + RBAC.
 *   - installControlsFromTemplate — idempotency (skip when control
 *     code already exists, tasks/requirements counts = 0 + reused
 *     controlId), happy install flow with tasks + framework mapping
 *     creation, audit emission per install, multi-template batch.
 *   - mapRequirementToControl / unmapRequirementFromControl —
 *     control-existence pre-check, mapping creation/deletion,
 *     mapping-not-found rejection on unmap.
 *   - listControlMappings — tab-lazy mappings fetch with pre-check
 *     for control existence.
 */

const mockDb = {
    control: { findFirst: jest.fn(), create: jest.fn() },
    // Unified Task + canonical controlRequirementLink — the tables the
    // install / map / unmap paths write after the R2-P1 link unification.
    // Install batches into task.createMany + controlRequirementLink.createMany;
    // map/unmap still use the canonical upsert/findFirst/delete.
    task: { create: jest.fn(), createMany: jest.fn() },
    controlRequirementLink: { upsert: jest.fn(), findFirst: jest.fn(), delete: jest.fn(), createMany: jest.fn() },
    // Policy resolution — a template's `relatedPolicies` (pipe-delimited
    // titles) becomes PolicyControlLink rows on install, matching what the
    // framework wizard does. Both are only touched when the template
    // actually names policies, which is why most cases below leave these
    // untouched.
    policy: { findMany: jest.fn() },
    policyControlLink: { createMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
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

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { ControlTemplateRepository } from '@/app-layer/repositories/ControlTemplateRepository';
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { FrameworkRepository } from '@/app-layer/repositories/FrameworkRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    listControlTemplates,
    installControlsFromTemplate,
    listFrameworks,
    listFrameworkRequirements,
    mapRequirementToControl,
    unmapRequirementFromControl,
    listControlMappings,
} from '@/app-layer/usecases/control/mappings';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── Read paths ────────────────────────────────────────────────────

describe('list reads', () => {
    it('listControlTemplates delegates under read gate', async () => {
        (ControlTemplateRepository.list as jest.Mock).mockResolvedValue([{ id: 't-1' }]);
        const rows = await listControlTemplates(readerCtx);
        expect(rows).toEqual([{ id: 't-1' }]);
    });

    it('listFrameworks delegates under read gate', async () => {
        (FrameworkRepository.listFrameworks as jest.Mock).mockResolvedValue([{ key: 'iso' }]);
        const rows = await listFrameworks(readerCtx);
        expect(rows).toEqual([{ key: 'iso' }]);
    });

    it('listFrameworkRequirements returns the rows on hit', async () => {
        (FrameworkRepository.listRequirements as jest.Mock).mockResolvedValue([{ id: 'r-1' }]);
        const rows = await listFrameworkRequirements(readerCtx, 'iso');
        expect(rows).toEqual([{ id: 'r-1' }]);
    });

    it('listFrameworkRequirements throws notFound when framework is missing', async () => {
        (FrameworkRepository.listRequirements as jest.Mock).mockResolvedValue(null);
        await expect(listFrameworkRequirements(readerCtx, 'nope'))
            .rejects.toThrow(/Framework not found/i);
    });
});

// ─── installControlsFromTemplate ───────────────────────────────────

describe('installControlsFromTemplate', () => {
    it('records an unresolved-templateId row for a template with no matching row', async () => {
        (ControlTemplateRepository.getById as jest.Mock).mockResolvedValue(null);
        const res = await installControlsFromTemplate(editorCtx, ['unknown']);
        expect(res).toEqual([
            { templateCode: '', controlId: '', tasksCreated: 0, requirementsLinked: 0, skipped: true, unresolvedTemplateId: 'unknown' },
        ]);
        expect(mockDb.control.create).not.toHaveBeenCalled();
    });

    it('idempotently skips when a control with the same code already exists', async () => {
        (ControlTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', code: 'A.5', title: 'X', description: 'd', category: 'OPS',
            defaultFrequency: 'MONTHLY', tasks: [], requirementLinks: [],
        });
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-existing' });

        const res = await installControlsFromTemplate(editorCtx, ['t-1']);

        expect(res).toEqual([{
            templateCode: 'A.5',
            controlId: 'c-existing',
            tasksCreated: 0,
            requirementsLinked: 0,
            skipped: true,
        }]);
        // No new control created
        expect(mockDb.control.create).not.toHaveBeenCalled();
        // No audit emitted on skip
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('creates a control + tasks + framework mappings on first install', async () => {
        (ControlTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', code: 'A.5', title: 'X', description: 'd', category: 'OPS',
            defaultFrequency: 'MONTHLY',
            tasks: [
                { title: 'Step 1', description: 'do x' },
                { title: 'Step 2', description: 'do y' },
            ],
            requirementLinks: [
                { requirementId: 'req-1' },
                { requirementId: 'req-2' },
            ],
        });
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        (mockDb.control.create as jest.Mock).mockResolvedValue({ id: 'c-new' });

        const res = await installControlsFromTemplate(editorCtx, ['t-1']);

        expect(res).toEqual([{
            templateCode: 'A.5', controlId: 'c-new', tasksCreated: 2, requirementsLinked: 2, skipped: false,
        }]);
        // Batched: a single createMany per table (was a per-task create + per-link upsert loop).
        expect(mockDb.task.create).not.toHaveBeenCalled();
        expect(mockDb.task.createMany).toHaveBeenCalledTimes(1);
        expect(mockDb.task.createMany.mock.calls[0][0].data).toHaveLength(2);
        expect(mockDb.controlRequirementLink.upsert).not.toHaveBeenCalled();
        expect(mockDb.controlRequirementLink.createMany).toHaveBeenCalledTimes(1);
        expect(mockDb.controlRequirementLink.createMany.mock.calls[0][0].data).toHaveLength(2);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_INSTALLED_FROM_TEMPLATE');
    });

    it('handles multi-template batch with mixed skip/install', async () => {
        (ControlTemplateRepository.getById as jest.Mock)
            .mockResolvedValueOnce({ id: 't-1', code: 'A.5', title: 'X', description: '', category: '', defaultFrequency: null, tasks: [], requirementLinks: [] })
            .mockResolvedValueOnce({ id: 't-2', code: 'A.6', title: 'Y', description: '', category: '', defaultFrequency: null, tasks: [], requirementLinks: [] });
        (mockDb.control.findFirst as jest.Mock)
            .mockResolvedValueOnce({ id: 'c-existing' })   // A.5 exists
            .mockResolvedValueOnce(null);                  // A.6 free
        (mockDb.control.create as jest.Mock).mockResolvedValue({ id: 'c-new' });

        const res = await installControlsFromTemplate(editorCtx, ['t-1', 't-2']);

        expect(res).toEqual([
            { templateCode: 'A.5', controlId: 'c-existing', tasksCreated: 0, requirementsLinked: 0, skipped: true },
            { templateCode: 'A.6', controlId: 'c-new', tasksCreated: 0, requirementsLinked: 0, skipped: false },
        ]);
    });

    it('rejects READER (create-control gate)', async () => {
        await expect(installControlsFromTemplate(readerCtx, ['t-1'])).rejects.toBeDefined();
    });
});

// ─── mapRequirementToControl / unmapRequirementFromControl ─────────

describe('mapRequirementToControl', () => {
    it('upserts a canonical controlRequirementLink when the control exists', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (mockDb.controlRequirementLink.upsert as jest.Mock).mockResolvedValue({ id: 'link-1' });

        const res = await mapRequirementToControl(editorCtx, 'c-1', 'req-1');

        expect(res).toEqual({ id: 'link-1' });
        const upsertArgs = (mockDb.controlRequirementLink.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertArgs.where.controlId_requirementId).toEqual({ controlId: 'c-1', requirementId: 'req-1' });
        expect(upsertArgs.create).toMatchObject({ controlId: 'c-1', requirementId: 'req-1' });
    });

    it('throws notFound when control does not exist', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(mapRequirementToControl(editorCtx, 'missing', 'req-1'))
            .rejects.toThrow(/Control not found/i);
        expect(mockDb.controlRequirementLink.upsert).not.toHaveBeenCalled();
    });
});

describe('unmapRequirementFromControl', () => {
    it('deletes the canonical link when both control and link exist', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (mockDb.controlRequirementLink.findFirst as jest.Mock).mockResolvedValue({ id: 'link-1' });

        const res = await unmapRequirementFromControl(editorCtx, 'c-1', 'req-1');

        expect(res).toEqual({ success: true });
        const deleteArgs = (mockDb.controlRequirementLink.delete as jest.Mock).mock.calls[0][0];
        expect(deleteArgs.where.id).toBe('link-1');
    });

    it('throws notFound on missing control', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(unmapRequirementFromControl(editorCtx, 'missing', 'req-1'))
            .rejects.toThrow(/Control not found/i);
    });

    it('throws notFound on missing mapping', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (mockDb.controlRequirementLink.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(unmapRequirementFromControl(editorCtx, 'c-1', 'req-orphan'))
            .rejects.toThrow(/Mapping not found/i);
    });
});

// ─── listControlMappings ───────────────────────────────────────────

describe('listControlMappings', () => {
    it('returns the framework mappings when the control exists', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (ControlRepository.listControlRequirementLinks as jest.Mock).mockResolvedValue([{ id: 'm-1' }]);

        const res = await listControlMappings(readerCtx, 'c-1');

        expect(res).toEqual([{ id: 'm-1' }]);
    });

    it('throws notFound when the control does not exist (skip the lookup)', async () => {
        (mockDb.control.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(listControlMappings(readerCtx, 'missing'))
            .rejects.toThrow(/Control not found/i);
        expect(ControlRepository.listControlRequirementLinks).not.toHaveBeenCalled();
    });
});

// keep adminCtx reference live for future expansion
void adminCtx;


describe('installControlsFromTemplate — policy links', () => {
    // This path had NO coverage, which is how a mock gap surfaced as a CI
    // failure rather than a local one: the usecase gained a policy lookup
    // and every existing test passed a mock db with no `policy` model.

    it('resolves relatedPolicies to PolicyControlLink rows', async () => {
        (ControlTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 'tpl-1',
            code: 'AC-1',
            title: 'Access control',
            category: 'Access',
            objective: 'Restrict access',
            successCriteria: 'No unauthorised access',
            testingMethodology: 'Sample 25',
            defaultFrequency: 'QUARTERLY',
            relatedPolicies: 'Access Policy|Missing Policy',
            tasks: [],
            requirementLinks: [],
        });
        mockDb.control.findFirst.mockResolvedValue(null);
        mockDb.control.create.mockResolvedValue({ id: 'c-1' });
        mockDb.policy.findMany.mockResolvedValue([{ id: 'p-1', title: 'Access Policy' }]);
        mockDb.policyControlLink.createMany.mockResolvedValue({ count: 1 });

        await installControlsFromTemplate(editorCtx, ['tpl-1']);

        // The known title links; the unknown one is dropped rather than
        // failing the install — a shared template names policies a given
        // tenant may not have written yet.
        expect(mockDb.policyControlLink.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [{ tenantId: editorCtx.tenantId, policyId: 'p-1', controlId: 'c-1' }],
                skipDuplicates: true,
            }),
        );

        // …and the three documented copy-through fields reach the Control.
        expect(mockDb.control.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    objective: 'Restrict access',
                    successCriteria: 'No unauthorised access',
                    testingMethodology: 'Sample 25',
                }),
            }),
        );
    });

    it('does not query policies when the template names none', async () => {
        // The lazy path. Calling the resolver unconditionally made every
        // install pay for a query it did not need — and was what broke the
        // existing suites, whose mock db has no `policy` model by default.
        (ControlTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 'tpl-2', code: 'AC-2', title: 'No policies', category: null,
            objective: null, successCriteria: null, testingMethodology: null,
            defaultFrequency: null, relatedPolicies: null, tasks: [], requirementLinks: [],
        });
        mockDb.control.findFirst.mockResolvedValue(null);
        mockDb.control.create.mockResolvedValue({ id: 'c-2' });
        mockDb.policy.findMany.mockClear();

        await installControlsFromTemplate(editorCtx, ['tpl-2']);

        expect(mockDb.policy.findMany).not.toHaveBeenCalled();
    });
});
