/**
 * #5313 item 11 — an approval of the risk appetite is bound to the version the
 * approver was shown (owner decision 2026-11-15).
 *
 * `POST …/risk-appetite/approve` carries the configuration's id and its
 * `updatedAt` as the page loaded them. A body that names no version, or names
 * it in a shape that is not a timestamp, is a 400 and never reaches the
 * usecase: an approval that names no version would approve whatever is stored.
 * The error wrapper is the real one, so the status is the one a client gets.
 */
import { NextRequest } from 'next/server';

const mockApprove = jest.fn();
const mockApproval = jest.fn();
jest.mock('@/app-layer/usecases/risk-appetite', () => ({
    approveAppetiteConfig: (...a: unknown[]) => mockApprove(...a),
    getAppetiteApproval: (...a: unknown[]) => mockApproval(...a),
}));
const ctx = { tenantId: 't1', userId: 'owner-1' };
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: (req: unknown, args: unknown, c: unknown) => unknown) =>
        (req: unknown, args: unknown) => handler(req, args, ctx),
}));

import { POST } from '@/app/api/t/[tenantSlug]/risk-appetite/approve/route';

const VIEWED = { configId: 'cfg-1', viewedUpdatedAt: '2026-11-15T09:00:00.123Z' };

function call(body: unknown) {
    const req = new NextRequest('https://x.test/api/t/acme/risk-appetite/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return (POST as unknown as (r: NextRequest, a: unknown) => Promise<Response>)(
        req,
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockApprove.mockResolvedValue({ id: 'cfg-1', approvedByUserId: 'owner-1', approvedAt: new Date() });
    mockApproval.mockResolvedValue({ approvedAt: '2026-11-15T10:00:00.000Z', approverName: 'Olga Owner' });
});

describe('POST /risk-appetite/approve — the version marker', () => {
    it('passes the version the page loaded to the usecase', async () => {
        const res = await call(VIEWED);
        expect(res.status).toBe(200);
        expect(mockApprove).toHaveBeenCalledWith(ctx, VIEWED);
    });

    it.each([
        ['no body at all', ''],
        ['an empty object', {}],
        ['no marker', { configId: 'cfg-1' }],
        ['no config id', { viewedUpdatedAt: VIEWED.viewedUpdatedAt }],
        ['a marker that is not a timestamp', { ...VIEWED, viewedUpdatedAt: 'yesterday' }],
        ['a null marker', { ...VIEWED, viewedUpdatedAt: null }],
        ['an approver named by the client', { ...VIEWED, approvedByUserId: 'someone-else' }],
    ])('refuses %s with a 400 and approves nothing', async (_label, body) => {
        const res = await call(body);
        expect(res.status).toBe(400);
        expect(mockApprove).not.toHaveBeenCalled();
    });
});
