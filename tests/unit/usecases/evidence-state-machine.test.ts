/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for the evidence state machine + free-text name lookup
 * retirement (Audit S3, 2026-05-22). Each test mounts the
 * `reviewEvidence` usecase and asserts the new gates fire.
 */
const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(() => policyCalls.push('write')),
    assertCanAdmin: jest.fn(() => policyCalls.push('admin')),
    assertCanAudit: jest.fn(),
}));

const repoUpdate = jest.fn();
const repoAddReview = jest.fn();
const repoGetById = jest.fn();
// SoD source (ep1 review gate) — empty map ⇒ fall back to owner.
const repoGetLatestSubmitters = jest.fn(async () => new Map());
jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        getById: repoGetById,
        update: repoUpdate,
        addReview: repoAddReview,
        getLatestSubmitters: repoGetLatestSubmitters,
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: any) => s),
    sanitizeOptional: jest.fn((s: any) => s),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

const tenantDb: any = {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    // R5-P2 #7 — owner notification now resolves via an ACTIVE membership in
    // this tenant, not an unscoped user lookup.
    tenantMembership: { findFirst: jest.fn() },
    notification: { create: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { reviewEvidence } from '@/app-layer/usecases/evidence';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    repoGetById.mockReset();
    repoUpdate.mockReset();
    repoAddReview.mockReset();
    tenantDb.user.findUnique.mockReset();
    tenantDb.user.findFirst.mockReset();
    tenantDb.tenantMembership.findFirst.mockReset();
    tenantDb.notification.create.mockReset();
});

const ctx = makeRequestContext('ADMIN');

describe('reviewEvidence — Audit S3 state machine', () => {
    it('refuses DRAFT → APPROVED (must pass through SUBMITTED)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'DRAFT' });
        await expect(
            reviewEvidence(ctx, 'e1', { action: 'APPROVED' }),
        ).rejects.toThrow(/illegal evidence transition DRAFT → APPROVED/i);
        // No write should have happened on the illegal jump.
        expect(repoUpdate).not.toHaveBeenCalled();
        expect(repoAddReview).not.toHaveBeenCalled();
    });

    it('refuses DRAFT → REJECTED', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'DRAFT' });
        await expect(
            reviewEvidence(ctx, 'e1', { action: 'REJECTED', comment: 'test rejection reason' }),
        ).rejects.toThrow(/illegal/i);
    });

    it('refuses APPROVED → SUBMITTED (no re-review without first cycling back)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'APPROVED' });
        await expect(
            reviewEvidence(ctx, 'e1', { action: 'SUBMITTED' }),
        ).rejects.toThrow(/illegal/i);
    });

    it('refuses APPROVED → REJECTED (revoking an approval needs a different path)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'APPROVED' });
        await expect(
            reviewEvidence(ctx, 'e1', { action: 'REJECTED', comment: 'test rejection reason' }),
        ).rejects.toThrow(/illegal/i);
    });

    it('accepts DRAFT → SUBMITTED', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'DRAFT', ownerUserId: null });
        repoUpdate.mockResolvedValueOnce({});
        const out = await reviewEvidence(ctx, 'e1', { action: 'SUBMITTED' });
        expect(out).toEqual({ success: true, status: 'SUBMITTED' });
        expect(repoUpdate).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'e1',
            { status: 'SUBMITTED' },
        );
    });

    it('accepts SUBMITTED → APPROVED', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'SUBMITTED', ownerUserId: null, title: 't' });
        repoUpdate.mockResolvedValueOnce({});
        const out = await reviewEvidence(ctx, 'e1', { action: 'APPROVED' });
        expect(out.status).toBe('APPROVED');
    });

    it('accepts SUBMITTED → REJECTED', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'SUBMITTED', ownerUserId: null, title: 't' });
        repoUpdate.mockResolvedValueOnce({});
        const out = await reviewEvidence(ctx, 'e1', { action: 'REJECTED', comment: 'test rejection reason' });
        expect(out.status).toBe('REJECTED');
    });

    it('accepts REJECTED → SUBMITTED (author revises and resubmits)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'REJECTED', ownerUserId: null });
        repoUpdate.mockResolvedValueOnce({});
        const out = await reviewEvidence(ctx, 'e1', { action: 'SUBMITTED' });
        expect(out.status).toBe('SUBMITTED');
    });

    it('accepts NEEDS_REVIEW → SUBMITTED (owner re-submits stale evidence)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'NEEDS_REVIEW', ownerUserId: null });
        repoUpdate.mockResolvedValueOnce({});
        const out = await reviewEvidence(ctx, 'e1', { action: 'SUBMITTED' });
        expect(out.status).toBe('SUBMITTED');
    });

    it('refuses NEEDS_REVIEW → APPROVED (must go through SUBMITTED + re-review)', async () => {
        repoGetById.mockResolvedValueOnce({ id: 'e1', status: 'NEEDS_REVIEW' });
        await expect(
            reviewEvidence(ctx, 'e1', { action: 'APPROVED' }),
        ).rejects.toThrow(/illegal/i);
    });
});

describe('reviewEvidence — Audit S3 free-text fallback retired', () => {
    it('routes notification via ownerUserId only — DOES NOT fall back to name lookup', async () => {
        // SUBMITTED → APPROVED; evidence carries `owner` (legacy name)
        // but NO `ownerUserId`. The notification path should NOT
        // attempt `user.findFirst({ where: { name: ... } })`.
        repoGetById.mockResolvedValueOnce({
            id: 'e1',
            status: 'SUBMITTED',
            ownerUserId: null,
            owner: 'Alice Legacy',
            title: 'Quarterly access report',
        });
        repoUpdate.mockResolvedValueOnce({});
        await reviewEvidence(ctx, 'e1', { action: 'APPROVED' });
        // No findFirst — only findUnique gated on ownerUserId.
        expect(tenantDb.user.findFirst).not.toHaveBeenCalled();
        // ownerUserId was null, so findUnique not called either.
        expect(tenantDb.user.findUnique).not.toHaveBeenCalled();
        // And no notification fired.
        expect(tenantDb.notification.create).not.toHaveBeenCalled();
    });

    it('fires notification via an ACTIVE membership check when ownerUserId is set', async () => {
        repoGetById.mockResolvedValueOnce({
            id: 'e1',
            status: 'SUBMITTED',
            ownerUserId: 'u-1',
            owner: null,
            title: 'Quarterly access report',
        });
        repoUpdate.mockResolvedValueOnce({});
        tenantDb.tenantMembership.findFirst.mockResolvedValueOnce({ id: 'm-1' });
        await reviewEvidence(ctx, 'e1', { action: 'APPROVED' });
        expect(tenantDb.tenantMembership.findFirst).toHaveBeenCalled();
        // must be scoped to an ACTIVE membership in this tenant, not a bare user lookup
        expect(tenantDb.tenantMembership.findFirst.mock.calls[0][0].where).toMatchObject({
            userId: 'u-1', status: 'ACTIVE',
        });
        expect(tenantDb.user.findUnique).not.toHaveBeenCalled();
        expect(tenantDb.notification.create).toHaveBeenCalled();
    });
});
