/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — AssessmentRepository.ts (previously ~0% branches).
 *
 * Covers all four exported classes against a fake `db`:
 *   - QuestionnaireRepository.listTemplates / getByKey
 *   - VendorAssessmentRepository: list/get/create + submit + decide
 *     state-machine guards (not-found, wrong-status) + updateScore
 */

import { QuestionnaireRepository, VendorAssessmentRepository } from '@/app-layer/repositories/AssessmentRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb() {
    return {
        questionnaireTemplate: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue({ key: 'k1' }),
        },
        vendorAssessment: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue({ id: 'as1', status: 'DRAFT' }),
            create: jest.fn().mockResolvedValue({ id: 'as1' }),
            update: jest.fn().mockResolvedValue({ id: 'as1' }),
        },
        vendorAssessmentAnswer: {
            upsert: jest.fn().mockImplementation((...args: any[]) => Promise.resolve({ id: 'ans', ...args[0].create })),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

let db: ReturnType<typeof freshDb>;

beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

describe('QuestionnaireRepository', () => {
    it('listTemplates filters isGlobal, orders by name, counts questions', async () => {
        await QuestionnaireRepository.listTemplates(db as any);
        const arg = db.questionnaireTemplate.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ isGlobal: true });
        expect(arg.orderBy).toEqual({ name: 'asc' });
        expect(arg.include._count.select).toEqual({ questions: true });
    });

    it('getByKey scopes by key and orders questions by section then sortOrder', async () => {
        await QuestionnaireRepository.getByKey(db as any, 'k1');
        const arg = db.questionnaireTemplate.findUnique.mock.calls[0][0];
        expect(arg.where).toEqual({ key: 'k1' });
        expect(arg.include.questions.orderBy).toEqual([{ section: 'asc' }, { sortOrder: 'asc' }]);
    });
});

describe('VendorAssessmentRepository read shapes', () => {
    it('listByVendor scopes by tenant + vendor, orders desc, includes graph', async () => {
        await VendorAssessmentRepository.listByVendor(db as any, ctx, 'v1');
        const arg = db.vendorAssessment.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: 'tenant-1', vendorId: 'v1' });
        expect(arg.orderBy).toEqual({ createdAt: 'desc' });
        expect(arg.include._count.select).toEqual({ answers: true });
    });

    it('getById scopes by id + tenant with nested template questions ordered', async () => {
        await VendorAssessmentRepository.getById(db as any, ctx, 'as1');
        const arg = db.vendorAssessment.findFirst.mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'as1', tenantId: 'tenant-1' });
        expect(arg.include.template.include.questions.orderBy).toEqual([
            { section: 'asc' },
            { sortOrder: 'asc' },
        ]);
    });

    it('create seeds DRAFT status + requestedBy + startedAt', async () => {
        await VendorAssessmentRepository.create(db as any, ctx, 'v1', 'tpl1');
        const arg = db.vendorAssessment.create.mock.calls[0][0];
        expect(arg.data).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'v1',
            templateId: 'tpl1',
            requestedByUserId: 'user-1',
            status: 'DRAFT',
        });
        expect(arg.data.startedAt).toBeInstanceOf(Date);
    });
});

describe('VendorAssessmentRepository.submit (state machine)', () => {
    it('returns null when assessment not found (guard branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        expect(await VendorAssessmentRepository.submit(db as any, ctx, 'as1')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('returns null when status is not DRAFT (wrong-status branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'as1', status: 'IN_REVIEW' });
        expect(await VendorAssessmentRepository.submit(db as any, ctx, 'as1')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('moves DRAFT → IN_REVIEW with submittedAt (happy branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'as1', status: 'DRAFT' });
        await VendorAssessmentRepository.submit(db as any, ctx, 'as1');
        const arg = db.vendorAssessment.update.mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'as1' });
        expect(arg.data.status).toBe('IN_REVIEW');
        expect(arg.data.submittedAt).toBeInstanceOf(Date);
    });
});

describe('VendorAssessmentRepository.decide (state machine)', () => {
    it('returns null when not found (guard branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        expect(await VendorAssessmentRepository.decide(db as any, ctx, 'as1', 'APPROVED')).toBeNull();
    });

    it('returns null when status is not IN_REVIEW (wrong-status branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'as1', status: 'DRAFT' });
        expect(await VendorAssessmentRepository.decide(db as any, ctx, 'as1', 'APPROVED')).toBeNull();
    });

    it('decides + persists notes when provided (notes-present branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'as1', status: 'IN_REVIEW' });
        await VendorAssessmentRepository.decide(db as any, ctx, 'as1', 'APPROVED', 'looks good');
        const arg = db.vendorAssessment.update.mock.calls[0][0];
        expect(arg.data.status).toBe('APPROVED');
        expect(arg.data.decidedByUserId).toBe('user-1');
        expect(arg.data.decidedAt).toBeInstanceOf(Date);
        expect(arg.data.notes).toBe('looks good');
    });

    it('coalesces falsy notes to null (notes-absent branch)', async () => {
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'as1', status: 'IN_REVIEW' });
        await VendorAssessmentRepository.decide(db as any, ctx, 'as1', 'REJECTED');
        expect(db.vendorAssessment.update.mock.calls[0][0].data.notes).toBeNull();
    });
});

describe('VendorAssessmentRepository.updateScore', () => {
    it('writes score + riskRating by id', async () => {
        await VendorAssessmentRepository.updateScore(db as any, 'as1', 88, 'HIGH');
        const arg = db.vendorAssessment.update.mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'as1' });
        expect(arg.data).toEqual({ score: 88, riskRating: 'HIGH' });
    });
});

