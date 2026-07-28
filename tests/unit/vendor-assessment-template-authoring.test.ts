/**
 * Epic G-3 prompt 2 — vendor-assessment-template authoring unit tests.
 *
 * Pure-memory tests of the four authoring usecases:
 *
 *   • createTemplate    — permission gate, key canonicalisation,
 *                         draft-defaults
 *   • addSection        — auto-sortOrder, publish-guard, sanitisation
 *   • addQuestion       — per-answerType validation, auto-sortOrder,
 *                         publish-guard
 *   • cloneTemplate     — deep copy, fresh ids, version semantics,
 *                         isLatestVersion flip
 *
 * Prisma is mocked via `runInTenantContext` short-circuit; logger,
 * sanitiser, and audit emitter are stubbed so the tests run in
 * pure memory.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockTx = {
    vendorAssessmentTemplate: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    vendorAssessmentTemplateSection: {
        create: jest.fn(),
        findFirst: jest.fn(),
        aggregate: jest.fn(),
    },
    vendorAssessmentTemplateQuestion: {
        create: jest.fn(),
        aggregate: jest.fn(),
    },
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
    createTemplate,
    addSection,
    addQuestion,
    cloneTemplate,
    publishTemplate,
} from '@/app-layer/usecases/vendor-assessment-template';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: { canWrite?: boolean } = {}) {
    const __base = getPermissionsForRole('ADMIN');
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true,
            canWrite: overrides.canWrite ?? true,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        // Vendor policies read the CUSTOM-ROLE-AWARE set (2026-07-28), so the
        // canWrite/canRead knobs this helper exposes must move the granular
        // `vendors.*` keys in step. `{} as never` left `appPermissions.vendors`
        // undefined the moment the policies stopped reading the coarse tier.
        appPermissions: { ...__base, vendors: { ...__base.vendors, edit: overrides.canWrite ?? true, create: overrides.canWrite ?? true } },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockTx.vendorAssessmentTemplate).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentTemplateSection).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentTemplateQuestion).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
});

// ═══════════════════════════════════════════════════════════════════
// 1. createTemplate
// ═══════════════════════════════════════════════════════════════════

describe('createTemplate', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            createTemplate(makeCtx({ canWrite: false }), {
                key: 'soc2',
                name: 'SOC 2 questionnaire',
            }),
        ).rejects.toThrow(/permission|ADMIN/);
    });

    test('canonicalises the key to lowercase-kebab-case', async () => {
        mockTx.vendorAssessmentTemplate.create.mockResolvedValueOnce({
            id: 't-1',
            name: 'x',
        });
        await createTemplate(makeCtx(), {
            key: 'Security Q  v2!',
            name: 'X',
        });
        const data = mockTx.vendorAssessmentTemplate.create.mock.calls[0][0]
            .data as { key: string };
        expect(data.key).toBe('security-q-v2');
    });

    test('rejects keys that canonicalise to empty', async () => {
        await expect(
            createTemplate(makeCtx(), { key: '!!!', name: 'X' }),
        ).rejects.toThrow(/alphanumeric/i);
    });

    test('creates with draft defaults: version=1, isLatestVersion=true, isPublished=false', async () => {
        mockTx.vendorAssessmentTemplate.create.mockResolvedValueOnce({
            id: 't-1',
            name: 'SOC 2',
        });
        await createTemplate(makeCtx(), {
            key: 'soc2',
            name: 'SOC 2 questionnaire',
            description: 'Standard SOC 2 vendor due diligence',
        });
        const data = mockTx.vendorAssessmentTemplate.create.mock.calls[0][0]
            .data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            key: 'soc2',
            version: 1,
            isLatestVersion: true,
            isPublished: false,
            isGlobal: false,
            createdByUserId: 'user-1',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. addSection
// ═══════════════════════════════════════════════════════════════════

describe('addSection', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            addSection(makeCtx({ canWrite: false }), 't-1', {
                title: 'X',
            }),
        ).rejects.toThrow(/permission|ADMIN/);
    });

    test('returns notFound when the template is not in the tenant', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce(null);
        await expect(
            addSection(makeCtx(), 't-missing', { title: 'X' }),
        ).rejects.toThrow(/not found/i);
    });

    test('rejects edits to a published template with a clone-first message', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: true,
            name: 'SOC 2',
        });
        await expect(
            addSection(makeCtx(), 't-1', { title: 'X' }),
        ).rejects.toThrow(/Clone it/i);
    });

    test('auto-assigns sortOrder = max(siblings)+1 when omitted', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: false,
            name: 'X',
        });
        mockTx.vendorAssessmentTemplateSection.aggregate.mockResolvedValueOnce({
            _max: { sortOrder: 4 },
        });
        mockTx.vendorAssessmentTemplateSection.create.mockResolvedValueOnce({
            id: 's-5',
            title: 'New section',
        });

        await addSection(makeCtx(), 't-1', { title: 'New section' });

        const data = mockTx.vendorAssessmentTemplateSection.create.mock.calls[0][0]
            .data;
        expect(data.sortOrder).toBe(5);
    });

    test('honours explicit sortOrder when provided', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            isPublished: false,
            name: 'X',
        });
        mockTx.vendorAssessmentTemplateSection.create.mockResolvedValueOnce({
            id: 's-1',
            title: 'X',
        });

        await addSection(makeCtx(), 't-1', { title: 'X', sortOrder: 0 });

        const data = mockTx.vendorAssessmentTemplateSection.create.mock.calls[0][0]
            .data;
        expect(data.sortOrder).toBe(0);
        // aggregate not called when caller specifies sortOrder.
        expect(
            mockTx.vendorAssessmentTemplateSection.aggregate,
        ).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. addQuestion
// ═══════════════════════════════════════════════════════════════════

describe('addQuestion — per-answerType validation', () => {
    test('SINGLE_SELECT without optionsJson is rejected', async () => {
        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Pick',
                answerType: 'SINGLE_SELECT',
            }),
        ).rejects.toThrow(/optionsJson/i);
    });

    test('MULTI_SELECT with empty optionsJson is rejected', async () => {
        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Pick',
                answerType: 'MULTI_SELECT',
                optionsJson: [],
            }),
        ).rejects.toThrow(/non-empty optionsJson/i);
    });

    test('SCALE without scaleConfigJson is rejected', async () => {
        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Rate',
                answerType: 'SCALE',
            }),
        ).rejects.toThrow(/scaleConfigJson/i);
    });

    test('SCALE with min >= max is rejected', async () => {
        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Rate',
                answerType: 'SCALE',
                scaleConfigJson: { min: 5, max: 5 },
            }),
        ).rejects.toThrow(/min < max/);
    });

    test('FILE_UPLOAD requires no extra config', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            templateId: 't-1',
            template: { isPublished: false, name: 'X' },
        });
        mockTx.vendorAssessmentTemplateQuestion.aggregate.mockResolvedValueOnce({
            _max: { sortOrder: -1 },
        });
        mockTx.vendorAssessmentTemplateQuestion.create.mockResolvedValueOnce({
            id: 'q-1',
        });

        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Upload your DPA',
                answerType: 'FILE_UPLOAD',
            }),
        ).resolves.toBeDefined();
    });
});

describe('addQuestion — happy path', () => {
    test('creates with auto-sortOrder and publish-guard passes', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            templateId: 't-1',
            template: { isPublished: false, name: 'X' },
        });
        mockTx.vendorAssessmentTemplateQuestion.aggregate.mockResolvedValueOnce({
            _max: { sortOrder: 2 },
        });
        mockTx.vendorAssessmentTemplateQuestion.create.mockResolvedValueOnce({
            id: 'q-3',
        });

        await addQuestion(makeCtx(), 's-1', {
            prompt: 'Encrypt at rest?',
            answerType: 'YES_NO',
            weight: 3,
        });

        const data = mockTx.vendorAssessmentTemplateQuestion.create.mock.calls[0][0]
            .data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            templateId: 't-1',
            sectionId: 's-1',
            sortOrder: 3,
            answerType: 'YES_NO',
            weight: 3,
            required: true,
        });
    });

    test('publish-guard rejects writes to a published template', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            templateId: 't-1',
            template: { isPublished: true, name: 'SOC 2' },
        });
        await expect(
            addQuestion(makeCtx(), 's-1', {
                prompt: 'Encrypt?',
                answerType: 'YES_NO',
            }),
        ).rejects.toThrow(/Clone it/i);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. cloneTemplate
// ═══════════════════════════════════════════════════════════════════

describe('cloneTemplate — NEW_KEY mode', () => {
    test('requires a key on the input', async () => {
        await expect(
            cloneTemplate(makeCtx(), 't-1', { mode: 'NEW_KEY' }),
        ).rejects.toThrow(/key/i);
    });

    test('creates a new family at version=1 and does not flip source isLatestVersion', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-source',
            tenantId: 'tenant-1',
            key: 'soc2',
            version: 3,
            name: 'SOC 2 v3',
            description: 'Original',
            isGlobal: false,
            sections: [
                {
                    id: 'sec-1',
                    title: 'Security',
                    description: null,
                    sortOrder: 0,
                    weight: null,
                },
            ],
            questions: [
                {
                    id: 'q-1',
                    sectionId: 'sec-1',
                    sortOrder: 0,
                    prompt: 'Encrypt?',
                    answerType: 'YES_NO',
                    required: true,
                    weight: 1,
                    optionsJson: null,
                    scaleConfigJson: null,
                    riskPointsJson: null,
                },
            ],
        });
        mockTx.vendorAssessmentTemplate.create.mockResolvedValueOnce({
            id: 't-clone',
            key: 'soc2-fork',
            version: 1,
        });
        mockTx.vendorAssessmentTemplateSection.create.mockResolvedValueOnce({
            id: 'sec-clone-1',
            title: 'Security',
        });
        mockTx.vendorAssessmentTemplateQuestion.create.mockResolvedValueOnce({
            id: 'q-clone-1',
        });

        await cloneTemplate(makeCtx(), 't-source', {
            mode: 'NEW_KEY',
            key: 'soc2 fork',
            name: 'SOC 2 fork',
        });

        // No isLatestVersion flip happens for NEW_KEY mode.
        expect(
            mockTx.vendorAssessmentTemplate.updateMany,
        ).not.toHaveBeenCalled();

        const cloneData = mockTx.vendorAssessmentTemplate.create.mock.calls[0][0]
            .data;
        expect(cloneData).toMatchObject({
            tenantId: 'tenant-1',
            key: 'soc2-fork',     // canonicalised
            version: 1,
            isLatestVersion: true,
            isPublished: false,    // clone always starts as draft
            name: 'SOC 2 fork',
        });
    });
});

describe('cloneTemplate — SAME_KEY_NEW_VERSION mode', () => {
    test('flips previous latest to false and creates version+1', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-source',
            tenantId: 'tenant-1',
            key: 'soc2',
            version: 2,
            name: 'SOC 2 v2',
            description: null,
            isGlobal: false,
            sections: [],
            questions: [],
        });
        mockTx.vendorAssessmentTemplate.updateMany.mockResolvedValueOnce({
            count: 1,
        });
        mockTx.vendorAssessmentTemplate.create.mockResolvedValueOnce({
            id: 't-v3',
            version: 3,
        });

        await cloneTemplate(makeCtx(), 't-source', {
            mode: 'SAME_KEY_NEW_VERSION',
        });

        // Update flips the previous latest to false. Scope: same key
        // in the same tenant where isLatestVersion=true.
        const updateCall =
            mockTx.vendorAssessmentTemplate.updateMany.mock.calls[0][0];
        expect(updateCall.where).toMatchObject({
            tenantId: 'tenant-1',
            key: 'soc2',
            isLatestVersion: true,
        });
        expect(updateCall.data).toEqual({ isLatestVersion: false });

        // New row inherits the source key + bumps version.
        const cloneData = mockTx.vendorAssessmentTemplate.create.mock.calls[0][0]
            .data;
        expect(cloneData).toMatchObject({
            key: 'soc2',
            version: 3,
            isLatestVersion: true,
            isPublished: false,
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. publishTemplate
// ═══════════════════════════════════════════════════════════════════

describe('publishTemplate', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            publishTemplate(makeCtx({ canWrite: false }), 't-1'),
        ).rejects.toThrow(/permission|ADMIN/);
    });

    test('returns notFound when the template is not in the tenant', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce(null);
        await expect(
            publishTemplate(makeCtx(), 't-missing'),
        ).rejects.toThrow(/not found/i);
    });

    test('rejects an already-published template with ALREADY_PUBLISHED', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            key: 'soc2',
            version: 1,
            name: 'SOC 2',
            isPublished: true,
            _count: { questions: 5 },
        });
        await expect(publishTemplate(makeCtx(), 't-1')).rejects.toThrow(
            /ALREADY_PUBLISHED/,
        );
        expect(mockTx.vendorAssessmentTemplate.update).not.toHaveBeenCalled();
    });

    test('rejects a template with zero questions with EMPTY_TEMPLATE', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            key: 'soc2',
            version: 1,
            name: 'SOC 2',
            isPublished: false,
            _count: { questions: 0 },
        });
        await expect(publishTemplate(makeCtx(), 't-1')).rejects.toThrow(
            /EMPTY_TEMPLATE/,
        );
        expect(mockTx.vendorAssessmentTemplate.update).not.toHaveBeenCalled();
    });

    test('flips isPublished to true on a non-empty draft', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            key: 'soc2',
            version: 2,
            name: 'SOC 2',
            isPublished: false,
            _count: { questions: 3 },
        });
        mockTx.vendorAssessmentTemplate.update.mockResolvedValueOnce({
            id: 't-1',
            isPublished: true,
        });

        const result = await publishTemplate(makeCtx(), 't-1');

        const updateCall =
            mockTx.vendorAssessmentTemplate.update.mock.calls[0][0];
        expect(updateCall.where).toEqual({ id: 't-1' });
        expect(updateCall.data).toEqual({ isPublished: true });
        expect(result).toMatchObject({ id: 't-1', isPublished: true });
    });
});

describe('cloneTemplate — deep copy semantics', () => {
    test('every section + question gets a new id but preserves sortOrder + types', async () => {
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-source',
            tenantId: 'tenant-1',
            key: 'k',
            version: 1,
            name: 'X',
            description: null,
            isGlobal: false,
            sections: [
                { id: 'sec-A', title: 'A', description: null, sortOrder: 0, weight: 2 },
                { id: 'sec-B', title: 'B', description: null, sortOrder: 1, weight: null },
            ],
            questions: [
                {
                    id: 'q-A1',
                    sectionId: 'sec-A',
                    sortOrder: 0,
                    prompt: 'Q1',
                    answerType: 'YES_NO',
                    required: true,
                    weight: 1,
                    optionsJson: null,
                    scaleConfigJson: null,
                    riskPointsJson: null,
                },
                {
                    id: 'q-B1',
                    sectionId: 'sec-B',
                    sortOrder: 0,
                    prompt: 'Q2',
                    answerType: 'SCALE',
                    required: true,
                    weight: 2,
                    optionsJson: null,
                    scaleConfigJson: { min: 1, max: 5 },
                    riskPointsJson: null,
                },
            ],
        });
        mockTx.vendorAssessmentTemplate.updateMany.mockResolvedValueOnce({
            count: 0,
        });
        mockTx.vendorAssessmentTemplate.create.mockResolvedValueOnce({
            id: 't-clone',
        });
        // Sections cloned in source order — return distinct ids so
        // the section-id map populates correctly.
        mockTx.vendorAssessmentTemplateSection.create
            .mockResolvedValueOnce({ id: 'sec-clone-A' })
            .mockResolvedValueOnce({ id: 'sec-clone-B' });
        mockTx.vendorAssessmentTemplateQuestion.create
            .mockResolvedValueOnce({ id: 'q-clone-A1' })
            .mockResolvedValueOnce({ id: 'q-clone-B1' });

        await cloneTemplate(makeCtx(), 't-source', {
            mode: 'SAME_KEY_NEW_VERSION',
        });

        // Both sections cloned in order with their original sortOrder.
        expect(
            mockTx.vendorAssessmentTemplateSection.create,
        ).toHaveBeenCalledTimes(2);
        const sec0 =
            mockTx.vendorAssessmentTemplateSection.create.mock.calls[0][0].data;
        const sec1 =
            mockTx.vendorAssessmentTemplateSection.create.mock.calls[1][0].data;
        expect(sec0.sortOrder).toBe(0);
        expect(sec0.weight).toBe(2);
        expect(sec1.sortOrder).toBe(1);

        // Questions cloned with matching new section ids (the
        // source→clone section-id map).
        expect(
            mockTx.vendorAssessmentTemplateQuestion.create,
        ).toHaveBeenCalledTimes(2);
        const q0 =
            mockTx.vendorAssessmentTemplateQuestion.create.mock.calls[0][0]
                .data;
        const q1 =
            mockTx.vendorAssessmentTemplateQuestion.create.mock.calls[1][0]
                .data;
        expect(q0.sectionId).toBe('sec-clone-A');
        expect(q0.answerType).toBe('YES_NO');
        expect(q1.sectionId).toBe('sec-clone-B');
        expect(q1.answerType).toBe('SCALE');
        expect(q1.scaleConfigJson).toEqual({ min: 1, max: 5 });
    });
});
