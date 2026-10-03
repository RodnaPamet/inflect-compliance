/**
 * THE ARM'S OWN ORDER, AND THE ONE REFUSAL A REAL DATABASE CANNOT PRODUCE.
 *
 * `tests/integration/external-write-automatic-arm.test.ts` drives this usecase
 * end to end against Postgres, which is where the journal row, the Art 12 row
 * and the moving target population have to be proved. Three claims are not
 * reachable from there and live here instead:
 *
 *   1. THE CLAMP IS THE FIRST CHECK. The integration suite lifts the ceiling to
 *      `AUTOMATIC` so the arm can run at all, so it cannot observe the refusal.
 *      And "first" is not a message — it is the absence of a query, which is
 *      only assertable with the database mocked and counted.
 *   2. A FAILED ART 12 WRITE REFUSES THE WRITE. Making `logAiDecision` fail
 *      against a real database means breaking the database, which breaks
 *      everything else in the same breath.
 *   3. THE CAP'S BOUNDARY IS `>=`, NOT `>`. Provable either way, and cheaper
 *      here, where the count is a number this file chooses.
 *
 * Every refusal below is paired with the case that must still be ACCEPTED, so a
 * check that refuses everything cannot pass as a check that refuses the right
 * thing.
 */
const countMock = jest.fn();
const beginWriteMock = jest.fn();
const settleWriteMock = jest.fn();
const logAiDecisionMock = jest.fn();

const mockTx = { externalWriteJournal: { count: countMock }, aiDecisionLog: {} };
const runInTenantContextMock = jest.fn(
    async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockTx),
);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...a: unknown[]) =>
        (runInTenantContextMock as unknown as (...x: unknown[]) => unknown)(...a),
}));
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    beginWrite: (...a: unknown[]) => beginWriteMock(...a),
    settleWrite: (...a: unknown[]) => settleWriteMock(...a),
}));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: (...a: unknown[]) => logAiDecisionMock(...a),
}));

import type { ExternalWriteMode } from '@/lib/integrations/external-write-ladder';

type ArmModule = typeof import('@/app-layer/usecases/external-write-automatic');

/** The arm, loaded against a ladder whose ceiling is `ceiling`. */
function armWithCeiling(ceiling: ExternalWriteMode): ArmModule {
    let mod: ArmModule | undefined;
    jest.isolateModules(() => {
        jest.doMock('@/lib/integrations/external-write-ladder', () => ({
            ...jest.requireActual('@/lib/integrations/external-write-ladder'),
            EXTERNAL_MAX_MODE: ceiling,
        }));
        mod = require('@/app-layer/usecases/external-write-automatic') as ArmModule;
    });
    if (!mod) throw new Error('the automatic arm failed to load');
    jest.dontMock('@/lib/integrations/external-write-ladder');
    return mod;
}

const ctx = { tenantId: 'tnt_1', userId: 'usr_1', agentId: 'agt_1' } as never;

const request = (over: Record<string, unknown> = {}) => ({
    connectionId: 'cmconnaaa',
    connectionName: 'HRM',
    endpointUrl: 'https://hrm.example.test/mcp',
    toolName: 'mcp__cmconnaaa__set_work_email',
    advertisedToolName: 'set_work_email',
    parameterSetLabel: 'offboard',
    argumentsJson: JSON.stringify({ reason: 'offboarding', employeeEmail: 'gone@x.test' }),
    priorStateJson: JSON.stringify({ workEmail: 'gone@x.test' }),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    countMock.mockResolvedValue(0);
    beginWriteMock.mockResolvedValue({ journalId: 'jrn_1' });
    logAiDecisionMock.mockResolvedValue('aid_1');
    settleWriteMock.mockResolvedValue(undefined);
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE CLAMP IS FIRST, AND "FIRST" MEANS NO QUERY
// ═════════════════════════════════════════════════════════════════════

describe('the clamp is the arm\'s first check', () => {
    it('refuses below the ceiling without reading anything or opening a row', async () => {
        const arm = armWithCeiling('PROPOSE_ONLY');

        await expect(arm.openAutomaticExternalWrite(ctx, request())).rejects.toThrow(
            /external_write_automatic_above_ceiling/,
        );

        // THE ORDERING, asserted as the absence it is. A clamp placed after the
        // cap would still produce the right message while having spent a query
        // on an authority this build refuses to exercise.
        expect(runInTenantContextMock).not.toHaveBeenCalled();
        expect(countMock).not.toHaveBeenCalled();
        expect(beginWriteMock).not.toHaveBeenCalled();
        expect(logAiDecisionMock).not.toHaveBeenCalled();
    });

    it('refuses the clamp BEFORE the missing-parameter-set check', async () => {
        // Both are wrong, and the message says which one is the stronger claim:
        // "not in this build at all" rather than "not configured like that".
        const arm = armWithCeiling('PROPOSE_ONLY');
        await expect(
            arm.openAutomaticExternalWrite(ctx, request({ parameterSetLabel: null })),
        ).rejects.toThrow(/external_write_automatic_above_ceiling/);
    });

    it('proceeds once the ceiling reaches the rung — the control', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        const { journalId } = await arm.openAutomaticExternalWrite(ctx, request());
        expect(journalId).toBe('jrn_1');
        expect(beginWriteMock).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. A SET MUST BE IN FORCE
// ═════════════════════════════════════════════════════════════════════

describe('an unattended write needs an approved parameter set', () => {
    it('refuses a null label, before the cap query and before any row', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        await expect(
            arm.openAutomaticExternalWrite(ctx, request({ parameterSetLabel: null })),
        ).rejects.toThrow(/external_write_automatic_requires_parameter_set/);
        expect(countMock).not.toHaveBeenCalled();
        expect(beginWriteMock).not.toHaveBeenCalled();
    });

    it('and passes the label through to the journal row — the control', async () => {
        // The label is what the SEND-TIME bound re-check finds the set by, so a
        // row that dropped it would be undispatchable in a way nothing else
        // here would notice.
        const arm = armWithCeiling('AUTOMATIC');
        await arm.openAutomaticExternalWrite(ctx, request());
        expect(beginWriteMock.mock.calls[0][1]).toMatchObject({
            mode: 'AUTOMATIC',
            parameterSetLabel: 'offboard',
            agentId: 'agt_1',
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE CAP'S BOUNDARY
// ═════════════════════════════════════════════════════════════════════

describe('the rolling-window cap refuses AT the ceiling, not one past it', () => {
    it('refuses when the window already holds exactly the allowance', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        countMock.mockResolvedValue(arm.AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW);
        await expect(arm.openAutomaticExternalWrite(ctx, request())).rejects.toThrow(
            /external_write_automatic_rate_limited/,
        );
        expect(beginWriteMock).not.toHaveBeenCalled();
    });

    it('admits the one BELOW — so `>=` and `>` are distinguishable here', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        countMock.mockResolvedValue(arm.AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW - 1);
        await arm.openAutomaticExternalWrite(ctx, request());
        expect(beginWriteMock).toHaveBeenCalledTimes(1);
    });

    it('counts this CONNECTION, this rung, and a window — never a lifetime', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        await arm.openAutomaticExternalWrite(ctx, request());
        const where = (countMock.mock.calls[0][0] as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({
            tenantId: 'tnt_1',
            connectionId: 'cmconnaaa',
            mode: 'AUTOMATIC',
        });
        // The range, which is what makes it ROLLING. A `where` with no
        // `attemptedAt` would be a permanent ceiling on the connection's whole
        // history, and every assertion above would still pass.
        const range = (where as { attemptedAt?: { gte?: Date } }).attemptedAt;
        expect(range?.gte).toBeInstanceOf(Date);
        expect(Date.now() - (range!.gte as Date).getTime()).toBeCloseTo(
            arm.AUTOMATIC_WRITE_WINDOW_MS,
            -3,
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE ART 12 RECORD IS NOT BEST-EFFORT
// ═════════════════════════════════════════════════════════════════════

describe('a write whose Art 12 record cannot be written is refused', () => {
    it('settles the already-open journal row FAILED and throws', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        logAiDecisionMock.mockRejectedValue(new Error('decision log unavailable'));

        await expect(arm.openAutomaticExternalWrite(ctx, request())).rejects.toThrow(
            /external_write_automatic_unrecorded/,
        );

        // The row EXISTS by then — `beginWrite` runs first so a process that
        // dies mid-dispatch still leaves evidence — so leaving it `PENDING`
        // would hand the dispatch pass a write with no record of the decision.
        // FAILED is also the honest claim: no request was made.
        expect(beginWriteMock).toHaveBeenCalledTimes(1);
        expect(settleWriteMock).toHaveBeenCalledTimes(1);
        const [, journalId, outcome, detail] = settleWriteMock.mock.calls[0];
        expect(journalId).toBe('jrn_1');
        expect(outcome).toBe('FAILED');
        expect(detail).toMatch(/external_write_automatic_unrecorded/);
    });

    it('stamps AUTONOMOUS when it CAN be written — the control', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        await arm.openAutomaticExternalWrite(ctx, request());

        expect(settleWriteMock).not.toHaveBeenCalled();
        const input = logAiDecisionMock.mock.calls[0][2] as Record<string, unknown>;
        // The one value that is TRUE at insert. A row left PENDING here is a
        // review nobody can ever perform.
        expect(input.humanOutcome).toBe('AUTONOMOUS');
        expect(input.feature).toBe('external-write-automatic');
    });

    it('never puts a resolved value in the summary, however the payload is shaped', async () => {
        const arm = armWithCeiling('AUTOMATIC');
        await arm.openAutomaticExternalWrite(
            ctx,
            request({ argumentsJson: JSON.stringify({ secretish: 'alice@victim.test' }) }),
        );
        const input = logAiDecisionMock.mock.calls[0][2] as { outputSummary: string };
        expect(input.outputSummary).toContain('argumentFields=secretish');
        expect(input.outputSummary).not.toContain('alice@victim.test');
    });

    it('survives an unparseable payload rather than turning it into a refused write', async () => {
        // A summary problem must not become a dispatch decision. The write is
        // still journalled and still recorded; the summary says what it can.
        const arm = armWithCeiling('AUTOMATIC');
        await arm.openAutomaticExternalWrite(ctx, request({ argumentsJson: 'not json' }));
        const input = logAiDecisionMock.mock.calls[0][2] as { outputSummary: string };
        expect(input.outputSummary).toContain('argumentFields=none');
        expect(beginWriteMock).toHaveBeenCalledTimes(1);
    });
});
