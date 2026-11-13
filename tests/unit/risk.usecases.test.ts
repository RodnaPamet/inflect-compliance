/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit Test: Risk usecase logic.
 * Tests score computation and audit logging.
 * Mocks the repository and event layers.
 */

// Create a mock db object that withTenantDb will pass to callbacks
const mockDb = {
    // No saved matrix: the default 5x5 bounds every score (#5080).
    riskMatrixConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
    },
    // RQ2-1 — every score-changing write appends a ledger event.
    riskScoreEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
    },
} as any;

// Mock withTenantDb/runInTenantContext to eagerly call the callback with mockDb
jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_tenantId: string, fn: (db: any) => any) => fn(mockDb)),
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

// Mock modules BEFORE imports
jest.mock('@/app-layer/repositories/RiskRepository', () => ({
    RiskRepository: {
        create: jest.fn(),
        getById: jest.fn(),
        update: jest.fn(),
        list: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/RiskTemplateRepository', () => ({
    RiskTemplateRepository: {
        getById: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 }),
        },
    },
}));

import { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { RiskTemplateRepository } from '@/app-layer/repositories/RiskTemplateRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    createRisk,
    createRiskFromTemplate,
    updateRisk,
} from '@/app-layer/usecases/risk';

const writerCtx: RequestContext = {
    requestId: 'req-test',
    userId: 'user-admin',
    tenantId: 'tenant-1',
    role: 'ADMIN' as any,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('ADMIN'),
};

describe('Risk Usecases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('createRisk', () => {
        it('computes score = likelihood * impact', async () => {
            const mockRisk = { id: 'risk-1', title: 'Test Risk', score: 15, likelihood: 3, impact: 5 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            const result = await createRisk(writerCtx, {
                title: 'Test Risk',
                likelihood: 3,
                impact: 5,
            });

            expect(result.score).toBe(15);
            expect(RiskRepository.create).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                expect.objectContaining({
                    score: 15,
                    inherentScore: 15,
                    likelihood: 3,
                    impact: 5,
                })
            );
        });

        it('emits audit log after creation', async () => {
            const mockRisk = { id: 'risk-1', title: 'Test Risk', score: 9 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            await createRisk(writerCtx, { title: 'Test Risk' });

            expect(logEvent).toHaveBeenCalledWith(mockDb, writerCtx, expect.objectContaining({
                action: 'CREATE',
                entityType: 'Risk',
                entityId: 'risk-1',
            }));
        });

        it('defaults likelihood=3 and impact=3 when not provided', async () => {
            const mockRisk = { id: 'risk-2', title: 'Default Risk', score: 9 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            await createRisk(writerCtx, { title: 'Default Risk' });

            expect(RiskRepository.create).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                expect.objectContaining({
                    score: 9,
                    likelihood: 3,
                    impact: 3,
                })
            );
        });

        it('sets createdByUserId from context', async () => {
            const mockRisk = { id: 'risk-3', title: 'Creator Risk', score: 9 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            await createRisk(writerCtx, { title: 'Creator Risk' });

            expect(RiskRepository.create).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                expect.objectContaining({
                    createdByUserId: 'user-admin',
                })
            );
        });
    });

    describe('createRiskFromTemplate', () => {
        it('uses template defaults when no overrides provided', async () => {
            const mockTemplate = {
                id: 'tmpl-1',
                title: 'Template Risk',
                description: 'Template desc',
                category: 'Cybersecurity',
                defaultLikelihood: 4,
                defaultImpact: 5,
            };
            (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue(mockTemplate);

            const mockRisk = { id: 'risk-4', title: 'Template Risk', score: 20 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            await createRiskFromTemplate(writerCtx, 'tmpl-1', {});

            expect(RiskRepository.create).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                expect.objectContaining({
                    title: 'Template Risk',
                    description: 'Template desc',
                    category: 'Cybersecurity',
                    likelihood: 4,
                    impact: 5,
                    score: 20,
                })
            );
        });

        it('allows overrides to replace template fields', async () => {
            const mockTemplate = {
                id: 'tmpl-1',
                title: 'Template Risk',
                description: 'Template desc',
                category: 'Cybersecurity',
                defaultLikelihood: 4,
                defaultImpact: 5,
            };
            (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue(mockTemplate);

            const mockRisk = { id: 'risk-5', title: 'Custom Title', score: 10 };
            (RiskRepository.create as jest.Mock).mockResolvedValue(mockRisk);

            await createRiskFromTemplate(writerCtx, 'tmpl-1', {
                title: 'Custom Title',
                likelihood: 2,
            });

            expect(RiskRepository.create).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                expect.objectContaining({
                    title: 'Custom Title',
                    likelihood: 2,
                    impact: 5, // from template
                    score: 10, // 2 * 5
                })
            );
        });
    });

    describe('updateRisk', () => {
        it('recomputes score when likelihood and impact change', async () => {
            const updatedRisk = { id: 'risk-1', likelihood: 5, impact: 4, score: 20, status: 'OPEN' };
            (RiskRepository.update as jest.Mock).mockResolvedValue(updatedRisk);

            await updateRisk(writerCtx, 'risk-1', { likelihood: 5, impact: 4 });

            expect(RiskRepository.update).toHaveBeenCalledWith(
                mockDb,
                writerCtx,
                'risk-1',
                expect.objectContaining({
                    score: 20,
                    inherentScore: 20,
                })
            );
        });

        it('emits audit log after update', async () => {
            const updatedRisk = { id: 'risk-1', title: 'Updated Title' };
            (RiskRepository.update as jest.Mock).mockResolvedValue(updatedRisk);

            const data = { title: 'Updated Title', likelihood: 3, impact: 3 };
            await updateRisk(writerCtx, 'risk-1', data);

            expect(logEvent).toHaveBeenCalledWith(mockDb, writerCtx, expect.objectContaining({
                action: 'UPDATE',
                entityType: 'Risk',
                entityId: 'risk-1',
            }));
        });
    });
});
