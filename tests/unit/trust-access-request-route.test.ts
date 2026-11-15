/**
 * The public access-request route's HTTP contract, with the NDA refusal of
 * #5613.
 *
 * This is the endpoint a visitor POSTs to, and the NDA was enforced only by the
 * browser form that normally calls it: the usecase read `ndaRequired` and never
 * used it, so a request sent without the form recorded a row with
 * `ndaSignedAt: null` against a center that requires an NDA, and the admin
 * queue could then approve it into a download token.
 */
import { NextRequest } from 'next/server';

const requestTrustCenterAccessMock = jest.fn();

jest.mock('@/lib/trust-center/gated', () => ({
    __esModule: true,
    requestTrustCenterAccess: (...a: unknown[]) => requestTrustCenterAccessMock(...a),
}));

import { POST } from '@/app/api/trust/[slug]/access-request/route';

const ctx = { params: Promise.resolve({ slug: 'acme' }) };
const body = (over: Record<string, unknown> = {}) => ({
    documentId: 'doc-1',
    requesterName: 'A Visitor',
    requesterEmail: 'v@acme.com',
    ...over,
});
const post = (b: Record<string, unknown>) =>
    new NextRequest('https://example.test/api/trust/acme/access-request', {
        method: 'POST',
        body: JSON.stringify(b),
        headers: { 'content-type': 'application/json' },
    });

beforeEach(() => {
    jest.clearAllMocks();
    requestTrustCenterAccessMock.mockResolvedValue({ status: 'REQUESTED' });
});

describe('POST /api/trust/[slug]/access-request', () => {
    it('records a request and answers 201', async () => {
        const res = await POST(post(body()), ctx);
        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toEqual({ status: 'REQUESTED' });
    });

    it('answers 400 nda_required when the center requires an NDA this request did not accept', async () => {
        requestTrustCenterAccessMock.mockResolvedValue({ status: 'NDA_REQUIRED' });

        const res = await POST(post(body()), ctx);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'nda_required' });
    });

    it('does not report a refusal as a filed request', async () => {
        // The failure to avoid is answering 201 "request received" for
        // something that was refused and recorded nothing — the visitor would
        // wait for an approval that can never come.
        requestTrustCenterAccessMock.mockResolvedValue({ status: 'NDA_REQUIRED' });
        const res = await POST(post(body()), ctx);
        expect(res.status).not.toBe(201);
        expect(await res.json()).not.toMatchObject({ status: 'REQUESTED' });
    });

    it('still answers 404 for a missing or disabled slug, disclosing nothing', async () => {
        requestTrustCenterAccessMock.mockResolvedValue(null);
        const res = await POST(post(body()), ctx);
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    });

    it('forwards ndaAccepted so the usecase can decide, rather than deciding here', async () => {
        await POST(post(body({ ndaAccepted: true })), ctx);
        // The rule lives in the usecase, which is also what the admin-approval
        // backstop reads; the route must not second-guess it.
        expect(requestTrustCenterAccessMock).toHaveBeenCalledWith(
            'acme',
            'doc-1',
            expect.objectContaining({ ndaAccepted: true }),
        );
    });
});
