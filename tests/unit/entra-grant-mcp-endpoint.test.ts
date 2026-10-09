/**
 * #3297 — the grant MCP endpoint: who may reach it, and what it advertises.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * ────────────────────────────────
 * Three properties, none of which is "the route returns 200":
 *
 *   1. OWNER-ONLY, AND THE ROUTE TABLE AGREES. `admin.tenant_lifecycle` is the
 *      key, ADMIN does not hold it, and the rule in `route-permissions.ts` must
 *      resolve to the same key the handler was wrapped with. Those are two
 *      separate facts — a route can be wrapped correctly and left out of the
 *      table, or listed under a weaker key — so both are asserted, and a
 *      disagreement between them is its own defect.
 *   2. THE WRITE AND THE READ ARE CLASSIFIED CORRECTLY BY THE REAL PREDICATE.
 *      Not "the annotation says X" — the assertion runs `declaresWrite`, the
 *      one definition the dispatch and the pairing both consult. The read must
 *      classify as a read or `setPriorStateRead` refuses the pairing; the grant
 *      must classify as a write or it skips the write rails entirely, which is
 *      the whole reason this endpoint exists.
 *   3. A REFUSAL IS IN-BAND. An operator's bad end date must come back as an
 *      MCP result with `isError`, at HTTP 200, so the client's session survives.
 *      A 500 would also "not grant access", which is why the assertion is on
 *      the shape and not merely on the absence of a grant.
 *
 * WHY THE CATALOGUE IS ASSERTED BY COUNT AS WELL AS BY NAME
 * ────────────────────────────────────────────────────────
 * `toHaveLength(2)` is the load-bearing half. This endpoint's safety argument is
 * that it advertises a grant and its paired read AND NOTHING ELSE — a third tool
 * appearing here reaches a privileged surface whose only intended client is our
 * own dispatch. Checking the two by name would pass with a third beside them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on denial must not reach a
// real database in a unit test. Its existence is the reason this population uses
// `requirePermission` rather than a usecase-layer assert (CLAUDE.md C.1).
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

const grantMock = jest.fn(async (_ctx: unknown, _input: unknown, _now?: Date) => ({
    ok: true as const,
    requestId: 'req-1',
}));
const readMock = jest.fn(async (_ctx: unknown, _args: unknown) => ({
    ok: true as const,
    assignments: [] as unknown[],
}));
jest.mock('@/app-layer/usecases/entra-grant-dispatch', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-grant-dispatch'),
    grantTimeBoundedAccess: (c: unknown, i: unknown, n?: Date) => grantMock(c, i, n),
    readAccessAssignments: (c: unknown, a: unknown) => readMock(c, a),
}));

import { NextRequest } from 'next/server';

import {
    POST,
    GRANT_TOOL,
    READ_TOOL,
} from '@/app/api/t/[tenantSlug]/admin/mcp/entra-grant/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { declaresWrite } from '@/lib/mcp/tool-write-classification';
import { MAX_GRANT_DAYS } from '@/app-layer/integrations/providers/entra-id/entitlement';

const PATH = '/api/t/acme/admin/mcp/entra-grant';

function ctxFor(role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const rpc = (body: unknown): NextRequest =>
    new NextRequest(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

const ARGS = { params: Promise.resolve({ tenantSlug: 'acme' }) };

const GRANT_ARGS = {
    targetId: '46184453-e63b-4f20-86c2-c557ed5d5df9',
    accessPackageId: 'a914b616-e04e-476b-aa37-91038f0b165b',
    assignmentPolicyId: '2264bf65-76ba-417b-a27d-54d291f0cbc8',
    endDateTime: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(ctxFor('OWNER'));
    grantMock.mockResolvedValue({ ok: true as const, requestId: 'req-1' });
    readMock.mockResolvedValue({ ok: true as const, assignments: [] });
});

// ═════════════════════════════════════════════════════════════════════
// 1. WHO MAY REACH IT
// ═════════════════════════════════════════════════════════════════════

describe('the grant endpoint is OWNER-only, and the route table says so too', () => {
    it('the route-permissions rule resolves to admin.tenant_lifecycle', () => {
        // The TABLE's answer, independent of how the handler was wrapped. A
        // route can be wrapped correctly and listed under a weaker key.
        const resolved = resolveRoutePermission(PATH, 'POST');
        expect(resolved).toBeTruthy();
        expect(resolved?.permission).toBe('admin.tenant_lifecycle');
    });

    it('an OWNER reaches the handler', async () => {
        const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ARGS);
        expect(res.status).toBe(200);
    });

    it('an ADMIN is REFUSED — tenant_lifecycle is the OWNER-only key', async () => {
        // The distinction this endpoint rests on. ADMIN holds every other admin
        // flag; `getPermissionsForRole('ADMIN')` returns tenant_lifecycle false
        // explicitly, and that is what keeps a grant out of ADMIN's reach.
        getTenantCtxMock.mockResolvedValue(ctxFor('ADMIN'));
        const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ARGS);
        expect(res.status).toBe(403);
    });

    it('an EDITOR is refused', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('EDITOR'));
        const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ARGS);
        expect(res.status).toBe(403);
    });

    it('a refused caller reaches NEITHER usecase', async () => {
        // The 403 must happen before the handler body. A route that returned 403
        // after calling the usecase would already have written.
        getTenantCtxMock.mockResolvedValue(ctxFor('ADMIN'));
        await POST(rpc({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        }), ARGS);
        expect(grantMock).not.toHaveBeenCalled();
        expect(readMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. WHAT IT ADVERTISES
// ═════════════════════════════════════════════════════════════════════

describe('the catalogue is exactly two tools, correctly classified', () => {
    async function listTools() {
        const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ARGS);
        const body = await res.json();
        return body.result.tools as Array<{
            name: string;
            description: string;
            annotations?: Record<string, unknown>;
        }>;
    }

    it('advertises TWO tools and no more', async () => {
        // The count is the assertion. A third tool here reaches a privileged
        // surface whose only intended client is our own dispatch, and checking
        // the two by name would pass with a third beside them.
        const tools = await listTools();
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.name).sort()).toEqual([GRANT_TOOL, READ_TOOL].sort());
    });

    it('the grant classifies as a WRITE under the real predicate', async () => {
        // `declaresWrite`, not a look at the annotation — it is the one
        // definition the dispatch and the pairing both consult. If this ever
        // returns false the grant skips the write rails, which is the whole
        // reason this endpoint exists instead of a tool on /api/mcp.
        const grant = (await listTools()).find((t) => t.name === GRANT_TOOL)!;
        expect(declaresWrite(grant.annotations)).toBe(true);
    });

    it('the prior-state read classifies as a READ, or the pairing is refused', async () => {
        // `setPriorStateRead` refuses a read that is not declared read-only,
        // because pairing a write as the prior-state read would send two changes
        // per dispatch with the first unjournalled.
        const read = (await listTools()).find((t) => t.name === READ_TOOL)!;
        expect(declaresWrite(read.annotations)).toBe(false);
        expect(read.annotations?.readOnlyHint).toBe(true);
    });

    it('both tools declare readOnlyHint EXPLICITLY, neither by default', async () => {
        // The grant would classify correctly by saying nothing. It says false
        // anyway so the pair reads as deliberate — a pair where one side is
        // explicit and the other relies on a default invites a tidy-up.
        for (const t of await listTools()) {
            expect(t.annotations).toBeDefined();
            expect(Object.hasOwn(t.annotations!, 'readOnlyHint')).toBe(true);
        }
    });

    it("the grant's description quotes the real cap, not a second literal", async () => {
        // The description is PINNED material — `McpToolManifestPin` hashes it and
        // refuses a definition rewritten since a human accepted it — so it must
        // name the bound rather than leave a model to infer that a grant is
        // temporary. Derived from the constant so it cannot drift from the
        // refusal that enforces it.
        const grant = (await listTools()).find((t) => t.name === GRANT_TOOL)!;
        expect(grant.description).toContain(`${MAX_GRANT_DAYS} days`);
        expect(grant.description).toMatch(/refused, not adjusted/);
    });

    it('the grant requires an end date in its schema', async () => {
        const grant = (await listTools()).find((t) => t.name === GRANT_TOOL)!;
        const schema = (grant as unknown as { inputSchema: { required: string[] } }).inputSchema;
        expect(schema.required).toContain('endDateTime');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. HOW IT ANSWERS
// ═════════════════════════════════════════════════════════════════════

describe('tool calls and refusals', () => {
    it('a grant call reaches the usecase and returns the request id', async () => {
        const res = await POST(rpc({
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        }), ARGS);
        expect(res.status).toBe(200);
        expect(grantMock).toHaveBeenCalledTimes(1);
        const body = await res.json();
        expect(JSON.parse(body.result.content[0].text)).toEqual({ requestId: 'req-1' });
        expect(body.result.isError).toBeFalsy();
    });

    it('an unparseable end date becomes an Invalid Date, not a thrown 500', async () => {
        // The route does `new Date(<whatever>)` on purpose so `expiryRefusal`
        // can refuse it by name. Throwing would turn an operator's typo into a
        // 500 instead of a sentence telling them what to fix.
        await POST(rpc({
            jsonrpc: '2.0', id: 8, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: { ...GRANT_ARGS, endDateTime: 'next friday' } },
        }), ARGS);
        const passed = grantMock.mock.calls[0][1] as { endDateTime: Date };
        expect(passed.endDateTime instanceof Date).toBe(true);
        expect(Number.isNaN(passed.endDateTime.getTime())).toBe(true);
    });

    it('a usecase refusal is IN-BAND — isError at HTTP 200, not a 500', async () => {
        grantMock.mockResolvedValue({
            ok: false as const, refused: 'Grant refused: the end date is missing',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        const res = await POST(rpc({
            jsonrpc: '2.0', id: 9, method: 'tools/call',
            params: { name: GRANT_TOOL, arguments: GRANT_ARGS },
        }), ARGS);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/end date is missing/);
    });

    it('an unknown tool name is an in-band refusal, and names nothing else', async () => {
        const res = await POST(rpc({
            jsonrpc: '2.0', id: 10, method: 'tools/call',
            params: { name: 'delete_everything', arguments: {} },
        }), ARGS);
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/Unknown tool/);
        // It must not enumerate what DOES exist.
        expect(body.result.content[0].text).not.toContain(GRANT_TOOL);
    });

    it('malformed JSON is a 400 parse error, not a crash', async () => {
        const res = await POST(
            new NextRequest(`http://localhost${PATH}`, { method: 'POST', body: 'not json' }),
            ARGS,
        );
        expect(res.status).toBe(400);
    });

    it('a batch of only NOTIFICATIONS gets 202 and no body', async () => {
        // A notification carries no id and gets no reply. Answering a batch of
        // them with `[]` would be a response to requests that asked for none.
        const res = await POST(rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), ARGS);
        expect(res.status).toBe(202);
        expect(await res.text()).toBe('');
    });

    it('a batch request gets an array, a single request gets an object', async () => {
        const batch = await POST(rpc([
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]), ARGS);
        expect(Array.isArray(await batch.json())).toBe(true);

        const single = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ARGS);
        expect(Array.isArray(await single.json())).toBe(false);
    });
});
