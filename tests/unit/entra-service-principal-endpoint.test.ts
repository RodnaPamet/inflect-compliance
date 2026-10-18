/**
 * #3671 — the service-principal MCP endpoint: who may reach it, what it
 * advertises, and where it lives.
 *
 * Four properties, none of which is "the route returns 200":
 *
 *   1. IT IS THE OUTBOUND SIDE. The route sits under `src/app/api/mcp/` beside
 *      the grant endpoint, and NOTHING the agent-facing server is built from —
 *      `src/lib/mcp/**` — can reach its tools. An agent calling `tools/call` on
 *      `/api/mcp` must find no disable there; the only way to it is a
 *      connection the external-write dispatch sends through.
 *   2. AN UNAUTHENTICATED CALLER REACHES NEITHER USECASE, and neither does a
 *      caller whose connection names a DIFFERENT endpoint — the grant
 *      connection's token must not open the disable. Asserted on the usecase
 *      spies, the only way to say "nothing happened".
 *   3. A REFUSAL THAT NAMES A TENANT IS AUDITED; ONE THAT CANNOT, IS NOT.
 *   4. EXACTLY TWO TOOLS, classified by the real predicate: the disable is a
 *      destructive write, the read is a read (or `setPriorStateRead` refuses the
 *      pairing).
 */
const authMock = jest.fn();
jest.mock('@/app-layer/usecases/entra-grant-auth', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-grant-auth'),
    authenticateGrantCaller: (h: string | null) => authMock(h),
}));

// SPREAD requireActual, never a subset: the barrel re-exports the no-silent-drop
// wrapper, and a subset factory would resolve it to `undefined`.
const auditMock = jest.fn(async (_input: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntryOrQueue: (input: unknown) => auditMock(input as never),
}));

const disableMock = jest.fn();
const readMock = jest.fn();
const bindingMock = jest.fn();
jest.mock('@/app-layer/usecases/entra-service-principal-dispatch', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-service-principal-dispatch'),
    disableServicePrincipal: (c: unknown, a: unknown) => disableMock(c, a),
    readServicePrincipalState: (c: unknown, a: unknown) => readMock(c, a),
    endpointBindingRefusal: (c: unknown, id: unknown) => bindingMock(c, id),
}));

import { NextRequest } from 'next/server';

import {
    POST,
    DISABLE_TOOL,
    READ_TOOL,
    TOOLS,
} from '@/app/api/mcp/entra-service-principal/route';
import { declaresWrite } from '@/lib/mcp/tool-write-classification';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import {
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_ENDPOINT_PATH,
    SERVICE_PRINCIPAL_READ_TOOL,
} from '@/lib/agentic/service-principal-disable';
import { ASYNC_DELIVERY_TOOLS } from '@/app-layer/usecases/external-write-dispatch';
import { repoRelativeFiles } from '../helpers/repo-files';

const CONN = 'conn-sp-abc123';
const TOKEN = `Bearer ${CONN}.s3cret-value`;
const SP = '9f1c2b7e-4a3d-4c1e-8b2f-6d5e4c3b2a19';

const rpc = (body: unknown, auth: string | null = TOKEN): NextRequest =>
    new NextRequest(`http://localhost${SERVICE_PRINCIPAL_ENDPOINT_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(auth === null ? {} : { Authorization: auth }),
        },
        body: JSON.stringify(body),
    });

/** A route with no dynamic segments is still called with a context argument. */
const call = (body: unknown, auth: string | null = TOKEN) => POST(rpc(body, auth), undefined as never);

const toolCall = (name: string, args: unknown) =>
    call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({
        ok: true,
        tenantId: 'tenant-A',
        connectionId: CONN,
        connectionName: 'SP endpoint',
    });
    bindingMock.mockResolvedValue(null);
    disableMock.mockResolvedValue({ ok: true });
    readMock.mockResolvedValue({
        ok: true,
        servicePrincipal: { id: SP, accountEnabled: true, appId: null, displayName: 'agent' },
    });
});

// ═════════════════════════════════════════════════════════════════════
// 1. OUTBOUND, NEVER AGENT-FACING
// ═════════════════════════════════════════════════════════════════════

describe('the disable lives on the outbound endpoint, not on the agent-facing server', () => {
    it('is served under /api/mcp/ as a sibling of the grant endpoint', () => {
        const routes = repoRelativeFiles().filter((f) =>
            /^src\/app\/api\/mcp\/[^/]+\/route\.ts$/.test(f),
        );
        expect(routes).toEqual(
            expect.arrayContaining([
                'src/app/api/mcp/entra-grant/route.ts',
                `src/app${SERVICE_PRINCIPAL_ENDPOINT_PATH}/route.ts`,
            ]),
        );
    });

    it('neither tool is in the agent-facing catalogue', () => {
        // `MCP_TOOL_NAMES` mirrors READ_TOOLS + PROPOSE_TOOLS exactly — the set
        // an agent on `/api/mcp` can call. Neither of these may be in it.
        expect(MCP_TOOL_NAMES.length).toBeGreaterThan(0);
        expect(MCP_TOOL_NAMES).not.toContain(SERVICE_PRINCIPAL_DISABLE_TOOL);
        expect(MCP_TOOL_NAMES).not.toContain(SERVICE_PRINCIPAL_READ_TOOL);
    });

    it('advertises the names the request path and the dispatch use', () => {
        expect(DISABLE_TOOL).toBe(SERVICE_PRINCIPAL_DISABLE_TOOL);
        expect(READ_TOOL).toBe(SERVICE_PRINCIPAL_READ_TOOL);
        // The disable settles ACCEPTED and only the reconcile promotes it; a
        // rename that dropped it from this set would settle APPLIED on a 204.
        expect(ASYNC_DELIVERY_TOOLS.has(DISABLE_TOOL)).toBe(true);
        expect(ASYNC_DELIVERY_TOOLS.has(READ_TOOL)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. WHO MAY REACH IT
// ═════════════════════════════════════════════════════════════════════

describe('the endpoint authenticates a per-connection token bound to THIS endpoint', () => {
    it('an authenticated, bound caller reaches the handler', async () => {
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(200);
        expect(bindingMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A' }), CONN);
    });

    it.each([
        ['no credential', { kind: 'no_credential', attributable: false }],
        ['a malformed token', { kind: 'malformed', attributable: false }],
        ['a wrong secret', { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' }],
        ['a disabled connection', { kind: 'disabled', attributable: true, tenantId: 'tenant-A' }],
    ])('%s is refused 401 and reaches neither usecase', async (_label, refusal) => {
        authMock.mockResolvedValue({ ok: false, refusal });
        const res = await toolCall(DISABLE_TOOL, { servicePrincipalId: SP });
        expect(res.status).toBe(401);
        expect(disableMock).not.toHaveBeenCalled();
        expect(readMock).not.toHaveBeenCalled();
    });

    it("a token whose connection names ANOTHER endpoint is refused — the grant connection cannot disable", async () => {
        bindingMock.mockResolvedValue('That connection is not configured to call this endpoint.');
        const res = await toolCall(DISABLE_TOOL, { servicePrincipalId: SP });
        expect(res.status).toBe(401);
        expect(disableMock).not.toHaveBeenCalled();
        expect(readMock).not.toHaveBeenCalled();
        expect(auditMock).toHaveBeenCalledTimes(1);
        expect((auditMock.mock.calls[0][0] as Record<string, unknown>).detailsJson).toEqual({
            endpoint: 'entra-service-principal',
            reason: 'wrong_endpoint',
        });
    });

    it('an attributable refusal writes AUTHZ_DENIED against the connection, with no credential in it', async () => {
        authMock.mockResolvedValue({
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: 'tenant-A' },
        });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).toHaveBeenCalledTimes(1);
        const entry = auditMock.mock.calls[0][0] as Record<string, unknown>;
        expect(entry.action).toBe('AUTHZ_DENIED');
        expect(entry.tenantId).toBe('tenant-A');
        expect(entry.entityId).toBe(CONN);
        const serialised = JSON.stringify(entry);
        expect(serialised).toContain('secret_mismatch');
        expect(serialised).not.toContain('s3cret-value');
    });

    it('an UNATTRIBUTABLE refusal writes no row — there is no tenant to write it to', async () => {
        authMock.mockResolvedValue({ ok: false, refusal: { kind: 'malformed', attributable: false } });
        await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(auditMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. WHAT IT ADVERTISES
// ═════════════════════════════════════════════════════════════════════

describe('the catalogue is exactly two tools, correctly classified', () => {
    async function listTools() {
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const body = await res.json();
        return body.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    }

    it('advertises TWO tools and no more', async () => {
        const tools = await listTools();
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.name).sort()).toEqual([DISABLE_TOOL, READ_TOOL].sort());
        expect(TOOLS).toHaveLength(2);
    });

    it('the disable is a DESTRUCTIVE write under the real predicate', async () => {
        const disable = (await listTools()).find((t) => t.name === DISABLE_TOOL)!;
        expect(declaresWrite(disable.annotations)).toBe(true);
        expect(disable.annotations?.destructiveHint).toBe(true);
    });

    it('the prior-state read is a READ, or the pairing would be refused', async () => {
        const read = (await listTools()).find((t) => t.name === READ_TOOL)!;
        expect(declaresWrite(read.annotations)).toBe(false);
        expect(read.annotations?.readOnlyHint).toBe(true);
    });

    it('both tools take the same single argument, so the read can carry the write\'s arguments', () => {
        for (const t of TOOLS) {
            const schema = t.inputSchema as { required?: string[]; additionalProperties?: boolean };
            expect(schema.required).toEqual(['servicePrincipalId']);
            expect(schema.additionalProperties).toBe(false);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. HOW IT ANSWERS
// ═════════════════════════════════════════════════════════════════════

describe('tool calls and refusals', () => {
    it('the read answers { servicePrincipal } as JSON text', async () => {
        const res = await toolCall(READ_TOOL, { servicePrincipalId: SP });
        const body = await res.json();
        expect(JSON.parse(body.result.content[0].text).servicePrincipal.id).toBe(SP);
        expect(readMock.mock.calls[0][1]).toEqual({ servicePrincipalId: SP });
    });

    it('the disable reaches its usecase under the SYSTEM context of the authenticated tenant', async () => {
        const res = await toolCall(DISABLE_TOOL, { servicePrincipalId: SP });
        const body = await res.json();
        expect(body.result.isError).toBeFalsy();
        const ctx = disableMock.mock.calls[0][0] as { tenantId: string; userId: string };
        expect(ctx.tenantId).toBe('tenant-A');
        expect(ctx.userId).toBe('system');
    });

    it('a usecase refusal is IN-BAND — isError at HTTP 200', async () => {
        disableMock.mockResolvedValue({ ok: false, refused: 'That service principal is already disabled.' });
        const res = await toolCall(DISABLE_TOOL, { servicePrincipalId: SP });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toContain('already disabled');
    });

    it('an unknown tool is an in-band refusal that names nothing else', async () => {
        const res = await toolCall('grant_time_bounded_access', {});
        const body = await res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toContain('Unknown tool');
        expect(disableMock).not.toHaveBeenCalled();
    });

    it('exposes no resources', async () => {
        const res = await call({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
        const body = await res.json();
        expect(body.result?.resources ?? []).toEqual([]);
    });
});
