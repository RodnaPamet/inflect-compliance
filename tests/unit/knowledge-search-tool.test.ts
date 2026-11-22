/**
 * `search_knowledge` in the catalogues (vector store Phase 3.3–3.5): the REAL
 * registry, the REAL offer and the REAL assistant tool set, with only the
 * mount gate's answer and the usecase behind the tool replaced.
 *
 *   1. With the gate closed the tool is in no catalogue — not the MCP listing,
 *      not an engine's offer, not the assistant's — and a run that would have
 *      been offered it records why (`RETRIEVER_NOT_EVALUATED`), including in
 *      its empty-catalogue message. A profile naming it does not report it as
 *      an ungranted tool.
 *   2. With the gate open it is offered like any read tool, to whoever holds
 *      `policies.view`, and to nobody else.
 *   3. A passage carrying an injection HALTS the step: the guard runs for real
 *      on the tool's real output, the run's review latch trips, and the next
 *      tool call — on either surface — is refused without reaching the funnel
 *      (the review latch is reused, as every engine's tool set reuses it).
 */
let mockState: 'MOUNTED' | 'UNMOUNTED' | 'ABSENT' = 'UNMOUNTED';
jest.mock('@/app-layer/services/knowledge-search-mount', () => ({
    knowledgeSearchMounted: () => mockState === 'MOUNTED',
    getKnowledgeSearchMount: () => ({ state: mockState }),
}));
jest.mock('@/app-layer/usecases/knowledge-search', () => ({
    ...jest.requireActual('@/app-layer/usecases/knowledge-search'),
    searchKnowledge: jest.fn(),
}));

import { INJECTION_CASES } from '../fixtures/prompt-injection-corpus';
import { assistantTools } from '@/app-layer/ai/assistant/tools';
import { searchKnowledge } from '@/app-layer/usecases/knowledge-search';
import { offerToolSet } from '@/lib/agentic/engine-tools/offer-tools';
import { runGuardedTool } from '@/lib/agentic/engine-tools/run-guarded-tool';
import { ReviewLatch } from '@/lib/agentic/engine-tools/review-latch';
import { emptyCatalogueMessage } from '@/lib/agentic/empty-catalogue-message';
import { MCP_READ_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { listReadToolDescriptors, loadableReadTools } from '@/lib/mcp/tools/registry';
import { unmountedReadTools } from '@/lib/mcp/mount-gated-tools';
import { searchKnowledgeTool } from '@/lib/mcp/tools/knowledge-tools';
import { makeRequestContext } from '../helpers/make-context';

const mockSearch = searchKnowledge as jest.MockedFunction<typeof searchKnowledge>;

/** A signed-in person's invocation: no agent, so no grant list; every tool in the catalogue snapshot. */
function invocation(role = 'READER'): McpInvocation {
    return {
        ctx: makeRequestContext(role, { tenantId: 't1', requestId: 'r1' }),
        autonomyCeiling: 6,
        offeredTools: [...MCP_READ_TOOL_NAMES],
        grantedTools: null,
        policyCard: null,
        externalTools: [],
    } as unknown as McpInvocation;
}

/** The same, with `policies.view` withdrawn (a custom role that cannot read policies). */
function withoutPolicies(): McpInvocation {
    const inv = invocation();
    const ctx = inv.ctx;
    return {
        ...inv,
        ctx: { ...ctx, appPermissions: { ...ctx.appPermissions, policies: { ...ctx.appPermissions.policies, view: false } } },
    } as McpInvocation;
}

const names = (tools: ReadonlyArray<{ name: string }>) => tools.map((t) => t.name);

beforeEach(() => {
    mockState = 'UNMOUNTED';
    mockSearch.mockReset();
});

describe('1. with the mount gate closed, search_knowledge is in no catalogue, and the run says why', () => {
    it('is absent from the registry’s loadable set and the MCP listing, and listed as unmounted', () => {
        expect(names(loadableReadTools(invocation()))).not.toContain('search_knowledge');
        expect(names(listReadToolDescriptors(invocation()))).not.toContain('search_knowledge');
        expect(names(unmountedReadTools(invocation()))).toEqual(['search_knowledge']);
    });

    it('an engine’s offer omits it as RETRIEVER_NOT_EVALUATED, never as an ungranted profile tool', () => {
        const set = offerToolSet(invocation(), (o) => o.tool.name, { sourcePrefix: 'test', profileTools: ['search_knowledge'] });
        expect(set.tools).toEqual([]);
        expect(set.omitted).toEqual([{ name: 'search_knowledge', reason: 'RETRIEVER_NOT_EVALUATED' }]);
        const message = emptyCatalogueMessage('tool_runner', { omitted: set.omitted, profileTools: ['search_knowledge'] });
        expect(message).toContain('knowledge search, which is offered only once a RAG evaluation record');
        expect(message).toContain('(search_knowledge)');
    });

    it('the assistant is not offered it', () => {
        expect(names(assistantTools(invocation()).tools)).not.toContain('search_knowledge');
    });

    it('a caller who could not use it anyway is not told it was withheld', () => {
        expect(names(unmountedReadTools(withoutPolicies()))).toEqual([]);
    });

    it('a deployment without the feature (store or route off) offers it nowhere and records nothing about it', () => {
        mockState = 'ABSENT';
        expect(names(loadableReadTools(invocation()))).not.toContain('search_knowledge');
        expect(unmountedReadTools(invocation())).toEqual([]);
        const set = offerToolSet(invocation(), (o) => o.tool.name, { sourcePrefix: 'test', profileTools: ['search_knowledge'] });
        expect(set.omitted).toEqual([]);
    });
});

describe('2. with the gate open it is an ordinary read tool, for whoever holds policies.view', () => {
    beforeEach(() => {
        mockState = 'MOUNTED';
    });

    it('the MCP listing, an engine’s offer and the assistant all carry it', () => {
        expect(names(listReadToolDescriptors(invocation()))).toContain('search_knowledge');
        const set = offerToolSet(invocation(), (o) => o.tool.name, { sourcePrefix: 'test' });
        expect(set.tools).toContain('search_knowledge');
        const assistant = assistantTools(invocation()).tools.find((t) => t.name === 'search_knowledge');
        expect(assistant?.jsonSchema).toBe(searchKnowledgeTool.inputSchema);
    });

    it('is not offered to a caller without policies.view', () => {
        expect(names(loadableReadTools(withoutPolicies()))).not.toContain('search_knowledge');
        expect(names(assistantTools(withoutPolicies()).tools)).not.toContain('search_knowledge');
    });

    it('bounds the result count at 20 in both schemas', () => {
        expect(searchKnowledgeTool.argsSchema.safeParse({ query: 'x', limit: 20 }).success).toBe(true);
        expect(searchKnowledgeTool.argsSchema.safeParse({ query: 'x', limit: 21 }).success).toBe(false);
        expect(searchKnowledgeTool.argsSchema.safeParse({ query: 'x', extra: 1 }).success).toBe(false);
        expect((searchKnowledgeTool.inputSchema.properties as { limit: { maximum: number } }).limit.maximum).toBe(20);
    });
});

describe('3. a flagged passage halts the step', () => {
    const payload = INJECTION_CASES[0].payload;

    it('the corpus case is a real injection (the guard is not mocked)', () => {
        expect(payload.length).toBeGreaterThan(10);
    });

    it('the result trips the run’s latch, and the next call on either surface is refused before the funnel', async () => {
        // The funnel's AUTHORIZATION is not under test here (the integration
        // suite runs it): `runReadTool` is replaced by the tool's own real
        // `run`, and the usecase's answer is supplied, carrying the payload in
        // a passage exactly where a poisoned policy would put it. Everything
        // after the funnel — the guards and the latch — is real.
        mockSearch.mockResolvedValue({
            available: true,
            embeddingModel: 'm',
            droppedStale: 0,
            hits: [
                {
                    sourceModel: 'PolicyVersion',
                    sourceId: 'pv-1',
                    chunkIndex: 0,
                    score: 0.9,
                    text: payload,
                    citation: { kind: 'policy', id: 'p-1', title: 'Access policy', version: 1 },
                },
            ],
        });
        const registry = jest.requireActual('@/lib/mcp/tools/registry') as typeof import('@/lib/mcp/tools/registry');
        const runRead = jest.spyOn(registry, 'runReadTool').mockImplementation(async (inv, name, args) => {
            const tool = registry.READ_TOOLS.find((t) => t.name === name)!;
            const data = await tool.run(inv.ctx, tool.argsSchema.parse(args));
            return { content: [{ type: 'text', text: JSON.stringify(data) }] };
        });
        try {
            const review = new ReviewLatch();
            const inv = invocation();
            await expect(
                runGuardedTool(inv, 'search_knowledge', { query: 'access policy' }, { sourcePrefix: 'test', review, toolCallId: 'c1' }),
            ).rejects.toThrow(/ai_guard_review_required/);
            expect(review.required).toBe(true);
            await expect(
                runGuardedTool(inv, 'list_tasks', {}, { sourcePrefix: 'test', review, toolCallId: 'c2' }),
            ).rejects.toThrow(/ai_guard_review_required/);
            await expect(
                runGuardedTool(inv, 'propose_risks', { items: [] }, { sourcePrefix: 'test', review, toolCallId: 'c3' }),
            ).rejects.toThrow(/ai_guard_review_required/);
            // The search reached the funnel once; nothing after the flag did.
            expect(runRead.mock.calls.map((c) => c[1])).toEqual(['search_knowledge']);
        } finally {
            runRead.mockRestore();
        }
    });
});
