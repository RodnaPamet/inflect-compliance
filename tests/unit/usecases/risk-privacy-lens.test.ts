/**
 * Unit cover for `getRiskPrivacyLens`.
 *
 * WHY THIS EXISTS: the lens was structural-grep-only. A guard asserting
 * that `risk.ts` contains the string `petTreatmentHints` proves the key is
 * SPELLED; it cannot see what the function does with a stored column that
 * is a nullable `Json?` and therefore arrives as anything at all — null,
 * `{}`, a string, an array with junk in it, an array with duplicates, an
 * array in the wrong order.
 *
 * That matters here more than usual because `Risk.linddunCategories` is
 * untyped at the database boundary. Every one of those shapes is reachable
 * from a hand-written import, an older row, or a bad API payload, and the
 * lens feeds a privacy classification — a wrong answer is a compliance
 * artefact, not a rendering glitch.
 *
 * Mocked at the tenant-context seam rather than hitting a database: the
 * behaviour under test is normalisation, and a real row could only ever
 * carry one of these shapes per test.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

import { getRiskPrivacyLens } from '@/app-layer/usecases/risk';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';
import { ForbiddenError, NotFoundError } from '@/lib/errors/types';
import { LINDDUN_CODES } from '@/lib/privacy/linddun';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

/** Stub the tenant context with a db whose findFirst returns `row`. */
function withRow(row: unknown) {
    mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
        fn({ risk: { findFirst: jest.fn().mockResolvedValue(row) } } as never),
    );
}

const ctx = () => makeRequestContext('ADMIN');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('getRiskPrivacyLens', () => {
    it('requires read access before touching the database', async () => {
        const noRead = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
        });
        await expect(getRiskPrivacyLens(noRead, 'r1')).rejects.toThrow(ForbiddenError);
        // The gate must short-circuit — no query may be issued for a caller
        // who is not allowed to read.
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('throws NotFound for a risk that is not in this tenant', async () => {
        withRow(null);
        await expect(getRiskPrivacyLens(ctx(), 'missing')).rejects.toThrow(NotFoundError);
    });

    it('returns the categories and their advisory PET hints', async () => {
        withRow({ id: 'r1', linddunCategories: ['I', 'DD'] });

        const lens = await getRiskPrivacyLens(ctx(), 'r1');

        expect(lens.riskId).toBe('r1');
        expect(lens.linddunCategories).toEqual(['I', 'DD']);
        expect(lens.petTreatmentHints).toContain('Data minimization');
        expect(lens.petTreatmentHints).toContain('Anonymization');
    });

    it('returns codes in canonical order regardless of stored order', async () => {
        // Stored back-to-front. The lens orders by LINDDUN_CODES so two rows
        // holding the same classification never render differently.
        withRow({ id: 'r1', linddunCategories: ['NC', 'U', 'L'] });

        const lens = await getRiskPrivacyLens(ctx(), 'r1');

        const canonical = LINDDUN_CODES.filter((c) => ['NC', 'U', 'L'].includes(c));
        expect(lens.linddunCategories).toEqual(canonical);
    });

    it('drops unknown codes rather than passing them through', async () => {
        // A hand-written import or an older row can carry anything. An
        // unrecognised code must not reach a privacy report.
        withRow({ id: 'r1', linddunCategories: ['L', 'NOT_A_CODE', 42, null, 'I'] });

        const lens = await getRiskPrivacyLens(ctx(), 'r1');

        expect(lens.linddunCategories).toEqual(['L', 'I']);
    });

    it('de-duplicates a repeated code', async () => {
        withRow({ id: 'r1', linddunCategories: ['I', 'I', 'I'] });
        const lens = await getRiskPrivacyLens(ctx(), 'r1');
        expect(lens.linddunCategories).toEqual(['I']);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty array', []],
        ['a non-array object', { L: true }],
        ['a bare string', 'L'],
    ])('treats %s as no classification, with no hints', async (_label, stored) => {
        withRow({ id: 'r1', linddunCategories: stored });

        const lens = await getRiskPrivacyLens(ctx(), 'r1');

        expect(lens.linddunCategories).toEqual([]);
        // The honest-empty contract: an unclassified risk gets NO advisory
        // hints. Emitting the full hint catalogue for a risk nobody has
        // classified would read as advice the tool never gave.
        expect(lens.petTreatmentHints).toEqual([]);
    });

    it('de-duplicates hints shared by two categories', async () => {
        withRow({ id: 'r1', linddunCategories: [...LINDDUN_CODES] });

        const lens = await getRiskPrivacyLens(ctx(), 'r1');

        expect(lens.linddunCategories).toEqual([...LINDDUN_CODES]);
        expect(new Set(lens.petTreatmentHints).size).toBe(lens.petTreatmentHints.length);
    });

    it('scopes the query to the caller’s tenant', async () => {
        const findFirst = jest.fn().mockResolvedValue({ id: 'r1', linddunCategories: [] });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ risk: { findFirst } } as never),
        );

        await getRiskPrivacyLens(ctx(), 'r1');

        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: ctx().tenantId, id: 'r1' }),
            }),
        );
    });
});
