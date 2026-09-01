/**
 * Unit tests for the MCP wire protocol — `src/lib/mcp/protocol.ts`.
 *
 * This module is PURE protocol (JSON-RPC framing + MCP method dispatch);
 * the only existing exercise of it was `tests/integration/mcp-server.test.ts`,
 * which drives it through the authenticated route and therefore only ever
 * reaches the happy arms. The refusal / fallback / notification branches —
 * the ones a regression would silently take — had no coverage at all.
 *
 * Regression classes protected here:
 *   - protocol-version negotiation falling back to LATEST on an
 *     unrecognised or absent request (a client asking for a version we do
 *     not speak must be answered with one we do, not echoed back).
 *   - the notification contract: `id` ABSENT means "no response"; `id: null`
 *     is a real id and MUST still get an error response. These are two
 *     different states and `== null` would collapse them.
 *   - InvalidParams refusals for `tools/call` without a name and
 *     `resources/read` without a uri — a handler must never be invoked
 *     with a missing selector.
 *   - `rpcError` omitting the `data` KEY entirely when no data is supplied
 *     (a `data: undefined` property is not the same wire shape).
 */
import {
    dispatchMcp,
    rpcSuccess,
    rpcError,
    RpcErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS,
    LATEST_PROTOCOL_VERSION,
    SERVER_INFO,
    type McpHandlers,
    type McpToolDescriptor,
    type McpResourceDescriptor,
    type McpToolResult,
    type McpResourceContents,
    type JsonRpcResponse,
    type JsonRpcSuccess,
    type JsonRpcError,
} from '@/lib/mcp/protocol';

// ─── Handler harness ───
//
// Typed explicitly rather than by inference from bare `jest.fn()` so the
// file is type-correct by construction (the lane runs without tsc).

interface HandlerSpies {
    listTools: jest.Mock<McpToolDescriptor[], []>;
    callTool: jest.Mock<Promise<McpToolResult>, [string, unknown]>;
    listResources: jest.Mock<McpResourceDescriptor[], []>;
    readResource: jest.Mock<Promise<McpResourceContents>, [string]>;
}

const TOOL: McpToolDescriptor = {
    name: 'ic_list_controls',
    description: 'List controls',
    inputSchema: { type: 'object', properties: {} },
};

const RESOURCE: McpResourceDescriptor = {
    uri: 'ic://frameworks',
    name: 'Frameworks',
};

const TOOL_RESULT: McpToolResult = {
    content: [{ type: 'text', text: '{"rows":[]}' }],
};

const RESOURCE_CONTENTS: McpResourceContents = {
    contents: [{ uri: 'ic://frameworks', mimeType: 'application/json', text: '[]' }],
};

function makeHandlers(): HandlerSpies {
    return {
        listTools: jest.fn<McpToolDescriptor[], []>(() => [TOOL]),
        callTool: jest.fn<Promise<McpToolResult>, [string, unknown]>(
            async () => TOOL_RESULT,
        ),
        listResources: jest.fn<McpResourceDescriptor[], []>(() => [RESOURCE]),
        readResource: jest.fn<Promise<McpResourceContents>, [string]>(
            async () => RESOURCE_CONTENTS,
        ),
    };
}

/** Narrow a dispatch result to the success arm, failing loudly otherwise. */
function asSuccess(res: JsonRpcResponse | null): JsonRpcSuccess {
    expect(res).not.toBeNull();
    expect(res).toHaveProperty('result');
    return res as JsonRpcSuccess;
}

/** Narrow a dispatch result to the error arm, failing loudly otherwise. */
function asError(res: JsonRpcResponse | null): JsonRpcError {
    expect(res).not.toBeNull();
    expect(res).toHaveProperty('error');
    return res as JsonRpcError;
}

let handlers: HandlerSpies;

beforeEach(() => {
    handlers = makeHandlers();
});

// ─── rpcSuccess / rpcError framing ───

describe('rpcError data-key omission', () => {
    it('OMITS the `data` key entirely when no data is supplied', () => {
        const err = rpcError(7, RpcErrorCode.InvalidParams, 'bad params');

        // `toEqual` ignores an explicit `undefined`, so it cannot tell
        // `{code,message}` from `{code,message,data:undefined}`. Assert the
        // key set directly — that is the wire shape that matters.
        expect(Object.keys(err.error).sort()).toStrictEqual(['code', 'message']);
        expect('data' in err.error).toBe(false);
        expect(err).toStrictEqual({
            jsonrpc: '2.0',
            id: 7,
            error: { code: RpcErrorCode.InvalidParams, message: 'bad params' },
        });
    });

    it('INCLUDES the `data` key when data is supplied, even when falsy', () => {
        const withNull = rpcError(1, RpcErrorCode.InternalError, 'boom', null);
        expect('data' in withNull.error).toBe(true);
        expect(withNull.error.data).toBeNull();

        const withZero = rpcError(1, RpcErrorCode.InternalError, 'boom', 0);
        expect('data' in withZero.error).toBe(true);
        expect(withZero.error.data).toBe(0);
    });

    it('rpcSuccess frames jsonrpc/id/result exactly', () => {
        expect(rpcSuccess('abc', { ok: 1 })).toStrictEqual({
            jsonrpc: '2.0',
            id: 'abc',
            result: { ok: 1 },
        });
        // A null id is a legal JSON-RPC id and must be preserved verbatim.
        expect(rpcSuccess(null, {}).id).toBeNull();
    });
});

// ─── initialize ───

describe('dispatchMcp — initialize protocol-version negotiation', () => {
    it('echoes a requested version that this server supports', async () => {
        const older = SUPPORTED_PROTOCOL_VERSIONS[1];
        const res = asSuccess(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: older } },
                handlers,
            ),
        );
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe(older);
        // Guard against the fallback silently swallowing a supported request.
        expect(older).not.toBe(LATEST_PROTOCOL_VERSION);
    });

    it('falls back to LATEST for an UNSUPPORTED requested version', async () => {
        const res = asSuccess(
            await dispatchMcp(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '1999-01-01' },
                },
                handlers,
            ),
        );
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe(
            LATEST_PROTOCOL_VERSION,
        );
    });

    it('falls back to LATEST when params are absent entirely', async () => {
        const res = asSuccess(
            await dispatchMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' }, handlers),
        );
        const result = res.result as {
            protocolVersion: string;
            capabilities: unknown;
            serverInfo: unknown;
            instructions: string;
        };
        expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        expect(result.capabilities).toStrictEqual({ tools: {}, resources: {} });
        // Value equality, NOT `toBe`: the wire shape is what the client sees,
        // so returning a copy (`{ ...SERVER_INFO }`) must stay green. A
        // reference-identity assertion here reddens on that no-op refactor
        // while catching nothing a value comparison misses.
        expect(result.serverInfo).toStrictEqual(SERVER_INFO);
        // The instructions declare the read-only posture to the agent —
        // dropping that sentence is a semantic regression, not cosmetics.
        expect(result.instructions).toContain('never mutates data directly');
    });

    it('falls back to LATEST when params exist but carry no protocolVersion', async () => {
        const res = asSuccess(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: {} } },
                handlers,
            ),
        );
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe(
            LATEST_PROTOCOL_VERSION,
        );
    });
});

// ─── notifications & ping ───

describe('dispatchMcp — notification contract', () => {
    it('returns null (no response body) for client notifications', async () => {
        expect(
            await dispatchMcp(
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                handlers,
            ),
        ).toBeNull();
        expect(
            await dispatchMcp(
                { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } },
                handlers,
            ),
        ).toBeNull();
    });

    it('returns null for an UNKNOWN method sent as a notification (no id)', async () => {
        expect(
            await dispatchMcp({ jsonrpc: '2.0', method: 'totally/unknown' }, handlers),
        ).toBeNull();
    });

    it('an EXPLICIT null id is a real id — unknown method still errors', async () => {
        // The load-bearing distinction: `request.id === undefined` (absent)
        // means notification; `id: null` does NOT. A `== null` check would
        // collapse these two and swallow the error response.
        const res = asError(
            await dispatchMcp(
                { jsonrpc: '2.0', id: null, method: 'totally/unknown' },
                handlers,
            ),
        );
        expect(res.id).toBeNull();
        expect(res.error.code).toBe(RpcErrorCode.MethodNotFound);
        expect(res.error.message).toBe('Method not found: totally/unknown');
    });

    it('names the offending method in the MethodNotFound message', async () => {
        const res = asError(
            await dispatchMcp({ jsonrpc: '2.0', id: 9, method: 'tools/delete' }, handlers),
        );
        expect(res.error.code).toBe(RpcErrorCode.MethodNotFound);
        expect(res.error.message).toBe('Method not found: tools/delete');
        expect(res.id).toBe(9);
    });

    it('ping answers with an empty result object', async () => {
        const res = asSuccess(await dispatchMcp({ jsonrpc: '2.0', id: 2, method: 'ping' }, handlers));
        expect(res.result).toStrictEqual({});
        expect(res.id).toBe(2);
    });
});

// ─── tools ───

describe('dispatchMcp — tools/list and tools/call', () => {
    it('tools/list wraps the handler output under `tools`', async () => {
        const res = asSuccess(
            await dispatchMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, handlers),
        );
        expect(res.result).toStrictEqual({ tools: [TOOL] });
        expect(handlers.listTools).toHaveBeenCalledTimes(1);
    });

    it('tools/call REFUSES with InvalidParams when params are absent', async () => {
        const res = asError(
            await dispatchMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call' }, handlers),
        );
        expect(res.error.code).toBe(RpcErrorCode.InvalidParams);
        expect(res.error.message).toBe('Missing tool name');
        // The refusal must happen BEFORE the handler is reached.
        expect(handlers.callTool).not.toHaveBeenCalled();
    });

    it('tools/call REFUSES with InvalidParams when the name is empty', async () => {
        const res = asError(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: '' } },
                handlers,
            ),
        );
        expect(res.error.code).toBe(RpcErrorCode.InvalidParams);
        expect(res.error.message).toBe('Missing tool name');
        expect(handlers.callTool).not.toHaveBeenCalled();
    });

    it('tools/call defaults ABSENT arguments to {} rather than undefined', async () => {
        const res = asSuccess(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ic_list_controls' } },
                handlers,
            ),
        );
        expect(res.result).toStrictEqual(TOOL_RESULT);
        expect(handlers.callTool).toHaveBeenCalledTimes(1);
        // A tool receiving `undefined` instead of `{}` would blow up in its
        // own zod parse — assert the exact second argument.
        expect(handlers.callTool.mock.calls[0][0]).toBe('ic_list_controls');
        expect(handlers.callTool.mock.calls[0][1]).toStrictEqual({});
    });

    it('tools/call forwards supplied arguments verbatim', async () => {
        await dispatchMcp(
            {
                jsonrpc: '2.0',
                id: 6,
                method: 'tools/call',
                params: { name: 'ic_list_controls', arguments: { limit: 5, status: 'ACTIVE' } },
            },
            handlers,
        );
        expect(handlers.callTool).toHaveBeenCalledWith('ic_list_controls', {
            limit: 5,
            status: 'ACTIVE',
        });
    });

    it('does NOT swallow a handler exception — the route maps it', async () => {
        handlers.callTool.mockRejectedValueOnce(new Error('forbidden'));
        await expect(
            dispatchMcp(
                { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } },
                handlers,
            ),
        ).rejects.toThrow('forbidden');
    });
});

// ─── resources ───

describe('dispatchMcp — resources/list and resources/read', () => {
    it('resources/list wraps the handler output under `resources`', async () => {
        const res = asSuccess(
            await dispatchMcp({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, handlers),
        );
        expect(res.result).toStrictEqual({ resources: [RESOURCE] });
        expect(handlers.listResources).toHaveBeenCalledTimes(1);
    });

    it('resources/read REFUSES with InvalidParams when params are absent', async () => {
        const res = asError(
            await dispatchMcp({ jsonrpc: '2.0', id: 9, method: 'resources/read' }, handlers),
        );
        expect(res.error.code).toBe(RpcErrorCode.InvalidParams);
        expect(res.error.message).toBe('Missing resource uri');
        expect(handlers.readResource).not.toHaveBeenCalled();
    });

    it('resources/read REFUSES with InvalidParams when the uri is empty', async () => {
        const res = asError(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: '' } },
                handlers,
            ),
        );
        expect(res.error.code).toBe(RpcErrorCode.InvalidParams);
        expect(res.error.message).toBe('Missing resource uri');
        expect(handlers.readResource).not.toHaveBeenCalled();
    });

    it('resources/read passes the uri through and returns contents unwrapped', async () => {
        const res = asSuccess(
            await dispatchMcp(
                { jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'ic://frameworks' } },
                handlers,
            ),
        );
        expect(handlers.readResource).toHaveBeenCalledWith('ic://frameworks');
        expect(res.result).toStrictEqual(RESOURCE_CONTENTS);
    });
});

// ─── async handler shapes ───

describe('dispatchMcp — handlers may be sync or async', () => {
    it('awaits a Promise-returning listTools', async () => {
        const asyncHandlers: McpHandlers = {
            ...handlers,
            listTools: async (): Promise<McpToolDescriptor[]> => [TOOL],
        };
        const res = asSuccess(
            await dispatchMcp({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, asyncHandlers),
        );
        // A missing `await` would leave a Promise in the payload.
        expect(res.result).toStrictEqual({ tools: [TOOL] });
    });

    it('awaits a Promise-returning listResources', async () => {
        const asyncHandlers: McpHandlers = {
            ...handlers,
            listResources: async (): Promise<McpResourceDescriptor[]> => [RESOURCE],
        };
        const res = asSuccess(
            await dispatchMcp({ jsonrpc: '2.0', id: 12, method: 'resources/list' }, asyncHandlers),
        );
        expect(res.result).toStrictEqual({ resources: [RESOURCE] });
    });
});
