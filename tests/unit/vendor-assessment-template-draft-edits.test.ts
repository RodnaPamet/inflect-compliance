/**
 * #4934 — a draft template's sections and questions can be edited and
 * removed; a published template's cannot, and an id from another template
 * is never reached.
 *
 * Pure-memory tests of updateSection / deleteSection / updateQuestion /
 * deleteQuestion, with Prisma mocked through `runInTenantContext`.
 */

const mockTx = {
    vendorAssessmentTemplateSection: {
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    vendorAssessmentTemplateQuestion: {
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.replace(/<[^>]*>/g, '').trim()),
}));

import { Prisma } from '@prisma/client';
import {
    deleteQuestion,
    deleteSection,
    updateQuestion,
    updateSection,
} from '@/app-layer/usecases/vendor-assessment-template';
import { logEvent } from '@/app-layer/events/audit';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(canWrite = true) {
    const base = getPermissionsForRole('ADMIN');
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: { canRead: true, canWrite, canAdmin: false, canAudit: false, canExport: false },
        appPermissions: { ...base, vendors: { ...base.vendors, edit: canWrite, create: canWrite } },
    } as never;
}

const DRAFT = { isPublished: false, name: 'Security questionnaire' };
const PUBLISHED = { isPublished: true, name: 'Security questionnaire' };

beforeEach(() => {
    jest.clearAllMocks();
    for (const model of Object.values(mockTx)) {
        for (const fn of Object.values(model)) (fn as jest.Mock).mockReset();
    }
});

describe('updateSection', () => {
    it('reads the section by id, template and tenant together', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce(null);
        await expect(updateSection(makeCtx(), 't-1', 's-other', { title: 'X' })).rejects.toThrow(/not found/i);
        expect(mockTx.vendorAssessmentTemplateSection.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 's-other', templateId: 't-1', tenantId: 'tenant-1' } }),
        );
        expect(mockTx.vendorAssessmentTemplateSection.update).not.toHaveBeenCalled();
    });

    it('sanitises and writes only the fields sent, and audits them', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            title: 'Old',
            template: DRAFT,
        });
        mockTx.vendorAssessmentTemplateSection.update.mockResolvedValueOnce({ id: 's-1', title: 'New' });

        await updateSection(makeCtx(), 't-1', 's-1', { title: ' <b>New</b> ' });

        expect(mockTx.vendorAssessmentTemplateSection.update).toHaveBeenCalledWith({
            where: { id: 's-1' },
            data: { title: 'New' },
        });
        expect(logEvent).toHaveBeenCalledWith(
            mockTx,
            expect.anything(),
            expect.objectContaining({ action: 'VENDOR_ASSESSMENT_TEMPLATE_SECTION_UPDATED' }),
        );
    });

    it('refuses a published template', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            title: 'Old',
            template: PUBLISHED,
        });
        await expect(updateSection(makeCtx(), 't-1', 's-1', { title: 'New' })).rejects.toThrow(
            /published and can no longer be changed/,
        );
        expect(mockTx.vendorAssessmentTemplateSection.update).not.toHaveBeenCalled();
    });

    it('refuses a caller who cannot manage templates', async () => {
        await expect(updateSection(makeCtx(false), 't-1', 's-1', { title: 'New' })).rejects.toThrow();
        expect(mockTx.vendorAssessmentTemplateSection.findFirst).not.toHaveBeenCalled();
    });
});

describe('deleteSection', () => {
    it('removes a draft section and reports how many questions went with it', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            title: 'Access',
            template: DRAFT,
            _count: { questions: 3 },
        });
        const result = await deleteSection(makeCtx(), 't-1', 's-1');
        expect(result).toEqual({ id: 's-1', questionsRemoved: 3 });
        expect(mockTx.vendorAssessmentTemplateSection.delete).toHaveBeenCalledWith({ where: { id: 's-1' } });
        expect(logEvent).toHaveBeenCalledWith(
            mockTx,
            expect.anything(),
            expect.objectContaining({
                action: 'VENDOR_ASSESSMENT_TEMPLATE_SECTION_DELETED',
                detailsJson: expect.objectContaining({
                    before: expect.objectContaining({ questionCount: 3 }),
                }),
            }),
        );
    });

    it('refuses a published template and deletes nothing', async () => {
        mockTx.vendorAssessmentTemplateSection.findFirst.mockResolvedValueOnce({
            id: 's-1',
            title: 'Access',
            template: PUBLISHED,
            _count: { questions: 3 },
        });
        await expect(deleteSection(makeCtx(), 't-1', 's-1')).rejects.toThrow(/published/);
        expect(mockTx.vendorAssessmentTemplateSection.delete).not.toHaveBeenCalled();
    });
});

describe('updateQuestion', () => {
    const stored = (over: Record<string, unknown> = {}) => ({
        id: 'q-1',
        answerType: 'YES_NO',
        optionsJson: null,
        scaleConfigJson: null,
        template: DRAFT,
        ...over,
    });

    it('reads the question by id, template and tenant together', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(null);
        await expect(updateQuestion(makeCtx(), 't-1', 'q-other', { prompt: 'X' })).rejects.toThrow(/not found/i);
        expect(mockTx.vendorAssessmentTemplateQuestion.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'q-other', templateId: 't-1', tenantId: 'tenant-1' } }),
        );
    });

    it('stores a choice question with its sanitised options and no scale', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(stored());
        mockTx.vendorAssessmentTemplateQuestion.update.mockResolvedValueOnce({ id: 'q-1' });

        await updateQuestion(makeCtx(), 't-1', 'q-1', {
            answerType: 'SINGLE_SELECT',
            optionsJson: [
                { label: '<i>Yearly</i>', value: 'yearly', points: 0 },
                { label: 'Never', value: 'never', points: 3 },
            ],
            scaleConfigJson: { min: 1, max: 5 },
        });

        expect(mockTx.vendorAssessmentTemplateQuestion.update).toHaveBeenCalledWith({
            where: { id: 'q-1' },
            data: {
                answerType: 'SINGLE_SELECT',
                optionsJson: [
                    { label: 'Yearly', value: 'yearly', points: 0 },
                    { label: 'Never', value: 'never', points: 3 },
                ],
                scaleConfigJson: Prisma.DbNull,
            },
        });
    });

    it('judges a type change with the options already stored', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(
            stored({ answerType: 'TEXT', optionsJson: null }),
        );
        await expect(
            updateQuestion(makeCtx(), 't-1', 'q-1', { answerType: 'MULTI_SELECT' }),
        ).rejects.toThrow(/at least one option/);
        expect(mockTx.vendorAssessmentTemplateQuestion.update).not.toHaveBeenCalled();
    });

    it('refuses two options with the same value', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(stored());
        await expect(
            updateQuestion(makeCtx(), 't-1', 'q-1', {
                answerType: 'SINGLE_SELECT',
                optionsJson: [
                    { label: 'A', value: 'a' },
                    { label: 'A again', value: 'a' },
                ],
            }),
        ).rejects.toThrow(/same/);
    });

    it('refuses a scale whose lowest value is not below its highest', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(stored());
        await expect(
            updateQuestion(makeCtx(), 't-1', 'q-1', {
                answerType: 'SCALE',
                scaleConfigJson: { min: 5, max: 5 },
            }),
        ).rejects.toThrow(/lowest value of a scale must be below/);
    });

    it('drops the options when a choice question becomes Yes or no', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(
            stored({
                answerType: 'SINGLE_SELECT',
                optionsJson: [{ label: 'A', value: 'a' }],
            }),
        );
        mockTx.vendorAssessmentTemplateQuestion.update.mockResolvedValueOnce({ id: 'q-1' });

        await updateQuestion(makeCtx(), 't-1', 'q-1', { answerType: 'YES_NO' });

        expect(mockTx.vendorAssessmentTemplateQuestion.update).toHaveBeenCalledWith({
            where: { id: 'q-1' },
            data: { answerType: 'YES_NO', optionsJson: Prisma.DbNull, scaleConfigJson: Prisma.DbNull },
        });
    });

    it('refuses a published template', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce(stored({ template: PUBLISHED }));
        await expect(updateQuestion(makeCtx(), 't-1', 'q-1', { prompt: 'X' })).rejects.toThrow(/published/);
        expect(mockTx.vendorAssessmentTemplateQuestion.update).not.toHaveBeenCalled();
    });
});

describe('deleteQuestion', () => {
    it('removes a draft question and audits it', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce({
            id: 'q-1',
            sectionId: 's-1',
            answerType: 'TEXT',
            template: DRAFT,
        });
        await expect(deleteQuestion(makeCtx(), 't-1', 'q-1')).resolves.toEqual({ id: 'q-1' });
        expect(mockTx.vendorAssessmentTemplateQuestion.delete).toHaveBeenCalledWith({ where: { id: 'q-1' } });
        expect(logEvent).toHaveBeenCalledWith(
            mockTx,
            expect.anything(),
            expect.objectContaining({ action: 'VENDOR_ASSESSMENT_TEMPLATE_QUESTION_DELETED' }),
        );
    });

    it('refuses a published template and deletes nothing', async () => {
        mockTx.vendorAssessmentTemplateQuestion.findFirst.mockResolvedValueOnce({
            id: 'q-1',
            sectionId: 's-1',
            answerType: 'TEXT',
            template: PUBLISHED,
        });
        await expect(deleteQuestion(makeCtx(), 't-1', 'q-1')).rejects.toThrow(/published/);
        expect(mockTx.vendorAssessmentTemplateQuestion.delete).not.toHaveBeenCalled();
    });
});
