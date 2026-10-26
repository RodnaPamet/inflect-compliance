/* eslint-disable @typescript-eslint/no-explicit-any -- a fake catalogue + tenant DB that interpret the where clauses the code sends. */
/**
 * "In use" for a framework (#4129) — the rule an audit cycle's framework must
 * pass, and the set its picker offers.
 *
 * `isFrameworkInUse` claims to be the Frameworks page's "Installed" rule,
 * `computeCoverage(...).mapped > 0`, asked with a `findFirst` instead of
 * loading every link. That claim is tested here by running BOTH over the same
 * fake world, whose tables interpret the where clauses the code sends — so a
 * filter one side applies and the other forgets (a deleted control, a
 * deprecated requirement, another tenant's link, the other representation of
 * ISO 27001) makes them disagree and fails the test.
 */

interface Fw { id: string; key: string; sourceUrn: string | null; retiredAt: null; _count: { requirements: number; packs: number } }
interface Req { id: string; frameworkId: string; code: string; title: string; section: string | null; category: string | null; sortOrder: number; deprecatedAt: Date | null }
interface Link { id: string; tenantId: string; requirementId: string; control: { id: string; code: string; name: string; status: string; deletedAt: Date | null } }

const world: { frameworks: Fw[]; requirements: Req[]; links: Link[] } = { frameworks: [], requirements: [], links: [] };

const matchReq = (where: any) => (r: Req) =>
    (where.frameworkId === undefined ||
        (typeof where.frameworkId === 'string' ? r.frameworkId === where.frameworkId : where.frameworkId.in.includes(r.frameworkId))) &&
    (where.deprecatedAt !== null || r.deprecatedAt === null);

const matchLink = (where: any) => (l: Link) =>
    l.tenantId === where.tenantId &&
    where.requirementId.in.includes(l.requirementId) &&
    (where.control?.deletedAt !== null || l.control.deletedAt === null);

const catalogue: any = {
    framework: {
        findFirst: jest.fn(async ({ where }: any) => world.frameworks.find((f) => f.key === where.key) ?? null),
        findMany: jest.fn(async () => world.frameworks),
    },
    frameworkRequirement: {
        findMany: jest.fn(async ({ where }: any) => world.requirements.filter(matchReq(where))),
    },
};
const tenantDb: any = {
    ...catalogue,
    controlRequirementLink: {
        findMany: jest.fn(async ({ where }: any) => world.links.filter(matchLink(where))),
        findFirst: jest.fn(async ({ where }: any) => world.links.find(matchLink(where)) ?? null),
    },
    // pack-scope.ts: a single-pack framework is never narrowed.
    frameworkPack: { count: jest.fn(async () => 1) },
    tenantFrameworkPack: { findMany: jest.fn(async () => []) },
};

jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: catalogue, default: catalogue }));
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return { ...actual, runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)) };
});
const viewCalls: string[] = [];
jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(() => viewCalls.push('view')),
}));
jest.mock('@/app-layer/usecases/framework/catalog', () => ({
    listFrameworks: jest.fn(async () => world.frameworks.filter((f) => f._count.packs > 0)),
}));

import { computeCoverage, isFrameworkInUse, listFrameworksInUse } from '@/app-layer/usecases/framework/coverage';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant-1' });

const fw = (id: string, key: string, sourceUrn: string | null = null, packs = 1): Fw =>
    ({ id, key, sourceUrn, retiredAt: null, _count: { requirements: 1, packs } });
const req = (id: string, frameworkId: string, code: string, deprecated = false): Req =>
    ({ id, frameworkId, code, title: code, section: null, category: null, sortOrder: 0, deprecatedAt: deprecated ? new Date() : null });
const link = (id: string, requirementId: string, opts: { tenantId?: string; deleted?: boolean } = {}): Link => ({
    id,
    tenantId: opts.tenantId ?? 'tenant-1',
    requirementId,
    control: { id: `ctl-${id}`, code: 'C', name: 'Control', status: 'IMPLEMENTED', deletedAt: opts.deleted ? new Date() : null },
});

beforeEach(() => {
    viewCalls.length = 0;
    world.frameworks = [
        fw('fw-iso', 'ISO27001'),
        // The library twin of ISO 27001: same family, `A.`-prefixed codes, no pack.
        fw('fw-iso-lib', 'ISO27001-2022', 'urn:inflect:library:iso27001-2022', 0),
        fw('fw-soc2', 'SOC2'),
        fw('fw-nis2', 'NIS2'),
        fw('fw-gdpr', 'GDPR'),
        fw('fw-cis', 'CIS'),
        fw('fw-hipaa', 'HIPAA'),
    ];
    world.requirements = [
        req('r-iso-1', 'fw-iso', '5.1'),
        req('r-iso-lib-1', 'fw-iso-lib', 'A.5.1'),
        req('r-soc2-1', 'fw-soc2', 'CC1.1'),
        req('r-nis2-old', 'fw-nis2', '21.1', true),
        req('r-nis2-1', 'fw-nis2', '21.2'),
        req('r-gdpr-1', 'fw-gdpr', 'Art.5'),
        req('r-cis-1', 'fw-cis', '1.1'),
        req('r-hipaa-1', 'fw-hipaa', '164.308'),
    ];
    world.links = [
        // ISO 27001: the tenant's link hangs off the OTHER representation.
        link('l-iso', 'r-iso-lib-1'),
        // SOC 2: only a deleted control.
        link('l-soc2', 'r-soc2-1', { deleted: true }),
        // NIS2: only a deprecated requirement.
        link('l-nis2', 'r-nis2-old'),
        // CIS: a live link.
        link('l-cis', 'r-cis-1'),
        // HIPAA: another tenant's link.
        link('l-hipaa', 'r-hipaa-1', { tenantId: 'tenant-2' }),
        // GDPR: nothing.
    ];
});

describe('isFrameworkInUse is the Frameworks page’s rule', () => {
    it.each(['ISO27001', 'SOC2', 'NIS2', 'GDPR', 'CIS', 'HIPAA'])(
        '%s — agrees with computeCoverage(...).mapped > 0',
        async (key) => {
            const coverage = await computeCoverage(ctx, key);
            await expect(isFrameworkInUse(ctx, key)).resolves.toBe(coverage.mapped > 0);
        },
    );

    it('answers each case the way the issue needs', async () => {
        const answers = Object.fromEntries(
            await Promise.all(
                ['ISO27001', 'SOC2', 'NIS2', 'GDPR', 'CIS', 'HIPAA'].map(async (k) => [k, await isFrameworkInUse(ctx, k)] as const),
            ),
        );
        // Without the answers pinned, both sides could agree on always-false.
        expect(answers).toEqual({ ISO27001: true, SOC2: false, NIS2: false, GDPR: false, CIS: true, HIPAA: false });
    });

    it('a key the catalogue does not hold, or an empty key, is not in use', async () => {
        await expect(isFrameworkInUse(ctx, 'NOPE')).resolves.toBe(false);
        await expect(isFrameworkInUse(ctx, '')).resolves.toBe(false);
    });

    it('asserts no permission of its own (the caller does)', async () => {
        await isFrameworkInUse(ctx, 'CIS');
        expect(viewCalls).toEqual([]);
    });
});

describe('listFrameworksInUse', () => {
    it('is the offered catalogue narrowed to the frameworks in use', async () => {
        const rows = await listFrameworksInUse(ctx);
        // The library twin is not offered (listFrameworks drops it), but its
        // link still puts ISO 27001 in use.
        expect(rows.map((f: any) => f.key)).toEqual(['ISO27001', 'CIS']);
    });
});
