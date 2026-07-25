/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/audit-readiness/sharing.ts` —
 * the share-link + auditor-account access-control surface.
 *
 * Wave-3 branch coverage. Compliance-critical: a bug here either
 *   - lets a stale token through after the pack was revoked, OR
 *   - lets a DRAFT pack leak before the freeze step ran, OR
 *   - lets an auditor keep access after `revokeAuditorAccess`.
 *
 * Branch matrix covered:
 *   - generateShareLink:  pack-not-found / pack-DRAFT / happy-path
 *   - revokeShare:        share-not-found / already-revoked / happy-path
 *   - getPackByShareToken: invalid token / expired / happy-path
 *   - inviteAuditor:      upsert success (with logEvent)
 *   - grantAuditorAccess: auditor-not-found / pack-not-found /
 *                         already-has-access (caught) / happy-path
 *   - revokeAuditorAccess: deleteMany + audit
 *   - hashToken / generateShareToken: deterministic / non-deterministic
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];

const appendCalls: any[] = [];

jest.mock('@/app-layer/policies/audit-readiness.policies', () => ({
    assertCanSharePack: jest.fn(() => policyCalls.push('share')),
    assertCanManageAuditors: jest.fn(() => policyCalls.push('manage')),
    assertCanViewPack: jest.fn(() => policyCalls.push('view')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

jest.mock('@/lib/security/encryption', () => ({
    hashForLookup: jest.fn((s: string) => `hash(${s})`),
}));

jest.mock('@/lib/security/sanitize', () => ({
    // Strip tags so the "sanitised on write" assertion is real. Applied
    // repeatedly until stable: a single pass over nested markup (`<scr<x>ipt>`)
    // can re-form the very sequence it just removed.
    sanitizePlainText: jest.fn((s: any) => {
        if (s == null) return '';
        let out = String(s);
        for (let prev = ''; out !== prev; ) {
            prev = out;
            out = out.replace(/<[^>]*>/g, '');
        }
        return out;
    }),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async (entry: any) => { appendCalls.push(entry); }),
}));

const tenantDb: any = {
    auditPack: { findFirst: jest.fn() },
    auditPackShare: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    auditPackItem: { findFirst: jest.fn() },
    auditPackShareComment: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    auditorAccount: { upsert: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    auditorPackAccess: { create: jest.fn(), deleteMany: jest.fn() },
    // feat/audit-cycle-unify — materialize path reads for the finding cascade.
    finding: { findFirst: jest.fn() },
    audit: { findFirst: jest.fn() },
};

// The materialize cascade delegates to the ctx-level createFinding / createTask
// usecases (own tenant contexts); mock them to assert the cascade wiring.
const createFindingMock = jest.fn(async (..._args: any[]) => ({ id: 'find-new' }));
const createTaskMock = jest.fn(async (..._args: any[]) => ({ id: 'task-new' }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: (...a: any[]) => createFindingMock(...a) }));
jest.mock('@/app-layer/usecases/task', () => ({ createTask: (...a: any[]) => createTaskMock(...a) }));
const globalDb: any = {
    auditPackShare: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, callback: any) => callback(tenantDb)),
        runInGlobalContext: jest.fn(async (callback: any) => callback(globalDb)),
        withTenantDb: jest.fn(async (_tenantId: any, callback: any) => callback(tenantDb)),
    };
});

import {
    hashToken,
    generateShareToken,
    generateShareLink,
    revokeShare,
    getPackByShareToken,
    addShareComment,
    listShareComments,
    resolveShareComment,
    materializeShareCommentFinding,
    inviteAuditor,
    grantAuditorAccess,
    revokeAuditorAccess,
    revokeAuditorAccount,
    listAuditors,
    listPackShares,
} from '@/app-layer/usecases/audit-readiness/sharing';
import {
    assertCanSharePack,
    assertCanManageAuditors,
} from '@/app-layer/policies/audit-readiness.policies';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    appendCalls.length = 0;
    [
        tenantDb.auditPack.findFirst,
        tenantDb.auditPackShare.create, tenantDb.auditPackShare.findFirst, tenantDb.auditPackShare.update,
        tenantDb.auditPackItem.findFirst,
        tenantDb.auditPackShareComment.create, tenantDb.auditPackShareComment.findFirst,
        tenantDb.auditPackShareComment.findMany, tenantDb.auditPackShareComment.update,
        tenantDb.auditorAccount.upsert, tenantDb.auditorAccount.findUnique, tenantDb.auditorAccount.findFirst, tenantDb.auditorAccount.findMany, tenantDb.auditorAccount.update,
        tenantDb.auditPackShare.findMany,
        tenantDb.auditorPackAccess.create, tenantDb.auditorPackAccess.deleteMany,
        globalDb.auditPackShare.findFirst,
        assertCanSharePack as jest.Mock,
        assertCanManageAuditors as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanSharePack as jest.Mock).mockImplementation(() => policyCalls.push('share'));
    (assertCanManageAuditors as jest.Mock).mockImplementation(() => policyCalls.push('manage'));
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// Token primitives — deterministic hash, fresh token
// ──────────────────────────────────────────────────────────────────────
describe('hashToken / generateShareToken', () => {
    it('hashToken is deterministic SHA-256 hex (64 chars)', () => {
        const a = hashToken('abc');
        const b = hashToken('abc');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        // Different input → different hash (sanity check).
        expect(hashToken('xyz')).not.toBe(a);
    });

    it('generateShareToken produces 32 bytes of fresh entropy (64 hex chars)', () => {
        const a = generateShareToken();
        const b = generateShareToken();
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).not.toBe(b); // Probability of collision is ~ 2^-256
    });
});

// ──────────────────────────────────────────────────────────────────────
// generateShareLink — 3 branches
// ──────────────────────────────────────────────────────────────────────
describe('generateShareLink', () => {
    it('throws notFound when the pack id is foreign to the tenant', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(
            generateShareLink(ctx, 'pack-foreign'),
        ).rejects.toThrow(/audit pack not found/i);
        expect(tenantDb.auditPackShare.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('rejects with badRequest when the pack is still DRAFT (must be frozen first)', async () => {
        // A DRAFT pack is still being edited; sharing it would leak
        // in-progress, pre-attestation content. The freeze step is
        // the compliance gate.
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        await expect(
            generateShareLink(ctx, 'p-1'),
        ).rejects.toThrow(/draft pack/i);
        expect(tenantDb.auditPackShare.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('creates the share row, fires AUDIT_PACK_SHARED, and returns { token, expiresAt }', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        tenantDb.auditPackShare.create.mockResolvedValueOnce({ id: 's-1' });

        const result = await generateShareLink(ctx, 'p-1', '2027-01-01T00:00:00Z');

        expect(result.token).toMatch(/^[0-9a-f]{64}$/);
        expect(result.expiresAt).toBe('2027-01-01T00:00:00Z');
        expect(policyCalls).toEqual(['share']);
        // Token stored as HASH, never raw — load-bearing for the
        // "leaked DB dump cannot replay" property.
        const createArg = tenantDb.auditPackShare.create.mock.calls[0][0];
        expect(createArg.data.tokenHash).toBe(hashToken(result.token));
        expect(createArg.data.expiresAt).toBeInstanceOf(Date);
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0].action).toBe('AUDIT_PACK_SHARED');
    });

    it('supports null expiry (no `expiresAt` argument → DB column null)', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        tenantDb.auditPackShare.create.mockResolvedValueOnce({ id: 's-1' });

        const result = await generateShareLink(ctx, 'p-1');

        expect(result.expiresAt).toBeNull();
        const createArg = tenantDb.auditPackShare.create.mock.calls[0][0];
        expect(createArg.data.expiresAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// revokeShare — 3 branches
// ──────────────────────────────────────────────────────────────────────
describe('revokeShare', () => {
    it('throws notFound when the share id is foreign to the tenant', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(revokeShare(ctx, 's-foreign')).rejects.toThrow(/share not found/i);
        expect(tenantDb.auditPackShare.update).not.toHaveBeenCalled();
    });

    it('is IDEMPOTENT-rejecting: already-revoked share throws badRequest (no double-write)', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', revokedAt: new Date('2026-01-01'),
        });
        await expect(revokeShare(ctx, 's-1')).rejects.toThrow(/already revoked/i);
        expect(tenantDb.auditPackShare.update).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('stamps revokedAt + fires AUDIT_PACK_REVOKED on the happy-path', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce({ id: 's-1', revokedAt: null });
        tenantDb.auditPackShare.update.mockResolvedValueOnce({ id: 's-1', revokedAt: new Date() });

        const result = await revokeShare(ctx, 's-1');

        expect(result).toEqual({ revoked: true });
        expect(tenantDb.auditPackShare.update).toHaveBeenCalledWith({
            where: { id: 's-1' },
            data: { revokedAt: expect.any(Date) },
        });
        expect(auditCalls[0].action).toBe('AUDIT_PACK_REVOKED');
    });
});

// ──────────────────────────────────────────────────────────────────────
// getPackByShareToken — 3 branches, no auth (the token IS the auth)
// ──────────────────────────────────────────────────────────────────────
describe('getPackByShareToken', () => {
    it('throws notFound when the token hash matches no live share row', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(getPackByShareToken('bogus')).rejects.toThrow(/invalid or expired/i);
    });

    it('throws forbidden when the share has expired', async () => {
        // Reaching this branch is what protects pasted-from-Slack-link
        // attacks that arrive past the configured expiry.
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1',
            expiresAt: new Date('2026-01-01T00:00:00Z'),
            revokedAt: null,
            pack: { id: 'p-1', items: [], cycle: { frameworkKey: 'iso' } },
        });
        await expect(getPackByShareToken('valid-but-expired')).rejects.toThrow(/expired/i);
    });

    it('returns { pack, cycle, items } on the happy-path', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1',
            expiresAt: null,
            revokedAt: null,
            pack: {
                id: 'p-1',
                items: [{ id: 'i-1', sortOrder: 1 }],
                cycle: { frameworkKey: 'iso', frameworkVersion: '2022', name: 'Cycle 1' },
            },
        });

        const result = await getPackByShareToken('legit');

        expect(result.pack.id).toBe('p-1');
        expect(result.cycle.frameworkKey).toBe('iso');
        expect(result.items).toHaveLength(1);
    });

    it('queries by tokenHash AND revokedAt-null (no auth bypass via revoked share)', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(getPackByShareToken('any')).rejects.toThrow(/invalid/i);

        const where = globalDb.auditPackShare.findFirst.mock.calls[0][0].where;
        expect(where.tokenHash).toBe(hashToken('any'));
        expect(where.revokedAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// inviteAuditor / grantAuditorAccess / revokeAuditorAccess
// ──────────────────────────────────────────────────────────────────────
describe('inviteAuditor', () => {
    it('upserts the auditor account (INVITED on first insert, ACTIVE on re-invite)', async () => {
        tenantDb.auditorAccount.findUnique.mockResolvedValueOnce(null);
        tenantDb.auditorAccount.upsert.mockResolvedValueOnce({ id: 'a-1', email: 'auditor@ex.com' });

        const result = await inviteAuditor(ctx, 'auditor@ex.com', 'Audrey');

        expect(result.id).toBe('a-1');
        expect(result.reactivated).toBe(false);
        expect(policyCalls).toEqual(['manage']);
        const upsertArg = tenantDb.auditorAccount.upsert.mock.calls[0][0];
        expect(upsertArg.create.status).toBe('INVITED');
        expect(upsertArg.update.status).toBe('ACTIVE');
        expect(auditCalls[0].action).toBe('AUDITOR_INVITED');
    });

    it('surfaces reactivation when a REVOKED auditor is re-invited', async () => {
        // PR-O — inviting an existing REVOKED account flips it back to ACTIVE.
        // The usecase must report reactivated=true + log AUDITOR_REACTIVATED so
        // the state change is visible, not silent.
        tenantDb.auditorAccount.findUnique.mockResolvedValueOnce({ status: 'REVOKED' });
        tenantDb.auditorAccount.upsert.mockResolvedValueOnce({ id: 'a-1', email: 'auditor@ex.com' });

        const result = await inviteAuditor(ctx, 'auditor@ex.com', 'Audrey');

        expect(result.reactivated).toBe(true);
        expect(auditCalls[0].action).toBe('AUDITOR_REACTIVATED');
    });

    it('does NOT flag reactivation for an already-ACTIVE re-invite', async () => {
        tenantDb.auditorAccount.findUnique.mockResolvedValueOnce({ status: 'ACTIVE' });
        tenantDb.auditorAccount.upsert.mockResolvedValueOnce({ id: 'a-1', email: 'auditor@ex.com' });

        const result = await inviteAuditor(ctx, 'auditor@ex.com', 'Audrey');

        expect(result.reactivated).toBe(false);
        expect(auditCalls[0].action).toBe('AUDITOR_INVITED');
    });
});

describe('revokeAuditorAccount', () => {
    it('throws notFound when the auditor is foreign to the tenant', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce(null);
        await expect(revokeAuditorAccount(ctx, 'a-foreign')).rejects.toThrow(/auditor not found/i);
        expect(policyCalls).toEqual(['manage']);
    });

    it('throws badRequest when the auditor is already revoked', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com', status: 'REVOKED' });
        await expect(revokeAuditorAccount(ctx, 'a-1')).rejects.toThrow(/already revoked/i);
    });

    it('flips the account to REVOKED, drops all pack access, and audits', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com', status: 'ACTIVE' });
        tenantDb.auditorAccount.update.mockResolvedValueOnce({ id: 'a-1' });
        tenantDb.auditorPackAccess.deleteMany.mockResolvedValueOnce({ count: 2 });

        const result = await revokeAuditorAccount(ctx, 'a-1');

        expect(result).toEqual({ revoked: true });
        expect(tenantDb.auditorAccount.update.mock.calls[0][0].data.status).toBe('REVOKED');
        expect(tenantDb.auditorPackAccess.deleteMany).toHaveBeenCalledWith({ where: { auditorId: 'a-1', tenantId: ctx.tenantId } });
        expect(auditCalls[0].action).toBe('AUDITOR_ACCOUNT_REVOKED');
    });
});

describe('grantAuditorAccess', () => {
    it('throws notFound when the auditor is foreign to the tenant', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce(null);
        await expect(grantAuditorAccess(ctx, 'a-foreign', 'p-1')).rejects.toThrow(/auditor not found/i);
    });

    it('throws notFound when the pack is foreign to the tenant', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(grantAuditorAccess(ctx, 'a-1', 'p-foreign')).rejects.toThrow(/pack not found/i);
    });

    it('rethrows duplicate-access (catch-block) as a badRequest (idempotent semantics)', async () => {
        // Prisma raises P2002 on the unique tuple (tenantId,auditorId,packId).
        // The usecase translates that to badRequest("already has access")
        // so the API surface is one stable shape across the underlying
        // concurrency outcomes.
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditorPackAccess.create.mockRejectedValueOnce(
            Object.assign(new Error('unique constraint'), { code: 'P2002' }),
        );
        await expect(grantAuditorAccess(ctx, 'a-1', 'p-1')).rejects.toThrow(/already has access/i);
        expect(auditCalls).toHaveLength(0);
    });

    it('creates the access row + audit on happy-path', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditorPackAccess.create.mockResolvedValueOnce({ id: 'ap-1' });

        const result = await grantAuditorAccess(ctx, 'a-1', 'p-1');

        expect(result).toEqual({ granted: true });
        expect(auditCalls[0].action).toBe('AUDITOR_GRANTED');
    });
});

describe('revokeAuditorAccess', () => {
    it('deletes ALL access rows for the (auditorId, packId) pair and fires AUDITOR_REVOKED', async () => {
        // Uses `deleteMany` instead of `delete`-by-id so a duplicate
        // row (shouldn't exist due to the unique tuple but the
        // resilience is cheap) gets cleaned up in the same call.
        tenantDb.auditorPackAccess.deleteMany.mockResolvedValueOnce({ count: 1 });

        const result = await revokeAuditorAccess(ctx, 'a-1', 'p-1');

        expect(result).toEqual({ revoked: true });
        expect(tenantDb.auditorPackAccess.deleteMany).toHaveBeenCalledWith({
            where: { auditorId: 'a-1', auditPackId: 'p-1' },
        });
        expect(auditCalls[0].action).toBe('AUDITOR_REVOKED');
    });

    it('still emits the audit when deleteMany matches zero rows (idempotent revoke)', async () => {
        // Revoking an already-revoked / never-granted auditor is a
        // no-op against the DB but still produces an audit row so
        // the action is traceable to the principal who attempted it.
        tenantDb.auditorPackAccess.deleteMany.mockResolvedValueOnce({ count: 0 });

        await revokeAuditorAccess(ctx, 'a-1', 'p-1');

        expect(auditCalls).toHaveLength(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// listAuditors / listPackShares — management readers
// ──────────────────────────────────────────────────────────────────────
describe('listAuditors', () => {
    it('returns auditors with their pack-access refs (manage-gated)', async () => {
        tenantDb.auditorAccount.findMany.mockResolvedValueOnce([
            {
                id: 'a-1', email: 'a@ex.com', name: 'Audrey', status: 'ACTIVE',
                createdAt: new Date('2026-01-01'),
                packAccess: [{ auditPackId: 'p-1', grantedAt: new Date('2026-02-01') }],
            },
            {
                id: 'a-2', email: 'b@ex.com', name: null, status: 'INVITED',
                createdAt: new Date('2026-01-02'), packAccess: [],
            },
        ]);

        const result = await listAuditors(ctx);

        expect(result).toHaveLength(2);
        expect(result[0].packAccess[0].auditPackId).toBe('p-1');
        expect(result[1].name).toBeNull();
        expect(policyCalls).toEqual(['manage']);
        // Scoped to the caller's tenant.
        const where = tenantDb.auditorAccount.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe(ctx.tenantId);
    });
});

describe('listPackShares', () => {
    it('throws notFound when the pack is foreign to the tenant', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(listPackShares(ctx, 'p-foreign')).rejects.toThrow(/audit pack not found/i);
        expect(tenantDb.auditPackShare.findMany).not.toHaveBeenCalled();
    });

    it('returns the pack share rows newest-first (share-gated, never leaks tokenHash)', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditPackShare.findMany.mockResolvedValueOnce([
            { id: 's-1', createdAt: new Date('2026-03-01'), expiresAt: null, revokedAt: null, createdByUserId: 'u-1' },
        ]);

        const result = await listPackShares(ctx, 'p-1');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s-1');
        expect(policyCalls).toEqual(['share']);
        const args = tenantDb.auditPackShare.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: ctx.tenantId, auditPackId: 'p-1' });
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        // Only lifecycle metadata is selected — the token hash is never returned.
        expect(args.select.tokenHash).toBeUndefined();
    });
});

// ──────────────────────────────────────────────────────────────────────
// Return channel — addShareComment (public, token-authenticated)
// ──────────────────────────────────────────────────────────────────────
describe('addShareComment', () => {
    it('throws notFound when the token matches no live share', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(addShareComment('bogus', { kind: 'COMMENT', body: 'hi' }))
            .rejects.toThrow(/invalid or expired/i);
        expect(tenantDb.auditPackShareComment.create).not.toHaveBeenCalled();
    });

    it('throws forbidden when the share has expired', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', tenantId: 't-1', auditPackId: 'p-1',
            expiresAt: new Date('2020-01-01T00:00:00Z'),
        });
        await expect(addShareComment('stale', { kind: 'COMMENT', body: 'hi' }))
            .rejects.toThrow(/expired/i);
        expect(tenantDb.auditPackShareComment.create).not.toHaveBeenCalled();
    });

    it('rejects an empty body (after sanitisation)', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', tenantId: 't-1', auditPackId: 'p-1', expiresAt: null,
        });
        await expect(addShareComment('ok', { kind: 'COMMENT', body: '   ' }))
            .rejects.toThrow(/body is required/i);
    });

    it('resolves the share cross-tenant, sanitises body, writes the row + audits as AUDITOR', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', tenantId: 't-1', auditPackId: 'p-1', expiresAt: null,
        });
        tenantDb.auditPackShareComment.create.mockResolvedValueOnce({
            id: 'c-1', kind: 'FINDING', status: 'OPEN', createdAt: new Date(),
        });

        const result = await addShareComment('legit', {
            kind: 'FINDING',
            body: 'Control gap<script>alert(1)</script>',
            authorLabel: 'jane@auditco.com',
        });

        expect(result.id).toBe('c-1');
        // Resolved cross-tenant on tokenHash + revokedAt null.
        const where = globalDb.auditPackShare.findFirst.mock.calls[0][0].where;
        expect(where.tokenHash).toBe(hashToken('legit'));
        expect(where.revokedAt).toBeNull();
        // Row written into the resolved tenant + sanitised body (no <script>).
        const createArg = tenantDb.auditPackShareComment.create.mock.calls[0][0];
        expect(createArg.data.tenantId).toBe('t-1');
        expect(createArg.data.auditPackId).toBe('p-1');
        expect(createArg.data.auditPackShareId).toBe('s-1');
        expect(createArg.data.kind).toBe('FINDING');
        // Case-insensitive and open-ended: `<SCRIPT>` / `<script src=…>` are the
        // same failure as `<script>`, so the assertion must catch them too.
        expect(createArg.data.body).not.toMatch(/<script/i);
        expect(createArg.data.authorLabel).toBe('jane@auditco.com');
        // External actor — audit row carries no platform userId.
        expect(appendCalls).toHaveLength(1);
        expect(appendCalls[0].actorType).toBe('AUDITOR');
        expect(appendCalls[0].userId).toBeNull();
        expect(appendCalls[0].action).toBe('AUDIT_SHARE_COMMENT_ADDED');
    });

    it('falls back to a generic authorLabel when none is supplied', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', tenantId: 't-1', auditPackId: 'p-1', expiresAt: null,
        });
        tenantDb.auditPackShareComment.create.mockResolvedValueOnce({ id: 'c-2', kind: 'COMMENT', status: 'OPEN', createdAt: new Date() });

        await addShareComment('legit', { kind: 'COMMENT', body: 'nice pack' });

        const createArg = tenantDb.auditPackShareComment.create.mock.calls[0][0];
        expect(createArg.data.authorLabel).toBe('External auditor');
    });

    it('rejects an item that does not belong to the resolved pack', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', tenantId: 't-1', auditPackId: 'p-1', expiresAt: null,
        });
        tenantDb.auditPackItem.findFirst.mockResolvedValueOnce(null);
        await expect(addShareComment('legit', { kind: 'COMMENT', body: 'x', auditPackItemId: 'i-foreign' }))
            .rejects.toThrow(/does not belong/i);
        expect(tenantDb.auditPackShareComment.create).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────
// Return channel — listShareComments / resolveShareComment (tenant)
// ──────────────────────────────────────────────────────────────────────
describe('listShareComments', () => {
    it('throws notFound when the pack is foreign to the tenant', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(listShareComments(ctx, 'p-foreign')).rejects.toThrow(/pack not found/i);
    });

    it('returns comments + openCount (COMMENT rows are NOT counted as open)', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditPackShareComment.findMany.mockResolvedValueOnce([
            { id: 'c-1', kind: 'FINDING', status: 'OPEN' },
            { id: 'c-2', kind: 'EVIDENCE_REQUEST', status: 'RESOLVED' },
            { id: 'c-3', kind: 'COMMENT', status: 'OPEN' },
            { id: 'c-4', kind: 'QUESTION', status: 'OPEN' },
        ]);

        const result = await listShareComments(ctx, 'p-1');

        expect(result.comments).toHaveLength(4);
        // Two OPEN actionable rows (FINDING + QUESTION); the OPEN COMMENT
        // and the RESOLVED request are excluded from the badge count.
        expect(result.openCount).toBe(2);
        expect(policyCalls).toContain('view');
    });
});

describe('resolveShareComment', () => {
    it('throws notFound when the entry is foreign to the tenant/pack', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce(null);
        await expect(resolveShareComment(ctx, 'p-1', 'c-x')).rejects.toThrow(/not found/i);
    });

    it('refuses to resolve a plain COMMENT', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'COMMENT', status: 'OPEN' });
        await expect(resolveShareComment(ctx, 'p-1', 'c-1')).rejects.toThrow(/cannot be resolved/i);
        expect(tenantDb.auditPackShareComment.update).not.toHaveBeenCalled();
    });

    it('is idempotent-rejecting: already-resolved throws badRequest', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'FINDING', status: 'RESOLVED' });
        await expect(resolveShareComment(ctx, 'p-1', 'c-1')).rejects.toThrow(/already resolved/i);
        expect(tenantDb.auditPackShareComment.update).not.toHaveBeenCalled();
    });

    it('stamps RESOLVED + resolvedByUserId and fires AUDIT_SHARE_COMMENT_RESOLVED', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'EVIDENCE_REQUEST', status: 'OPEN' });
        tenantDb.auditPackShareComment.update.mockResolvedValueOnce({ id: 'c-1', status: 'RESOLVED', resolvedAt: new Date() });

        const result = await resolveShareComment(ctx, 'p-1', 'c-1');

        expect(result.status).toBe('RESOLVED');
        const updateArg = tenantDb.auditPackShareComment.update.mock.calls[0][0];
        expect(updateArg.data.status).toBe('RESOLVED');
        expect(updateArg.data.resolvedByUserId).toBe(ctx.userId);
        expect(auditCalls[0].action).toBe('AUDIT_SHARE_COMMENT_RESOLVED');
    });
});

describe('materializeShareCommentFinding — auditor FINDING → real Finding+Task', () => {
    beforeEach(() => {
        createFindingMock.mockClear();
        createTaskMock.mockClear();
        createFindingMock.mockResolvedValue({ id: 'find-new' });
        tenantDb.finding.findFirst.mockReset();
        tenantDb.audit.findFirst.mockReset();
    });

    it('rejects a plain COMMENT / QUESTION (only FINDING & EVIDENCE_REQUEST)', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'QUESTION', status: 'OPEN', body: 'hi', auditPackItemId: null });
        await expect(materializeShareCommentFinding(ctx, 'p-1', 'c-1')).rejects.toThrow(/FINDING or EVIDENCE_REQUEST/i);
        expect(createFindingMock).not.toHaveBeenCalled();
    });

    it('a FINDING creates a Finding + Task tied to the cycle audit and resolves the comment', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'FINDING', status: 'OPEN', body: 'Control X is not implemented', auditPackItemId: 'item-1' });
        tenantDb.finding.findFirst.mockResolvedValueOnce(null); // no existing materialisation
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ auditCycleId: 'cyc-1' });
        tenantDb.audit.findFirst.mockResolvedValueOnce({ id: 'aud-1' }); // a fieldwork audit exists
        tenantDb.auditPackItem.findFirst.mockResolvedValueOnce({ entityType: 'CONTROL', entityId: 'ctrl-9' });
        tenantDb.auditPackShareComment.update.mockResolvedValueOnce({ id: 'c-1', status: 'RESOLVED' });

        const result = await materializeShareCommentFinding(ctx, 'p-1', 'c-1');

        expect(result.findingId).toBe('find-new');
        // Finding is tied to the cycle's fieldwork audit + the control the item targets.
        expect(createFindingMock).toHaveBeenCalledWith(
            ctx,
            expect.objectContaining({ auditId: 'aud-1', controlId: 'ctrl-9', type: 'NONCONFORMITY', sourceKind: 'AUDITOR_SHARE_COMMENT', sourceRef: 'c-1' }),
        );
        // A remediation Task links the finding.
        expect(createTaskMock).toHaveBeenCalledWith(ctx, expect.objectContaining({ findingId: 'find-new', type: 'AUDIT_FINDING' }));
        // The comment is resolved + a materialization audit entry fires.
        expect(tenantDb.auditPackShareComment.update.mock.calls[0][0].data.status).toBe('RESOLVED');
        expect(auditCalls.some((e) => e.action === 'AUDIT_SHARE_COMMENT_MATERIALIZED')).toBe(true);
    });

    it('is idempotent — an already-materialised comment returns the existing finding without a duplicate', async () => {
        tenantDb.auditPackShareComment.findFirst.mockResolvedValueOnce({ id: 'c-1', kind: 'FINDING', status: 'OPEN', body: 'x', auditPackItemId: null });
        tenantDb.finding.findFirst.mockResolvedValueOnce({ id: 'find-existing' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ auditCycleId: 'cyc-1' });
        tenantDb.audit.findFirst.mockResolvedValueOnce(null);
        tenantDb.auditPackShareComment.update.mockResolvedValueOnce({ id: 'c-1', status: 'RESOLVED' });

        const result = await materializeShareCommentFinding(ctx, 'p-1', 'c-1');

        expect(result).toEqual({ findingId: 'find-existing', alreadyExisted: true });
        expect(createFindingMock).not.toHaveBeenCalled();
    });
});
