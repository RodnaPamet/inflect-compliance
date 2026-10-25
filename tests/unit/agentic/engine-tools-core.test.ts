/**
 * The engine-neutral tool core (`src/lib/agentic/engine-tools/`, Step 0a of
 * `docs/claude-agent-sdk-design.md`).
 *
 * Three properties the move must not have changed, and one it must add:
 *
 *   1. FLUE WRITES THE SAME ROWS. Every guard source a Flue tool call writes —
 *      which is also the `entityId` of the guard's audit row — is byte-identical
 *      to what it was before the core moved. Driven through the tool set's own
 *      `run`, the path a Flue run takes, rather than through the exported
 *      helper alone.
 *   2. A SECOND ENGINE WRITES ITS OWN. The prefix is the engine's, so a run on
 *      another engine can never be mistaken for a Flue run in the audit trail.
 *   3. THE ENGINE ONLY SHAPES. The builder is handed a tool that already passed
 *      the scope and autonomy terms and a `run` already bound to the funnel; a
 *      builder that declines a schema drops the tool visibly.
 *   4. `isReasoningEngine` is pinned for every driver there is.
 */
import type { McpInvocation } from '@/lib/mcp/authorize';
import type { McpProposeTool } from '@/lib/mcp/tools/propose-tools';
import type { McpReadTool } from '@/lib/mcp/tools/types';

jest.mock('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn(),
    runReadTool: jest.fn(),
}));
// `isProposeTool` gets REAL behaviour over the fixture names, as in
// `tests/unit/flue-tools-adapter.test.ts`: it decides which funnel a call
// reaches, and a fixed mock answer would hand the dispatch its own verdict.
jest.mock('@/lib/mcp/tools/propose-tools', () => {
    const PROPOSE_NAMES = ['propose_risks'];
    return {
        loadableProposeTools: jest.fn(),
        runProposeTool: jest.fn(),
        isProposeTool: (name: string) => PROPOSE_NAMES.includes(name),
    };
});
jest.mock('@/app-layer/ai/guard', () => ({
    guardEgress: jest.fn(),
    guardUntrustedInput: jest.fn(),
    assertGuardAllowed: jest.fn(),
    assertNoReviewRequired: jest.fn(),
}));
jest.mock('@/lib/auth/api-key-auth', () => ({
    enforceApiKeyScope: jest.fn(),
}));

import { guardEgress, guardUntrustedInput } from '@/app-layer/ai/guard';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { loadableReadTools, runReadTool } from '@/lib/mcp/tools/registry';
import { loadableProposeTools, runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { offerToolSet, type OfferedTool } from '@/lib/agentic/engine-tools';
import { flueToolsFor } from '@/lib/agentic/flue/tools-adapter';
import { AGENT_DRIVERS, isReasoningEngine } from '@/lib/agentic/agent-driver';

const mockLoadable = loadableReadTools as jest.MockedFunction<typeof loadableReadTools>;
const mockRunRead = runReadTool as jest.MockedFunction<typeof runReadTool>;
const mockLoadablePropose = loadableProposeTools as jest.MockedFunction<typeof loadableProposeTools>;
const mockRunPropose = runProposeTool as jest.MockedFunction<typeof runProposeTool>;
const mockEgress = guardEgress as jest.MockedFunction<typeof guardEgress>;
const mockInput = guardUntrustedInput as jest.MockedFunction<typeof guardUntrustedInput>;
const mockScope = enforceApiKeyScope as jest.MockedFunction<typeof enforceApiKeyScope>;

const CLEAN = { blocked: false, reviewRequired: false, ruleIds: [] } as never;

function readTool(name: string, overrides: Partial<McpReadTool<unknown>> = {}): McpReadTool<unknown> {
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

function proposeTool(name: string): McpProposeTool {
    return {
        name,
        description: `the ${name} tool`,
        inputSchema: { type: 'object', properties: { rationale: { type: 'string' } } },
        kind: 'RISK',
        resourceScope: { resource: name, action: 'read' },
        authorize: { keys: ['risks.create'], basis: 'principal', mirrors: `POST /${name}` },
    } as McpProposeTool;
}

function invocation(autonomyCeiling = 6): McpInvocation {
    return { ctx: { tenantId: 't1', requestId: 'r1' }, autonomyCeiling } as unknown as McpInvocation;
}

const sourcesWritten = (): string[] => [
    ...mockEgress.mock.calls.map((c) => (c[2] as { source: string }).source),
    ...mockInput.mock.calls.map((c) => (c[2] as { source: string }).source),
];

beforeEach(() => {
    jest.clearAllMocks();
    mockEgress.mockResolvedValue(CLEAN);
    mockInput.mockResolvedValue(CLEAN);
    mockScope.mockImplementation(() => undefined);
    mockLoadable.mockReturnValue([readTool('list_risks')]);
    mockLoadablePropose.mockReturnValue([proposeTool('propose_risks')]);
    mockRunRead.mockResolvedValue({ content: [{ type: 'text', text: '{"risk":"one"}' }] } as never);
    mockRunPropose.mockResolvedValue({ content: [{ type: 'text', text: '{"queued":1}' }] } as never);
});

describe('1. a Flue tool call writes the guard sources it always did', () => {
    it('a read, driven through the tool set Flue binds', async () => {
        const set = flueToolsFor(invocation());
        const tool = set.tools.find((t) => t.name === 'list_risks');
        expect(tool).toBeDefined();

        await tool!.run({ toolCallId: 'call-7', data: { limit: 3 } });

        // EXACTLY these three, in this order. The source is also the guard
        // audit row's entityId (`ai/guard/index.ts`), so these strings are
        // what an investigator searches the trail for.
        expect(sourcesWritten().sort()).toEqual(
            [
                'flue-tool-args:list_risks:call-7',
                'flue-tool-result-egress:list_risks:call-7',
                'flue-tool-result:list_risks:call-7',
            ].sort(),
        );
        expect(mockRunRead).toHaveBeenCalledWith(expect.anything(), 'list_risks', { limit: 3 });
    });

    it('a proposal, driven the same way, carries the run origin through', async () => {
        const originFor = jest.fn(() => ({ runId: 'run-1', stepSeq: 4 }));
        const set = flueToolsFor(invocation(), undefined, originFor);
        const tool = set.tools.find((t) => t.name === 'propose_risks');

        await tool!.run({ toolCallId: 'call-8', data: { rationale: 'r' } });

        expect(sourcesWritten()).toContain('flue-tool-args:propose_risks:call-8');
        expect(mockRunPropose).toHaveBeenCalledWith(expect.anything(), 'propose_risks', { rationale: 'r' }, {
            runId: 'run-1',
            stepSeq: 4,
        });
        // Resolved at CALL time, for the call's own id.
        expect(originFor).toHaveBeenCalledWith('call-8');
    });
});

describe('2. another engine names its own rows', () => {
    it('writes every source under the prefix it supplied, and none under Flue’s', async () => {
        const set = offerToolSet(invocation(), (offered: OfferedTool) => offered, { sourcePrefix: 'probe-engine' });
        const offered = set.tools.find((t) => t.tool.name === 'list_risks');

        await offered!.run({ limit: 1 }, 'call-9');

        const written = sourcesWritten();
        expect(written.sort()).toEqual(
            [
                'probe-engine-tool-args:list_risks:call-9',
                'probe-engine-tool-result-egress:list_risks:call-9',
                'probe-engine-tool-result:list_risks:call-9',
            ].sort(),
        );
        expect(written.some((s) => s.startsWith('flue-'))).toBe(false);
    });
});

describe('3. the engine only shapes', () => {
    it('is handed only tools that passed scope and autonomy, each with its surface', () => {
        // One read tool refused its scope; the propose tool sits on rung 2.
        mockLoadable.mockReturnValue([readTool('list_risks'), readTool('list_secrets')]);
        mockScope.mockImplementation((_ctx, resource) => {
            if (resource === 'list_secrets') throw new Error('scope');
        });
        const seen: Array<[string, string]> = [];

        const set = offerToolSet(
            invocation(1),
            (offered) => {
                seen.push([offered.tool.name, offered.capability]);
                return offered.tool.name;
            },
            { sourcePrefix: 'probe-engine' },
        );

        expect(seen).toEqual([['list_risks', 'read']]);
        expect(set.tools).toEqual(['list_risks']);
        expect(set.omitted).toEqual([
            { name: 'list_secrets', reason: 'SCOPE' },
            { name: 'propose_risks', reason: 'AUTONOMY' },
        ]);
    });

    it('a builder that declines a schema drops the tool visibly, in the order it was met', () => {
        mockLoadable.mockReturnValue([readTool('list_a'), readTool('list_b'), readTool('list_c')]);
        mockScope.mockImplementation((_ctx, resource) => {
            if (resource === 'list_c') throw new Error('scope');
        });

        const set = offerToolSet(invocation(), (offered) => (offered.tool.name === 'list_a' ? null : offered.tool.name), {
            sourcePrefix: 'probe-engine',
            readOnly: true,
        });

        // The order is the candidate order, interleaving the reasons, which is
        // what the single loop guarantees and two passes would not.
        expect(set.omitted).toEqual([
            { name: 'list_a', reason: 'UNCONVERTIBLE_SCHEMA' },
            { name: 'list_c', reason: 'SCOPE' },
            { name: 'propose_risks', reason: 'READ_ONLY_WORKFLOW' },
        ]);
        expect(set.tools).toEqual(['list_b']);
    });

    it('shares ONE latch across both surfaces', () => {
        const set = offerToolSet(invocation(), (offered) => offered, { sourcePrefix: 'probe-engine' });
        expect(set.tools.map((t) => t.capability).sort()).toEqual(['propose', 'read']);
        expect(set.review.required).toBe(false);
    });
});

describe('4. isReasoningEngine is pinned for every driver', () => {
    it('answers for each driver there is, and only Flue reasons today', () => {
        const answers = Object.fromEntries(AGENT_DRIVERS.map((d) => [d, isReasoningEngine(d)]));
        expect(answers).toEqual({ static: false, flue: true });
    });
});
