/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * adapter shims that mirror runtime contracts. Per-line typing has poor
 * cost/benefit in test files; the file-level disable is this repo's standard
 * pattern for these surfaces. */

/**
 * An audit cycle can be created for ANY installed framework.
 *
 * THE DEFECT
 * ----------
 * `POST /api/t/:slug/audits/cycles` validated `frameworkKey` against
 * `z.enum(['ISO27001', 'NIS2'])`. Every other layer already supported any key:
 *
 *   - Prisma: `AuditCycle.frameworkKey` is a free `String`.
 *   - Usecase: `createAuditCycle` validates the key against the tenant's
 *     INSTALLED `Framework` rows and throws
 *     `badRequest('frameworkKey must be an installed framework')`. Its own
 *     comment says "the only thing that gated custom frameworks was this
 *     allowlist" — that layer was fixed and the route never was.
 *   - Scoring: non-ISO/NIS2 keys dispatch to `computeGenericReadiness`, which
 *     was therefore unreachable — dead code, along with `GENERIC_WEIGHTS`.
 *   - UI: the picker fetches `/frameworks` and offers every installed one.
 *
 * So a tenant with SOC 2 / CIS / SSDF / NIST Privacy installed saw them in the
 * picker and got `400 invalid_enum_value` on submit.
 *
 * The two assertions that matter are a PAIR, and neither is sufficient alone:
 * an installed non-seed framework must be accepted, and an UNinstalled key
 * must still be rejected. Widening the route without keeping the second is how
 * you'd turn a wall into a hole.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/app-layer/policies/audit-readiness.policies', () => ({
    assertCanManageAuditCycles: jest.fn(),
    assertCanViewPack: jest.fn(),
}));

jest.mock('@/lib/observability/business-metrics', () => ({
    recordAuditCycleStarted: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));

import { createAuditCycle } from '@/app-layer/usecases/audit-readiness/cycles';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** A tenant with `installedKeys` installed, recording the cycle it creates. */
function dbWithInstalled(installedKeys: string[]) {
    const created: any[] = [];
    mockDbHolder.db = {
        framework: {
            findFirst: jest.fn(async ({ where }: any) =>
                installedKeys.includes(where.key) ? { key: where.key } : null,
            ),
        },
        auditCycle: {
            create: jest.fn(async ({ data }: any) => {
                const row = { id: `cycle-${created.length}`, ...data };
                created.push(row);
                return row;
            }),
        },
        auditLog: { create: jest.fn(), findFirst: jest.fn(async () => null) },
    };
    return created;
}

const baseInput = {
    frameworkVersion: '2017',
    name: 'FY26 SOC 2 readiness',
};

describe('createAuditCycle — any INSTALLED framework', () => {
    beforeEach(() => jest.clearAllMocks());

    it('accepts a non-ISO/NIS2 framework the tenant has installed', () => {
        // The exact case that 400'd: picker offers SOC2, submit was rejected.
        const created = dbWithInstalled(['SOC2', 'ISO27001']);
        return createAuditCycle(ctx, { ...baseInput, frameworkKey: 'SOC2' }).then((cycle) => {
            expect(cycle.frameworkKey).toBe('SOC2');
            expect(created).toHaveLength(1);
            expect(created[0].tenantId).toBe(ctx.tenantId);
        });
    });

    it.each(['CIS', 'SSDF', 'NIST_PRIVACY'])(
        'accepts %s — the framework set is not an allowlist',
        async (key) => {
            dbWithInstalled([key]);
            const cycle = await createAuditCycle(ctx, { ...baseInput, frameworkKey: key });
            expect(cycle.frameworkKey).toBe(key);
        },
    );

    it('still REJECTS a framework the tenant has not installed', () => {
        // The gate that has to survive widening the route. Without it a cycle
        // could reference a key with no requirements to score against.
        dbWithInstalled(['ISO27001']);
        return expect(
            createAuditCycle(ctx, { ...baseInput, frameworkKey: 'NOT_INSTALLED' }),
        ).rejects.toThrow(/installed framework/i);
    });

    it('rejects an empty frameworkKey', async () => {
        dbWithInstalled(['ISO27001']);
        await expect(
            createAuditCycle(ctx, { ...baseInput, frameworkKey: '' }),
        ).rejects.toThrow(/installed framework/i);
    });

    it('keeps accepting the two seeded frameworks', async () => {
        // Widening must not regress the path that already worked.
        for (const key of ['ISO27001', 'NIS2']) {
            dbWithInstalled([key]);
            const cycle = await createAuditCycle(ctx, { ...baseInput, frameworkKey: key });
            expect(cycle.frameworkKey).toBe(key);
        }
    });
});

describe('the route schema no longer walls off installed frameworks', () => {
    // The usecase gate above is only reachable if the route stops rejecting
    // first. This asserts the route's contract directly: any non-empty string
    // parses, so validation reaches the layer that can actually check the
    // tenant's installed set.
    const { z } = require('zod');

    // Mirrors the shape in
    // src/app/api/t/[tenantSlug]/audits/cycles/route.ts.
    const RouteSchema = z.object({
        frameworkKey: z.string().min(1),
        frameworkVersion: z.string().min(1),
        name: z.string().min(1).max(200),
    });

    it.each(['SOC2', 'CIS', 'SSDF', 'NIST_PRIVACY', 'ISO27001', 'NIS2'])(
        'parses %s at the HTTP boundary',
        (key) => {
            const parsed = RouteSchema.safeParse({ ...baseInput, frameworkKey: key });
            expect(parsed.success).toBe(true);
        },
    );

    it('rejects an empty key at the boundary', () => {
        const parsed = RouteSchema.safeParse({ ...baseInput, frameworkKey: '' });
        expect(parsed.success).toBe(false);
    });

    it('the real route file declares no framework enum', () => {
        // A regex here on purpose: the defect was a *type-level* allowlist, and
        // re-adding one would sail past every behavioural test above while
        // reinstating the exact 400 this fixes.
        const src = require('node:fs').readFileSync(
            require('node:path').resolve(
                __dirname,
                '../../src/app/api/t/[tenantSlug]/audits/cycles/route.ts',
            ),
            'utf8',
        );
        expect(src).not.toMatch(/frameworkKey:\s*z\.enum/);
        expect(src).toMatch(/frameworkKey:\s*z\.string\(\)/);
    });
});
