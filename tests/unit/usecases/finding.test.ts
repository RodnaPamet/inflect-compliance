/**
 * Unit tests for src/app-layer/usecases/finding.ts
 *
 * Wave 2 of GAP-02. Existing tests cover plumbing; this file adds
 * the security-load-bearing assertions:
 *   1. assertCanWrite gate — READER cannot create or update findings.
 *   2. Epic D.2 sanitisation: every free-text field passes through
 *      `sanitizePlainText` before persistence. Bug = stored XSS that
 *      surfaces in PDF export / audit-pack share / SDK consumer.
 *   3. Audit emits CREATE / UPDATE actions for the hash chain.
 *   4. Finding-not-found / wrong-tenant on update returns 404.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => {
        const fakeDb = {};
        return fn(fakeDb);
    }),
}));

jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        create: jest.fn().mockResolvedValue({
            id: 'find-1',
            title: 'Sanitised Title',
        }),
        getById: jest.fn(),
        update: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { createFinding, updateFinding } from '@/app-layer/usecases/finding';
import { FindingRepository } from '@/app-layer/repositories/FindingRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockCreate = FindingRepository.create as jest.MockedFunction<typeof FindingRepository.create>;
const mockGetById = FindingRepository.getById as jest.MockedFunction<typeof FindingRepository.getById>;
const mockUpdate = FindingRepository.update as jest.MockedFunction<typeof FindingRepository.update>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockCreate.mockResolvedValue({ id: 'find-1', title: 'SANITISED(Risk found)' } as never);
});

const baseInput = {
    severity: 'HIGH',
    type: 'CONTROL_DEFICIENCY',
    title: 'Risk found',
    description: '<script>alert(1)</script>raw description',
    rootCause: '<img onerror=...>',
    correctiveAction: 'Apply patch',
    owner: 'Alice',
};

describe('createFinding', () => {
    it('rejects READER (no canWrite)', async () => {
        await expect(
            createFinding(makeRequestContext('READER'), baseInput),
        ).rejects.toThrow();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects AUDITOR — read-only role', async () => {
        await expect(
            createFinding(makeRequestContext('AUDITOR'), baseInput),
        ).rejects.toThrow();
    });

    it('allows EDITOR to create', async () => {
        await createFinding(makeRequestContext('EDITOR'), baseInput);
        expect(mockCreate).toHaveBeenCalled();
    });

    // ── Epic D.2 sanitisation ──
    it('sanitises every free-text field before persistence', async () => {
        await createFinding(makeRequestContext('EDITOR'), baseInput);

        const repoArgs = mockCreate.mock.calls[0][2];
        // Regression: a refactor that drops the sanitise wrappers
        // around description/rootCause/correctiveAction/title would
        // persist raw HTML — surfacing as stored XSS in any
        // downstream renderer (PDF, audit-pack, SDK).
        expect(repoArgs.title).toBe('SANITISED(Risk found)');
        expect(repoArgs.description).toBe('SANITISED(<script>alert(1)</script>raw description)');
        expect(repoArgs.rootCause).toBe('SANITISED(<img onerror=...>)');
        expect(repoArgs.correctiveAction).toBe('SANITISED(Apply patch)');
        expect(repoArgs.owner).toBe('SANITISED(Alice)');
    });

    it('passes empty-string description through (no sanitise call) when input is undefined', async () => {
        await createFinding(makeRequestContext('EDITOR'), {
            ...baseInput,
            description: undefined,
        });
        const repoArgs = mockCreate.mock.calls[0][2];
        // The usecase passes '' when description undefined — sanitize
        // is NOT called for the falsy branch.
        expect(repoArgs.description).toBe('');
    });

    it('persists status=OPEN by default', async () => {
        await createFinding(makeRequestContext('EDITOR'), baseInput);
        expect(mockCreate.mock.calls[0][2].status).toBe('OPEN');
    });

    it('emits a CREATE audit row', async () => {
        await createFinding(makeRequestContext('EDITOR'), baseInput);
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'Finding',
            }),
        );
    });

    it('handles a missing dueDate (passes null to repo, not Invalid Date)', async () => {
        await createFinding(makeRequestContext('EDITOR'), {
            ...baseInput,
            dueDate: null,
        });
        const repoArgs = mockCreate.mock.calls[0][2];
        expect(repoArgs.dueDate).toBeNull();
    });
});

describe('updateFinding', () => {
    it('rejects READER on update', async () => {
        await expect(
            updateFinding(makeRequestContext('READER'), 'find-1', { severity: 'LOW' }),
        ).rejects.toThrow();
    });

    // #4461 — the register's edit form can empty a due date or the analysis.
    // Both collapsed `null` to "untouched", so neither could be removed.
    describe('three-state nullable fields', () => {
        beforeEach(() => {
            mockGetById.mockResolvedValue({ id: 'find-1', status: 'OPEN' } as never);
            mockUpdate.mockResolvedValue({ id: 'find-1' } as never);
        });
        const repoArgs = () => mockUpdate.mock.calls[0][3];

        it('a null dueDate clears it', async () => {
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { dueDate: null });
            expect(repoArgs().dueDate).toBeNull();
        });

        it('an absent dueDate leaves it alone', async () => {
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { severity: 'LOW' });
            expect(repoArgs().dueDate).toBeUndefined();
        });

        it('a dueDate string sets it', async () => {
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { dueDate: '2026-12-01' });
            expect(repoArgs().dueDate).toEqual(new Date('2026-12-01'));
        });

        it('a null analysis clears it, an absent one leaves it alone', async () => {
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { analysis: null });
            expect(repoArgs().analysis).toBeNull();
            mockUpdate.mockClear();
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { severity: 'LOW' });
            expect(repoArgs().analysis).toBeUndefined();
        });

        it('a new analysis is still sanitised', async () => {
            await updateFinding(makeRequestContext('EDITOR'), 'find-1', { analysis: '<b>x</b>' });
            expect(repoArgs().analysis).toBe('SANITISED(<b>x</b>)');
        });
    });

    it('rejects when the finding does not exist for this tenant', async () => {
        mockGetById.mockResolvedValue(null);
        await expect(
            updateFinding(makeRequestContext('EDITOR'), 'missing-id', { severity: 'LOW' }),
        ).rejects.toThrow();
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});
