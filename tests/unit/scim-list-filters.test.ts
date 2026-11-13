/**
 * SCIM list endpoints answer the question they are asked (#5079, #5208).
 *
 * Entra and Okta look an object up with `filter=<attr> eq "<value>"` before
 * creating it. Groups ignored the filter entirely and Users ignored any filter
 * it did not recognise, so a lookup got the whole population back — and a
 * provisioning client reads "results came back" as "it exists", then patches
 * the first resource returned instead of creating the one it meant.
 */
const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ scimGroup: { findMany: mockFindMany, count: mockCount } }),
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/auth/entra-group-sync', () => ({ syncEntraMembershipRole: jest.fn() }));

import { parseScimEqFilter, scimPage, ScimFilterError } from '@/lib/scim/filter';
import { scimListGroups } from '@/app-layer/usecases/scim-groups';

const ctx = { tenantId: 't1', tenantSlug: 't1', tokenId: 'tok' } as never;

beforeEach(() => {
    mockFindMany.mockReset().mockResolvedValue([]);
    mockCount.mockReset().mockResolvedValue(0);
});

describe('parseScimEqFilter', () => {
    it('reads one eq clause on an allowed attribute, case-insensitively, in the allowlist spelling', () => {
        expect(parseScimEqFilter('DISPLAYNAME eq "Finance Admins"', ['displayName', 'externalId'] as const)).toEqual({
            attribute: 'displayName',
            value: 'Finance Admins',
        });
    });

    it('unescapes a quoted value', () => {
        expect(parseScimEqFilter('userName eq "a\\"b@x.test"', ['userName'] as const)?.value).toBe('a"b@x.test');
    });

    it('treats an absent or blank filter as no filter', () => {
        expect(parseScimEqFilter(undefined, ['userName'] as const)).toBeNull();
        expect(parseScimEqFilter('   ', ['userName'] as const)).toBeNull();
    });

    it.each([
        ['another operator', 'userName co "a"'],
        ['an attribute not on the list', 'emails.value eq "a@b"'],
        ['a compound filter', 'userName eq "a" and active eq true'],
        ['an unquoted value', 'userName eq a'],
    ])('refuses %s as invalidFilter', (_label, filter) => {
        expect(() => parseScimEqFilter(filter, ['userName'] as const)).toThrow(ScimFilterError);
    });
});

describe('scimPage', () => {
    it('reads startIndex below 1 as 1, a negative count as 0, and caps count', () => {
        expect(scimPage('0', '-5', { count: 100, max: 200 })).toEqual({ startIndex: 1, count: 0 });
        expect(scimPage('3', '9999', { count: 100, max: 200 })).toEqual({ startIndex: 3, count: 200 });
        expect(scimPage(null, 'x', { count: 100, max: 200 })).toEqual({ startIndex: 1, count: 100 });
    });
});

describe('scimListGroups (#5079)', () => {
    it('puts a displayName eq filter IN the query and reports the filtered total', async () => {
        mockCount.mockResolvedValue(1);
        const r = await scimListGroups(ctx, { filter: 'displayName eq "Finance Admins"' });

        const where = { tenantId: 't1', displayName: 'Finance Admins' };
        expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
        expect(mockCount).toHaveBeenCalledWith({ where });
        expect(r.total).toBe(1);
    });

    it('honours externalId eq, startIndex and count', async () => {
        await scimListGroups(ctx, { filter: 'externalId eq "g-123"', startIndex: 3, count: 10 });
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 't1', externalId: 'g-123' }, skip: 2, take: 10 }),
        );
    });

    it('refuses an unsupported filter rather than listing every group', async () => {
        await expect(scimListGroups(ctx, { filter: 'members.value eq "u1"' })).rejects.toBeInstanceOf(ScimFilterError);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});
