/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/policy.ts
 *
 * Wave 2 of GAP-02. Existing tests cover lifecycle wiring; this file
 * locks in the security-load-bearing behaviours:
 *
 *   1. canWrite gate on create + version create
 *   2. Epic C.5 sanitisation: createPolicy with content AND
 *      createPolicyVersion route HTML/MARKDOWN/EXTERNAL_LINK content
 *      through `sanitizePolicyContent` BEFORE persisting. Stored row
 *      must never carry raw <script>.
 *   3. Versioning lifecycle: creating a new version of an APPROVED /
 *      PUBLISHED policy demotes status back to DRAFT.
 *   4. Cannot create version for ARCHIVED policy.
 *   5. Content-type validation: EXTERNAL_LINK requires externalUrl;
 *      HTML/MARKDOWN require contentText.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => fn({})),
}));

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: {
        getBySlug: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'p1', slug: 'p', title: 'P' }),
        getById: jest.fn(),
        setCurrentVersion: jest.fn(),
        updateStatus: jest.fn(),
        updateMetadata: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: {
        create: jest.fn().mockResolvedValue({ id: 'v1', versionNumber: 1 }),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePolicyContent: jest.fn((_type: string, s: string) => `SANITISED(${s})`),
    sanitizePlainText: jest.fn((s: string | null | undefined) => s),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { createPolicy, createPolicyVersion, markPolicyReviewed } from '@/app-layer/usecases/policy';
import { ConflictError } from '@/lib/errors/types';
import { PolicyRepository } from '@/app-layer/repositories/PolicyRepository';
import { PolicyVersionRepository } from '@/app-layer/repositories/PolicyVersionRepository';
import { sanitizePolicyContent } from '@/lib/security/sanitize';
import { makeRequestContext } from '../../helpers/make-context';

const mockGetBySlug = PolicyRepository.getBySlug as jest.MockedFunction<typeof PolicyRepository.getBySlug>;
const mockGetById = PolicyRepository.getById as jest.MockedFunction<typeof PolicyRepository.getById>;
const mockUpdateStatus = PolicyRepository.updateStatus as jest.MockedFunction<typeof PolicyRepository.updateStatus>;
const mockVersionCreate = PolicyVersionRepository.create as jest.MockedFunction<typeof PolicyVersionRepository.create>;
const mockSanitizePolicy = sanitizePolicyContent as jest.MockedFunction<typeof sanitizePolicyContent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetBySlug.mockResolvedValue(null);
    mockSanitizePolicy.mockImplementation((_t: any, s: any) => `SANITISED(${s})`);
    mockVersionCreate.mockResolvedValue({ id: 'v1', versionNumber: 1 } as never);
});

describe('createPolicy — RBAC + sanitisation', () => {
    it('rejects READER (no canWrite)', async () => {
        await expect(
            createPolicy(makeRequestContext('READER'), { title: 'P' }),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR (read-only)', async () => {
        await expect(
            createPolicy(makeRequestContext('AUDITOR'), { title: 'P' }),
        ).rejects.toThrow();
    });

    it('sanitises initial-version content via sanitizePolicyContent before persist', async () => {
        await createPolicy(makeRequestContext('EDITOR'), {
            title: 'My Policy',
            content: '<script>x</script>raw markdown',
        });
        expect(mockSanitizePolicy).toHaveBeenCalledWith(
            'MARKDOWN',
            '<script>x</script>raw markdown',
        );
        // Regression: a refactor that drops the wrapper around
        // data.content would persist raw HTML.
        const versionArgs = mockVersionCreate.mock.calls[0][3];
        expect(versionArgs.contentText).toBe('SANITISED(<script>x</script>raw markdown)');
    });

    it('omits version creation when content is missing (policy without initial version)', async () => {
        await createPolicy(makeRequestContext('EDITOR'), { title: 'Skeleton' });
        expect(mockVersionCreate).not.toHaveBeenCalled();
        expect(mockSanitizePolicy).not.toHaveBeenCalled();
    });
});

describe('createPolicyVersion — sanitisation + lifecycle', () => {
    it('throws notFound when policy does not exist', async () => {
        mockGetById.mockResolvedValue(null);
        await expect(
            createPolicyVersion(makeRequestContext('EDITOR'), 'missing-id', {
                contentType: 'MARKDOWN',
                contentText: 'body',
            }),
        ).rejects.toThrow(/Policy not found/);
    });

    it('rejects creating a version for an ARCHIVED policy', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'ARCHIVED' } as never);
        await expect(
            createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
                contentType: 'MARKDOWN',
                contentText: 'body',
            }),
        ).rejects.toThrow(/archived policy/);
        expect(mockVersionCreate).not.toHaveBeenCalled();
    });

    it('rejects EXTERNAL_LINK without externalUrl', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);
        await expect(
            createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
                contentType: 'EXTERNAL_LINK',
            }),
        ).rejects.toThrow(/externalUrl is required/);
    });

    it('rejects MARKDOWN without contentText', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);
        await expect(
            createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
                contentType: 'MARKDOWN',
            }),
        ).rejects.toThrow(/contentText is required/);
    });

    it('sanitises HTML content before repository write (Epic C.5)', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);
        await createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
            contentType: 'HTML',
            contentText: '<script>alert(1)</script><p>ok</p>',
        });
        expect(mockSanitizePolicy).toHaveBeenCalledWith(
            'HTML',
            '<script>alert(1)</script><p>ok</p>',
        );
        const versionArgs = mockVersionCreate.mock.calls[0][3];
        expect(versionArgs.contentText).toBe('SANITISED(<script>alert(1)</script><p>ok</p>)');
    });

    // ── Lifecycle invariant: PUBLISHED + APPROVED demote to DRAFT on
    //    new version ──
    it('moves PUBLISHED policy to DRAFT when a new version is created', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'PUBLISHED' } as never);
        await createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
            contentType: 'MARKDOWN',
            contentText: 'updated',
        });
        expect(mockUpdateStatus).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'p1',
            'DRAFT',
        );
        // Regression: a refactor that skips the demotion would leave
        // a PUBLISHED policy showing the OLD content but with a NEW
        // unapproved version sitting unreviewed.
    });

    it('moves APPROVED policy to DRAFT when a new version is created', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'APPROVED' } as never);
        await createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
            contentType: 'MARKDOWN',
            contentText: 'rev',
        });
        expect(mockUpdateStatus).toHaveBeenCalled();
    });

    it('does NOT touch status when policy is already DRAFT', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' } as never);
        await createPolicyVersion(makeRequestContext('EDITOR'), 'p1', {
            contentType: 'MARKDOWN',
            contentText: 'body',
        });
        expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
});

describe('markPolicyReviewed — an archived policy is not reviewed (#4279)', () => {
    const mockUpdateMetadata = PolicyRepository.updateMetadata as jest.MockedFunction<typeof PolicyRepository.updateMetadata>;

    it('refuses an ARCHIVED policy with a 409 and moves no review date', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'ARCHIVED', reviewFrequencyDays: 365, nextReviewAt: null } as never);
        const attempt = markPolicyReviewed(makeRequestContext('EDITOR'), 'p1');
        await expect(attempt).rejects.toBeInstanceOf(ConflictError);
        await expect(attempt).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/archived/i) });
        expect(mockUpdateMetadata).not.toHaveBeenCalled();
    });

    it('still marks a live policy reviewed', async () => {
        mockGetById.mockResolvedValue({ id: 'p1', status: 'PUBLISHED', reviewFrequencyDays: 365, nextReviewAt: null } as never);
        await markPolicyReviewed(makeRequestContext('EDITOR'), 'p1');
        expect(mockUpdateMetadata).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'p1',
            expect.objectContaining({ lastReviewedAt: expect.any(Date) }),
        );
    });
});
