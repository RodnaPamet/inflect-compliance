/**
 * The adapter that hands this product's MCP read tools to an external agent
 * runtime.
 *
 * ── THE TWO CLAIMS WORTH TESTING ────────────────────────────────────────────
 *
 * 1. NOTHING REACHES THE FUNNEL UNGUARDED, AND NOTHING LEAVES IT UNSCANNED.
 *    The egress guard must run BEFORE `runReadTool`, not beside it — a guard
 *    that fires after the funnel is reporting on a read that already happened.
 *    So the decisive assertion is not "the guard was called": it is that when
 *    the guard blocks, `runReadTool` was **never called at all**. Asserting the
 *    call count of the thing that must not happen is the only version of this
 *    test that can fail for the right reason.
 *
 * 2. THE ADVERTISED SET IS THE PERMITTED SET.
 *    A tool the credential's scope or the agent's autonomy ceiling would refuse
 *    is not offered to the model, and the reason it was dropped is reported
 *    rather than swallowed.
 *
 * ── WHAT IS DELIBERATELY NOT TESTED HERE ────────────────────────────────────
 *
 * Authorization. This adapter performs none: exposure, the policy card, the
 * ceiling's enforcement, credential scope and the human route's own permission
 * check all live in `runReadTool`, which has its own suites. A test here that
 * asserted a refusal would be asserting the mock.
 */
import type { McpInvocation } from '@/lib/mcp/authorize';
import type { McpReadTool } from '@/lib/mcp/tools/types';

jest.mock('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn(),
    runReadTool: jest.fn(),
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardEgress: jest.fn(),
    guardUntrustedInput: jest.fn(),
    assertGuardAllowed: jest.fn(),
}));
jest.mock('@/lib/auth/api-key-auth', () => ({
    enforceApiKeyScope: jest.fn(),
}));

import { guardEgress, guardUntrustedInput, assertGuardAllowed } from '@/app-layer/ai/guard';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { loadableReadTools, runReadTool } from '@/lib/mcp/tools/registry';
import { flueToolsFor, runGuardedTool } from '@/lib/agentic/flue/tools-adapter';

const mockLoadable = loadableReadTools as jest.MockedFunction<typeof loadableReadTools>;
const mockRunReadTool = runReadTool as jest.MockedFunction<typeof runReadTool>;
const mockGuardEgress = guardEgress as jest.MockedFunction<typeof guardEgress>;
const mockGuardInput = guardUntrustedInput as jest.MockedFunction<typeof guardUntrustedInput>;
const mockAssert = assertGuardAllowed as jest.MockedFunction<typeof assertGuardAllowed>;
const mockScope = enforceApiKeyScope as jest.MockedFunction<typeof enforceApiKeyScope>;

function tool(name: string, overrides: Partial<McpReadTool<unknown>> = {}): McpReadTool<unknown> {
    return {
        name,
        description: `the ${name} tool`,
        inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
        argsSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        resourceScope: { resource: name, action: 'read' },
        authorize: { basis: 'effective', mirrors: `GET /${name}` },
        run: jest.fn(),
        ...overrides,
    } as McpReadTool<unknown>;
}

function invocation(autonomyCeiling = 6): McpInvocation {
    return {
        ctx: { tenantId: 't1', requestId: 'r1' },
        autonomyCeiling,
    } as unknown as McpInvocation;
}

const CLEAN = { blocked: false } as never;

beforeEach(() => {
    jest.clearAllMocks();
    mockGuardEgress.mockResolvedValue(CLEAN);
    mockGuardInput.mockResolvedValue(CLEAN);
    mockAssert.mockImplementation(() => undefined);
    mockScope.mockImplementation(() => undefined);
    mockRunReadTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"ok":true}' }],
    } as never);
});

describe('the advertised set is the permitted set', () => {
    it('offers a tool that passes every term', () => {
        mockLoadable.mockReturnValue([tool('list_risks')]);
        const set = flueToolsFor(invocation());
        expect(set.tools.map((t) => t.name)).toEqual(['list_risks']);
        expect(set.omitted).toEqual([]);
    });

    it('drops a tool whose resource scope the credential does not hold', () => {
        mockLoadable.mockReturnValue([tool('list_risks'), tool('list_controls')]);
        mockScope.mockImplementation((_ctx, resource) => {
            if (resource === 'list_risks') throw new Error('no scope');
        });

        const set = flueToolsFor(invocation());
        expect(set.tools.map((t) => t.name)).toEqual(['list_controls']);
        expect(set.omitted).toEqual([{ name: 'list_risks', reason: 'SCOPE' }]);
    });

    it('drops a tool whose required autonomy is above the ceiling', () => {
        mockLoadable.mockReturnValue([
            tool('ordinary'),
            tool('ambitious', { authorize: { basis: 'effective', mirrors: 'x', autonomy: 5 } }),
        ]);

        const set = flueToolsFor(invocation(2));
        expect(set.tools.map((t) => t.name)).toEqual(['ordinary']);
        expect(set.omitted).toEqual([{ name: 'ambitious', reason: 'AUTONOMY' }]);
    });

    it('drops — rather than offering unschema\'d — a tool it cannot convert', () => {
        // Offering it with no input schema would hand the model a tool it
        // cannot call correctly and give no signal that anything was wrong.
        mockLoadable.mockReturnValue([
            tool('nested', {
                inputSchema: { type: 'object', properties: { f: { type: 'object' } } },
            }),
        ]);

        const set = flueToolsFor(invocation());
        expect(set.tools).toEqual([]);
        expect(set.omitted).toEqual([{ name: 'nested', reason: 'UNCONVERTIBLE_SCHEMA' }]);
    });

    it('marks every offered tool read-only, which is a fact about the funnel', () => {
        // `runReadTool` can only reach `McpReadTool.run`; the propose tools live
        // behind a different funnel. So this is not a per-tool claim to be kept
        // in sync — it is true by construction of the path.
        mockLoadable.mockReturnValue([tool('a'), tool('b')]);
        const set = flueToolsFor(invocation());
        expect(set.tools.map((t) => t.annotations)).toEqual([
            { readOnlyHint: true, destructiveHint: false, title: 'a' },
            { readOnlyHint: true, destructiveHint: false, title: 'b' },
        ]);
    });
});

describe('the guard sandwich', () => {
    it('guards the arguments BEFORE the funnel and the result AFTER it', async () => {
        const order: string[] = [];
        mockGuardEgress.mockImplementation(async () => {
            order.push('egress');
            return CLEAN;
        });
        mockRunReadTool.mockImplementation(async () => {
            order.push('funnel');
            return { content: [{ type: 'text', text: 'payload' }] } as never;
        });
        mockGuardInput.mockImplementation(async () => {
            order.push('input');
            return CLEAN;
        });

        await runGuardedTool(invocation(), 'list_risks', { limit: 5 }, 'call-1');

        expect(order).toEqual(['egress', 'funnel', 'input']);
    });

    it('NEVER reaches the funnel when the argument guard blocks', async () => {
        // The assertion with teeth. A sandwich whose first slice fires after
        // the filling has already been served is not a sandwich, and "the guard
        // was called" cannot tell the two apart.
        mockAssert.mockImplementationOnce(() => {
            throw new Error('ai_guard_blocked: egress malicious [rule-7]');
        });

        await expect(
            runGuardedTool(invocation(), 'list_risks', { limit: 5 }, 'call-1'),
        ).rejects.toThrow(/ai_guard_blocked/);

        expect(mockRunReadTool).not.toHaveBeenCalled();
    });

    it('does not return the payload when the result guard blocks', async () => {
        // The funnel HAS run here — the read happened — but the injected text
        // must not reach the model.
        mockAssert
            .mockImplementationOnce(() => undefined) // egress: clean
            .mockImplementationOnce(() => {
                throw new Error('ai_guard_blocked: input malicious [rule-2]');
            });

        await expect(
            runGuardedTool(invocation(), 'list_risks', {}, 'call-1'),
        ).rejects.toThrow(/ai_guard_blocked/);

        expect(mockRunReadTool).toHaveBeenCalledTimes(1);
    });

    it('scans the WHOLE result, provenance banner included', async () => {
        mockRunReadTool.mockResolvedValue({
            content: [
                { type: 'text', text: '{"risk":"one"}' },
                { type: 'text', text: 'PROVENANCE: tool output, untrusted' },
            ],
        } as never);

        const out = await runGuardedTool(invocation(), 'list_risks', {}, 'call-1');

        // Both blocks reach the model, so both are scanned and both are
        // returned. Scanning only content[0] would leave an injection in the
        // second block unexamined.
        expect(mockGuardInput).toHaveBeenCalledWith(
            expect.anything(),
            '{"risk":"one"}\nPROVENANCE: tool output, untrusted',
            expect.anything(),
        );
        expect(out).toBe('{"risk":"one"}\nPROVENANCE: tool output, untrusted');
    });

    it('labels each guard verdict with the tool and the runtime\'s call id', async () => {
        await runGuardedTool(invocation(), 'list_risks', {}, 'call-42');

        expect(mockGuardEgress).toHaveBeenCalledWith(expect.anything(), {}, {
            source: 'flue-tool-args:list_risks:call-42',
        });
        expect(mockGuardInput).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
            source: 'flue-tool-result:list_risks:call-42',
        });
    });

    it('passes the runtime-validated arguments through from context.data', async () => {
        // The contract that the compile-time check in the adapter exists to
        // protect: arguments arrive as `context.data`, not as a bare first
        // parameter. A descriptor built against the wrong shape would call the
        // funnel with `undefined` every time.
        mockLoadable.mockReturnValue([tool('list_risks')]);
        const [descriptor] = flueToolsFor(invocation()).tools;

        await descriptor.run({ toolCallId: 'call-9', data: { limit: 7 } });

        expect(mockRunReadTool).toHaveBeenCalledWith(expect.anything(), 'list_risks', {
            limit: 7,
        });
    });
});
