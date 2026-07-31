/**
 * `parseEnumListFilter` / `parseIdListFilter` — the canonical list-filter
 * parser every list repository funnels its query-string filters through.
 *
 * Regression cover for the production 500 on
 * `GET /api/t/{slug}/risks?status=ACTIVE`. Two reachable shapes used to
 * reach Prisma unchecked and throw `PrismaClientValidationError` (which
 * has no mapping in `src/lib/errors/types.ts`, so it surfaced as a 500
 * AND took the Server Component render with it):
 *
 *   - a comma-joined multi-select (`?status=OPEN,MITIGATING`), and
 *   - a value belonging to a DIFFERENT entity's enum (`?status=ACTIVE`
 *     is an AssetStatus / VendorStatus, never a RiskStatus), which is
 *     how a URL carried over from another list page breaks this one.
 *
 * Both must now be handled at the boundary: valid members collapse to a
 * scalar or `{ in: [...] }`, unknown members are a 400.
 */
import { RiskStatus, AssetStatus, EvidenceStatus } from '@prisma/client';

import {
    parseEnumListFilter,
    parseIdListFilter,
} from '@/app-layer/domain/list-filter';

const RISK_STATUSES = Object.values(RiskStatus);

describe('parseEnumListFilter', () => {
    describe('absent input', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['empty string', ''],
            ['only separators', ',,,'],
            ['only whitespace', '  ,  '],
        ])('returns undefined for %s', (_label, raw) => {
            expect(
                parseEnumListFilter(raw, RISK_STATUSES, 'risk status'),
            ).toBeUndefined();
        });
    });

    describe('valid input', () => {
        it('collapses a single member to a bare scalar', () => {
            expect(
                parseEnumListFilter('OPEN', RISK_STATUSES, 'risk status'),
            ).toBe('OPEN');
        });

        it('expands a comma-joined multi-select to an `in` filter', () => {
            expect(
                parseEnumListFilter(
                    'OPEN,MITIGATING',
                    RISK_STATUSES,
                    'risk status',
                ),
            ).toEqual({ in: ['OPEN', 'MITIGATING'] });
        });

        it('trims whitespace around members', () => {
            expect(
                parseEnumListFilter(
                    ' OPEN , MITIGATING ',
                    RISK_STATUSES,
                    'risk status',
                ),
            ).toEqual({ in: ['OPEN', 'MITIGATING'] });
        });

        it('dedupes repeated members, collapsing back to a scalar', () => {
            expect(
                parseEnumListFilter('OPEN,OPEN', RISK_STATUSES, 'risk status'),
            ).toBe('OPEN');
        });

        it('accepts a Set of valid members as well as an array', () => {
            expect(
                parseEnumListFilter(
                    'CLOSED',
                    new Set(RISK_STATUSES),
                    'risk status',
                ),
            ).toBe('CLOSED');
        });
    });

    describe('invalid input → 400, never a Prisma 500', () => {
        it('rejects a value from another entity\'s enum (the reported bug)', () => {
            // `ACTIVE` is an AssetStatus/VendorStatus. Landing on /risks with
            // a URL carried over from those pages used to 500.
            expect(RISK_STATUSES).not.toContain('ACTIVE');
            expect(() =>
                parseEnumListFilter('ACTIVE', RISK_STATUSES, 'risk status'),
            ).toThrow(/Invalid risk status "ACTIVE"/);
        });

        it('surfaces as a 400-shaped error, not a generic throw', () => {
            let caught: unknown;
            try {
                parseEnumListFilter('ACTIVE', RISK_STATUSES, 'risk status');
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeDefined();
            expect((caught as { status?: number }).status).toBe(400);
        });

        it('rejects a mixed list where only one member is unknown', () => {
            expect(() =>
                parseEnumListFilter(
                    'OPEN,NOT_A_STATUS',
                    RISK_STATUSES,
                    'risk status',
                ),
            ).toThrow(/Invalid risk status "NOT_A_STATUS"/);
        });

        it('names the allowed members so the caller can self-correct', () => {
            expect(() =>
                parseEnumListFilter('ACTIVE', RISK_STATUSES, 'risk status'),
            ).toThrow(new RegExp(RISK_STATUSES.join(', ')));
        });

        it('is case-sensitive — enum members are exact', () => {
            expect(() =>
                parseEnumListFilter('open', RISK_STATUSES, 'risk status'),
            ).toThrow(/Invalid risk status "open"/);
        });
    });

    describe('the same contract holds for the sibling list enums', () => {
        it('accepts ACTIVE for assets (where it IS a real member)', () => {
            expect(
                parseEnumListFilter(
                    'ACTIVE',
                    Object.values(AssetStatus),
                    'asset status',
                ),
            ).toBe('ACTIVE');
        });

        it('expands an evidence multi-select rather than passing the literal', () => {
            expect(
                parseEnumListFilter(
                    'DRAFT,SUBMITTED',
                    Object.values(EvidenceStatus),
                    'evidence status',
                ),
            ).toEqual({ in: ['DRAFT', 'SUBMITTED'] });
        });
    });
});

describe('parseIdListFilter', () => {
    it('returns undefined for absent input', () => {
        expect(parseIdListFilter(undefined)).toBeUndefined();
        expect(parseIdListFilter('')).toBeUndefined();
        expect(parseIdListFilter(' , ')).toBeUndefined();
    });

    it('collapses a single id to a bare scalar', () => {
        expect(parseIdListFilter('user-1')).toBe('user-1');
    });

    it('expands a comma-joined id list', () => {
        expect(parseIdListFilter('user-1,user-2')).toEqual({
            in: ['user-1', 'user-2'],
        });
    });

    it('never rejects — there is no enum to validate against', () => {
        expect(parseIdListFilter('anything-at-all')).toBe('anything-at-all');
    });
});
