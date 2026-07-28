/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/vendor.ts
 *
 * Wave 4 of GAP-02. Vendor management drives third-party risk — the
 * activation gate (now a single shared `assertVendorActivationAllowed`,
 * reached via `updateVendor`) says "you can't promote a vendor to ACTIVE
 * without a completed assessment review". A regression here lets a
 * compliance-bypass vendor land in production use.
 *
 * Behaviours protected:
 *   1. assertCanManageVendors gate on createVendor / updateVendor.
 *   2. Epic D.2 — sanitises name, legalName, country, domain,
 *      websiteUrl, description, AND each tag string. Loose-typed
 *      patch to updateVendor sanitises strings only (enums + ids
 *      pass through).
 *   3. updateVendor: VENDOR_STATUS_CHANGED audit when status
 *      changes; VENDOR_UPDATED otherwise.
 *   4. updateVendor activation gate (PR-T): cannot promote to ACTIVE
 *      without a completed assessment review (REVIEWED/CLOSED + rating).
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/VendorRepository', () => ({
    VendorRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    VendorDocumentRepository: {
        listByVendor: jest.fn(),
        create: jest.fn(),
        deleteById: jest.fn(),
    },
    VendorLinkRepository: {
        listByVendor: jest.fn(),
        create: jest.fn(),
        deleteById: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/AssessmentRepository', () => ({
    QuestionnaireRepository: {
        getByKey: jest.fn(),
        listTemplates: jest.fn(),
    },
    VendorAssessmentRepository: {
        getById: jest.fn(),
        create: jest.fn(),
        submit: jest.fn(),
        decide: jest.fn(),
        updateScore: jest.fn(),
    },
    VendorAnswerRepository: {
        upsertMany: jest.fn(),
        listByAssessment: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('@/app-layer/services/vendor-scoring', () => ({
    computeAnswerPoints: jest.fn(() => 5),
    computeAssessmentScore: jest.fn(() => ({ score: 50, percentScore: 0.7 })),
    scoreToRiskRating: jest.fn(() => 'MEDIUM'),
}));

jest.mock('@/app-layer/services/vendor-enrichment', () => ({
    getEnrichmentProvider: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createVendor,
    updateVendor,
} from '@/app-layer/usecases/vendor';
import { runInTenantContext } from '@/lib/db-context';
import { VendorRepository } from '@/app-layer/repositories/VendorRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockVendorCreate = VendorRepository.create as jest.MockedFunction<typeof VendorRepository.create>;
const mockVendorUpdate = VendorRepository.update as jest.MockedFunction<typeof VendorRepository.update>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockVendorCreate.mockResolvedValue({
        id: 'v1', name: 'SANITISED(Acme)', status: 'PROSPECTIVE', criticality: 'MEDIUM',
    } as never);
});

describe('createVendor — RBAC + sanitisation', () => {
    it('rejects READER (canManageVendors gate)', async () => {
        await expect(
            createVendor(makeRequestContext('READER'), { name: 'x' }),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR (read-only role)', async () => {
        await expect(
            createVendor(makeRequestContext('AUDITOR'), { name: 'x' }),
        ).rejects.toThrow();
    });

    it('sanitises name + legalName + country + domain + websiteUrl + description + tags', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await createVendor(makeRequestContext('EDITOR'), {
            name: 'Acme',
            legalName: 'Acme Inc.',
            country: 'US',
            domain: 'acme.com',
            websiteUrl: 'https://acme.com',
            description: '<script>x</script>',
            tags: ['saas', '<img>'],
        });

        const repoArgs = mockVendorCreate.mock.calls[0][2] as any;
        expect(repoArgs.name).toBe('SANITISED(Acme)');
        expect(repoArgs.legalName).toBe('SANITISED(Acme Inc.)');
        expect(repoArgs.country).toBe('SANITISED(US)');
        expect(repoArgs.domain).toBe('SANITISED(acme.com)');
        expect(repoArgs.websiteUrl).toBe('SANITISED(https://acme.com)');
        expect(repoArgs.description).toBe('SANITISED(<script>x</script>)');
        expect(repoArgs.tags).toEqual(['SANITISED(saas)', 'SANITISED(<img>)']);
        // Regression: a refactor that dropped the `tags?.map(...)`
        // wrapper would persist raw HTML in tag chips on the vendor
        // detail page.
    });
});

describe('updateVendor — loose-typed patch sanitisation + status-change audit', () => {
    it('only sanitises known free-text columns (enums + ids untouched)', async () => {
        // ownerUserId is now resolved against an ACTIVE membership before
        // the write, so the stub db needs tenantMembership. The id itself
        // must still reach the repo unsanitised — that is what this asserts.
        const membershipDb = {
            tenantMembership: {
                findFirst: jest.fn().mockResolvedValue({ id: 'mem-1' }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(membershipDb as never));
        mockVendorUpdate.mockResolvedValueOnce({ id: 'v1', name: 'X' } as never);

        await updateVendor(makeRequestContext('ADMIN'), 'v1', {
            name: 'New',
            criticality: 'HIGH',         // enum — must NOT be sanitised
            ownerUserId: 'user-123',     // FK id — must NOT be sanitised
        });

        // The owner was verified in-tenant and ACTIVE before the write.
        expect(membershipDb.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: 'user-123',
                    status: 'ACTIVE',
                }),
            }),
        );

        const args = mockVendorUpdate.mock.calls[0][3] as any;
        expect(args.name).toBe('SANITISED(New)');
        // Regression: a refactor that flattened to "sanitise every
        // string in the patch" would mangle enum values like 'HIGH' →
        // 'SANITISED(HIGH)' and blow up the Prisma client at write.
        expect(args.criticality).toBe('HIGH');
        expect(args.ownerUserId).toBe('user-123');
    });

    it('emits VENDOR_STATUS_CHANGED when status changes; VENDOR_UPDATED otherwise', async () => {
        // The status-change path now loads the current vendor + latest
        // assessment via db.vendor.findFirst; supply a completed-review
        // assessment so the ACTIVE activation gate is satisfied.
        const db = {
            vendor: {
                findFirst: jest.fn().mockResolvedValue({
                    status: 'PROSPECTIVE',
                    assessments: [{ status: 'REVIEWED', riskRating: 'LOW' }],
                }),
            },
        };
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(db as never));
        mockVendorUpdate.mockResolvedValue({ id: 'v1', name: 'X' } as never);

        await updateVendor(makeRequestContext('ADMIN'), 'v1', {
            status: 'ACTIVE',
        });
        await updateVendor(makeRequestContext('ADMIN'), 'v1', {
            description: 'a',
        });

        const actions = mockLog.mock.calls.map(c => (c[2] as any).action);
        expect(actions).toContain('VENDOR_STATUS_CHANGED');
        expect(actions).toContain('VENDOR_UPDATED');
    });
});

describe('updateVendor — completed-review activation gate (PR-T: single gate impl)', () => {
    // PR-T — the dead updateVendorStatusWithGate was removed; the live gate is
    // updateVendor routed through assertVendorActivationAllowed. These exercise
    // that live path.
    it('rejects promotion to ACTIVE when no completed assessment review exists', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                vendor: {
                    findFirst: jest.fn().mockResolvedValue({
                        status: 'PROSPECTIVE',
                        assessments: [{ status: 'DRAFT', riskRating: null }], // not a completed review
                    }),
                },
            } as never),
        );

        await expect(
            updateVendor(makeRequestContext('ADMIN'), 'v1', { status: 'ACTIVE' }),
        ).rejects.toThrow(/completed assessment review/);
        // Regression: a refactor that bypassed this gate would let an
        // admin rubber-stamp a vendor as ACTIVE without ever completing an
        // assessment review — the very compliance bypass this gate prevents.
    });

    it('rejects when there are no assessments at all', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                vendor: {
                    findFirst: jest.fn().mockResolvedValue({
                        status: 'PROSPECTIVE',
                        assessments: [],
                    }),
                },
            } as never),
        );

        await expect(
            updateVendor(makeRequestContext('ADMIN'), 'v1', { status: 'ACTIVE' }),
        ).rejects.toThrow(/completed assessment review/);
    });

    it('allows promotion to ACTIVE when latest assessment is a completed review with a rating', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                vendor: {
                    findFirst: jest.fn().mockResolvedValue({
                        status: 'PROSPECTIVE',
                        // Completed review (REVIEWED/CLOSED) carrying a risk rating.
                        assessments: [{ status: 'REVIEWED', riskRating: 'LOW' }],
                    }),
                },
            } as never),
        );
        mockVendorUpdate.mockResolvedValueOnce({ id: 'v1', name: 'X' } as never);

        await expect(
            updateVendor(makeRequestContext('ADMIN'), 'v1', { status: 'ACTIVE' }),
        ).resolves.toBeDefined();
    });

    it('allows non-ACTIVE transitions even without a completed assessment review', async () => {
        // Going to OFFBOARDING / etc. is always allowed; the gate only fires on
        // the ACTIVE promotion.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                vendor: {
                    findFirst: jest.fn().mockResolvedValue({
                        status: 'ACTIVE',
                        assessments: [],
                    }),
                },
            } as never),
        );
        mockVendorUpdate.mockResolvedValueOnce({ id: 'v1', name: 'X' } as never);

        await expect(
            updateVendor(makeRequestContext('ADMIN'), 'v1', { status: 'OFFBOARDING' }),
        ).resolves.toBeDefined();
    });
});
