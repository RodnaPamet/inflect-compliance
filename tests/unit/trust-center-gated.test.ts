/**
 * PR-8 — gated trust-center document access: domain auto-approve, single-use +
 * expiring download tokens, and no-existence-disclosure. Pure prisma-mock.
 */
jest.mock('@/lib/prisma', () => ({
    prisma: {
        trustCenter: { findFirst: jest.fn() },
        trustCenterDocument: { findFirst: jest.fn(), findMany: jest.fn() },
        trustCenterAccessRequest: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    },
}));

import { requestTrustCenterAccess, consumeDownloadToken, listPublicTrustCenterDocuments } from '@/lib/trust-center/gated';
import { prisma } from '@/lib/prisma';
import * as tcAdmin from '@/app-layer/usecases/trust-center-documents';

const m = prisma as unknown as {
    trustCenter: { findFirst: jest.Mock };
    trustCenterDocument: { findFirst: jest.Mock; findMany: jest.Mock };
    trustCenterAccessRequest: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
};
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', accessDomainAllowlist: ['acme.com'], ndaRequired: false });
    m.trustCenterDocument.findFirst.mockResolvedValue({ id: 'doc-1' });
    m.trustCenterAccessRequest.create.mockResolvedValue({ id: 'req-1' });
});

describe('requestTrustCenterAccess', () => {
    it('H4 — an allowlisted domain does NOT auto-grant a token (never trust a visitor-supplied domain)', async () => {
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW);
        // Uniform REQUESTED, no inline token — even for an allowlisted domain.
        expect(r?.status).toBe('REQUESTED');
        expect(r?.downloadToken).toBeUndefined();
        const data = m.trustCenterAccessRequest.create.mock.calls[0][0].data;
        expect(data.status).toBe('REQUESTED');
        expect(data.downloadTokenHash).toBeNull();
        expect(data.grantedAt).toBeNull();
    });

    it('H4 — a non-allowlisted domain gets the SAME uniform REQUESTED response (no oracle)', async () => {
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@evil.com' }, NOW);
        expect(r?.status).toBe('REQUESTED');
        expect(r?.downloadToken).toBeUndefined();
        expect(m.trustCenterAccessRequest.create.mock.calls[0][0].data.downloadTokenHash).toBeNull();
    });

    it('H4 — NDA-required tenant still never auto-grants inline (admin approval only)', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', accessDomainAllowlist: ['acme.com'], ndaRequired: true });
        const withNda = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com', ndaAccepted: true }, NOW);
        expect(withNda?.status).toBe('REQUESTED');
        expect(withNda?.downloadToken).toBeUndefined();
    });

    it('returns null for a disabled/missing slug (no existence disclosure)', async () => {
        m.trustCenter.findFirst.mockResolvedValue(null);
        expect(await requestTrustCenterAccess('nope', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW)).toBeNull();
    });

    it('returns null for an unknown / ungated document', async () => {
        m.trustCenterDocument.findFirst.mockResolvedValue(null);
        expect(await requestTrustCenterAccess('acme', 'doc-x', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW)).toBeNull();
    });
});

describe('consumeDownloadToken', () => {
    it('serves once then is single-use', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'APPROVED', expiresAt: new Date('2026-12-01'), downloadedAt: null, document: { fileRecordId: 'file-1' } });
        m.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 1 });
        const r = await consumeDownloadToken('ictc_abc', NOW);
        // accessRequestId is carried out so the distribution ledger can name WHO
        // received the bytes on the only unauthenticated egress. toEqual is exact,
        // so this assertion is what will notice if that stops being returned.
        expect(r).toEqual({ fileRecordId: 'file-1', accessRequestId: 'req-1' });
        // the consume was atomic on downloadedAt: null
        expect(m.trustCenterAccessRequest.updateMany.mock.calls[0][0].where.downloadedAt).toBeNull();
    });

    it('rejects an already-downloaded token', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'APPROVED', expiresAt: null, downloadedAt: NOW, document: { fileRecordId: 'file-1' } });
        expect(await consumeDownloadToken('ictc_abc', NOW)).toBeNull();
    });

    it('rejects an expired token', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'APPROVED', expiresAt: new Date('2020-01-01'), downloadedAt: null, document: { fileRecordId: 'file-1' } });
        expect(await consumeDownloadToken('ictc_abc', NOW)).toBeNull();
    });

    it('rejects a non-approved or wrong-format token', async () => {
        expect(await consumeDownloadToken('bad', NOW)).toBeNull();
        m.trustCenterAccessRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'REQUESTED', expiresAt: null, downloadedAt: null, document: { fileRecordId: 'file-1' } });
        expect(await consumeDownloadToken('ictc_abc', NOW)).toBeNull();
    });
});

describe('listPublicTrustCenterDocuments', () => {
    it('returns labels only (never fileRecordId) for an enabled trust center', async () => {
        m.trustCenterDocument.findMany.mockResolvedValue([{ id: 'd1', label: 'SOC 2', gated: true }]);
        const docs = await listPublicTrustCenterDocuments('acme');
        expect(docs).toEqual([{ id: 'd1', label: 'SOC 2', gated: true }]);
        // the select must not request fileRecordId
        expect(m.trustCenterDocument.findMany.mock.calls[0][0].select.fileRecordId).toBeUndefined();
    });
});

describe('trust-center-documents usecase exports', () => {
    it('exposes admin document/request functions', () => {
        expect(typeof tcAdmin.addTrustCenterDocument).toBe('function');
        expect(typeof tcAdmin.approveTrustCenterAccessRequest).toBe('function');
    });
});
