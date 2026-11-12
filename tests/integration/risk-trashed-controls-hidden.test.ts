/**
 * Risk pages hide controls in the trash (#5376, owner decision 2026-11-12).
 *
 * Soft-deleting a control keeps its `RiskControl` rows, and the soft-delete
 * extension filters top-level reads only — never a nested `include`, `select`
 * or `_count` — so a control in the trash was still listed on the risk's page
 * and counted in the risk list's Controls column. The Risk Register PDF stopped
 * listing them in #5427; this pins the same rule on the three reads behind the
 * risk pages:
 *
 *   - the list (`listRisks` / `listRisksPaginated`) — the Controls column is
 *     `controls.length` on each row;
 *   - the detail read (`getRisk`);
 *   - the risk's traceability panel (`getRiskTraceability` / `listRiskControls`),
 *     which is where the risk page shows and manages its linked controls.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { listRisks, listRisksPaginated, getRisk } from '@/app-layer/usecases/risk';
import { getRiskTraceability, listRiskControls } from '@/app-layer/usecases/traceability';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rtc-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;
const ctx = makeRequestContext('READER', { tenantId: A, tenantSlug: A });

let riskId = '';
let liveId = '';
let trashedId = '';

describeFn('risk pages hide controls in the trash (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: A, name: A, slug: A } });
        riskId = (await prisma.risk.create({ data: { tenantId: A, title: `${SUITE} risk`, score: 9, category: 'cat' } })).id;
        liveId = (await prisma.control.create({ data: { tenantId: A, name: `${SUITE} live control` } })).id;
        trashedId = (await prisma.control.create({ data: { tenantId: A, name: `${SUITE} trashed control` } })).id;
        await prisma.riskControl.create({ data: { tenantId: A, riskId, controlId: liveId } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId, controlId: trashedId } });
        // The soft delete leaves the join row in place — only the reads can hide it.
        await prisma.control.update({ where: { id: trashedId }, data: { deletedAt: new Date() } });
        expect(await prisma.riskControl.count({ where: { tenantId: A, riskId } })).toBe(2);
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [A]);
        await prisma.riskControl.deleteMany({ where: { tenantId: A } });
        await prisma.control.deleteMany({ where: { tenantId: A } });
        await prisma.risk.deleteMany({ where: { tenantId: A } });
        await prisma.tenant.deleteMany({ where: { id: A } });
        await prisma.$disconnect();
    });

    it('the risk list counts only the live control', async () => {
        const rows = await listRisks(ctx);
        const row = rows.find((r) => r.id === riskId);
        expect(row?.controls.map((c) => c.control.id)).toEqual([liveId]);

        const page = await listRisksPaginated(ctx, { limit: 50 });
        const paged = (page.items as unknown as Array<{ id: string; controls: Array<{ control: { id: string } }> }>)
            .find((r) => r.id === riskId);
        expect(paged?.controls.map((c) => c.control.id)).toEqual([liveId]);
    });

    it('the risk detail read lists only the live control', async () => {
        const risk = await getRisk(ctx, riskId);
        expect(risk.controls.map((c) => c.controlId)).toEqual([liveId]);
    });

    it('the risk\'s traceability panel lists only the live control', async () => {
        expect((await getRiskTraceability(ctx, riskId)).controls.map((l) => l.control.id)).toEqual([liveId]);
        expect((await listRiskControls(ctx, riskId)).map((l) => l.control.id)).toEqual([liveId]);
    });
});
