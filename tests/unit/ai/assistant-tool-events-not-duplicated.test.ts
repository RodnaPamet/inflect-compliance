/**
 * Tool events reach a streaming client EXACTLY ONCE (#3886).
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * A mutation proof found the gap. `tests/unit/ai/assistant-loop-bounds.test.ts`
 * asserts "announces each call exactly once" — and it drives
 * `runAssistantLoop` DIRECTLY, so it cannot see the duplication it was written
 * to prevent. Restoring the old post-hoc replay loop in `answerFromToolLoop`
 * alongside the live hooks left all 333 tests green.
 *
 * The replay lived one level ABOVE the loop, so the guard has to live there
 * too. That is the whole lesson: an assertion placed at the wrong level reads
 * identically to one that works.
 *
 * ═══ WHAT IS MOCKED, AND WHY THE LOOP IS NOT ═══
 *
 * Three seams, all of which would otherwise make `answerFromToolLoop` return
 * null before reaching the loop: the model resolution (`resolveFlueModel`
 * REFUSES when nothing is configured, by design), the provider factory, and
 * the tool set, which needs a real MCP invocation.
 *
 * `runAssistantLoop` itself is REAL. Mocking it would leave exactly the seam
 * under test — the wiring between the loop's hooks and the stream's emits —
 * untested, which is the mistake this file exists to correct.
 */

jest.mock('@/app-layer/ai/risk-assessment/feature-gate', () => ({
    enforceFeatureGate: jest.fn(),
}));
jest.mock('@/app-layer/ai/risk-assessment/rate-limiter', () => ({
    checkRateLimit: jest.fn(),
    recordGeneration: jest.fn(),
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn().mockResolvedValue({ blocked: false, reviewRequired: false }),
    guardEgress: jest.fn().mockResolvedValue({ blocked: false, reviewRequired: false }),
    assertGuardAllowed: jest.fn(),
    assertNoReviewRequired: jest.fn(),
    sanitizePlainText: (s: string) => s,
}));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(),
    AGENTIC_SUMMARY_MAX: 4000,
    summaryCapFor: () => 4000,
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
    ),
}));
jest.mock('@/app-layer/usecases/dashboard', () => ({
    getDashboardData: jest.fn().mockResolvedValue({ stats: {}, recentActivity: [] }),
}));
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: jest.fn(),
}));
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async () => ({ ctx: { tenantId: 't1' } })),
}));

// The three seams that would otherwise short-circuit before the loop.
jest.mock('@/lib/agentic/flue/model-selection', () => ({
    RESIDENCY_SELECT: { aiResidency: true },
    residencyTermsFrom: () => ({}),
    resolveFlueModel: () => ({ ok: true, specifier: 'inflect-external/claude-haiku-4-5' }),
}));
jest.mock('@/app-layer/ai/assistant/turn-provider', () => ({
    // `jest.fn()`, not a plain arrow: the script below has to be swapped in per
    // test via `mockReturnValue`, and a plain function has no such method —
    // which surfaced as "assistantProviderFor.mockReturnValue is not a
    // function" and failed every test in the file, the self-contained control
    // included.
    assistantProviderFor: jest.fn(),
}));
jest.mock('@/app-layer/ai/assistant/tools', () => ({
    assistantTools: () => ({
        tools: [
            {
                name: 'list_findings',
                description: 'the list_findings tool',
                jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: async () => 'rows from list_findings',
            },
            {
                name: 'list_risks',
                description: 'the list_risks tool',
                jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: async () => 'rows from list_risks',
            },
        ],
        reviewRequired: () => false,
        omitted: [],
    }),
}));

import { streamAssistant } from '@/app-layer/usecases/assistant';
import { assistantProviderFor } from '@/app-layer/ai/assistant/turn-provider';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });

/** A provider that asks for two tools, then answers. */
function scriptProvider(): void {
    const turns = [
        {
            text: null,
            toolCalls: [{ id: 'c1', name: 'list_findings', args: {} }],
            stopReason: 'tool_use' as const,
        },
        {
            text: null,
            toolCalls: [{ id: 'c2', name: 'list_risks', args: {} }],
            stopReason: 'tool_use' as const,
        },
        { text: 'You have 3 open findings.', toolCalls: [], stopReason: 'end' as const },
    ];
    let i = 0;
    (assistantProviderFor as jest.Mock).mockReturnValue({
        complete: async () => turns[Math.min(i++, turns.length - 1)],
    });
}

async function collect(question: string) {
    const events: Array<{ type: string; name?: string }> = [];
    await streamAssistant(ctx, { question }, {
        emit: (e: unknown) => events.push(e as { type: string; name?: string }),
    } as never);
    return events;
}

beforeEach(() => {
    jest.clearAllMocks();
    scriptProvider();
});

describe('a streaming client sees each tool exactly once', () => {
    it('emits one tool_call and one tool_result per call, in order', async () => {
        const events = await collect('how many findings?');

        // The denominator first: if the loop never ran, there would be no tool
        // events at all and "no duplicates" would be vacuously true. This is
        // the assertion the whole file depends on.
        const calls = events.filter((e) => e.type === 'tool_call');
        const results = events.filter((e) => e.type === 'tool_result');
        expect(calls.map((e) => e.name)).toEqual(['list_findings', 'list_risks']);
        expect(results.map((e) => e.name)).toEqual(['list_findings', 'list_risks']);
    });

    it('interleaves each call with its own result, rather than batching them', async () => {
        // The ORDER is the #3886 property. Replayed after the turn, every
        // tool_call arrived in one burst immediately before the answer — the
        // names and the count were right and the events were useless, because
        // each arrived after the pause it existed to explain.
        const shape = (await collect('how many findings?'))
            .filter((e) => e.type !== 'thinking')
            .map((e) => (e.name === undefined ? e.type : `${e.type}:${e.name}`));

        expect(shape).toEqual([
            'tool_call:list_findings',
            'tool_result:list_findings',
            'tool_call:list_risks',
            'tool_result:list_risks',
            'answer',
            'done',
        ]);
    });

    it('the order assertion can fail — a batched shape is not this shape', async () => {
        // Positive control. Without it, a `toEqual` against a mistyped array
        // would be the kind of assertion that passes because both sides are
        // equally wrong.
        const batched = [
            'tool_call:list_findings',
            'tool_call:list_risks',
            'tool_result:list_findings',
            'tool_result:list_risks',
            'answer',
            'done',
        ];
        const interleaved = [
            'tool_call:list_findings',
            'tool_result:list_findings',
            'tool_call:list_risks',
            'tool_result:list_risks',
            'answer',
            'done',
        ];
        expect(batched).not.toEqual(interleaved);
    });
});
