/**
 * The assistant stream's gate, through the REAL middleware (#3830).
 *
 * Distinct from `tests/unit/ai/assistant-stream-transport.test.ts`, which
 * replaces `requirePermission` with a pass-through to reach the stream at all.
 * That makes it blind to the gate itself — so this exercises the real
 * `requirePermission`, the real `hasPermission`, and the real denial path, with
 * only the context resolution and the audit sink doubled.
 *
 * ═══ WHY THE AUDIT SINK IS MOCKED RATHER THAN READ FROM A DATABASE ═══
 *
 * The assertion that matters is a COUNT — exactly one `AUTHZ_DENIED` row, not
 * zero and not two. Zero means the deny path skipped the audit; two means a
 * double-write, which corrupts the row's meaning as a count of attempts. A
 * mocked sink counts exactly, where a database read has to distinguish this
 * test's rows from every other row in a shared tenant, which is the kind of
 * setup that ends up asserting "at least one".
 *
 * The existing guard tests take the same approach and say why:
 * "`requirePermission` writes an AUTHZ_DENIED row on denial; it must not reach
 * a real database from a guard test."
 */

// Imported above the mock factories on purpose: the factory below closes over
// `strictMock`, and the subject import runs it. An import placed after that
// import would still be uninitialised when the factory fires.
import { strictMock } from '../helpers/strict-mock';
const appendAuditEntryOrQueueMock = jest.fn(async () => ({
    id: 'audit-1',
    entryHash: 'h',
    previousHash: null,
}));
jest.mock('@/lib/audit', () =>
    // strictMock, not a bare subset: `requireActual` here means an export this
    // factory forgot names itself at the moment of access, instead of resolving
    // to `undefined` and failing somewhere inside the route.
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...args: unknown[]) => appendAuditEntryOrQueueMock(...(args as [])),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-1', entryHash: 'h', previousHash: null })),
    }),
);

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => getTenantCtxMock(...(args as [])),
}));

jest.mock('@/lib/validation/route', () => ({
    parseJsonBody: async () => ({ question: 'how many open findings?' }),
}));

jest.mock('@/app-layer/usecases/assistant', () => ({
    AskAssistantSchema: { parse: (v: unknown) => v },
    streamAssistant: async (_c: unknown, _i: unknown, opts: { emit: (e: unknown) => void }) => {
        opts.emit({ type: 'done', truncatedAny: false });
    },
}));

import { NextRequest } from 'next/server';

import * as route from '@/app/api/t/[tenantSlug]/assistant/stream/route';
import { __resetStreamCapacity, streamCapacitySnapshot } from '@/app-layer/ai/assistant/stream-capacity';
import { getPermissionsForRole } from '@/lib/permissions';
import { hasPermission } from '@/lib/security/permission-key';

const request = (): NextRequest =>
    new NextRequest('http://localhost/api/t/acme/assistant/stream', { method: 'POST', body: '{}' });

/**
 * The route's SECOND argument, carrying `params` as a Promise.
 *
 * Next 16 passes params asynchronously, and `permission-middleware` awaits it
 * before resolving the context — its own comment explains that reading a
 * segment off the unawaited Promise yields `undefined`, "silent for a tolerant
 * `findMany`, a 500 for a required composite-key lookup".
 *
 * Passing `undefined` here produced exactly that 500, from a TypeError inside
 * the middleware rather than anything about this route — which is why it is
 * spelled out instead of cast away.
 */
const routeArgs = (): { params: Promise<{ tenantSlug: string }> } => ({
    params: Promise.resolve({ tenantSlug: 'acme' }),
});

/**
 * A context with a REAL permission set, optionally with `controls.view` removed.
 *
 * ═══ WHY THE DENIED CASE IS NOT JUST AN UNKNOWN ROLE ═══
 *
 * Measured rather than assumed: `hasPermission(getPermissionsForRole(r),
 * 'controls.view')` is TRUE for READER *and* for an unrecognised role string —
 * unknown roles fall back to a default set, so there is no role name that
 * denies this key. A test that denied by passing `role: 'NONE'` would be
 * asserting a refusal that never happens, and would pass only because of some
 * other error.
 *
 * So the denied case removes the key explicitly, which is also the shape a real
 * denial takes: a scoped credential or a custom role whose set lacks it. The
 * permission set is nested by domain — `{ controls: { view, ... }, ... }` — so
 * only that one leaf is flipped and the rest of the set stays real.
 */
function ctxFor(opts: { withControlsView: boolean }): Record<string, unknown> {
    const base = getPermissionsForRole('READER' as never) as unknown as Record<string, Record<string, boolean>>;
    const permissions = opts.withControlsView
        ? base
        : { ...base, controls: { ...base.controls, view: false } };
    return {
        requestId: 'req-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        userId: 'user-1',
        role: 'READER',
        // `appPermissions`, not `permissions`. The context carries BOTH, with
        // different meanings, and `hasPermission` reads this one — its signature
        // names the parameter `appPermissions`. Setting the wrong field produced
        // a 500 from inside `assertPermission` rather than a denial, which looks
        // nothing like a permission problem in the logs.
        appPermissions: permissions,
        permissions,
    };
}

beforeEach(() => {
    __resetStreamCapacity();
    appendAuditEntryOrQueueMock.mockClear();
    getTenantCtxMock.mockReset();
});

describe('a principal WITHOUT controls.view is refused and audited', () => {
    it('writes exactly ONE AUTHZ_DENIED entry', async () => {
        // A role whose permission set lacks the key. Driven from the real
        // `getPermissionsForRole`, so a future permission reshuffle changes the
        // fixture with the product rather than leaving it asserting a role that
        // no longer lacks the key.
        getTenantCtxMock.mockResolvedValue(ctxFor({ withControlsView: false }));

        // A RESPONSE, not a rejection: `withApiErrorHandling` converts the
        // thrown `forbidden` into a 403. Asserting `rejects` here would fail
        // against a correctly-denying route.
        const res = await route.POST(request() as never, routeArgs() as never);
        expect(res.status).toBe(403);

        // EXACTLY one. Zero means the deny path skipped the audit; two means a
        // double-write that makes the row lie about how many attempts occurred.
        expect(appendAuditEntryOrQueueMock).toHaveBeenCalledTimes(1);
    });

    it('takes no stream slot when it is refused', async () => {
        // The gate runs BEFORE the capacity lease, so a refused caller cannot
        // consume capacity. Without this, a denial loop would exhaust the
        // per-tenant cap and deny legitimate users — a refusal turning into a
        // denial of service.
        getTenantCtxMock.mockResolvedValue(ctxFor({ withControlsView: false }));
        const res = await route.POST(request() as never, routeArgs() as never);
        expect(res.status).toBe(403);
        expect(streamCapacitySnapshot().total).toBe(0);
    });

    it('does not echo the permission key to the caller', async () => {
        // A 403 naming `controls.view` tells an attacker exactly which key to
        // obtain. `requirePermission` throws a generic `forbidden`, and this
        // asserts the generic-ness rather than trusting it.
        getTenantCtxMock.mockResolvedValue(ctxFor({ withControlsView: false }));

        const res = await route.POST(request() as never, routeArgs() as never);
        const body = await res.text();

        expect(res.status).toBe(403);
        expect(body).not.toMatch(/controls\.view/);
    });
});

describe('a principal WITH controls.view is admitted — the control', () => {
    it('streams, and writes no denial', async () => {
        // Without this the three assertions above are satisfied by a route that
        // refuses everyone, which would be a different defect wearing the same
        // green.
        getTenantCtxMock.mockResolvedValue(ctxFor({ withControlsView: true }));

        const res = await route.POST(request() as never, routeArgs() as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        expect(appendAuditEntryOrQueueMock).not.toHaveBeenCalled();
    });

    it('and the two fixtures really do differ on the key', () => {
        // The fixtures' own premise, asserted. Without this, both cases could be
        // carrying the same permission set and the pair would prove nothing —
        // which is exactly what happened when the denied fixture was an unknown
        // role string that fell back to the default set.
        expect(hasPermission(ctxFor({ withControlsView: true }).appPermissions as never, 'controls.view' as never)).toBe(
            true,
        );
        expect(hasPermission(ctxFor({ withControlsView: false }).appPermissions as never, 'controls.view' as never)).toBe(
            false,
        );
    });
});
