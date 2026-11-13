/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and
 * fixtures mirror runtime contracts (Prisma mocks, SCIM payloads).
 * Per-line typing has poor cost/benefit in test files; file-level
 * disable is the codebase standard. */
/**
 * Branch-coverage supplement for src/app-layer/usecases/scim-users.ts.
 *
 * The canonical suite (tests/unit/usecases/scim-users.test.ts) covers
 * the security invariants (admin block, idempotency, tenant scoping).
 * This file targets the BRANCHES that suite leaves uncovered:
 *
 *   - scimListUsers: no-filter / userName-eq-filter / no-match / count path
 *   - emitScimAudit catch branch (audit failure must not throw)
 *   - scimPatchUser: name.givenName / name.familyName (both length
 *     branches), displayName, name.formatted, root-level no-path
 *     (active / displayName / name object), userUpdates apply, role
 *     apply on a non-ADMIN, active=true reactivate branch
 *   - scimPutUser: status-change branch, role-apply branch, displayName
 *     fall-through chain
 *   - scimCreateUser: displayName fall-through (givenName/familyName,
 *     formatted, local-part), already-ACTIVE no reactivate
 */

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findUnique: jest.fn(), update: jest.fn() },
        tenantMembership: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import { hashForLookup } from '@/lib/security/encryption';
import {
    scimListUsers,
    scimCreateUser,
    scimPatchUser,
    scimPutUser,
    toScimUser,
} from '@/app-layer/usecases/scim-users';
import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

const mockUserFindUnique = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockUserUpdate = prisma.user.update as jest.MockedFunction<typeof prisma.user.update>;
const mockMembershipFindFirst = prisma.tenantMembership.findFirst as jest.MockedFunction<typeof prisma.tenantMembership.findFirst>;
const mockMembershipFindUnique = prisma.tenantMembership.findUnique as jest.MockedFunction<typeof prisma.tenantMembership.findUnique>;
const mockMembershipFindMany = prisma.tenantMembership.findMany as jest.MockedFunction<typeof prisma.tenantMembership.findMany>;
const mockMembershipUpdate = prisma.tenantMembership.update as jest.MockedFunction<typeof prisma.tenantMembership.update>;
const mockMembershipCount = prisma.tenantMembership.count as jest.MockedFunction<typeof prisma.tenantMembership.count>;
const mockAppendAudit = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;

const scimCtx = (tenantId = 'tenant-1') => ({
    tenantId,
    tokenLabel: 'okta-prod',
    tokenId: 'tok-1',
});

const userRow = (over: Partial<{ id: string; email: string; name: string | null }> = {}) => ({
    id: 'u1',
    email: 'a@b.com',
    name: 'Alice Doe',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── scimListUsers ───────────────────────────────────────────────────
describe('scimListUsers — filter parsing + count branches', () => {
    it('no filter: uses prisma.count for total, default startIndex/count', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([
            { status: 'ACTIVE', role: 'READER', user: userRow() },
        ] as never);
        mockMembershipCount.mockResolvedValueOnce(7 as never);

        const result = await scimListUsers(scimCtx(), 'https://x');

        expect(result.total).toBe(7);
        expect(result.startIndex).toBe(1);
        expect(result.resources).toHaveLength(1);
        // count path (not filter.length) — branch where emailFilter undefined
        expect(mockMembershipCount).toHaveBeenCalledWith({
            where: expect.objectContaining({ tenantId: 'tenant-1' }),
        });
    });

    it('userName eq is part of the QUERY, so paging and the total apply to the match (#5208)', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([
            { status: 'ACTIVE', role: 'READER', user: userRow({ email: 'match@b.com' }) },
        ] as never);
        mockMembershipCount.mockResolvedValueOnce(1 as never);

        const result = await scimListUsers(scimCtx(), 'https://x', {
            filter: 'userName eq "Match@b.com"',
            startIndex: 1,
            count: 5,
        });

        // The address is matched by its lookup hash, case-folded, IN the where —
        // not by filtering whatever page the skip/take happened to return.
        const where = (mockMembershipFindMany.mock.calls[0][0] as { where: { user?: unknown } }).where;
        expect(where.user).toEqual({ emailHash: hashForLookup('match@b.com') });
        expect(mockMembershipCount).toHaveBeenCalledWith({ where });
        expect(result.total).toBe(1);
        expect(result.resources[0].userName).toBe('match@b.com');
    });

    it('an UNSUPPORTED filter is refused, never answered with every user (#5208)', async () => {
        await expect(
            scimListUsers(scimCtx(), 'https://x', { filter: 'displayName co "foo"' }),
        ).rejects.toMatchObject({ status: 400, scimType: 'invalidFilter' });
        expect(mockMembershipFindMany).not.toHaveBeenCalled();
    });

    it('count capped at 200 via Math.min', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([] as never);
        mockMembershipCount.mockResolvedValueOnce(0 as never);

        await scimListUsers(scimCtx(), 'https://x', { count: 9999 });

        expect(mockMembershipFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 200 }),
        );
    });
});

// ─── emitScimAudit catch branch ──────────────────────────────────────
describe('emitScimAudit — audit failure never blocks provisioning', () => {
    it('swallows appendAuditEntry rejection (delete-style path still succeeds)', async () => {
        mockAppendAudit.mockRejectedValueOnce(new Error('audit chain down'));
        mockMembershipFindFirst.mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE', role: 'READER',
            user: { id: 'u1', email: 'a@b.com', name: 'A' },
        } as never)
        .mockResolvedValueOnce({
            id: 'm1', status: 'DEACTIVATED', role: 'READER', user: userRow(),
        } as never);

        // patch should resolve without throwing even though audit threw
        const result = await scimPatchUser(
            scimCtx(),
            'u1',
            [{ op: 'replace', path: 'active', value: false }],
            'https://x',
        );

        expect(result).not.toBeNull();
        expect(mockAppendAudit).toHaveBeenCalled();
    });

    it('swallows a non-Error rejection (String(err) wrapping branch)', async () => {
        mockAppendAudit.mockRejectedValueOnce('plain string failure');
        mockMembershipFindFirst.mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE', role: 'READER',
            user: { id: 'u1', email: 'a@b.com', name: 'A' },
        } as never)
        .mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE', role: 'READER', user: userRow(),
        } as never);

        await expect(
            scimPatchUser(
                scimCtx(),
                'u1',
                [{ op: 'replace', path: 'displayname', value: 'New Name' }],
                'https://x',
            ),
        ).resolves.not.toBeNull();
    });
});

// ─── scimPatchUser — name & profile branches ─────────────────────────
describe('scimPatchUser — name/profile path branches', () => {
    function primePatch(memberName: string | null, status = 'ACTIVE', role = 'READER') {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1', role, status,
                user: { id: 'u1', email: 'a@b.com', name: memberName },
            } as never)
            .mockResolvedValueOnce({
                id: 'm1', status, role,
                user: userRow({ name: memberName }),
            } as never);
    }

    it('path=displayname updates user.name (userUpdates apply branch)', async () => {
        primePatch('Alice Doe');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'add', path: 'displayName', value: 'Bob' }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Bob' } }),
        );
    });

    it('path=name.givenname replaces first token', async () => {
        primePatch('Alice Doe');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'name.givenName', value: 'Carol' }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Carol Doe' } }),
        );
    });

    it('path=name.familyname replaces last token when name has >1 part', async () => {
        primePatch('Alice Doe');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'name.familyName', value: 'Smith' }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Alice Smith' } }),
        );
    });

    it('path=name.familyname appends when current name is single token', async () => {
        primePatch('Alice');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'name.familyName', value: 'Jones' }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Alice Jones' } }),
        );
    });

    it('path=name.givenname with null current name (|| "" branch)', async () => {
        primePatch(null);
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'name.givenName', value: 'Dave' }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Dave' } }),
        );
    });

    it('applies a non-ADMIN role update (role apply branch, line ~454)', async () => {
        primePatch('Alice Doe', 'ACTIVE', 'READER');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'roles', value: [{ value: 'editor' }] }], 'https://x');
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'EDITOR' } }),
        );
    });

    it('roles op with empty array does NOT set role (Array length=0 branch)', async () => {
        primePatch('Alice Doe');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'roles', value: [] }], 'https://x');
        expect(mockMembershipUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ role: expect.anything() }) }),
        );
    });

    it('active=true via string "true" → status ACTIVE, deactivatedAt null', async () => {
        primePatch('Alice Doe', 'DEACTIVATED');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'active', value: 'true' }], 'https://x');
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'ACTIVE', deactivatedAt: null }),
            }),
        );
        // non-DEACTIVATED → SCIM_USER_UPDATED audit action branch
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_UPDATED' }),
        );
    });

    it('ignores ops with op=remove (only replace/add handled)', async () => {
        primePatch('Alice Doe');
        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'remove', path: 'displayName' }], 'https://x');
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockMembershipUpdate).not.toHaveBeenCalled();
    });
});

// ─── scimPatchUser — root-level (no path) branch ─────────────────────
describe('scimPatchUser — root-level replace (op.path undefined)', () => {
    function primeRoot(status = 'ACTIVE') {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1', role: 'READER', status,
                user: { id: 'u1', email: 'a@b.com', name: 'Old Name' },
            } as never)
            .mockResolvedValueOnce({
                id: 'm1', status, role: 'READER', user: userRow(),
            } as never);
    }

    it('root value with active+displayName+name object updates all three', async () => {
        primeRoot('ACTIVE');
        await scimPatchUser(scimCtx(), 'u1', [{
            op: 'replace',
            value: {
                active: false,
                displayName: 'Root Display',
                name: { givenName: 'Root', familyName: 'User' },
            },
        }], 'https://x');

        // active=false → DEACTIVATED status + deactivatedAt
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'DEACTIVATED' }) }),
        );
        // name object → givenName+familyName joined (later wins over displayName)
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Root User' } }),
        );
    });

    it('root value with name.formatted fallback when given/family absent', async () => {
        primeRoot();
        await scimPatchUser(scimCtx(), 'u1', [{
            op: 'replace',
            value: { name: { formatted: 'Formatted Only' } },
        }], 'https://x');
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Formatted Only' } }),
        );
    });

    it('root value active via string "true" → ACTIVE branch', async () => {
        primeRoot('DEACTIVATED');
        await scimPatchUser(scimCtx(), 'u1', [{
            op: 'replace', value: { active: 'true' },
        }], 'https://x');
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
        );
    });

    it('root value that is falsy/empty → no updates (if (val) branch false)', async () => {
        primeRoot();
        await scimPatchUser(scimCtx(), 'u1', [{ op: 'replace', value: undefined }], 'https://x');
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockMembershipUpdate).not.toHaveBeenCalled();
    });
});

// ─── scimPutUser — status & role branches ────────────────────────────
describe('scimPutUser — status-change + role-apply branches', () => {
    it('changes status when current differs (ACTIVE → DEACTIVATED) + role apply', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'a@b.com',
            active: false,
            roles: [{ value: 'editor' }],
        }, 'https://x');

        expect(mockUserUpdate).toHaveBeenCalled();
        // status change branch
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'DEACTIVATED', deactivatedAt: expect.any(Date) }),
            }),
        );
        // role apply branch (non-admin, not blocked)
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: 'EDITOR' } }),
        );
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_DEACTIVATED' }),
        );
    });

    it('skips status update when status already matches (no membership.update for status)', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'a@b.com', active: true,
        }, 'https://x');

        expect(mockMembershipUpdate).not.toHaveBeenCalled();
        // active!==false → SCIM_USER_UPDATED action
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_UPDATED' }),
        );
    });

    it('blocked role on PUT does NOT apply role update', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'a@b.com', active: true,
            roles: [{ value: 'admin' }],
        }, 'https://x');

        expect(mockMembershipUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ role: expect.anything() }) }),
        );
    });

    it('displayName derives from name.formatted when displayName absent', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'a@b.com', active: true,
            name: { formatted: 'Formatted Person' },
        }, 'https://x');

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Formatted Person' } }),
        );
    });

    it('displayName derives from given+family when formatted absent', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'a@b.com', active: true,
            name: { givenName: 'Given', familyName: 'Family' },
        }, 'https://x');

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'Given Family' } }),
        );
    });

    it('displayName falls back to userName local-part when no name fields', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({ id: 'm1', role: 'READER', status: 'ACTIVE' } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(scimCtx(), 'u1', {
            userName: 'localpart@example.com', active: true,
        }, 'https://x');

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { name: 'localpart' } }),
        );
    });
});

// ─── scimCreateUser — displayName derivation branches ────────────────
describe('scimCreateUser — displayName fall-through chain', () => {
    function primeNewUserTx(capture: (role?: string, status?: string, name?: string) => void) {
        mockUserFindUnique.mockResolvedValueOnce(null);
        (prisma.$transaction as jest.MockedFunction<any>).mockImplementationOnce(
            async (fn: any) => fn({
                user: {
                    create: jest.fn().mockImplementation((args: any) => {
                        capture(undefined, undefined, args.data.name);
                        return {
                            id: 'u-new', email: args.data.email, name: args.data.name,
                            createdAt: new Date(), updatedAt: new Date(),
                        };
                    }),
                },
                tenantMembership: {
                    create: jest.fn().mockImplementation((args: any) => {
                        capture(args.data.role, args.data.status);
                        return { id: 'm-new', ...args.data };
                    }),
                },
            }),
        );
    }

    it('uses name.formatted when displayName absent', async () => {
        let name: string | undefined;
        primeNewUserTx((_r, _s, n) => { if (n !== undefined) name = n; });
        await scimCreateUser(scimCtx(), {
            userName: 'x@y.com',
            name: { formatted: 'Formatted Name' },
        }, 'https://x');
        expect(name).toBe('Formatted Name');
    });

    it('uses given+family join when displayName+formatted absent', async () => {
        let name: string | undefined;
        primeNewUserTx((_r, _s, n) => { if (n !== undefined) name = n; });
        await scimCreateUser(scimCtx(), {
            userName: 'x@y.com',
            name: { givenName: 'First', familyName: 'Last' },
        }, 'https://x');
        expect(name).toBe('First Last');
    });

    it('falls back to email local-part when no name supplied', async () => {
        let name: string | undefined;
        primeNewUserTx((_r, _s, n) => { if (n !== undefined) name = n; });
        await scimCreateUser(scimCtx(), { userName: 'JustLocal@y.com' }, 'https://x');
        expect(name).toBe('justlocal');
    });

    it('already-ACTIVE membership: returns created=false WITHOUT reactivation update', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userRow() as never);
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE', role: 'READER',
        } as never);

        const res = await scimCreateUser(scimCtx(), { userName: 'a@b.com' }, 'https://x');
        expect(res.created).toBe(false);
        expect(mockMembershipUpdate).not.toHaveBeenCalled();
    });

    it('REMOVED membership is also reactivated (status==="REMOVED" branch)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userRow() as never);
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', status: 'REMOVED', role: 'READER',
        } as never);

        await scimCreateUser(scimCtx(), { userName: 'a@b.com' }, 'https://x');
        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
        );
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_REACTIVATED' }),
        );
    });
});

// ─── Remaining edge branches ─────────────────────────────────────────
describe('residual branch edges', () => {
    it('scimCreateUser: existing user, no membership, active=false → DEACTIVATED membership', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userRow({ id: 'shared' }) as never);
        mockMembershipFindUnique.mockResolvedValueOnce(null);
        let observedStatus: string | undefined;
        (prisma.tenantMembership.create as jest.MockedFunction<any>)
            .mockImplementationOnce((args: any) => {
                observedStatus = args.data.status;
                return { id: 'm-new', ...args.data };
            });

        await scimCreateUser(scimCtx(), { userName: 'a@b.com', active: false }, 'https://x');
        expect(observedStatus).toBe('DEACTIVATED');
    });

    it('scimPutUser: returns null when membership not found', async () => {
        mockMembershipFindFirst.mockResolvedValueOnce(null);
        const res = await scimPutUser(scimCtx('tenant-A'), 'foreign', { userName: 'a@b.com' }, 'https://x');
        expect(res).toBeNull();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('scimPatchUser: op with an unrecognised path is ignored (no updates)', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1', role: 'READER', status: 'ACTIVE',
                user: { id: 'u1', email: 'a@b.com', name: 'Alice Doe' },
            } as never)
            .mockResolvedValueOnce({ id: 'm1', status: 'ACTIVE', role: 'READER', user: userRow() } as never);

        await scimPatchUser(scimCtx(), 'u1',
            [{ op: 'replace', path: 'emails', value: 'foo' }], 'https://x');
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockMembershipUpdate).not.toHaveBeenCalled();
    });
});

// ─── toScimUser — name-part edge branches ────────────────────────────
describe('toScimUser — display fallbacks', () => {
    it('falls back displayName to email when name is null', () => {
        const u = userRow({ name: null });
        const out = toScimUser(u, { status: 'ACTIVE' }, 'https://x');
        expect(out.displayName).toBe('a@b.com');
        expect(out.active).toBe(true);
    });
});
