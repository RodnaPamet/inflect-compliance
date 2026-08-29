/**
 * A SUCCESSFUL cross-entity unlink must report success.
 *
 * Both routes below deleted the link and then returned **404** to the caller.
 * The DELETE handler invoked its usecase twice (#2165 landed a duplicated
 * line in each), and the repository layer uses `delete({ where: <unique> })`,
 * which throws Prisma `P2025` when the row is gone. So the first call
 * committed the delete plus its audit row, the second threw, and
 * `withApiErrorHandling` mapped P2025 to `404 Resource not found or already
 * deleted`. The unlink happened; the UI was told it had not.
 *
 * WHY THE ORIGINAL TESTS DID NOT CATCH IT. #2165 was an authorization change,
 * and its tests mocked the usecase and asserted `toHaveBeenCalled()` — which a
 * handler calling it twice satisfies perfectly. `toHaveBeenCalledTimes(1)`
 * would have failed, but the stronger statement is the one a user would make:
 * the response status. So the mock here REPRODUCES Prisma's behaviour —
 * resolves once, then rejects with a P2025-shaped error exactly as
 * `delete()` does on a missing row — and the assertion is on the status code.
 *
 * That is what makes this a regression test rather than a call-count ratchet:
 * it fails against the pre-fix handler for the same reason production did, and
 * it keeps failing for any future rewrite that lands a second delete, whatever
 * shape that rewrite takes.
 */

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));

const mockAppendAuditEntry = jest.fn();
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...a: unknown[]) => mockAppendAuditEntry(...a),
}));

const mockUnmapAssetFromControl = jest.fn();
const mockUnmapControlFromRisk = jest.fn();
jest.mock('@/app-layer/usecases/traceability', () => ({
    unmapAssetFromControl: (...a: unknown[]) => mockUnmapAssetFromControl(...a),
    unmapControlFromRisk: (...a: unknown[]) => mockUnmapControlFromRisk(...a),
}));

import type { NextRequest } from 'next/server';
import { makeRequestContext } from '../helpers/make-context';
import { DELETE as assetControlUnlink } from '@/app/api/t/[tenantSlug]/assets/[id]/controls/[controlId]/route';
import { DELETE as controlRiskUnlink } from '@/app/api/t/[tenantSlug]/controls/[controlId]/risks/[riskId]/route';

type Handler = (req: NextRequest, args: { params: unknown }) => Promise<Response>;
const asHandler = (h: unknown): Handler => h as Handler;

const req = (path: string): NextRequest =>
    ({
        method: 'DELETE',
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: {
            pathname: path,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
    }) as unknown as NextRequest;

/**
 * What `db.<model>.delete({ where: <unique> })` actually does: succeeds once,
 * then throws P2025 because the row is no longer there. `withApiErrorHandling`
 * detects Prisma errors structurally (a string `code` property), so the shape
 * matters more than the class.
 */
const deleteOnceThenP2025 = (mock: jest.Mock) => {
    let gone = false;
    mock.mockImplementation(async () => {
        if (gone) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
        gone = true;
        return { ok: true };
    });
};

const CASES = [
    {
        name: 'DELETE /assets/[id]/controls/[controlId]',
        handler: asHandler(assetControlUnlink),
        path: '/api/t/acme/assets/a-1/controls/c-1',
        params: { tenantSlug: 'acme', id: 'a-1', controlId: 'c-1' },
        usecase: mockUnmapAssetFromControl,
    },
    {
        name: 'DELETE /controls/[controlId]/risks/[riskId]',
        handler: asHandler(controlRiskUnlink),
        path: '/api/t/acme/controls/c-1/risks/r-1',
        params: { tenantSlug: 'acme', controlId: 'c-1', riskId: 'r-1' },
        usecase: mockUnmapControlFromRisk,
    },
];

beforeEach(() => {
    [mockGetTenantCtx, mockAppendAuditEntry, mockUnmapAssetFromControl, mockUnmapControlFromRisk].forEach(
        (m) => m.mockReset(),
    );
    mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
});

describe.each(CASES)('$name', (c) => {
    it('returns success when the link is removed — not 404', async () => {
        deleteOnceThenP2025(c.usecase);

        const res = await c.handler(req(c.path), { params: c.params });

        expect(res.status).toBeLessThan(400);
    });

    it('removes the link exactly once', async () => {
        // The precise statement of the defect. Kept alongside the status
        // assertion because it names the cause, while the status names the
        // symptom — a future regression could reproduce either one alone.
        c.usecase.mockResolvedValue({ ok: true });

        await c.handler(req(c.path), { params: c.params });

        expect(c.usecase).toHaveBeenCalledTimes(1);
    });

    it('still surfaces a genuine missing-link 404 from the first call', async () => {
        // The positive companion: the fix must not swallow P2025 generally.
        // Unlinking something that was never linked is still a 404.
        c.usecase.mockRejectedValue(
            Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }),
        );

        const res = await c.handler(req(c.path), { params: c.params });

        expect(res.status).toBe(404);
    });
});
