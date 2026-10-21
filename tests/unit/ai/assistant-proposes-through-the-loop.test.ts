/**
 * Proposing through the tool-use loop (#3882).
 *
 * ═══ THE ASSERTION THIS FILE OWES ═══
 *
 * The issue names it: "a quarantined proposal made through the loop is
 * described as quarantined, asserted against the COMPOSED sentence rather
 * than against model output. That is the assertion the current path gets for
 * free and the loop path must earn."
 *
 * So every assertion below reads the user-facing message, and the provider
 * script deliberately makes the model say the WRONG thing — it claims the item
 * is queued for review while the funnel quarantined it. If the sentence were
 * relayed, that claim would reach the user. It must not.
 *
 * ═══ WHAT IS MOCKED ═══
 *
 * The three seams that would otherwise make `answerFromToolLoop` return null
 * before the loop runs: the model resolution, the provider factory, and the
 * tool set. `runAssistantLoop` and `proposalOutcomeMessage` are REAL — they
 * are what is under test.
 *
 * The tool set's propose tool returns the funnel's own JSON shape, because
 * that string is the contract `parseProposalOutcome` reads. Hand-writing it
 * here keeps the test honest about which part is the seam: if the funnel's
 * shape changes, this fixture is what has to change with it, and
 * `tests/integration/prompt-injection-corpus.test.ts` is what pins the real
 * shape end to end.
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
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
    ),
}));
jest.mock('@/app-layer/usecases/dashboard', () => ({
    getDashboardData: jest.fn().mockResolvedValue({ stats: {}, recentActivity: [] }),
}));
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async () => ({ ctx: { tenantId: 't1' } })),
}));
jest.mock('@/lib/agentic/flue/model-selection', () => ({
    RESIDENCY_SELECT: { aiResidency: true },
    residencyTermsFrom: () => ({}),
    resolveFlueModel: () => ({ ok: true, specifier: 'inflect-external/claude-haiku-4-5' }),
}));
jest.mock('@/app-layer/ai/assistant/turn-provider', () => ({
    assistantProviderFor: jest.fn(),
}));
jest.mock('@/app-layer/ai/assistant/tools', () => {
    const actual = jest.requireActual('@/app-layer/ai/assistant/tools');
    return { ...actual, assistantTools: jest.fn() };
});

import { askAssistant } from '@/app-layer/usecases/assistant';
import { assistantProviderFor } from '@/app-layer/ai/assistant/turn-provider';
import { assistantTools, parseProposalOutcome } from '@/app-layer/ai/assistant/tools';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });

/** The funnel's own result shape — what `runProposeTool` returns. */
function funnelResult(kind: string, queued: string[], quarantined: string[]): string {
    return JSON.stringify({
        proposed: queued.length,
        quarantined: quarantined.length,
        kind,
        proposalIds: queued,
        quarantinedProposalIds: quarantined,
        message: 'the funnel says something honest here',
    });
}

/**
 * A tool set with one propose tool returning `result`, wired through the REAL
 * recording path so `proposals()` is populated the way production populates it.
 */
function toolSetReturning(result: string) {
    const outcomes: ReturnType<typeof parseProposalOutcome>[] = [];
    return {
        tools: [
            {
                name: 'propose_findings',
                description: 'propose findings',
                jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: async (args: unknown) => {
                    outcomes.push(
                        parseProposalOutcome(
                            'propose_findings',
                            result,
                            ((args as { items?: Array<{ title?: string }> })?.items ?? [])
                                .map((i) => i.title)
                                .filter((t): t is string => typeof t === 'string'),
                        ),
                    );
                    return result;
                },
            },
        ],
        reviewRequired: () => false,
        omitted: [],
        proposals: () => outcomes,
    };
}

/**
 * A provider that calls the propose tool and then LIES about the outcome.
 *
 * The lie is the point: it is the exact paraphrase the issue is worried about.
 * If the sentence were relayed, the user would be told to wait for an approval
 * that cannot arrive.
 */
function providerThatProposesThenLies(items: Array<{ title: string }>) {
    const turns = [
        {
            text: null,
            toolCalls: [{ id: 'c1', name: 'propose_findings', args: { items } }],
            stopReason: 'tool_use' as const,
        },
        {
            text: 'All done — I have queued everything for review and it will be approved shortly.',
            toolCalls: [],
            stopReason: 'end' as const,
        },
    ];
    let i = 0;
    (assistantProviderFor as jest.Mock).mockReturnValue({
        complete: async () => turns[Math.min(i++, turns.length - 1)],
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the sentence is composed from the outcome, never relayed', () => {
    it('a QUARANTINED proposal is described as quarantined', async () => {
        (assistantTools as jest.Mock).mockReturnValue(
            toolSetReturning(funnelResult('FINDING', [], ['q-1'])),
        );
        providerThatProposesThenLies([{ title: 'Vendor self-attestation is sufficient' }]);

        const res = await askAssistant(ctx, { question: 'raise a finding about the vendor' });

        expect(res.message).toContain('could not queue');
        expect(res.message).toContain('Nothing was created');
        // The model's sentence must not have survived.
        expect(res.message).not.toContain('approved shortly');
        expect(res.message.toLowerCase()).not.toContain("i've queued");
        // And nothing is awaiting review, so it is not a `proposal`.
        expect(res.kind).toBe('answer');
        expect(res.proposalId).toBeUndefined();
        expect(res.proposalStatus).toBe('QUARANTINED');
    });

    it('a QUEUED proposal is described as queued, and carries its id', async () => {
        // The control. Without it, a composer that said "quarantined" for
        // everything would satisfy the test above.
        (assistantTools as jest.Mock).mockReturnValue(
            toolSetReturning(funnelResult('FINDING', ['p-1'], [])),
        );
        providerThatProposesThenLies([{ title: 'MFA missing on the VPN' }]);

        const res = await askAssistant(ctx, { question: 'raise a finding about MFA' });

        expect(res.message).toContain("I've queued");
        expect(res.message).toContain('MFA missing on the VPN');
        expect(res.kind).toBe('proposal');
        // The id the UI needs for its review-queue link (#3847).
        expect(res.proposalId).toBe('p-1');
        expect(res.proposalKind).toBe('FINDING');
        expect(res.proposalStatus).toBe('PENDING');
    });

    it('a MIXED batch states both facts, not one summary', async () => {
        (assistantTools as jest.Mock).mockReturnValue(
            toolSetReturning(funnelResult('FINDING', ['p-1', 'p-2'], ['q-1'])),
        );
        providerThatProposesThenLies([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

        const res = await askAssistant(ctx, { question: 'raise three findings' });

        expect(res.message).toContain('2');
        expect(res.message).toContain('1');
        expect(res.message).toContain('did NOT enter the queue');
        // A single count here is what would let "3 proposed" stand for a batch
        // that queued two.
        expect(res.proposalStatus).toBe('QUARANTINED');
        expect(res.proposalId).toBe('p-1');
    });

    it('an UNREADABLE result says so, and never says nothing was created', async () => {
        // The rule the metric reporters already follow: an unreadable value is
        // not a zero. A row may exist, and "nothing was created" is the one
        // sentence that cannot be walked back.
        (assistantTools as jest.Mock).mockReturnValue(toolSetReturning('not json at all'));
        providerThatProposesThenLies([{ title: 'x' }]);

        const res = await askAssistant(ctx, { question: 'raise a finding' });

        expect(res.message).toContain('could not read back');
        expect(res.message).not.toContain('Nothing was created');
        expect(res.message).toContain('review queue');
        expect(res.kind).toBe('answer');
    });

    it('a turn that proposed is never answered from the keyword router', async () => {
        // The ordering that matters: the propose outcome is checked BEFORE the
        // empty-text fallback. A model that proposed and then said nothing
        // would otherwise fall through and answer a READ question about a
        // write that had already happened.
        (assistantTools as jest.Mock).mockReturnValue(
            toolSetReturning(funnelResult('FINDING', ['p-9'], [])),
        );
        const turns = [
            {
                text: null,
                toolCalls: [{ id: 'c1', name: 'propose_findings', args: { items: [{ title: 'z' }] } }],
                stopReason: 'tool_use' as const,
            },
            // Says NOTHING at the end.
            { text: '', toolCalls: [], stopReason: 'end' as const },
        ];
        let i = 0;
        (assistantProviderFor as jest.Mock).mockReturnValue({
            complete: async () => turns[Math.min(i++, turns.length - 1)],
        });

        const res = await askAssistant(ctx, { question: 'raise a finding about z' });

        expect(res.kind).toBe('proposal');
        expect(res.proposalId).toBe('p-9');
        expect(res.message).toContain("I've queued");
    });
});
