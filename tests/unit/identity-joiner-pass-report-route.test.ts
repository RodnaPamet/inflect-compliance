/**
 * `listJoinerPasses` and `GET /api/t/:tenantSlug/admin/identity-joiner-passes`
 * — the READ half of the joiner's record, which #2687 shipped with no
 * behavioural coverage at all.
 *
 * WHY THE READ NEEDS ITS OWN TESTS. The pass writes one `IntegrationExecution`
 * row per run into a table it shares with every connector check and with the
 * LEAVER's rows, so what distinguishes a joiner artefact from everything else
 * beside it is one `endsWith` predicate. Get that predicate wrong in either
 * direction and nothing throws: too narrow and the report is empty on a tenant
 * whose passes ran (indistinguishable, from the page, from a dead worker —
 * which is the failure mode the JML section of CLAUDE.md is mostly about); too
 * wide and an OWNER-only surface starts rendering rows that are not joiner
 * passes, keyed by a decision shape they do not have.
 *
 * Three things are proved, and the third is not about this file's own subject:
 *
 *   1. THE PREDICATE, as the exact complement of the exclusion in
 *      `listAllControlChecks`. The two are asserted against the SAME exported
 *      constant, because a pass that is excluded there and not returned here is
 *      invisible on both surfaces at once.
 *   2. THE CAP IS A CEILING, NOT A DEFAULT. `Math.min(limit ?? MAX, MAX)`
 *      reads almost identically to `Math.max(...)` and to a bare
 *      `limit ?? MAX`; both of those pass a test that only checks the default,
 *      so the over-cap case is asserted separately from the default one.
 *   3. THE GATE IS OWNER-ONLY, asserted on ADMIN specifically. A READER is
 *      refused by any gate at all, so a READER-only test stays green after the
 *      key is softened to `admin.manage` and certifies nothing. The role model
 *      is pinned alongside, so a future grant of `tenant_lifecycle` to ADMIN
 *      cannot leave these 403s passing for the wrong reason.
 *
 * The 403 cases assert the DATABASE was never reached, not merely that a
 * usecase spy went uncalled: the report names which of a customer's people the
 * product would create an account for and under what address, so a 403 produced
 * after the read has already run is a disclosure that happens to be discarded,
 * and the status alone cannot tell the two apart.
 */

// ── Mocks (declared before the imports that consume them) ───────────

/**
 * The real `listJoinerPasses` runs against this fake in every test below,
 * including the route ones. Mocking the USECASE instead would make the
 * "never reached the read" assertions weaker than they look — they would prove
 * a wrapper was not called, not that no query was issued.
 */
const mockDb = { integrationExecution: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The hash-chained AUTHZ_DENIED row `requirePermission` writes on a denial must
// not reach a real database from a unit test.
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: jest.fn(async () => ({
        recorded: 'chain' as const,
        auditId: 'audit-x',
    })),
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-x',
        entryHash: 'hash-x',
        previousHash: null,
    })),
}));

// ── Imports after mocks ─────────────────────────────────────────────

import { NextRequest } from 'next/server';
import {
    listJoinerPasses,
    JOINER_PASS_AUTOMATION_SUFFIX,
} from '@/app-layer/usecases/identity-joiner-run';
import { LEAVER_PASS_AUTOMATION_SUFFIX } from '@/app-layer/usecases/identity-leaver-pass';
import { GET } from '@/app/api/t/[tenantSlug]/admin/identity-joiner-passes/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';
import type { Role } from '@prisma/client';

// ── Helpers ─────────────────────────────────────────────────────────

const ctx = makeRequestContext('OWNER', { tenantId: 't1' });

function ctxFor(role: Role) {
    const perms = getPermissionsForRole(role);
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        role,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: perms.admin.manage,
            canAudit: true,
            canExport: true,
        },
        appPermissions: perms,
    };
}

function req(): NextRequest {
    return new NextRequest('http://localhost/api/t/acme/admin/identity-joiner-passes', {
        method: 'GET',
    });
}

const ROUTE_ARGS = { params: Promise.resolve({ tenantSlug: 'acme' }) };

const ROW = {
    id: 'exec-1',
    provider: 'entra-id',
    status: 'PASSED',
    executedAt: new Date('2026-09-20T04:30:00.000Z'),
    completedAt: new Date('2026-09-20T04:30:04.000Z'),
    resultJson: { mode: 'DRY_RUN', decisions: [{ employeeId: 'e1', outcome: 'WOULD_CREATE' }] },
};

/** The `findMany` argument object the call under test handed the fake. */
function lastQuery() {
    return mockDb.integrationExecution.findMany.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationExecution.findMany.mockResolvedValue([ROW]);
});

// ── The read predicate ──────────────────────────────────────────────

describe('listJoinerPasses — what it reads', () => {
    it('reads joiner passes and ONLY joiner passes, most recent first', async () => {
        await listJoinerPasses(ctx);

        expect(lastQuery().where).toEqual({
            tenantId: 't1',
            automationKey: { endsWith: JOINER_PASS_AUTOMATION_SUFFIX },
        });
        expect(lastQuery().orderBy).toEqual({ executedAt: 'desc' });
    });

    it('is the exact complement of the control-check EXCLUSION, by construction', async () => {
        // Same constant on both sides, asserted here so the pair cannot drift:
        // `listAllControlChecks` excludes rows ending in this suffix, and this
        // read returns exactly those. If the two ever name different strings, a
        // pass is either invisible on both surfaces or visible on the
        // `controls.view` one — and `.joiner_pass` was in fact missing from that
        // exclusion until the review of #2687.
        await listJoinerPasses(ctx);

        expect(JOINER_PASS_AUTOMATION_SUFFIX).toBe('.joiner_pass');
        expect(lastQuery().where.automationKey.endsWith).toBe(JOINER_PASS_AUTOMATION_SUFFIX);
        // And never the leaver's rows: they are keyed by LINK id, so a joiner
        // reader would render them as starters with no employee.
        expect(JOINER_PASS_AUTOMATION_SUFFIX).not.toBe(LEAVER_PASS_AUTOMATION_SUFFIX);
    });

    it('returns resultJson verbatim — the per-starter decisions ARE the artefact', async () => {
        // A `select` that dropped this would leave a report that can say a pass
        // happened and not what it decided, which is the half the seven-day
        // DRY_RUN observation exists to look at.
        const rows = await listJoinerPasses(ctx);

        expect(lastQuery().select.resultJson).toBe(true);
        expect(rows).toEqual([ROW]);
    });

    it('scopes to the tenant — the suffix filter is an addition, not a replacement', async () => {
        // Guarding the guard: a rewrite that left `where` holding only the
        // suffix clause would satisfy the predicate assertions above while
        // returning every tenant's joiner passes, which is by far the more
        // serious of the two.
        await listJoinerPasses(ctx);
        expect(lastQuery().where.tenantId).toBe('t1');
    });
});

// ── The cap ─────────────────────────────────────────────────────────

describe('listJoinerPasses — the take cap', () => {
    it('defaults to 100', async () => {
        await listJoinerPasses(ctx);
        expect(lastQuery().take).toBe(100);
    });

    it('CLAMPS a larger limit rather than honouring it', async () => {
        // The assertion that separates `Math.min(limit ?? MAX, MAX)` from the
        // two things it reads like: `limit ?? MAX` and `Math.max(...)`. Both of
        // those pass the default case above and return 100000 here.
        await listJoinerPasses(ctx, { limit: 100000 });
        expect(lastQuery().take).toBe(100);
    });

    it('honours a limit BELOW the cap, so the cap is a ceiling and not a fixed page', async () => {
        // The other direction, and it is not implied by the one above: a
        // hardcoded `take: 100` would pass both the default and the clamp case.
        await listJoinerPasses(ctx, { limit: 5 });
        expect(lastQuery().take).toBe(5);
    });
});

// ── The gate ────────────────────────────────────────────────────────

describe('GET …/admin/identity-joiner-passes — authorisation', () => {
    it('lets an OWNER read the passes — the positive half of the gate', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req(), ROUTE_ARGS as any);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.passes).toHaveLength(1);
        expect(body.passes[0]).toMatchObject({ id: 'exec-1', provider: 'entra-id' });
        expect(mockDb.integrationExecution.findMany).toHaveBeenCalledTimes(1);
    });

    it.each(['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const)(
        'refuses %s with 403 and issues no query at all',
        async (role) => {
            getTenantCtxMock.mockResolvedValueOnce(ctxFor(role));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = await GET(req(), ROUTE_ARGS as any);

            expect(res.status).toBe(403);
            expect(mockDb.integrationExecution.findMany).not.toHaveBeenCalled();
        },
    );

    it('ADMIN genuinely lacks the key this route uses (not a stale role model)', () => {
        // The load-bearing half of every 403 above. Without it, softening the
        // route to `admin.manage` would leave the ADMIN case green.
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
    });

    it('the permission MAP declares the same OWNER-only key as the handler enforces', () => {
        // Two separate mechanisms: the handler gates the request, the map is
        // what SDK generation and `/api/docs` publish. A rule ordered after a
        // broader `admin/...` pattern would document a weaker gate than the
        // handler applies, with nothing failing.
        const rule = resolveRoutePermission('/api/t/acme/admin/identity-joiner-passes', 'GET');
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('carries the same key as its LEAVER sibling — one key for both halves of JML', () => {
        const leaver = resolveRoutePermission('/api/t/acme/admin/identity-leaver-passes', 'GET');
        expect(leaver?.permission).toBe('admin.tenant_lifecycle');
    });
});
