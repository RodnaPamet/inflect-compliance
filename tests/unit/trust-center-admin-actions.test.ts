/**
 * #4824 — what an administrator can do with the trust center's documents on
 * request, and what a save refuses rather than drops:
 *   - a waiting request can be denied; an approved one gets a new link, which
 *     replaces the old one; a denied one is final;
 *   - a document can be removed, with its requests;
 *   - a half-filled row or a non-web address is refused by name.
 */
const db = {
    trustCenterAccessRequest: { findFirst: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    trustCenterDocument: { findFirst: jest.fn(), deleteMany: jest.fn() },
};
const reachedDb = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => {
        reachedDb();
        return fn(db);
    },
}));
const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import {
    approveTrustCenterAccessRequest,
    denyTrustCenterAccessRequest,
    removeTrustCenterDocument,
} from '@/app-layer/usecases/trust-center-documents';
import { upsertTrustCenter } from '@/app-layer/usecases/trust-center';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const NOW = new Date('2026-10-31T00:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    db.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe('deny', () => {
    it('denies a waiting request, only while it is still waiting, and audits it', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'REQUESTED' });
        await expect(denyTrustCenterAccessRequest(ctx, 'r-1')).resolves.toEqual({ requestId: 'r-1' });
        expect(db.trustCenterAccessRequest.updateMany).toHaveBeenCalledWith({
            where: { id: 'r-1', tenantId: 'tenant-1', status: 'REQUESTED' },
            data: { status: 'DENIED' },
        });
        expect(logEvent.mock.calls[0][2]).toMatchObject({ entityId: 'r-1', detailsJson: { operation: 'denied' } });
    });

    it.each(['APPROVED', 'DENIED'])('refuses a request that is %s', async (status) => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status });
        await expect(denyTrustCenterAccessRequest(ctx, 'r-1')).rejects.toThrow(/still waiting/);
        expect(db.trustCenterAccessRequest.updateMany).not.toHaveBeenCalled();
    });

    it('says so when the request changed underneath it', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'REQUESTED' });
        db.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(denyTrustCenterAccessRequest(ctx, 'r-1')).rejects.toThrow(/changed while you were looking/);
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('refuses a reader before any read', async () => {
        await expect(denyTrustCenterAccessRequest(makeRequestContext('READER'), 'r-1')).rejects.toThrow();
        expect(reachedDb).not.toHaveBeenCalled();
    });
});

describe('approve and issue a new link', () => {
    it('approves a waiting request, claiming it from that status', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'REQUESTED' });
        const { downloadToken } = await approveTrustCenterAccessRequest(ctx, 'r-1', NOW);
        expect(downloadToken).toMatch(/^ictc_[0-9a-f]{48}$/);
        expect(db.trustCenterAccessRequest.updateMany.mock.calls[0][0].where).toEqual({ id: 'r-1', tenantId: 'tenant-1', status: 'REQUESTED' });
        expect(logEvent.mock.calls[0][2].detailsJson.operation).toBe('approved');
    });

    it('gives an approved request a new link that replaces the old one', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'APPROVED' });
        await approveTrustCenterAccessRequest(ctx, 'r-1', NOW);
        const { where, data } = db.trustCenterAccessRequest.updateMany.mock.calls[0][0];
        expect(where.status).toBe('APPROVED');
        // A fresh hash, a fresh 7-day window, and the link usable once more.
        expect(data.downloadTokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(data.expiresAt).toEqual(new Date('2026-11-07T00:00:00.000Z'));
        expect(data.downloadedAt).toBeNull();
        expect(logEvent.mock.calls[0][2].detailsJson.operation).toBe('link_reissued');
    });

    it('never approves a denied request', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'DENIED' });
        await expect(approveTrustCenterAccessRequest(ctx, 'r-1', NOW)).rejects.toThrow(/was denied/);
        expect(db.trustCenterAccessRequest.updateMany).not.toHaveBeenCalled();
    });

    it('issues nothing when the request was denied in between', async () => {
        db.trustCenterAccessRequest.findFirst.mockResolvedValue({ id: 'r-1', status: 'REQUESTED' });
        db.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(approveTrustCenterAccessRequest(ctx, 'r-1', NOW)).rejects.toThrow(/changed while you were looking/);
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('remove a document', () => {
    it('deletes the document in this workspace and audits what went with it', async () => {
        db.trustCenterDocument.findFirst.mockResolvedValue({ id: 'd-1', label: 'SOC 2', gated: true });
        db.trustCenterAccessRequest.count.mockResolvedValue(3);
        await expect(removeTrustCenterDocument(ctx, 'd-1')).resolves.toEqual({ documentId: 'd-1' });
        expect(db.trustCenterDocument.deleteMany).toHaveBeenCalledWith({ where: { id: 'd-1', tenantId: 'tenant-1' } });
        const entry = logEvent.mock.calls[0][2];
        expect(entry).toMatchObject({ action: 'DELETE', entityType: 'TrustCenterDocument', entityId: 'd-1' });
        expect(entry.detailsJson.summary).toContain('3 access requests removed with it');
    });

    it('refuses a document it cannot find, and deletes nothing', async () => {
        db.trustCenterDocument.findFirst.mockResolvedValue(null);
        await expect(removeTrustCenterDocument(ctx, 'd-x')).rejects.toThrow(/not found/);
        expect(db.trustCenterDocument.deleteMany).not.toHaveBeenCalled();
    });
});

describe('a save refuses what it used to drop', () => {
    const base = { displayName: 'Acme' };

    it('refuses a document whose address is not a web address, by name', async () => {
        await expect(
            upsertTrustCenter(ctx, { ...base, publishedDocuments: [{ label: 'Whitepaper', url: 'javascript:alert(1)' }] }),
        ).rejects.toThrow('The address of "Whitepaper" must be a full web address');
        expect(reachedDb).not.toHaveBeenCalled();
    });

    it('refuses a half-filled document or framework row', async () => {
        await expect(upsertTrustCenter(ctx, { ...base, publishedDocuments: [{ label: 'Whitepaper', url: '' }] })).rejects.toThrow(
            /needs both a name and an address: "Whitepaper"/,
        );
        await expect(upsertTrustCenter(ctx, { ...base, publishedFrameworks: [{ key: 'SOC 2', statusLabel: '' }] })).rejects.toThrow(
            /needs both a name and a status: "SOC 2"/,
        );
        expect(reachedDb).not.toHaveBeenCalled();
    });

    it('says what is missing when there is no display name', async () => {
        await expect(upsertTrustCenter(ctx, { displayName: '  ' })).rejects.toThrow('Give the trust center a display name.');
    });
});
