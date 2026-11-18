/**
 * #5764 item 6 — `GET /api/t/:slug/training` passes the paging and filter
 * parameters to the read, and answers in two shapes: the paged
 * `{ rows, nextCursor, total }` the page's "Load more" reads when `cursor` or
 * `limit` is given, and otherwise the older `{ assignments, truncated }` keys,
 * kept for readers written before paging, plus `nextCursor` and `total`.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const listMock = jest.fn();
jest.mock('@/app-layer/usecases/training', () => ({
    ...jest.requireActual('@/app-layer/usecases/training'),
    listTrainingAssignments: (...args: unknown[]) => listMock(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/training/route';
import { makeRequestContext } from '../helpers/make-context';

const page = { rows: [{ id: 'a-1' }], nextCursor: 'next-1', total: 734, filters: { q: '', statuses: [] } };

async function call(query: string) {
    const req = new NextRequest(`http://localhost/api/t/acme/training${query}`, { method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
    return { status: res.status, body: await res.json() };
}

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('OWNER'));
    listMock.mockReset();
    listMock.mockResolvedValue(page);
});

it('hands the cursor, limit, search and every status to the read, and answers the paged shape', async () => {
    const res = await call('?cursor=c-1&limit=25&q=ada&status=ASSIGNED,OVERDUE&status=COMPLETED');
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0][1]).toEqual({
        cursor: 'c-1',
        limit: 25,
        q: 'ada',
        status: ['ASSIGNED,OVERDUE', 'COMPLETED'],
    });
    expect(res.body).toEqual({ rows: page.rows, nextCursor: 'next-1', total: 734 });
});

it('ignores a malformed limit rather than refusing', async () => {
    const res = await call('?limit=lots');
    expect(res.status).toBe(200);
    expect(listMock.mock.calls[0][1]).toMatchObject({ limit: undefined, cursor: null });
});

it('without cursor or limit keeps the older keys, now for the first page', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignments: page.rows, truncated: true, nextCursor: 'next-1', total: 734 });
});

it('the last page reads as not truncated', async () => {
    listMock.mockResolvedValue({ ...page, nextCursor: null, total: 1 });
    const res = await call('?q=ada');
    expect(res.body).toEqual({ assignments: page.rows, truncated: false, nextCursor: null, total: 1 });
});
