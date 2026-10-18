/**
 * #3674 — which close the route sends a campaign to.
 *
 * The route named CONNECTED_APP and LEGACY_APP and sent everything else to the
 * MEMBER close, which has no zero-subject guard: so the AGENT value would have
 * reached the one close that can produce evidence over zero rows. The dispatch
 * now reads which table holds the scope's subjects, and an unknown scope goes
 * to the connected close, which refuses zero subjects.
 */
const mockGetAccessReview = jest.fn();
const mockCloseMember = jest.fn();
const mockCloseConnected = jest.fn();

jest.mock('@/app-layer/usecases/access-review', () => ({
    getAccessReview: (...a: unknown[]) => mockGetAccessReview(...a),
    closeAccessReview: (...a: unknown[]) => mockCloseMember(...a),
}));
jest.mock('@/app-layer/usecases/access-review-connected', () => ({
    closeConnectedAccessReview: (...a: unknown[]) => mockCloseConnected(...a),
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: unknown) => handler,
}));
jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));

import { POST } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/close/route';

const ctx = { tenantId: 't1', userId: 'u1' } as never;

function close() {
    return (POST as unknown as (r: Request, a: unknown, c: unknown) => Promise<Response>)(
        new Request('https://x/api/t/acme/access-reviews/ar-1/close', { method: 'POST' }),
        { params: { tenantSlug: 'acme', reviewId: 'ar-1' } },
        ctx,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCloseMember.mockResolvedValue({ via: 'member' });
    mockCloseConnected.mockResolvedValue({ via: 'connected' });
});

describe('the close route dispatches on the subject table, not on two scope names', () => {
    it.each(['CONNECTED_APP', 'LEGACY_APP', 'AGENT'])('%s goes to the connected close', async (scope) => {
        mockGetAccessReview.mockResolvedValue({ id: 'ar-1', scope });
        await close();
        expect(mockCloseConnected).toHaveBeenCalledWith(ctx, 'ar-1');
        expect(mockCloseMember).not.toHaveBeenCalled();
    });

    it.each(['ALL_USERS', 'ADMIN_ONLY', 'CUSTOM'])('%s goes to the member close', async (scope) => {
        mockGetAccessReview.mockResolvedValue({ id: 'ar-1', scope });
        await close();
        expect(mockCloseMember).toHaveBeenCalledWith(ctx, 'ar-1');
        expect(mockCloseConnected).not.toHaveBeenCalled();
    });

    it('a scope this build does not know never reaches the member close', async () => {
        mockGetAccessReview.mockResolvedValue({ id: 'ar-1', scope: 'SOMETHING_NEW' });
        await close();
        expect(mockCloseMember).not.toHaveBeenCalled();
        expect(mockCloseConnected).toHaveBeenCalled();
    });
});
