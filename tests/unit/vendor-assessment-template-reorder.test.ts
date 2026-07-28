/**
 * Epic G-3 prompt 6 — reorderTemplate + getTemplateTree tests.
 *
 * Pins:
 *   • permission gate (canWrite)
 *   • notFound when template is not in tenant
 *   • publish-guard rejects with "Clone it" message
 *   • reorder updates section + question rows scoped to (id, tenantId, templateId)
 *   • cross-section move rewrites sectionId on the question
 *   • getTemplateTree returns the full include
 */

const mockTx = {
    vendorAssessmentTemplate: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    vendorAssessmentTemplateSection: { updateMany: jest.fn() },
    vendorAssessmentTemplateQuestion: { updateMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.trim()),
}));

import {
    reorderTemplate,
    getTemplateTree,
    listTemplates,
} from '@/app-layer/usecases/vendor-assessment-template';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(opts: { canWrite?: boolean; canRead?: boolean } = {}) {
    const __base = getPermissionsForRole('ADMIN');
    return {
        requestId: 'r-1',
        userId: 'u-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: opts.canRead ?? true,
            canWrite: opts.canWrite ?? true,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        // Vendor policies read the CUSTOM-ROLE-AWARE set (2026-07-28), so the
        // canWrite/canRead knobs this helper exposes must move the granular
        // `vendors.*` keys in step. `{} as never` left `appPermissions.vendors`
        // undefined the moment the policies stopped reading the coarse tier.
        appPermissions: { ...__base, vendors: { ...__base.vendors, view: opts.canRead ?? true, edit: opts.canWrite ?? true, create: opts.canWrite ?? true } },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockTx.vendorAssessmentTemplate).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    mockTx.vendorAssessmentTemplateSection.updateMany.mockReset();
    mockTx.vendorAssessmentTemplateQuestion.updateMany.mockReset();
});

describe('reorderTemplate — guards', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            reorderTemplate(makeCtx({ canWrite: false }), 't-1', {
                sections: [],
            }),
        ).rejects.toThrow(/permission|ADMIN/);
    });

    test('rejects when template is not in tenant', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce(null);
        await expect(
            reorderTemplate(makeCtx(), 't-missing', { sections: [] }),
        ).rejects.toThrow(/not found/i);
    });

    test('publish-guard rejects published template', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: true,
            name: 'X',
        });
        await expect(
            reorderTemplate(makeCtx(), 't-1', { sections: [] }),
        ).rejects.toThrow(/Clone it/i);
    });
});

describe('reorderTemplate — happy path', () => {
    test('rewrites section sortOrder scoped to (id, tenantId, templateId)', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: false,
            name: 'X',
        });
        mockTx.vendorAssessmentTemplateSection.updateMany.mockResolvedValue({ count: 1 });
        await reorderTemplate(makeCtx(), 't-1', {
            sections: [
                { id: 's-A', sortOrder: 0 },
                { id: 's-B', sortOrder: 1 },
            ],
        });
        expect(mockTx.vendorAssessmentTemplateSection.updateMany).toHaveBeenCalledTimes(2);
        const callA = mockTx.vendorAssessmentTemplateSection.updateMany.mock.calls[0][0];
        expect(callA.where).toEqual({
            id: 's-A',
            tenantId: 'tenant-1',
            templateId: 't-1',
        });
        expect(callA.data).toEqual({ sortOrder: 0 });
    });

    test('cross-section question move rewrites sectionId + sortOrder', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: false,
            name: 'X',
        });
        mockTx.vendorAssessmentTemplateSection.updateMany.mockResolvedValue({ count: 1 });
        mockTx.vendorAssessmentTemplateQuestion.updateMany.mockResolvedValue({ count: 1 });
        await reorderTemplate(makeCtx(), 't-1', {
            sections: [
                {
                    id: 's-A',
                    sortOrder: 0,
                    questions: [],
                },
                {
                    id: 's-B',
                    sortOrder: 1,
                    questions: [
                        // Question that lived in s-A migrates to s-B.
                        { id: 'q-1', sectionId: 's-B', sortOrder: 0 },
                    ],
                },
            ],
        });
        expect(
            mockTx.vendorAssessmentTemplateQuestion.updateMany,
        ).toHaveBeenCalledTimes(1);
        const qCall = mockTx.vendorAssessmentTemplateQuestion.updateMany.mock.calls[0][0];
        expect(qCall.where).toEqual({
            id: 'q-1',
            tenantId: 'tenant-1',
            templateId: 't-1',
        });
        expect(qCall.data).toEqual({
            sectionId: 's-B',
            sortOrder: 0,
        });
    });
});

describe('getTemplateTree + listTemplates', () => {
    test('getTemplateTree returns the full include shape', async () => {
        const fakeTree = {
            id: 't-1',
            name: 'X',
            sections: [],
            questions: [],
        };
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce(fakeTree);
        const r = await getTemplateTree(makeCtx(), 't-1');
        expect(r).toBe(fakeTree);
        const call = mockTx.vendorAssessmentTemplate.findFirst.mock.calls[0][0];
        expect(call.include?.sections.orderBy).toEqual({ sortOrder: 'asc' });
        expect(call.include?.questions.orderBy).toEqual({ sortOrder: 'asc' });
    });

    test('listTemplates filters by isLatestVersion=true', async () => {
        mockTx.vendorAssessmentTemplate.findMany.mockResolvedValueOnce([]);
        await listTemplates(makeCtx());
        const call = mockTx.vendorAssessmentTemplate.findMany.mock.calls[0][0];
        expect(call.where).toMatchObject({
            tenantId: 'tenant-1',
            isLatestVersion: true,
        });
        expect(call.orderBy).toEqual({ updatedAt: 'desc' });
    });
});
