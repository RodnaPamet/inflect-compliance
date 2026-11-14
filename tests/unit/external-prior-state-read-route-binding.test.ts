/**
 * The prior-state-read PUT and DELETE act on the connection their URL names,
 * and the DELETE reports what it removed (#5303).
 *
 * Both used to ignore `params.connectionId`: a body naming connection B's
 * tools set or removed B's pairing through A's URL. And the DELETE answered
 * `cleared: true` whatever it removed, so a mistyped write name reported a
 * withdrawal while the write stayed paired.
 */
const deleteMany = jest.fn();
const upsert = jest.fn();
const listExternalMcpTools = jest.fn();

jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (_key: string, handler: (req: Request, args: unknown, ctx: unknown) => unknown) =>
        async (req: Request, args: { params: Promise<unknown> }) =>
            handler(req, { params: await args.params }, { tenantId: 't1', userId: 'u1' }),
}));
jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ externalToolPriorStateRead: { deleteMany: (a: unknown) => deleteMany(a), upsert: (a: unknown) => upsert(a) } }),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/usecases/external-mcp-tools', () => ({
    listExternalMcpTools: (...a: unknown[]) => listExternalMcpTools(...a),
}));

import { PUT, DELETE } from '@/app/api/t/[tenantSlug]/admin/external-prior-state-read/[connectionId]/route';

const A = 'cmconnaaaaaaaaaaaaaaaaaa';
const B = 'cmconnbbbbbbbbbbbbbbbbbb';
const tool = (conn: string, name: string) => `mcp__${conn}__${name}`;

type Handler = (req: Request, args: { params: Promise<unknown> }) => Promise<Response>;
function call(handler: unknown, method: string, body: unknown, connectionId = A) {
    return (handler as Handler)(
        new Request(`http://localhost/api/t/acme/admin/external-prior-state-read/${connectionId}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ tenantSlug: 'acme', connectionId }) },
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    deleteMany.mockResolvedValue({ count: 1 });
    listExternalMcpTools.mockImplementation(async (_ctx: unknown, conn: string) => ({
        connectionId: conn,
        tools: [
            { toolName: tool(conn, 'set_x'), advertisedName: 'set_x', connectionId: conn, declaresWrite: true },
            { toolName: tool(conn, 'get_x'), advertisedName: 'get_x', connectionId: conn, declaresWrite: false },
        ],
    }));
});

describe('DELETE reports what it removed', () => {
    it('cleared:true when a pairing was removed', async () => {
        const res = await call(DELETE, 'DELETE', { writeToolName: tool(A, 'set_x') });
        expect(await res.json()).toEqual({ writeToolName: tool(A, 'set_x'), cleared: true });
    });

    it('cleared:false when the name had no pairing', async () => {
        deleteMany.mockResolvedValue({ count: 0 });
        const res = await call(DELETE, 'DELETE', { writeToolName: tool(A, 'set_typo') });
        expect(await res.json()).toEqual({ writeToolName: tool(A, 'set_typo'), cleared: false });
    });
});

describe('both act only on the connection in the URL', () => {
    it('a DELETE on A naming B’s write is refused and removes nothing', async () => {
        await expect(call(DELETE, 'DELETE', { writeToolName: tool(B, 'set_x') })).rejects.toThrow(
            /not a tool of this connection/,
        );
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('a PUT on A naming B’s tools is refused and stores nothing', async () => {
        await expect(
            call(PUT, 'PUT', { writeToolName: tool(B, 'set_x'), readToolName: tool(B, 'get_x') }),
        ).rejects.toThrow(/not a tool of this connection/);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('a PUT on A naming A’s tools is stored', async () => {
        const res = await call(PUT, 'PUT', { writeToolName: tool(A, 'set_x'), readToolName: tool(A, 'get_x') });
        expect(await res.json()).toEqual({ writeToolName: tool(A, 'set_x'), readToolName: tool(A, 'get_x') });
        expect(upsert).toHaveBeenCalledTimes(1);
    });
});
