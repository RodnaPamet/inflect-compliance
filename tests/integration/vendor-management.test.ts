import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Integration tests for Vendor Management:
 * - Route module existence
 * - No prisma in routes (structural)
 * - No direct logAudit in routes
 * - Repository + scoring importability
 */
describe('Vendor Management Integration', () => {
    const apiBase = join(process.cwd(), 'src/app/api/t/[tenantSlug]/vendors');

    describe('Route modules exist', () => {
        const routes = [
            'route.ts',
            '[vendorId]/route.ts',
            '[vendorId]/documents/route.ts',
            '[vendorId]/documents/[docId]/route.ts',
            '[vendorId]/assessments/[assessmentId]/route.ts',
            '[vendorId]/assessments/send/route.ts',
            '[vendorId]/links/route.ts',
            '[vendorId]/links/[linkId]/route.ts',
            'linked/route.ts',
            'questionnaires/templates/route.ts',
            'questionnaires/templates/[templateKey]/route.ts',
        ];

        it.each(routes)('route %s exists', (route) => {
            expect(existsSync(join(apiBase, route))).toBe(true);
        });
    });

    describe('Structural: no prisma imports in vendor routes', () => {
        const routeDir = apiBase;
        const routeFiles = [
            'route.ts',
            '[vendorId]/route.ts',
            '[vendorId]/documents/route.ts',
            '[vendorId]/documents/[docId]/route.ts',
            '[vendorId]/assessments/[assessmentId]/route.ts',
            '[vendorId]/assessments/send/route.ts',
            '[vendorId]/links/route.ts',
            '[vendorId]/links/[linkId]/route.ts',
            'linked/route.ts',
        ];

        it.each(routeFiles)('route %s does not import prisma directly', (route) => {
            const filePath = join(routeDir, route);
            if (!existsSync(filePath)) return;
            const content = readFileSync(filePath, 'utf-8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).not.toMatch(/from\s+['"]@prisma\/client['"]/);
        });

        it.each(routeFiles)('route %s does not call logAudit/logEvent directly', (route) => {
            const filePath = join(routeDir, route);
            if (!existsSync(filePath)) return;
            const content = readFileSync(filePath, 'utf-8');
            expect(content).not.toMatch(/import.*logEvent/);
            expect(content).not.toMatch(/import.*logAudit/);
        });
    });

    describe('Repository modules importable', () => {
        it('VendorRepository is importable', () => {
            const mod = require('../../src/app-layer/repositories/VendorRepository');
            expect(mod.VendorRepository).toBeDefined();
            expect(typeof mod.VendorRepository.list).toBe('function');
            expect(typeof mod.VendorRepository.create).toBe('function');
        });

        it('VendorDocumentRepository is importable', () => {
            const mod = require('../../src/app-layer/repositories/VendorRepository');
            expect(mod.VendorDocumentRepository).toBeDefined();
            expect(typeof mod.VendorDocumentRepository.listByVendor).toBe('function');
        });

        it('VendorLinkRepository is importable', () => {
            const mod = require('../../src/app-layer/repositories/VendorRepository');
            expect(mod.VendorLinkRepository).toBeDefined();
            expect(typeof mod.VendorLinkRepository.listByVendor).toBe('function');
        });

        it('AssessmentRepository is importable', () => {
            const mod = require('../../src/app-layer/repositories/AssessmentRepository');
            expect(mod.QuestionnaireRepository).toBeDefined();
            expect(mod.VendorAssessmentRepository).toBeDefined();
            // VendorAnswerRepository was retired with the legacy questionnaire
            // path (#5533): it had no src/ caller, and its `upsertMany` was the
            // last writer that set a bare `questionId` with no
            // `templateQuestionId` — the shape #5068 fixed.
            expect(mod.VendorAnswerRepository).toBeUndefined();
        });
    });

    describe('Scoring service importable', () => {
        it('functions exist', () => {
            const mod = require('../../src/app-layer/services/vendor-scoring');
            expect(typeof mod.computeAnswerPoints).toBe('function');
            expect(typeof mod.computeAssessmentScore).toBe('function');
            expect(typeof mod.scoreToRiskRating).toBe('function');
        });
    });

    describe('Usecases importable', () => {
        it('all vendor usecases export properly', () => {
            const mod = require('../../src/app-layer/usecases/vendor');
            const expected = [
                'listVendors', 'getVendor', 'createVendor', 'updateVendor',
                'listVendorDocuments', 'addVendorDocument', 'removeVendorDocument',
                'getVendorAssessment',
                'listQuestionnaireTemplates', 'getQuestionnaireTemplate',
                'setVendorReviewDates',
                'listVendorLinks', 'addVendorLink', 'removeVendorLink',
            ];
            for (const fn of expected) {
                expect(typeof mod[fn]).toBe('function');
            }
        });
    });

    describe('Zod schema validation enforcement', () => {
        const { CreateVendorSchema, DecideAssessmentSchema, SaveAssessmentAnswersSchema } = require('../../src/lib/schemas');

        it('CreateVendorSchema rejects missing name', () => {
            expect(CreateVendorSchema.safeParse({}).success).toBe(false);
        });

        it('DecideAssessmentSchema rejects missing decision', () => {
            expect(DecideAssessmentSchema.safeParse({}).success).toBe(false);
        });

        it('SaveAssessmentAnswersSchema rejects missing answers', () => {
            expect(SaveAssessmentAnswersSchema.safeParse({}).success).toBe(false);
        });
    });
});
