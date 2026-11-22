/**
 * The coverage dashboard's NAME LISTS answer to each kind's view key; its
 * COUNTS do not (#5442, owner decision 2026-11-12).
 *
 * `coverageSummary` gates on the coarse read tier, so a custom role on a READER
 * base that withholds `risks.view` (or `assets.view`, or `controls.view`) still
 * read the unmapped risks' titles, the uncovered critical assets' names and the
 * hot controls' names off the dashboard — the leak #5376 closed on the
 * traceability panels. Now each list is omitted for a kind the caller may not
 * view, `withheld` names it, and every total and percentage is byte-for-byte
 * what a built-in READER reads.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { coverageSummary } from '@/app-layer/usecases/traceability';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `csv-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;

const reader = makeRequestContext('READER', { tenantId: A, tenantSlug: A });

function customRole(mutate: (p: PermissionSet) => void): RequestContext {
    const appPermissions = structuredClone(getPermissionsForRole('READER'));
    mutate(appPermissions);
    return makeRequestContext('READER', { tenantId: A, tenantSlug: A, appPermissions });
}

const RISK_TITLE = `${SUITE} unmapped risk`;
const ASSET_NAME = `${SUITE} uncovered asset`;
const CONTROL_NAME = `${SUITE} hot control`;

type Summary = Awaited<ReturnType<typeof coverageSummary>>;

/** Everything in the summary but the three name lists and the `withheld` flags. */
function counts(s: Summary) {
    const { unmappedRisks: _r, uncoveredCriticalAssets: _a, hotControls: _c, withheld: _w, ...rest } = s;
    return rest;
}

describeFn('coverageSummary: name lists honour each view key, counts do not (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: A, name: A, slug: A } });
        // One risk with no control (the unmapped list), one with a control (the hot control).
        await prisma.risk.create({ data: { tenantId: A, title: RISK_TITLE, score: 20, category: 'cat' } });
        const mapped = await prisma.risk.create({ data: { tenantId: A, title: `${SUITE} mapped risk`, score: 4, category: 'cat' } });
        const control = await prisma.control.create({ data: { tenantId: A, name: CONTROL_NAME, code: 'HOT-1' } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: mapped.id, controlId: control.id } });
        // A critical asset no control covers.
        await prisma.asset.create({ data: { tenantId: A, name: ASSET_NAME, type: 'SYSTEM', status: 'ACTIVE', criticality: 'HIGH' } });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [A]);
        await prisma.riskControl.deleteMany({ where: { tenantId: A } });
        await prisma.control.deleteMany({ where: { tenantId: A } });
        await prisma.risk.deleteMany({ where: { tenantId: A } });
        await prisma.asset.deleteMany({ where: { tenantId: A } });
        await prisma.tenant.deleteMany({ where: { id: A } });
        await prisma.$disconnect();
    });

    it('a built-in READER reads every list', async () => {
        const s = await coverageSummary(reader);
        expect(s.withheld).toEqual({ risks: false, assets: false, controls: false });
        expect(s.unmappedRisks.map((r) => r.title)).toEqual([RISK_TITLE]);
        expect(s.uncoveredCriticalAssets.map((a) => a.name)).toEqual([ASSET_NAME]);
        expect(s.hotControls.map((c) => c.name)).toEqual([CONTROL_NAME]);
        expect(s.unmappedRisksTotal).toBe(1);
        expect(s.uncoveredCriticalAssetsTotal).toBe(1);
    });

    it.each([
        ['risks', 'unmappedRisks', RISK_TITLE] as const,
        ['assets', 'uncoveredCriticalAssets', ASSET_NAME] as const,
        ['controls', 'hotControls', CONTROL_NAME] as const,
    ])('without %s.view the %s list is omitted and every count is unchanged', async (domain, list, name) => {
        const blind = customRole((p) => {
            p[domain].view = false;
        });
        const [mine, builtIn] = [await coverageSummary(blind), await coverageSummary(reader)];

        expect(mine[list]).toEqual([]);
        expect(JSON.stringify(mine)).not.toContain(name);
        expect(mine.withheld).toEqual({ risks: false, assets: false, controls: false, [domain]: true });
        // The other two lists are still there.
        for (const other of (['unmappedRisks', 'uncoveredCriticalAssets', 'hotControls'] as const).filter((l) => l !== list)) {
            expect([other, mine[other]]).toEqual([other, builtIn[other]]);
        }
        expect(counts(mine)).toEqual(counts(builtIn));
    });
});
