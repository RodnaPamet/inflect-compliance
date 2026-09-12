/**
 * `POST /api/t/:tenantSlug/admin/identity-leaver-passes/run` — the off-schedule
 * re-run trigger for the direction that writes to a customer's directory.
 *
 * The pass itself is covered by `identity-leaver-pass.test.ts` and the fan-out
 * arithmetic by `jobs-fan-out.test.ts`. What is proved here is the pair of
 * things that did not exist until this route did, and neither is provable by
 * asserting "enqueue was called":
 *
 *   1. AN ADMIN CANNOT FIRE IT. The route sits on `admin.tenant_lifecycle`,
 *      which the role model denies ADMIN. Asserted on ADMIN specifically, not
 *      on a READER — a READER is refused by any gate at all, so a READER-only
 *      test stays green after the key is softened to `admin.manage` and
 *      certifies nothing. The role model itself is pinned alongside, so a
 *      future grant of `tenant_lifecycle` to ADMIN cannot leave the 403 cases
 *      passing for the wrong reason.
 *
 *   2. TWO RUNS IN ONE UTC DAY GET DIFFERENT JOB IDS. This is the entire
 *      defect (#2484). The 05:00 dispatcher's id is floored to the UTC DAY, so
 *      re-firing it the same day dedupes to a silent no-op inside BullMQ — no
 *      error, no refusal row, indistinguishable from a dead worker. A re-run
 *      button that inherited that bucket would reproduce the defect exactly
 *      while LOOKING like a fix, and every "did it enqueue?" assertion would
 *      still pass, because the route really does call enqueue: BullMQ is where
 *      the second one disappears.
 *
 *      So the ids are compared, not the call count — and with two controls, to
 *      keep the comparison from passing for reasons other than the bucket:
 *
 *        · a DAILY bucket over the same two instants is asserted to collapse
 *          them. Without that, a test whose two timestamps happened to straddle
 *          midnight would pass with the daily bucket still in place.
 *        · the id is asserted DIFFERENT from the one the 05:00 dispatcher mints
 *          for the same (tenant, provider). That is the specific key the manual
 *          run must not be swallowed by.
 *
 *      And the other direction: two clicks inside ONE minute collapse to one
 *      id, on purpose. `attempts: 1` on this job is a correctness constraint —
 *      two concurrent passes each mint a journal row per candidate and the
 *      second cannot tell its own predecessor's unsettled row from a genuinely
 *      INDETERMINATE write — so a double-click must not become two passes.
 */

// ── Mocks (declared before the imports that consume them) ───────────

// `requirePermission` resolves the caller through this; handing back a role is
// how each authz case is set up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The hash-chained AUTHZ_DENIED row `requirePermission` writes on a denial must
// not reach a real database from a unit test. Its presence is the whole reason
// this population gates at the route rather than in the usecase (CLAUDE.md C.1).
jest.mock('@/lib/audit', () => ({
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
        // Mirrors BullMQ: a custom jobId becomes the job's id.
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
    MANUAL_LEAVER_PASS_JOB_KEY,
} from '@/app/api/t/[tenantSlug]/admin/identity-leaver-passes/run/route';
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
    return new NextRequest(
        'http://localhost/api/t/acme/admin/identity-leaver-passes/run',
        { method: 'POST', headers, body: JSON.stringify(body) },
    );
}

const ROUTE_ARGS = { params: Promise.resolve({ tenantSlug: 'acme' }) };

/**
 * Two instants ONE MINUTE apart inside the same UTC day — the shape of the
 * scenario the issue describes: the 05:00 pass ran, something was wrong, an
 * operator fixes it and fires the pass again the same morning.
 */
const T0 = Date.parse('2026-09-12T05:00:00.000Z');
const T1 = Date.parse('2026-09-12T05:01:00.000Z');

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

describe('POST …/admin/identity-leaver-passes/run — authorisation', () => {
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
            // The second and third assertions are not redundant. A 403 produced
            // AFTER the pass was already queued is a directory write that
            // happens to return an error page, and the status alone cannot tell
            // the two apart.
            expect(enqueueMock).not.toHaveBeenCalled();
            expect(logEventMock).not.toHaveBeenCalled();
        },
    );

    it('ADMIN genuinely lacks the key this route uses (not a stale role model)', () => {
        // The load-bearing half of the ADMIN 403 above. Without this, a future
        // grant of tenant_lifecycle to ADMIN would leave that case passing for
        // the wrong reason until somebody noticed by eye.
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
    });
});

// ── The re-run property (#2484) ─────────────────────────────────────

describe('POST …/admin/identity-leaver-passes/run — the job id', () => {
    it('mints a DIFFERENT id for two runs in the same UTC day', async () => {
        const first = await runAt(T0);
        const second = await runAt(T1);

        expect(first).toBeTruthy();
        expect(second).toBeTruthy();
        expect(second).not.toBe(first);
    });

    it('control — a DAILY bucket would have collapsed those same two instants', () => {
        // Without this the test above could pass because T0 and T1 straddled
        // midnight rather than because the route uses a minute bucket, and the
        // defect would be reintroduced with the suite still green.
        const daily = (now: number) => dispatchJobId('x', 'tenant-A:entra-id', DAILY_BUCKET_MS, now);
        expect(daily(T1)).toBe(daily(T0));
    });

    it('is not the id the 05:00 dispatcher would mint for the same unit', async () => {
        // The specific key a same-day re-run was being swallowed by: the
        // dispatcher enqueues `identity-leaver-pass` under a UTC-day bucket, so
        // a manual run that produced the same string would be deduped away
        // inside BullMQ with no error and no row.
        const scheduled = dispatchJobId(
            'identity-leaver-pass',
            'tenant-A:entra-id',
            DAILY_BUCKET_MS,
            T0,
        );

        const manual = await runAt(T0);

        expect(manual).not.toBe(scheduled);
    });

    it('mints its id under a namespace SEPARATE from the scheduled job', () => {
        // THE ONE LITERAL, and the only assertion here that notices a rename.
        //
        // Every other case in this file mints its expectation from
        // MANUAL_LEAVER_PASS_JOB_KEY, which makes them tautological in the
        // namespace dimension — adversarial review collapsed the constant onto
        // the scheduled job's own name and all 21 stayed green. The separation
        // the route argues for was therefore asserted nowhere.
        //
        // Pinned in ONE place on purpose: restating the string in twenty
        // assertions would make a deliberate rename twenty edits, and people
        // route around that. Here it is a single deliberate edit that forces a
        // reviewer to look at the dedupe story.
        expect(MANUAL_LEAVER_PASS_JOB_KEY).toBe('identity-leaver-pass-manual');
        // And it must not BE the scheduled job's key — the property the literal
        // exists to protect, stated so a future rename to the same value fails
        // even if someone updates the literal above to match.
        expect(MANUAL_LEAVER_PASS_JOB_KEY).not.toBe('identity-leaver-pass');
    });

    it('uses the minute bucket under its own dedupe namespace', async () => {
        // Asserted against the constants, which keeps this case about the
        // BUCKET. The namespace itself is pinned literally above; without that
        // pin this assertion is tautological in the namespace dimension.
        const manual = await runAt(T0);

        expect(manual).toBe(
            dispatchJobId(MANUAL_LEAVER_PASS_JOB_KEY, 'tenant-A:entra-id', MINUTE_MS, T0),
        );
    });

    it('collapses two clicks inside one minute to a single id', async () => {
        // The other direction, and deliberate. Two passes running at once each
        // mint a journal row per candidate, and the second cannot tell its own
        // predecessor's unsettled row from a real INDETERMINATE write — which
        // is why the job carries attempts: 1. A double-click must not defeat it.
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

describe('POST …/admin/identity-leaver-passes/run — payload', () => {
    it('enqueues the scheduled job with a ctx-derived tenant and nothing else', async () => {
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('OWNER', { tenantId: 'tenant-B', userId: 'owner-7' }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req({ provider: 'entra-id' }), ROUTE_ARGS as any);
        expect(res.status).toBe(202);

        // The JOB is the scheduled one, exactly. A manual run that enqueued a
        // different job would be exercising something other than the 05:00 path.
        const [name, payload] = enqueueMock.mock.calls[0];
        expect(name).toBe('identity-leaver-pass');
        expect(payload).toEqual({ tenantId: 'tenant-B', provider: 'entra-id' });
    });

    it('refuses a caller-supplied tenantId with 400 rather than stripping it', async () => {
        // `.strict()`. A silent strip reads to the caller exactly like being
        // honoured, on a route whose whole subject is which directory gets
        // written to.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        const res = await POST(
            req({ provider: 'entra-id', tenantId: 'tenant-VICTIM' }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ROUTE_ARGS as any,
        );

        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it.each([
        ['a provider with no writer', { provider: 'okta' }],
        ['no provider at all', {}],
    ])('refuses %s with 400 and queues nothing', async (_label, body) => {
        // A typo would otherwise become an enqueued pass that refuses
        // UNSUPPORTED_PROVIDER into an execution row — a slow and confusing way
        // to learn you misspelled a directory on the morning you needed it.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(body), ROUTE_ARGS as any);

        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('hands back the queued id so the caller can find the run', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), ROUTE_ARGS as any);
        const body = await res.json();

        expect(body).toMatchObject({ status: 'queued', provider: 'entra-id' });
        expect(body.jobId).toBe(enqueueMock.mock.calls[0][2]?.jobId);
    });
});

// ── The record that somebody asked ──────────────────────────────────

describe('POST …/admin/identity-leaver-passes/run — audit', () => {
    it('writes IDENTITY_LEAVER_PASS_REQUESTED carrying the provider and job id', async () => {
        // The pass writes its own execution and journal rows, but only if a
        // worker picks it up. This row is the only trace that a human asked for
        // an off-schedule directory write, and it must survive a worker that
        // never runs.
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('OWNER', { tenantId: 'tenant-A', userId: 'owner-9' }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await POST(req(), ROUTE_ARGS as any);

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const payload = logEventMock.mock.calls[0][2];
        expect(payload.action).toBe('IDENTITY_LEAVER_PASS_REQUESTED');
        expect(payload.entityType).toBe('Tenant');
        expect(payload.entityId).toBe('tenant-A');
        expect(payload.metadata).toMatchObject({
            provider: 'entra-id',
            trigger: 'manual',
            jobId: enqueueMock.mock.calls[0][2]?.jobId,
        });
    });
});

// ── The declarative half ────────────────────────────────────────────

describe('route-permission map', () => {
    const RUN_PATH = '/api/t/acme/admin/identity-leaver-passes/run';

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
        // ordering ever puts it first, the run trigger silently inherits
        // whatever key the read surface is given, and the two are no longer
        // independently reviewable.
        const rule = resolveRoutePermission(RUN_PATH, 'POST')?.rule;
        expect(rule?.path.test('/api/t/acme/admin/identity-leaver-passes')).toBe(false);
    });

    it('still gates the report index it sits under', () => {
        // The new exact-anchored rule must not have displaced the subtree rule
        // for its siblings.
        expect(
            resolveRoutePermission('/api/t/acme/admin/identity-leaver-passes', 'GET')
                ?.permission,
        ).toBe('admin.tenant_lifecycle');
    });
});
