/**
 * The four `BiaDependencyType` arms — PROCESS, ASSET, VENDOR, RISK — in the
 * two places the type is switched on.
 *
 * Only ASSET was covered in either, which is why `business-impact-analysis.ts`
 * sat at 74.9% branches with three-quarters of two switches unexercised
 * (`:172-201` in the dependency resolver, `:403-427` in the option list).
 *
 * These are the arms nothing type-checks for you. Each one names a Prisma
 * model, a display column and a client route, and all three differ per type —
 * so a copy-paste between arms compiles, passes every existing test, and
 * produces a BIA whose "Vendor: Acme" dependency links to `/assets/…`. The
 * assertions below are per-arm on purpose: a single loop over the four would
 * be satisfied by an implementation that returns the same thing for all of
 * them.
 */

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('../../src/app-layer/policies/common', () => ({ assertCanRead: jest.fn(), assertCanWrite: jest.fn() }));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (s: string) => s }));
jest.mock('../../src/app-layer/services/bia-recovery-priority', () => ({
    deriveRecoveryPriority: jest.fn(() => []),
    rankFor: jest.fn(() => ({ rank: 1 })),
}));

import { listBiaDependencyOptions, getBia } from '@/app-layer/usecases/business-impact-analysis';
import { runInTenantContext } from '@/lib/db-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (over: any = {}): any => ({ tenantId: 't1', userId: 'u1', role: 'ADMIN', ...over });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withDb = (db: any) => mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db));

beforeEach(() => jest.clearAllMocks());

// ─── listBiaDependencyOptions ───────────────────────────────────────

describe('listBiaDependencyOptions — one arm per dependency type', () => {
    const models = () => ({
        processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'n1', label: 'Payroll run' }]) },
        asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1', name: 'HR database' }]) },
        vendor: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', name: 'Acme Payroll' }]) },
        risk: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', title: 'Payroll outage' }]) },
    });

    // Each row is (type -> model, display column). The display column differs:
    // `label` for a process node, `name` for asset and vendor, `title` for a
    // risk. Mapping the wrong one yields `label: undefined` and an option list
    // of blanks — a UI bug with no error anywhere.
    it.each([
        ['PROCESS', 'processNode', 'n1', 'Payroll run'],
        ['ASSET', 'asset', 'a1', 'HR database'],
        ['VENDOR', 'vendor', 'v1', 'Acme Payroll'],
        ['RISK', 'risk', 'r1', 'Payroll outage'],
    ])('%s reads the %s model and maps its display column to `label`', async (type, model, id, label) => {
        const db = models();
        withDb(db);

        const out = await listBiaDependencyOptions(ctx(), type as never);

        expect(out).toEqual([{ id, label }]);
        // The right model, and ONLY the right model — an arm that queried two
        // would still return the correct shape.
        for (const [name, m] of Object.entries(db)) {
            const called = (m.findMany as jest.Mock).mock.calls.length;
            expect({ model: name, called: called > 0 }).toEqual({ model: name, called: name === model });
        }
    });

    it.each([['PROCESS'], ['ASSET'], ['VENDOR'], ['RISK']])(
        '%s is tenant-scoped, ordered and bounded at 500',
        async (type) => {
            const db = models();
            withDb(db);
            await listBiaDependencyOptions(ctx({ tenantId: 'tenant-X' }), type as never);

            const call = Object.values(db)
                .map((m) => (m.findMany as jest.Mock).mock.calls[0])
                .find(Boolean)!;
            expect(call[0]).toMatchObject({ where: { tenantId: 'tenant-X' }, take: 500 });
            // Unordered options make a 500-row dropdown unusable, and the cap
            // means the 500 you get would be an arbitrary 500.
            expect(call[0].orderBy).toBeDefined();
        },
    );
});

// ─── the dependency resolver on getBia ──────────────────────────────

describe('getBia — resolving each dependency type to a name and a route', () => {
    const bia = (deps: Array<{ dependsOnType: string; dependsOnId: string }>) => ({
        id: 'b1',
        name: 'Payroll',
        tenantId: 't1',
        dependencies: deps.map((d, i) => ({ id: `d${i}`, ...d, notes: null })),
        // The field is `evidenceLinks`, not `controlLinks` — `getBia` maps it
        // to controlIds before resolving. Getting this wrong is what my first
        // fixture did, and the failure named the line.
        evidenceLinks: [] as Array<{ controlId: string }>,
    });

    const db = (over: Record<string, unknown> = {}) => ({
        businessImpactAnalysis: {
            findFirst: jest.fn().mockResolvedValue(over.bia ?? bia([])),
            // `getBia` also ranks this BIA against the tenant's full set for
            // recovery priority; empty is fine, the arms under test are below.
            findMany: jest.fn().mockResolvedValue([]),
        },
        processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'n1', label: 'Payroll run', processMapId: 'pm-1' }]) },
        asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1', name: 'HR database' }]) },
        vendor: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', name: 'Acme Payroll' }]) },
        risk: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', title: 'Payroll outage' }]) },
        ...over,
    });

    // The route is the part a reader cannot verify by eye, and the part a
    // copy-paste between arms gets wrong. A VENDOR dependency pointing at
    // `/assets/v1` renders a plausible link to a 404.
    it.each([
        ['PROCESS', 'n1', 'Payroll run', '/processes/pm-1'],
        ['ASSET', 'a1', 'HR database', '/assets/a1'],
        ['VENDOR', 'v1', 'Acme Payroll', '/vendors/v1'],
        ['RISK', 'r1', 'Payroll outage', '/risks/r1'],
    ])('%s resolves to its own name and its own route', async (type, id, name, path) => {
        withDb(db({ bia: bia([{ dependsOnType: type, dependsOnId: id }]) }));

        const out = await getBia(ctx(), 'b1');

        expect(out.dependencies).toHaveLength(1);
        expect(out.dependencies[0]).toMatchObject({ targetName: name, targetPath: path });
    });

    // A PROCESS node links through its MAP, not its own id — the only arm
    // whose route uses a second field. Losing it yields `/processes/` and a
    // link to the index rather than the node.
    it('routes a PROCESS dependency via its processMapId', async () => {
        withDb(db({ bia: bia([{ dependsOnType: 'PROCESS', dependsOnId: 'n1' }]) }));
        const out = await getBia(ctx(), 'b1');
        expect(out.dependencies[0].targetPath).toBe('/processes/pm-1');
        expect(out.dependencies[0].targetPath).not.toBe('/processes/n1');
    });

    // A dependency whose target was deleted must degrade, not throw: the BIA
    // still has to render, and the dangling row is what tells an operator to
    // fix it. Nulls rather than a broken half-link.
    it.each([['PROCESS'], ['ASSET'], ['VENDOR'], ['RISK']])(
        'leaves a dangling %s dependency as nulls rather than throwing',
        async (type) => {
            withDb(db({ bia: bia([{ dependsOnType: type, dependsOnId: 'deleted-id' }]) }));

            const out = await getBia(ctx(), 'b1');

            expect(out.dependencies[0]).toMatchObject({ targetName: null, targetPath: null });
        },
    );

    it('resolves a mixed dependency set without cross-contaminating the arms', async () => {
        withDb(db({
            bia: bia([
                { dependsOnType: 'ASSET', dependsOnId: 'a1' },
                { dependsOnType: 'VENDOR', dependsOnId: 'v1' },
                { dependsOnType: 'RISK', dependsOnId: 'r1' },
            ]),
        }));

        const out = await getBia(ctx(), 'b1');

        expect(out.dependencies.map((d: { targetPath: string | null }) => d.targetPath))
            .toEqual(['/assets/a1', '/vendors/v1', '/risks/r1']);
    });
});
