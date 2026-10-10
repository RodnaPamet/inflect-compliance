/**
 * #3297 / #3323 — the grant MCP endpoint: who may reach it, and what it advertises.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * ────────────────────────────────
 * Four properties, none of which is "the route returns 200":
 *
 *   1. AN UNAUTHENTICATED CALLER REACHES NEITHER USECASE. The 401 must happen
 *      before the body is parsed and before any tool runs, so the assertions
 *      are on the usecase spies NOT having been called — the only way to state
 *      "nothing happened" rather than "nothing was returned".
 *   2. AN ATTRIBUTABLE REFUSAL IS AUDITED; AN UNATTRIBUTABLE ONE IS NOT.
 *      `requirePermission` wrote AUTHZ_DENIED for free and this endpoint no
 *      longer has it, so the row is written explicitly — but only where a
 *      tenant is known. A malformed token names no tenant and `AuditLog` is
 *      tenant-scoped, so there is nothing to write and inventing a row would
 *      mean guessing whose trail it belongs in. Both halves are asserted,
 *      because the gap is a decision and not an oversight.
 *   3. THE WRITE AND THE READ ARE CLASSIFIED BY THE REAL PREDICATE. The
 *      assertion runs `declaresWrite`, the one definition the dispatch and the
 *      pairing both consult — not a look at the annotation. The read must
 *      classify as a read or `setPriorStateRead` refuses the pairing; the grant
 *      must classify as a write or it skips the write rails, which is the whole
 *      reason this endpoint exists.
 *   4. A REFUSAL FROM A TOOL IS IN-BAND. An operator's bad end date comes back
 *      as an MCP result with `isError` at HTTP 200, so the client's session
 *      survives. A 500 would also "not grant access", which is why the
 *      assertion is on the shape rather than on the absence of a grant.
 *
 * WHY THE CATALOGUE IS ASSERTED BY COUNT
 * ──────────────────────────────────────
 * `toHaveLength(2)` is load-bearing. This endpoint's safety argument is that it
 * advertises a grant and its paired read AND NOTHING ELSE — a third tool here
 * reaches a privileged surface whose only intended client is our own dispatch.
 * Checking the two by name would pass with a third beside them. Discovery
 * (#3329) is deliberately elsewhere for exactly this reason.
 */
const authMock = jest.fn();
jest.mock('@/app-layer/usecases/entra-grant-auth', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-grant-auth'),
    authenticateGrantCaller: (h: string | null) => authMock(h),
}));

// SPREAD requireActual, not a subset factory. `partial-mock-of-a-guarded-barrel`
// caps subset mocks of this barrel: it re-exports `appendAuditEntryOrQueue`, the
// no-silent-drop wrapper (#2657), and a factory supplying only some names
// resolves the rest to `undefined` — so a call meant to guarantee an audit row
// silently does nothing while every assertion still passes.
const auditMock = jest.fn(async (_input: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntryOrQueue: (input: unknown) => auditMock(input as never),
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-x',
        entryHash: 'hash-x',
        previousHash: null,
    })),
}));

const grantMock = jest.fn(async (_ctx: unknown, _input: unknown, _now?: Date) => ({
    ok: true as const,
    requestId: 'req-1',
}));
const readMock = jest.fn(async (_ctx: unknown, _args: unknown) => ({
    ok: true as const,
    assignments: [] as unknown[],
}));
const revokeMock = jest.fn(async (_ctx: unknown, _input: unknown) => ({
    ok: true as const,
    requestId: 'req-rev',
}));
jest.mock('@/app-layer/usecases/entra-grant-dispatch', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-grant-dispatch'),
    grantTimeBoundedAccess: (c: unknown, i: unknown, n?: Date) => grantMock(c, i, n),
    readAccessAssignments: (c: unknown, a: unknown) => readMock(c, a),
    // #3374. This module is PARTIALLY mocked, so a new export has to be added
    // here too: without it the route reaches `undefined` and fails with
    // "is not a function" at call time rather than at import.
    revokeAccessAssignment: (c: unknown, i: unknown) => revokeMock(c, i),
}));

import { NextRequest } from 'next/server';

import { POST, GRANT_TOOL, READ_TOOL, REVOKE_TOOL } from '@/app/api/mcp/entra-grant/route';
import { declaresWrite } from '@/lib/mcp/tool-write-classification';
import { MAX_GRANT_DAYS } from '@/app-layer/integrations/providers/entra-id/entitlement';

const PATH = '/api/mcp/entra-grant';
const CONN = 'conn-abc123';
const TOKEN = `Bearer ${CONN}.s3cret-value`;

const rpc = (body: unknown, auth: string | null = TOKEN): NextRequest =>
    new NextRequest(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(auth === null ? {} : { Authorization: auth }),
        },
        body: JSON.stringify(body),
    });

/**
 * `withApiErrorHandling` returns an `ApiRouteHandler<Context>` whose both
 * overloads declare a required `ctx`, so a route with no dynamic segments is
 * still called with two arguments. The cast lives here once rather than at
 * nineteen call sites — each copy would be a chance to write something
 * meaningful into a slot this route never reads.
 */
const call = (body: unknown, auth: string | null = TOKEN) =>
    POST(rpc(body, auth), undefined as never);

const GRANT_ARGS = {
    targetId: '46184453-e63b-4f20-86c2-c557ed5d5df9',
    accessPackageId: 'a914b616-e04e-476b-aa37-91038f0b165b',
    assignmentPolicyId: '2264bf65-76ba-417b-a27d-54d291f0cbc8',
    endDateTime: '2026-11-01T00:00:00.000Z',
};

const AUTHED = {
    ok: true as const,
    tenantId: 'tenant-A',
    connectionId: CONN,
    connectionName: 'Grant endpoint',
};

beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue(AUTHED);
    grantMock.mockResolvedValue({ ok: true as const, requestId: 'req-1' });
    readMock.mockResolvedValue({ ok: true as const, assignments: [] });
    auditMock.mockResolvedValue({ recorded: 'chain' as const, auditId: 'audit-x' });
});

// ═════════════════════════════════════════════════════════════════════
// 1. WHO MAY REACH IT
// ═════════════════════════════════════════════════════════════════════

describe('the endpoint authenticates a per-connection token, not a permission', () => {
    it('an authenticated caller reaches the handler', async () => {
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(200);
    });

    it.each([
        ['no credential', { kind: 'no_credential', attributable: false }],
        ['a malformed token', { kind: 'malformed', attributable: false }],
        ['an unknown connection', { kind: 'unknown_connection', attributable: false }],
        ['a wrong secret', { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' }],
        ['a disabled connection', { kind: 'disabled', attributable: true, tenantId: 'tenant-A' }],
    ])('%s is refused 401', async (_label, refusal) => {
        authMock.mockResolvedValue({ ok: false, refusal });
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
    });

    it('a refused caller reaches NEITHER usecase', async () => {
        // The only way to say "nothing happened". A route that 401'd after
        // calling the usecase would already have written.
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' },
        });
        await call({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        });
        expect(grantMock).not.toHaveBeenCalled();
        expect(readMock).not.toHaveBeenCalled();
    });

    it('authenticates BEFORE parsing the body — malformed JSON from a bad caller is still 401', async () => {
        // Order matters: a caller that may not be here must not have its
        // payload parsed, and a refusal must cost the same whatever it sent.
        authMock.mockResolvedValue({ ok: false, refusal: { kind: 'malformed', attributable: false } });
        const res = await POST(
            new NextRequest(`http://localhost${PATH}`, { method: 'POST', body: 'not json' }),
            undefined as never,
        );
        expect(res.status).toBe(401);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. THE REFUSAL TRAIL `requirePermission` USED TO GIVE FOR FREE
// ═════════════════════════════════════════════════════════════════════

describe('an attributable refusal is audited; an unattributable one cannot be', () => {
    it('a wrong secret writes AUTHZ_DENIED against the connection', async () => {
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' },
        });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).toHaveBeenCalledTimes(1);
        const entry = auditMock.mock.calls[0][0] as Record<string, unknown>;
        expect(entry.tenantId).toBe('tenant-A');
        expect(entry.action).toBe('AUTHZ_DENIED');
        expect(entry.entity).toBe('IntegrationConnection');
        expect(entry.entityId).toBe(CONN);
        expect(entry.detailsJson).toEqual({ endpoint: 'entra-grant', reason: 'secret_mismatch' });
    });

    it('an OAuth-shadowed connection is audited by that name, not as a mismatch', async () => {
        // The diagnosability this refusal exists for (#3340). If the trail
        // said `secret_mismatch`, an operator reading it would go and check a
        // secret that is correct; the cause is two credentials where only one
        // is sent, and the row has to say so for anyone to find it.
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'oauth_shadows_static', attributable: true, tenantId: 'tenant-A' },
        });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).toHaveBeenCalledTimes(1);
        const entry = auditMock.mock.calls[0][0] as Record<string, unknown>;
        expect(entry.action).toBe('AUTHZ_DENIED');
        expect(entry.detailsJson).toEqual({
            endpoint: 'entra-grant',
            reason: 'oauth_shadows_static',
        });
    });

    it('the audit row carries NO part of the presented credential', async () => {
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' },
        });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const serialised = JSON.stringify(auditMock.mock.calls[0][0]);
        // POSITIVE CONTROL first. Both assertions below are negated, and a
        // negated assertion over an empty or absent window passes while
        // checking nothing — so prove the row was captured before asserting
        // what it lacks.
        expect(serialised).toContain('AUTHZ_DENIED');
        expect(serialised).not.toContain('s3cret-value');
        expect(serialised).not.toContain(TOKEN);
        // NOT the secret's LENGTH. That assertion was here and was unsound in
        // both directions: `'s3cret-value'.length` is 12 and the connection id
        // `conn-abc123` contains "12", so it failed for a reason that is not a
        // leak — and had the length been a digit string absent from the row it
        // would have passed without the endpoint doing anything right.
    });

    it('an UNATTRIBUTABLE refusal writes no row, because there is no tenant to write it to', async () => {
        // The deliberate gap. `AuditLog` is tenant-scoped and a malformed token
        // names no tenant, so a row here would mean guessing whose trail it
        // belongs in. Asserted so the gap reads as a decision.
        authMock.mockResolvedValue({ ok: false, refusal: { kind: 'malformed', attributable: false } });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).not.toHaveBeenCalled();
    });

    it('a failed audit write does not turn the 401 into a 500', async () => {
        // Best-effort, like `requirePermission`'s own: the refusal already
        // happened and the caller is owed its answer either way.
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' },
        });
        auditMock.mockRejectedValue(new Error('chain and outbox both unavailable'));
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
    });

    it('an AUTHENTICATED call writes no AUTHZ_DENIED row', async () => {
        // The positive control: the audit assertions above are about refusals,
        // not about the endpoint auditing everything it touches.
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. WHAT IT ADVERTISES
// ═════════════════════════════════════════════════════════════════════

describe('the catalogue is exactly three tools, correctly classified', () => {
    async function listTools() {
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const body = await res.json();
        return body.result.tools as Array<{
            name: string;
            description: string;
            annotations?: Record<string, unknown>;
        }>;
    }

    it('advertises THREE tools and no more', async () => {
        // Pinned by COUNT and by NAME. #3374 added the withdrawal, and this
        // assertion is what made that deliberate rather than incidental: a
        // tool arriving on this endpoint is a new thing a model can be asked
        // to do against a customer's directory.
        const tools = await listTools();
        expect(tools).toHaveLength(3);
        expect(tools.map((t) => t.name).sort()).toEqual(
            [GRANT_TOOL, REVOKE_TOOL, READ_TOOL].sort(),
        );
    });

    it('the withdrawal classifies as a WRITE, and says so DESTRUCTIVELY', async () => {
        // Both are writes; only one removes access, and `destructiveHint` is
        // the field a client uses to decide whether to confirm with a human.
        // The PAIR is the point — a client treating them alike would either
        // confirm every grant or confirm no withdrawal.
        const tools = await listTools();
        const revoke = tools.find((t) => t.name === REVOKE_TOOL)!;
        expect(declaresWrite(revoke.annotations)).toBe(true);
        expect(revoke.annotations?.destructiveHint).toBe(true);
        expect(tools.find((t) => t.name === GRANT_TOOL)!.annotations?.destructiveHint).toBe(false);
    });

    it("the withdrawal's description names both refusals a caller will hit", async () => {
        // Pinned material a human accepts. A model told only "ends access now"
        // will retry a refusal it cannot interpret; these two are the ones it
        // will actually meet.
        const revoke = (await listTools()).find((t) => t.name === REVOKE_TOOL)!;
        expect(revoke.description).toMatch(/no live assignment/i);
        expect(revoke.description).toMatch(/more than one/i);
    });

    it('the grant classifies as a WRITE under the real predicate', async () => {
        const grant = (await listTools()).find((t) => t.name === GRANT_TOOL)!;
        expect(declaresWrite(grant.annotations)).toBe(true);
    });

    it('the prior-state read classifies as a READ, or the pairing is refused', async () => {
        const read = (await listTools()).find((t) => t.name === READ_TOOL)!;
        expect(declaresWrite(read.annotations)).toBe(false);
        expect(read.annotations?.readOnlyHint).toBe(true);
    });

    it('every tool declares readOnlyHint EXPLICITLY, none by default', async () => {
        for (const t of await listTools()) {
            expect(t.annotations).toBeDefined();
            expect(Object.hasOwn(t.annotations!, 'readOnlyHint')).toBe(true);
        }
    });

    it("the grant's description quotes the real cap, not a second literal", async () => {
        const grant = (await listTools()).find((t) => t.name === GRANT_TOOL)!;
        expect(grant.description).toContain(`${MAX_GRANT_DAYS} days`);
        expect(grant.description).toMatch(/refused, not adjusted/);
    });

    it("the read's description says an EXPIRED assignment is not a holding", async () => {
        // Measured live (#3311): an assignment that lapses stays in the
        // collection as `expired` rather than being deleted, which is why
        // #3326 exists. The description is pinned material a human accepts, so
        // it must not let a model read a lapsed row as current access.
        const read = (await listTools()).find((t) => t.name === READ_TOOL)!;
        expect(read.description).toMatch(/expired/i);
        expect(read.description).toMatch(/NOT a current holding/i);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. HOW IT ANSWERS
// ═════════════════════════════════════════════════════════════════════

describe('tool calls and refusals', () => {
    it('a grant call reaches the usecase and returns the request id', async () => {
        const res = await call({
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        });
        expect(res.status).toBe(200);
        expect(grantMock).toHaveBeenCalledTimes(1);
        const body = await res.json();
        expect(JSON.parse(body.result.content[0].text)).toEqual({ requestId: 'req-1' });
        expect(body.result.isError).toBeFalsy();
    });

    it('the usecase receives the SYSTEM context for the authenticated tenant', async () => {
        // The actor is the machine. A delegated context would attribute a
        // machine write to whichever user happened to be resolvable.
        await call({
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        });
        const ctx = grantMock.mock.calls[0][0] as { tenantId: string; userId: unknown };
        expect(ctx.tenantId).toBe('tenant-A');
        // The SENTINEL, not null. `buildSystemContext` sets `userId: 'system'`
        // deliberately and greppably; a null would also be true of a context
        // that merely failed to resolve a user, so it is the weaker claim.
        expect(ctx.userId).toBe('system');
    });

    it('an unparseable end date becomes an Invalid Date, not a thrown 500', async () => {
        await call({
            jsonrpc: '2.0', id: 8, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: { ...GRANT_ARGS, endDateTime: 'next friday' } },
        });
        const passed = grantMock.mock.calls[0][1] as { endDateTime: Date };
        expect(passed.endDateTime instanceof Date).toBe(true);
        expect(Number.isNaN(passed.endDateTime.getTime())).toBe(true);
    });

    it('a usecase refusal is IN-BAND — isError at HTTP 200, not a 500', async () => {
        grantMock.mockResolvedValue({
            ok: false as const, refused: 'Grant refused: the end date is missing',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        const res = await call({
            jsonrpc: '2.0', id: 9, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/end date is missing/);
    });

    it('an unknown tool name is an in-band refusal, and names nothing else', async () => {
        const res = await call({
            jsonrpc: '2.0', id: 10, method: 'tools/call',
            params: { name: 'delete_everything', arguments: {} },
        });
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/Unknown tool/);
        expect(body.result.content[0].text).not.toContain(GRANT_TOOL);
    });

    it('malformed JSON from an AUTHENTICATED caller is a 400 parse error', async () => {
        const res = await POST(
            new NextRequest(`http://localhost${PATH}`, {
                method: 'POST',
                headers: { Authorization: TOKEN },
                body: 'not json',
            }),
            undefined as never,
        );
        expect(res.status).toBe(400);
    });

    it('a batch of only NOTIFICATIONS gets 202 and no body', async () => {
        const res = await call([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
        expect(res.status).toBe(202);
        expect(await res.text()).toBe('');
    });

    it('a batch request gets an array, a single request gets an object', async () => {
        const batch = await call([
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]);
        expect(Array.isArray(await batch.json())).toBe(true);
        const single = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(Array.isArray(await single.json())).toBe(false);
    });

    it('exposes no resources, and a resources/read is refused', async () => {
        // `dispatchMcp` advertises a resources capability unconditionally, so
        // this endpoint claims one whether or not it has any. Defaulting the
        // handlers to the agent-facing server's would reach this tenant's
        // compliance data from a grant endpoint.
        const list = await call({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
        const body = await list.json();
        expect(body.result?.resources ?? []).toEqual([]);
    });
});
