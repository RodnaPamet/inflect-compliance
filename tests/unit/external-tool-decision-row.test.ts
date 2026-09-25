/**
 * THE ART 12 DISCLOSURE FOR WORK THIS DEPLOYMENT DID NOT DO.
 *
 * Everything else about an external call is already recorded: the funnel writes
 * a hash-chained audit row naming the tool and the policy version, and the
 * `TOOL_CALL` step carries the arguments the model chose. The one fact none of
 * them state is that a step of this run was executed by a THIRD PARTY, which is
 * the disclosure this row exists to make.
 *
 * Two properties are easy to lose and are asserted directly:
 *
 *   · a FAILED call is recorded too. It still sent something outward, and a
 *     record of only the successes is a record of the calls that worked rather
 *     than of the data that left.
 *   · a BUILT-IN call records nothing. The engine calls this on every tool, so
 *     without that the decision log would fill with rows claiming a third party
 *     ran work that never left the tenant.
 */
const logAiDecisionMock = jest.fn();
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: (...a: unknown[]) => logAiDecisionMock(...a),
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

jest.mock('@/lib/agentic/flue/model-decision', () => ({
    aiSystemIdFor: jest.fn(async () => 'sys_1'),
}));

import { recordExternalToolDecision } from '@/lib/agentic/flue/tool-decision';
import { runInTenantContext } from '@/lib/db-context';
import { externalToolName } from '@/lib/mcp/external-tool-name';

const CONN = 'cmconnaaa';
const EXT = externalToolName(CONN, 'list_alerts');
const ctx = { tenantId: 'tnt_1', agentId: 'agent_1' } as never;

beforeEach(() => jest.clearAllMocks());

describe('an external call is disclosed', () => {
    it('names the provider by connection, and joins to the run', async () => {
        await recordExternalToolDecision(ctx, {
            runId: 'run_9',
            toolName: EXT,
            status: 'DONE',
            latencyMs: 120,
        });

        expect(logAiDecisionMock).toHaveBeenCalledTimes(1);
        const [, , row] = logAiDecisionMock.mock.calls[0];
        expect(row).toMatchObject({
            feature: 'agentic-tool:external',
            provider: `mcp:${CONN}`,
            // No model served this; a placeholder would be worse than a gap.
            model: null,
            // The Art 14 join — how a human reviewing the run finds it.
            sessionRef: 'run_9',
            latencyMs: 120,
            aiSystemId: 'sys_1',
        });
    });

    it('records a FAILED call, because it still sent something', async () => {
        await recordExternalToolDecision(ctx, {
            runId: 'run_9',
            toolName: EXT,
            status: 'FAILED',
        });
        expect(logAiDecisionMock).toHaveBeenCalledTimes(1);
        expect(logAiDecisionMock.mock.calls[0][2]).toMatchObject({
            provider: `mcp:${CONN}`,
            outputSummary: 'external failed',
        });
    });

    it('never carries the arguments — they are on the step already', async () => {
        await recordExternalToolDecision(ctx, {
            runId: 'run_9',
            toolName: EXT,
            status: 'DONE',
        });
        expect(logAiDecisionMock.mock.calls[0][2].sanitizedInput).toBe('list_alerts');
    });
});

describe('a built-in call is not', () => {
    it.each([
        ['a read tool', 'list_risks'],
        ['a propose tool', 'propose_risks'],
        ['an unqualified name', 'mcp_not_really'],
    ])('writes nothing for %s', async (_label, toolName) => {
        await recordExternalToolDecision(ctx, { runId: 'run_9', toolName, status: 'DONE' });
        // Not merely "no row" — no TRANSACTION. Asserting the row count alone
        // would pass for the wrong reason: deleting the early return makes the
        // null dereference escape through the catch block, so the failure this
        // test would report is a thrown function rather than the guard it is
        // named for. A built-in must cost nothing at all here.
        expect({
            rows: logAiDecisionMock.mock.calls.length,
            transactions: (runInTenantContext as jest.Mock).mock.calls.length,
        }).toEqual({ rows: 0, transactions: 0 });
    });
});

describe('the disclosure is best-effort', () => {
    it('does not fail the run when the row cannot be written', async () => {
        logAiDecisionMock.mockRejectedValue(new Error('db down'));
        await expect(
            recordExternalToolDecision(ctx, { runId: 'run_9', toolName: EXT, status: 'DONE' }),
        ).resolves.toBeUndefined();
    });
});
