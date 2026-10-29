/**
 * The Findings register's status facet (#4461), server side.
 *
 * The register had no filter, so the dashboard's "Open Findings" arrow landed
 * on a list that also showed closed findings, and the truncation banner told
 * the reader to "refine your filters" on a page that had none. The facet is
 * applied by the API — not over the loaded rows — so narrowing also reaches
 * findings past the 5,000-row cap.
 *
 *   - the repository turns `?status=` into a validated Prisma predicate;
 *   - an unknown status is a 400, never a silent zero-row match;
 *   - the GET route forwards the query-string value;
 *   - the dashboard's arrow names exactly the statuses its KPI counts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const listFindingsMock = jest.fn(async (_ctx: unknown, _opts?: unknown) => [] as unknown[]);
jest.mock('@/app-layer/usecases/finding', () => ({
    ...jest.requireActual('@/app-layer/usecases/finding'),
    listFindings: (ctx: unknown, opts?: unknown) => listFindingsMock(ctx, opts),
}));

jest.mock('@/lib/observability/list-page-metrics', () => ({
    recordListPageRowCount: jest.fn(),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { FindingRepository } from '@/app-layer/repositories/FindingRepository';
import { GET } from '@/app/api/t/[tenantSlug]/findings/route';
import { FINDING_STATUSES } from '@/app/t/[tenantSlug]/(app)/findings/filter-defs';
import { makeRequestContext } from '../helpers/make-context';

function fakeDb() {
    const findMany = jest.fn(async (_args: unknown) => [] as unknown[]);
    return { db: { finding: { findMany } } as never, findMany };
}

const whereOf = (findMany: jest.Mock) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

describe('FindingRepository.list — the status facet', () => {
    const ctx = makeRequestContext('READER');

    it('one status is an equality', async () => {
        const { db, findMany } = fakeDb();
        await FindingRepository.list(db, ctx, { status: 'OPEN' });
        expect(whereOf(findMany)).toEqual({ tenantId: ctx.tenantId, status: 'OPEN' });
    });

    it('several are an `in`, as the multi-select sends them', async () => {
        const { db, findMany } = fakeDb();
        await FindingRepository.list(db, ctx, { status: 'OPEN,IN_PROGRESS' });
        expect(whereOf(findMany).status).toEqual({ in: ['OPEN', 'IN_PROGRESS'] });
    });

    it('no status filters nothing', async () => {
        const { db, findMany } = fakeDb();
        await FindingRepository.list(db, ctx, {});
        expect(whereOf(findMany).status).toBeUndefined();
        expect(whereOf(findMany).tenantId).toBe(ctx.tenantId);
    });

    it('a value that is not a finding status is refused, not matched against nothing', async () => {
        const { db, findMany } = fakeDb();
        await expect(FindingRepository.list(db, ctx, { status: 'ACTIVE' })).rejects.toMatchObject({
            status: 400,
        });
        expect(findMany).not.toHaveBeenCalled();
    });
});

describe('GET /api/t/:slug/findings — forwards the facet', () => {
    const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    beforeEach(() => {
        listFindingsMock.mockClear();
        getTenantCtxMock.mockResolvedValue(makeRequestContext('READER'));
    });

    it('passes ?status= through to listFindings', async () => {
        const req = new NextRequest('http://localhost/api/t/acme/findings?status=OPEN%2CIN_PROGRESS', { method: 'GET' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req, routeArgs as any);
        expect(res.status).toBe(200);
        expect(listFindingsMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'OPEN,IN_PROGRESS' }),
        );
    });

    it('passes no status when the query has none', async () => {
        const req = new NextRequest('http://localhost/api/t/acme/findings', { method: 'GET' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await GET(req, routeArgs as any);
        expect((listFindingsMock.mock.calls[0][1] as { status?: string }).status).toBeUndefined();
    });
});

describe("the dashboard's Open Findings arrow", () => {
    const ROOT = path.resolve(__dirname, '../..');
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it('lands on exactly the statuses the KPI counts', () => {
        // The KPI counts `status: { not: 'CLOSED' }`.
        const repo = read('src/app-layer/repositories/DashboardRepository.ts');
        const counted = repo.match(/db\.finding\.count\(\{ where: \{ tenantId, status: \{ not: '([A-Z_]+)' \} \} \}\)/);
        expect(counted?.[1]).toBe('CLOSED');

        const client = read('src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');
        const drill = client.match(/drillHref=\{href\('\/findings\?status=([A-Z_,]+)'\)\}/);
        expect(drill?.[1].split(',')).toEqual(FINDING_STATUSES.filter((s) => s !== counted?.[1]));
    });
});
