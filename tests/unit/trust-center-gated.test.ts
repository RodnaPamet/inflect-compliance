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

import { requestTrustCenterAccess, resolveDownloadToken, spendDownloadToken, listPublicTrustCenterDocuments, getPublicGatedDocuments } from '@/lib/trust-center/gated';
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

    // ── #5613: the NDA is a server rule, not a browser one ──────────────
    it('REFUSES a request that did not accept a required NDA, and records nothing', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', ndaRequired: true });
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW);
        expect(r).toEqual({ status: 'NDA_REQUIRED' });
        // The whole defect: a row used to be written with ndaSignedAt null.
        expect(m.trustCenterAccessRequest.create).not.toHaveBeenCalled();
    });

    it('refuses an explicit ndaAccepted: false the same way', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', ndaRequired: true });
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com', ndaAccepted: false }, NOW);
        expect(r).toEqual({ status: 'NDA_REQUIRED' });
        expect(m.trustCenterAccessRequest.create).not.toHaveBeenCalled();
    });

    it('decides the NDA refusal BEFORE looking a document up, so it is no existence oracle', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', ndaRequired: true });
        await requestTrustCenterAccess('acme', 'whatever-id', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW);
        // A real and a bogus documentId are indistinguishable to a caller who
        // omits the NDA, because no document is read at all.
        expect(m.trustCenterDocument.findFirst).not.toHaveBeenCalled();
    });

    it('records ndaSignedAt when a required NDA IS accepted', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', tenantId: 'T1', ndaRequired: true });
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com', ndaAccepted: true }, NOW);
        expect(r?.status).toBe('REQUESTED');
        expect(m.trustCenterAccessRequest.create.mock.calls[0][0].data.ndaSignedAt).toEqual(NOW);
    });

    it('a center that requires no NDA still records a request that did not mention one', async () => {
        const r = await requestTrustCenterAccess('acme', 'doc-1', { requesterName: 'X', requesterEmail: 'x@acme.com' }, NOW);
        expect(r?.status).toBe('REQUESTED');
        expect(m.trustCenterAccessRequest.create.mock.calls[0][0].data.ndaSignedAt).toBeNull();
    });
});

describe('resolveDownloadToken (#5614 — resolving never spends)', () => {
    const approved = (over: Record<string, unknown> = {}) => ({
        id: 'req-1', status: 'APPROVED', expiresAt: new Date('2026-12-01'), downloadedAt: null,
        document: { fileRecordId: 'file-1', trustCenter: { enabled: true } }, ...over,
    });

    it('returns the file and the request it came from, and spends NOTHING', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue(approved());
        const r = await resolveDownloadToken('ictc_abc', NOW);
        // accessRequestId is carried out so the distribution ledger can name WHO
        // received the bytes on the only unauthenticated egress. toEqual is exact,
        // so this assertion is what will notice if that stops being returned.
        expect(r).toEqual({ fileRecordId: 'file-1', accessRequestId: 'req-1' });
        // THE point of the split: the token is still unspent after a successful
        // resolve, so the caller's own gates can refuse without costing the
        // requester their one use.
        expect(m.trustCenterAccessRequest.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an already-downloaded token', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue(approved({ expiresAt: null, downloadedAt: NOW }));
        expect(await resolveDownloadToken('ictc_abc', NOW)).toBeNull();
    });

    it('rejects an expired token', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue(approved({ expiresAt: new Date('2020-01-01') }));
        expect(await resolveDownloadToken('ictc_abc', NOW)).toBeNull();
    });

    it('serves nothing once the trust center is unpublished, and does not spend the token', async () => {
        m.trustCenterAccessRequest.findUnique.mockResolvedValue(approved({ document: { fileRecordId: 'file-1', trustCenter: { enabled: false } } }));
        expect(await resolveDownloadToken('ictc_abc', NOW)).toBeNull();
        expect(m.trustCenterAccessRequest.updateMany).not.toHaveBeenCalled();
        expect(m.trustCenterAccessRequest.findUnique.mock.calls[0][0].select.document.select.trustCenter).toEqual({ select: { enabled: true } });
    });

    it('rejects a non-approved or wrong-format token', async () => {
        expect(await resolveDownloadToken('bad', NOW)).toBeNull();
        m.trustCenterAccessRequest.findUnique.mockResolvedValue(approved({ status: 'REQUESTED', expiresAt: null }));
        expect(await resolveDownloadToken('ictc_abc', NOW)).toBeNull();
    });

    it('never spends on ANY refusal path', async () => {
        // One assertion over every way resolve can say no, so a future early
        // return that spends first fails here rather than in a route test.
        const refusals = [
            approved({ status: 'REQUESTED' }),
            approved({ downloadedAt: NOW }),
            approved({ expiresAt: new Date('2020-01-01') }),
            approved({ document: { fileRecordId: 'f', trustCenter: { enabled: false } } }),
            null,
        ];
        for (const r of refusals) {
            m.trustCenterAccessRequest.findUnique.mockResolvedValue(r);
            expect(await resolveDownloadToken('ictc_abc', NOW)).toBeNull();
        }
        expect(m.trustCenterAccessRequest.updateMany).not.toHaveBeenCalled();
    });
});

describe('spendDownloadToken (#5614)', () => {
    it('claims the single use atomically on downloadedAt: null', async () => {
        m.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 1 });
        await expect(spendDownloadToken('req-1', NOW)).resolves.toBe(true);
        const call = m.trustCenterAccessRequest.updateMany.mock.calls[0][0];
        expect(call.where).toEqual({ id: 'req-1', downloadedAt: null });
        expect(call.data).toEqual({ downloadedAt: NOW });
    });

    it('returns false when a concurrent request already took the use', async () => {
        m.trustCenterAccessRequest.updateMany.mockResolvedValue({ count: 0 });
        await expect(spendDownloadToken('req-1', NOW)).resolves.toBe(false);
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

describe('getPublicGatedDocuments (#4649)', () => {
    it('lists only gated documents of an ENABLED trust center, by id and label, with its NDA requirement', async () => {
        m.trustCenter.findFirst.mockResolvedValue({ id: 'tc-1', ndaRequired: true });
        m.trustCenterDocument.findMany.mockResolvedValue([{ id: 'd1', label: 'SOC 2' }]);
        await expect(getPublicGatedDocuments('acme')).resolves.toEqual({ ndaRequired: true, documents: [{ id: 'd1', label: 'SOC 2' }] });
        expect(m.trustCenter.findFirst.mock.calls[0][0].where).toEqual({ slug: 'acme', enabled: true });
        const query = m.trustCenterDocument.findMany.mock.calls[0][0];
        expect(query.where).toEqual({ trustCenterId: 'tc-1', gated: true });
        expect(query.select).toEqual({ id: true, label: true });
    });

    it('returns null for a missing or disabled slug, and reads no documents', async () => {
        m.trustCenter.findFirst.mockResolvedValue(null);
        await expect(getPublicGatedDocuments('nope')).resolves.toBeNull();
        expect(m.trustCenterDocument.findMany).not.toHaveBeenCalled();
    });
});

describe('trust-center-documents usecase exports', () => {
    it('exposes admin document/request functions', () => {
        expect(typeof tcAdmin.addTrustCenterDocument).toBe('function');
        expect(typeof tcAdmin.approveTrustCenterAccessRequest).toBe('function');
    });
});
