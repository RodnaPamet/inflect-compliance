/**
 * `POST /api/t/:tenantSlug/admin/identity-joiner-passes/run` — the off-schedule
 * trigger #2687 added so a proving run does not have to wait for a cron tick.
 *
 * The pass itself is covered by `identity-joiner-run.test.ts` and the fan-out by
 * `identity-joiner-dispatch.test.ts`. Three things are proved here, and none of
 * them is provable by asserting "enqueue was called":
 *
 *   1. AN ADMIN CANNOT FIRE IT. Asserted on ADMIN specifically, never on a
 *      READER — a READER is refused by any gate at all, so a READER-only test
 *      stays green after the key is softened to `admin.manage` and certifies
 *      nothing. The role model is pinned alongside, so a future grant of
 *      `tenant_lifecycle` to ADMIN cannot leave the 403 cases passing for the
 *      wrong reason.
 *
 *   2. TWO RUNS IN ONE UTC DAY GET DIFFERENT JOB IDS. The 04:30 dispatcher's id
 *      is floored to the UTC DAY, so re-firing it the same day dedupes to a
 *      silent no-op inside BullMQ — no error, no row, indistinguishable from a
 *      dead worker. A trigger that inherited that bucket would reproduce the
 *      defect exactly while LOOKING like a fix, and every "did it enqueue?"
 *      assertion would still pass, because the route really does call enqueue.
 *      So the IDS are compared, with two controls: a daily bucket is shown to
 *      collapse the same two instants, and the manual id is shown to differ
 *      from the one the dispatcher mints for the same unit.
 *
 *   3. IT ENQUEUES THE SCHEDULED JOB, NOT A PARALLEL ONE. A manual run that
 *      behaved differently from the nightly one would be testing something
 *      other than the thing that runs at 04:30 — and `JOB_DEFAULTS` is keyed on
 *      the job NAME, so a bespoke name would also silently drop `attempts: 1`.
 */

// ── Mocks (declared before the imports that consume them) ───────────

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

/**
 * Captures the THIRD argument too. A mock that only records (name, payload)
 * cannot see the `jobId`, which is the only thing this route decides that
 * BullMQ acts on.
 */
const enqueueMock = jest.fn(
    async (_name: string, _payload: unknown, options?: { jobId?: string }) => ({
        id: options?.jobId ?? 'generated-id',
    }),
);
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (name: string, payload: unknown, options?: { jobId?: string }) =>
        enqueueMock(name, payload, options),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logEventMock = jest.fn<Promise<void>, [unknown, unknown, any]>(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logEvent: (db: unknown, ctx: unknown, payload: any) => logEventMock(db, ctx, payload),
}));

// ── Imports after mocks ─────────────────────────────────────────────

import { NextRequest } from 'next/server';
import {
    POST,
    MANUAL_JOINER_PASS_JOB_KEY,
} from '@/app/api/t/[tenantSlug]/admin/identity-joiner-passes/run/route';
import { dispatchJobId, MINUTE_MS, DAILY_BUCKET_MS } from '@/app-layer/jobs/fan-out';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { Role } from '@prisma/client';

// ── Helpers ─────────────────────────────────────────────────────────

function ctxFor(role: Role, overrides: { tenantId?: string; userId?: string } = {}) {
    const perms = getPermissionsForRole(role);
    return {
        requestId: 'req-1',
        userId: overrides.userId ?? `${role.toLowerCase()}-1`,
        tenantId: overrides.tenantId ?? 'tenant-A',
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

function req(body: unknown = { provider: 'entra-id' }): NextRequest {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('x-forwarded-for', '1.2.3.4');
    return new NextRequest('http://localhost/api/t/acme/admin/identity-joiner-passes/run', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

const ROUTE_ARGS = { params: Promise.resolve({ tenantSlug: 'acme' }) };

/** Two instants one minute apart inside the same UTC day. */
const T0 = Date.parse('2026-09-20T04:30:00.000Z');
const T1 = Date.parse('2026-09-20T04:31:00.000Z');

/** Fire one POST with the clock pinned, and return the jobId that reached BullMQ. */
async function runAt(now: number, provider = 'entra-id'): Promise<string> {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req({ provider }), ROUTE_ARGS as any);
        expect(res.status).toBe(202);
        const options = enqueueMock.mock.calls.at(-1)?.[2];
        return options?.jobId as string;
    } finally {
        clock.mockRestore();
    }
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ── Authorisation ───────────────────────────────────────────────────

describe('POST …/admin/identity-joiner-passes/run — authorisation', () => {
    it('lets an OWNER fire it — the positive half of the gate', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), ROUTE_ARGS as any);

        expect(res.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    it.each(['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const)(
        'refuses %s with 403, enqueues nothing and audits nothing',
        async (role) => {
            getTenantCtxMock.mockResolvedValueOnce(ctxFor(role));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = await POST(req(), ROUTE_ARGS as any);

            expect(res.status).toBe(403);
            // A 403 produced AFTER the pass was already queued is a run that
            // happens to return an error page, and the status alone cannot tell
            // the two apart.
            expect(enqueueMock).not.toHaveBeenCalled();
            expect(logEventMock).not.toHaveBeenCalled();
        },
    );

    it('ADMIN genuinely lacks the key this route uses (not a stale role model)', () => {
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
    });
});

// ── The job id ──────────────────────────────────────────────────────

describe('POST …/admin/identity-joiner-passes/run — the job id', () => {
    it('mints a DIFFERENT id for two runs in the same UTC day', async () => {
        const first = await runAt(T0);
        const second = await runAt(T1);

        expect(second).not.toBe(first);
    });

    it('control — a DAILY bucket would have collapsed those same two instants', () => {
        // Without this, a test whose two timestamps happened to straddle
        // midnight would pass with the daily bucket still in place.
        expect(dispatchJobId('x', 'k', DAILY_BUCKET_MS, T0)).toBe(
            dispatchJobId('x', 'k', DAILY_BUCKET_MS, T1),
        );
    });

    it('is not the id the 04:30 dispatcher would mint for the same unit', async () => {
        const scheduled = dispatchJobId(
            'identity-joiner-pass',
            'tenant-A:entra-id',
            DAILY_BUCKET_MS,
            T0,
        );

        const manual = await runAt(T0);

        expect(manual).not.toBe(scheduled);
    });

    it('mints its id under a namespace SEPARATE from the scheduled job', () => {
        // THE ONE LITERAL, and the only assertion here that notices a rename.
        // Every other case mints its expectation from the constant, which makes
        // them tautological in the namespace dimension — the leaver's twin suite
        // stayed 21/21 green with its constant collapsed onto the scheduled
        // job's own name, because every assertion asked the value under test.
        expect(MANUAL_JOINER_PASS_JOB_KEY).toBe('identity-joiner-pass-manual');
        // And the property the literal protects, stated so that a rename to the
        // scheduled name fails even if someone updates the literal to match.
        expect(MANUAL_JOINER_PASS_JOB_KEY).not.toBe('identity-joiner-pass');
    });

    it('uses the minute bucket under its own dedupe namespace', async () => {
        const manual = await runAt(T0);

        expect(manual).toBe(
            dispatchJobId(MANUAL_JOINER_PASS_JOB_KEY, 'tenant-A:entra-id', MINUTE_MS, T0),
        );
    });

    it('collapses two clicks inside one minute to a single id', async () => {
        // Deliberate, and the other direction: two passes at once would insert
        // two artefacts for one morning, and an observation window that cannot
        // tell a run from a double-click is not one.
        const first = await runAt(T0);
        const second = await runAt(T0 + 30_000);

        expect(second).toBe(first);
    });

    it('separates the directories — one provider cannot dedupe another away', async () => {
        const entra = await runAt(T0, 'entra-id');
        const onPrem = await runAt(T0, 'active-directory');

        expect(onPrem).not.toBe(entra);
    });
});

// ── Payload + validation ────────────────────────────────────────────

describe('POST …/admin/identity-joiner-passes/run — payload', () => {
    it('enqueues the SCHEDULED job with a ctx-derived tenant and nothing else', async () => {
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('OWNER', { tenantId: 'tenant-B', userId: 'owner-7' }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await POST(req({ provider: 'active-directory' }), ROUTE_ARGS as any);

        // The job NAME is load-bearing: JOB_DEFAULTS is keyed on it, so a
        // bespoke name would silently drop `attempts: 1` as well as the
        // executor.
        expect(enqueueMock.mock.calls[0][0]).toBe('identity-joiner-pass');
        expect(enqueueMock.mock.calls[0][1]).toEqual({
            tenantId: 'tenant-B',
            provider: 'active-directory',
        });
    });

    it('refuses a caller-supplied tenantId with 400 rather than stripping it', async () => {
        // A non-strict schema would STRIP it silently, which reads to that
        // caller exactly like being honoured.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        const res = await POST(
            req({ provider: 'entra-id', tenantId: 'tenant-victim' }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ROUTE_ARGS as any,
        );

        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('refuses a provider no writer resolves for', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req({ provider: 'okta' }), ROUTE_ARGS as any);

        // A typo would otherwise queue a pass that reads an enumeration for a
        // directory the joiner has no story about — a slow and confusing way to
        // learn you misspelled `entra-id`.
        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('hands back the queued id so the caller can find the run', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), ROUTE_ARGS as any);
        const body = (await res.json()) as { status: string; jobId: string; provider: string };

        expect(body.status).toBe('queued');
        expect(body.provider).toBe('entra-id');
        expect(body.jobId).toBe(enqueueMock.mock.calls[0][2]?.jobId);
    });
});

// ── Audit ───────────────────────────────────────────────────────────

describe('POST …/admin/identity-joiner-passes/run — audit', () => {
    it('writes IDENTITY_JOINER_PASS_REQUESTED carrying the provider and job id', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await POST(req(), ROUTE_ARGS as any);

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const payload = logEventMock.mock.calls[0][2];
        expect(payload.action).toBe('IDENTITY_JOINER_PASS_REQUESTED');
        // The record that somebody ASKED survives a worker that never runs and
        // BullMQ's removeOnComplete horizon — so it has to name what was asked
        // for, not merely that something was.
        expect(payload.metadata.provider).toBe('entra-id');
        expect(payload.metadata.jobId).toBe(enqueueMock.mock.calls[0][2]?.jobId);
        expect(payload.metadata.trigger).toBe('manual');
    });
});

// ── The declarative half ────────────────────────────────────────────

describe('route-permission map', () => {
    const RUN_PATH = '/api/t/acme/admin/identity-joiner-passes/run';

    it('declares the OWNER-only key for the run path', () => {
        // The runtime middleware and the map are two separate mechanisms — SDK
        // generation and /api/docs read the map, not the handler — so a
        // disagreement between them is a real defect and is checked on its own.
        expect(resolveRoutePermission(RUN_PATH, 'POST')?.permission).toBe(
            'admin.tenant_lifecycle',
        );
    });

    it('resolves through its OWN rule, not the report subtree rule', () => {
        // Structural rather than note-matching, so it survives an editorial
        // pass. The report rule is a subtree regex that also matches /run; if
        // ordering ever puts it first, the trigger silently inherits whatever
        // key the read surface is given.
        const rule = resolveRoutePermission(RUN_PATH, 'POST')?.rule;
        expect(rule?.path.test('/api/t/acme/admin/identity-joiner-passes')).toBe(false);
    });

    it('still gates the report index it sits under', () => {
        expect(
            resolveRoutePermission('/api/t/acme/admin/identity-joiner-passes', 'GET')?.permission,
        ).toBe('admin.tenant_lifecycle');
    });
});
