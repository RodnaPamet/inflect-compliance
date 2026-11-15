/**
 * #5313, item 10 — the latest match run on a connection, however many other
 * runs came after it. Real route, real usecase, real database.
 *
 * The reconciliation queue and the legacy runs card used to pick "the latest
 * match run" out of the 50 newest executions on the connection, every kind
 * together. A connection whose last match run had been followed by 50 pulls or
 * syncs read as never matched, and its queue as having nothing to review.
 * `executions/latest` asks for the kind instead.
 *
 * Only `getTenantCtx` is mocked, because it is the one thing in the path that
 * needs a browser session; `requirePermission`, the usecase and RLS are real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { GET } from '@/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/executions/latest/route';
import {
    getLatestExecutionForConnection,
    listExecutionsForConnection,
} from '@/app-layer/usecases/integrations';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `lmr-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ta-${SUITE}`;
const TENANT_B = `tb-${SUITE}`;
const RECONCILE = 'legacy-mcp.reconcile';

let connA = '';
let connB = '';

const ctxFor = (tenantId: string) =>
    makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: `u-${SUITE}` });

const get = (tenantSlug: string, connectionId: string, query: string) =>
    GET(
        new NextRequest(
            `http://localhost/api/t/${tenantSlug}/admin/integrations/${connectionId}/executions/latest?${query}`,
        ),
        { params: Promise.resolve({ tenantSlug, connectionId }) },
    );

const at = (minutesAfterEpoch: number) => new Date(Date.UTC(2026, 0, 1) + minutesAfterEpoch * 60_000);

async function execution(tenantId: string, connectionId: string, automationKey: string, status: 'PASSED' | 'PARTIAL' | 'ERROR', when: Date) {
    return prisma.integrationExecution.create({
        data: {
            tenantId, connectionId, provider: 'legacy-mcp', automationKey, status,
            triggeredBy: 'manual', executedAt: when, completedAt: when,
            errorMessage: status === 'PARTIAL' ? 'NO_FRESH_ROSTER' : null,
        },
        select: { id: true },
    });
}

describeFn('the latest match run on a connection (#5313 item 10)', () => {
    let matchRunId = '';

    beforeAll(async () => {
        for (const id of [TENANT_A, TENANT_B]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        connA = (await prisma.integrationConnection.create({
            data: { tenantId: TENANT_A, provider: 'legacy-mcp', name: `legacy-a-${SUITE}`, configJson: {} },
        })).id;
        connB = (await prisma.integrationConnection.create({
            data: { tenantId: TENANT_B, provider: 'legacy-mcp', name: `legacy-b-${SUITE}`, configJson: {} },
        })).id;

        // One finished match run, then 60 newer runs of other kinds: more than
        // the 50 rows the connection's history returns.
        matchRunId = (await execution(TENANT_A, connA, RECONCILE, 'PASSED', at(0))).id;
        await prisma.integrationExecution.createMany({
            data: Array.from({ length: 60 }, (_, i) => ({
                tenantId: TENANT_A,
                connectionId: connA,
                provider: 'legacy-mcp',
                automationKey: i % 2 === 0 ? 'legacy-mcp.pull' : 'legacy-mcp.sync',
                status: 'PASSED' as const,
                triggeredBy: 'scheduled',
                executedAt: at(10 + i),
                completedAt: at(10 + i),
            })),
        });

        // Another tenant's match run, NEWER than tenant A's, on its own connection.
        await execution(TENANT_B, connB, RECONCILE, 'PASSED', at(1000));
    });

    beforeEach(() => {
        getTenantCtxMock.mockReset();
    });

    afterAll(async () => {
        await prisma.integrationExecution.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await deleteAuditRowsForTenants(prisma, TENANT_A);
        await deleteAuditRowsForTenants(prisma, TENANT_B);
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    });

    it('the defect: the 50-row history no longer holds the match run', async () => {
        const history = await listExecutionsForConnection(ctxFor(TENANT_A), connA);
        expect(history).toHaveLength(50);
        expect(history.some((e) => e.automationKey === RECONCILE)).toBe(false);
    });

    it('the read returns the match run, behind 60 newer runs of other kinds', async () => {
        const latest = await getLatestExecutionForConnection(ctxFor(TENANT_A), connA, RECONCILE);
        expect(latest).toMatchObject({ id: matchRunId, automationKey: RECONCILE, status: 'PASSED' });
    });

    it('the route reports it, as the queue asks for it (PASSED only), with the connection named', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));

        const res = await get(TENANT_A, connA, `automationKey=${RECONCILE}&status=PASSED`);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.execution).toMatchObject({ id: matchRunId, automationKey: RECONCILE, status: 'PASSED' });
        expect(body.connection).toMatchObject({ id: connA, name: `legacy-a-${SUITE}` });
    });

    it('a newer refused match run is the latest of the kind, and PASSED still finds the finished one', async () => {
        const refused = await execution(TENANT_A, connA, RECONCILE, 'PARTIAL', at(500));
        try {
            getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
            const any = await (await get(TENANT_A, connA, `automationKey=${RECONCILE}`)).json();
            expect(any.execution).toMatchObject({ id: refused.id, status: 'PARTIAL', errorMessage: 'NO_FRESH_ROSTER' });

            getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
            const passed = await (await get(TENANT_A, connA, `automationKey=${RECONCILE}&status=PASSED`)).json();
            expect(passed.execution.id).toBe(matchRunId);
        } finally {
            await prisma.integrationExecution.delete({ where: { id: refused.id } });
        }
    });

    it('a kind that never ran is null, not a run of another kind', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
        const res = await get(TENANT_A, connA, 'automationKey=legacy-mcp.never');
        expect(res.status).toBe(200);
        expect((await res.json()).execution).toBeNull();
    });

    it('another tenant\'s match run is never returned', async () => {
        // Tenant A asking about tenant B's connection: the usecase finds
        // nothing, and the route answers 404 for a connection A does not hold.
        expect(await getLatestExecutionForConnection(ctxFor(TENANT_A), connB, RECONCILE)).toBeNull();

        getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
        const res = await get(TENANT_A, connB, `automationKey=${RECONCILE}`);
        expect(res.status).toBe(404);
        expect(await res.json()).not.toHaveProperty('execution');

        // And tenant A's own answer is its own run, not B's newer one.
        const own = await getLatestExecutionForConnection(ctxFor(TENANT_A), connA, RECONCILE);
        expect(own?.id).toBe(matchRunId);
    });

    it('refuses a request that names no kind, or a status that is not one', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
        expect((await get(TENANT_A, connA, '')).status).toBe(400);
        getTenantCtxMock.mockResolvedValue(ctxFor(TENANT_A));
        expect((await get(TENANT_A, connA, `automationKey=${RECONCILE}&status=DONE`)).status).toBe(400);
    });
});
