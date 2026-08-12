/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * List repositories validate enum filters instead of casting them.
 *
 * Regression cover for the production 500 on
 * `GET /api/t/{slug}/risks?status=ACTIVE`. Every repository below used to
 * assign the raw query-string value straight onto a Prisma enum column
 * with an `as` cast:
 *
 *     where.status = filters.status as RiskStatus;   // ✗
 *
 * Prisma rejects both reachable bad shapes with
 * `PrismaClientValidationError` — a comma-joined multi-select
 * (`?status=OPEN,MITIGATING`, which is exactly what the list pages'
 * `multiple: true` facets serialise to) and a value belonging to another
 * entity's enum (`?status=ACTIVE`, carried over from the Assets or
 * Vendors list, where it IS valid). That error has no mapping in
 * `src/lib/errors/types.ts`, so it fell through to a 500 — and because
 * the list pages read the same filters server-side, it took the Server
 * Component render with it ("Something went wrong" on the whole page).
 *
 * These tests assert the two halves of the fix at the repository
 * boundary, mirroring the fake-`db` style of
 * `tests/unit/repositories/TaskRepository.test.ts`:
 *
 *   1. a valid multi-select reaches Prisma as `{ in: [...] }` — the
 *      shape Prisma accepts — never as one comma-joined literal;
 *   2. an unknown member never reaches Prisma at all; it throws a
 *      400-shaped error before the query is built.
 */
import { AiSystemRepository } from '@/app-layer/repositories/AiSystemRepository';
import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { PolicyRepository } from '@/app-layer/repositories/PolicyRepository';
import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { VendorRepository } from '@/app-layer/repositories/VendorRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** Minimal fake `db` — only `findMany`, which is all `list()` needs. */
function fakeDb(model: string) {
    const findMany = jest.fn().mockResolvedValue([]);
    return { db: { [model]: { findMany } } as any, findMany };
}

/** The `where` clause the repository handed to Prisma. */
function capturedWhere(findMany: jest.Mock): any {
    expect(findMany).toHaveBeenCalledTimes(1);
    return findMany.mock.calls[0]![0].where;
}

interface Case {
    /** Human label for the test name. */
    name: string;
    /** Prisma model key on the fake db. */
    model: string;
    /** Invoke `Repo.list(db, ctx, filters)`. */
    list: (db: any, filters: Record<string, string>) => Promise<unknown>;
    /** Filter key under test. */
    key: string;
    /** Two REAL members of the enum, comma-joined by the UI's multi-select. */
    validPair: [string, string];
    /** A value that is NOT a member of this enum. */
    invalid: string;
    /** Fragment of the expected 400 message. */
    label: string;
}

const CASES: Case[] = [
    {
        name: 'RiskRepository.status',
        model: 'risk',
        list: (db, filters) => RiskRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['OPEN', 'MITIGATING'],
        // The exact value from the production report — an AssetStatus /
        // VendorStatus that is not a RiskStatus.
        invalid: 'ACTIVE',
        label: 'risk status',
    },
    {
        name: 'RiskRepository.treatment',
        model: 'risk',
        list: (db, filters) => RiskRepository.list(db, ctx, filters as any),
        key: 'treatment',
        validPair: ['TREAT', 'TOLERATE'],
        invalid: 'ACTIVE',
        label: 'risk treatment',
    },
    {
        name: 'AssetRepository.status',
        model: 'asset',
        list: (db, filters) => AssetRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['ACTIVE', 'RETIRED'],
        invalid: 'OPEN',
        label: 'asset status',
    },
    {
        name: 'AssetRepository.criticality',
        model: 'asset',
        list: (db, filters) => AssetRepository.list(db, ctx, filters as any),
        key: 'criticality',
        validPair: ['HIGH', 'CRITICAL'],
        invalid: 'ACTIVE',
        label: 'asset criticality',
    },
    {
        name: 'VendorRepository.status',
        model: 'vendor',
        list: (db, filters) => VendorRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['ACTIVE', 'ONBOARDING'],
        invalid: 'OPEN',
        label: 'vendor status',
    },
    {
        name: 'PolicyRepository.status',
        model: 'policy',
        list: (db, filters) => PolicyRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['DRAFT', 'PUBLISHED'],
        invalid: 'ACTIVE',
        label: 'policy status',
    },
    {
        name: 'EvidenceRepository.status',
        model: 'evidence',
        list: (db, filters) => EvidenceRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['DRAFT', 'SUBMITTED'],
        invalid: 'ACTIVE',
        label: 'evidence status',
    },
    {
        name: 'AiSystemRepository.status',
        model: 'aiSystem',
        list: (db, filters) => AiSystemRepository.list(db, ctx, filters as any),
        key: 'status',
        validPair: ['ACTIVE', 'RETIRED'],
        invalid: 'OPEN',
        label: 'AI system status',
    },
    {
        // `riskTier` escaped the first sweep because the `as AiRiskTier` cast
        // lived in the ROUTE, not the repository — the sibling `status` on the
        // same call was fixed while this one stayed live.
        name: 'AiSystemRepository.riskTier',
        model: 'aiSystem',
        list: (db, filters) => AiSystemRepository.list(db, ctx, filters as any),
        key: 'riskTier',
        validPair: ['HIGH', 'LIMITED'],
        invalid: 'ACTIVE',
        label: 'AI risk tier',
    },
];

describe.each(CASES)(
    '$name — enum filters are validated, not cast',
    ({ model, list, key, validPair, invalid, label }) => {
        it('passes a single valid member through as a scalar', async () => {
            const { db, findMany } = fakeDb(model);
            await list(db, { [key]: validPair[0] });
            expect(capturedWhere(findMany)[key]).toBe(validPair[0]);
        });

        it('expands a comma-joined multi-select into an `in` filter', async () => {
            const { db, findMany } = fakeDb(model);
            await list(db, { [key]: `${validPair[0]},${validPair[1]}` });

            const where = capturedWhere(findMany);
            expect(where[key]).toEqual({ in: [validPair[0], validPair[1]] });
            // The literal comma-joined string is what Prisma rejected.
            expect(where[key]).not.toBe(`${validPair[0]},${validPair[1]}`);
        });

        it('rejects an unknown member with a 400 before touching Prisma', async () => {
            const { db, findMany } = fakeDb(model);

            await expect(list(db, { [key]: invalid })).rejects.toMatchObject({
                status: 400,
            });
            await expect(list(db, { [key]: invalid })).rejects.toThrow(
                new RegExp(`Invalid ${label} "${invalid}"`),
            );
            // Never reached the database — a 500 was the old outcome.
            expect(findMany).not.toHaveBeenCalled();
        });

        it('rejects a mixed list containing one unknown member', async () => {
            const { db, findMany } = fakeDb(model);
            await expect(
                list(db, { [key]: `${validPair[0]},${invalid}` }),
            ).rejects.toMatchObject({ status: 400 });
            expect(findMany).not.toHaveBeenCalled();
        });

        it('omits the filter entirely when the param is absent', async () => {
            const { db, findMany } = fakeDb(model);
            await list(db, {});
            expect(capturedWhere(findMany)[key]).toBeUndefined();
        });
    },
);

describe('VendorRepository.riskRating — nested relation filter', () => {
    it('expands a multi-select inside the assessments relation', async () => {
        const { db, findMany } = fakeDb('vendor');
        await VendorRepository.list(db, ctx, { riskRating: 'HIGH,CRITICAL' } as any);
        expect(capturedWhere(findMany).assessments).toEqual({
            some: { riskRating: { in: ['HIGH', 'CRITICAL'] } },
        });
    });

    it('rejects an unknown rating with a 400', async () => {
        const { db, findMany } = fakeDb('vendor');
        await expect(
            VendorRepository.list(db, ctx, { riskRating: 'ACTIVE' } as any),
        ).rejects.toMatchObject({ status: 400 });
        expect(findMany).not.toHaveBeenCalled();
    });
});
