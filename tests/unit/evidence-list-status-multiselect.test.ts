/**
 * Evidence list — the status facet is multi-select, so the route must accept
 * the comma-joined form it produces.
 *
 * `filter-defs.ts` declares `status` with `multiple: true`, and the filter
 * layer comma-joins selections into `?status=DRAFT,SUBMITTED`. The route's
 * query schema narrowed it with a single-member `z.enum`, so any two-value
 * selection failed validation with a 400 and the table rendered EMPTY — which
 * reads to a user as "no evidence matches these filters", not as an error.
 *
 * `EvidenceRepository._buildWhere` has always run `parseEnumListFilter` over
 * the value, which validates members and returns `{ in: [...] }` for the
 * multi-value form. That branch was simply unreachable behind the route's
 * enum; the repository's own comment says so.
 *
 * These drive the real route with the usecase mocked, so what is under test is
 * the QUERY CONTRACT: what the schema lets through and what it hands on.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const listEvidenceMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/evidence', () => ({
    __esModule: true,
    listEvidence: (...a: unknown[]) => listEvidenceMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/evidence/route';

const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
const req = (qs: string) =>
    new NextRequest(`https://x.test/api/t/acme/evidence${qs}`);

/** The filters object the route handed to the usecase. */
function passedFilters(): Record<string, unknown> {
    const call = listEvidenceMock.mock.calls[0];
    if (!call) throw new Error('listEvidence was never called');
    return (call[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({
        tenantId: 't1',
        userId: 'u1',
        role: 'ADMIN',
        requestId: 'r1',
        permissions: {},
        appPermissions: { evidence: { read: true, upload: true } },
    });
    listEvidenceMock.mockResolvedValue({
        items: [],
        pageInfo: { nextCursor: null, hasNextPage: false },
    });
});

describe('evidence list — status query contract', () => {
    it('accepts a MULTI-value status and passes it through intact', async () => {
        const res = await GET(req('?status=DRAFT,SUBMITTED'), params);

        // The bug: this used to be 400 and the list rendered empty.
        expect(res.status).toBe(200);
        // Passed through verbatim — splitting + enum validation is the
        // repository's job via parseEnumListFilter, and doing it twice in two
        // places is how the two drifted apart in the first place.
        expect(passedFilters().status).toBe('DRAFT,SUBMITTED');
    });

    it('still accepts a single status', async () => {
        const res = await GET(req('?status=APPROVED'), params);

        expect(res.status).toBe(200);
        expect(passedFilters().status).toBe('APPROVED');
    });

    it('accepts every member the UI facet can produce', async () => {
        // filter-defs.ts offers exactly these five. A facet option the route
        // rejects is a control that is visibly broken for the user.
        const all = 'DRAFT,SUBMITTED,APPROVED,REJECTED,NEEDS_REVIEW';
        const res = await GET(req(`?status=${all}`), params);

        expect(res.status).toBe(200);
        expect(passedFilters().status).toBe(all);
    });

    it('leaves status undefined when the facet is cleared', async () => {
        const res = await GET(req(''), params);

        expect(res.status).toBe(200);
        expect(passedFilters().status).toBeUndefined();
    });
});
