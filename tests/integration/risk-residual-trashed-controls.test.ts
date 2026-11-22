/**
 * The control-derived residual suggestion does not count a control in the
 * trash (#5442, owner decision 2026-11-12).
 *
 * `loadResidualSuggestion` read the risk's controls through a nested select,
 * which the soft-delete extension does not reach, so a soft-deleted control
 * still lowered the suggested residual — and `acceptResidualSuggestion` /
 * `completePlan` persist that suggestion. A risk linked to a live and a trashed
 * control must now get exactly the suggestion of a twin risk linked to the live
 * control alone.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { getResidualSuggestion } from '@/app-layer/usecases/risk-residual-suggestion';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rrt-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;
const ctx = makeRequestContext('READER', { tenantId: A, tenantSlug: A });

let withTrashed = '';
let liveOnly = '';
let trashedId = '';

describeFn('residual suggestion ignores controls in the trash (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: A, name: A, slug: A } });
        const risk = (title: string) => prisma.risk.create({
            data: { tenantId: A, title: `${SUITE} ${title}`, likelihood: 5, impact: 5, score: 25, category: 'cat' },
        }).then((r) => r.id);
        withTrashed = await risk('linked to a live and a trashed control');
        liveOnly = await risk('linked to the live control only');
        // Both controls carry a DECLARED signal, so each would participate.
        const live = await prisma.control.create({ data: { tenantId: A, name: `${SUITE} live`, mitigationType: 'PREVENTIVE', effectiveness: 40 } });
        trashedId = (await prisma.control.create({ data: { tenantId: A, name: `${SUITE} trashed`, mitigationType: 'PREVENTIVE', effectiveness: 90 } })).id;
        await prisma.riskControl.create({ data: { tenantId: A, riskId: withTrashed, controlId: trashedId } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: withTrashed, controlId: live.id } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: liveOnly, controlId: live.id } });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [A]);
        await prisma.riskControl.deleteMany({ where: { tenantId: A } });
        await prisma.control.deleteMany({ where: { tenantId: A } });
        await prisma.risk.deleteMany({ where: { tenantId: A } });
        await prisma.tenant.deleteMany({ where: { id: A } });
        await prisma.$disconnect();
    });

    it('both controls count while neither is in the trash', async () => {
        const s = await getResidualSuggestion(ctx, withTrashed);
        expect(s.combined.participatingCount).toBe(2);
    });

    it('once one is trashed, the suggestion is as if its link did not exist', async () => {
        await prisma.control.update({ where: { id: trashedId }, data: { deletedAt: new Date() } });
        // The soft delete keeps the join row; only the read can drop it.
        expect(await prisma.riskControl.count({ where: { tenantId: A, riskId: withTrashed } })).toBe(2);

        const { riskId: _a, ...mine } = await getResidualSuggestion(ctx, withTrashed);
        const { riskId: _b, ...twin } = await getResidualSuggestion(ctx, liveOnly);
        expect(mine.combined.participatingCount).toBe(1);
        expect(JSON.stringify(mine)).not.toContain(trashedId);
        expect(mine).toEqual(twin);
    });
});
