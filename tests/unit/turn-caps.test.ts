/**
 * The org-level turn caps (#4594, owner decision 3 of 2026-11-13).
 *
 *   - `resolveTurnCaps`: the value that applies is the lower of the
 *     organization's ceiling and the workspace's value, per cap; a NULL
 *     workspace value follows the ceiling; a workspace with no organization
 *     takes the product defaults (3, 1) as its ceiling; an absent settings row
 *     narrows nothing. Every value carries its basis.
 *   - `readTurnCaps`: ONE read of the tenant row, and a failed read resolves to
 *     0 delegations and 1 tool call — never wider than anything a tenant or an
 *     organization can store — logged at WARN, never thrown. It replaces
 *     `readFanOutCap`, whose failed-read rule (#5376) it keeps.
 */
const mockFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } },
}));
const mockWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    DEFAULT_DELEGATIONS_PER_TURN,
    DEFAULT_TOOL_CALLS_PER_TURN,
    evaluateToolCallsPerTurn,
    isPermittedTurnCap,
    resolveTurnCaps,
    toolCallsPerTurnRefusalMessage,
} from '@/lib/agentic/turn-caps';
import { DEFAULT_MAX_SUBAGENTS_PER_TURN } from '@/lib/agentic/subagent-fanout';
import { FAILED_READ_FAN_OUT_CAP, readTurnCaps } from '@/lib/agentic/turn-caps-policy';

beforeEach(() => jest.clearAllMocks());

const org = (delegationsPerTurn: number, toolCallsPerTurn: number) => ({ delegationsPerTurn, toolCallsPerTurn });
const ws = (delegationsPerTurn: number | null, toolCallsPerTurn: number | null) => ({
    delegationsPerTurn,
    toolCallsPerTurn,
});

describe('resolveTurnCaps', () => {
    it('the product defaults are today\'s behaviour: 3 delegations and 1 tool call', () => {
        expect(DEFAULT_DELEGATIONS_PER_TURN).toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
        expect(DEFAULT_DELEGATIONS_PER_TURN).toBe(3);
        expect(DEFAULT_TOOL_CALLS_PER_TURN).toBe(1);
    });

    it('a NULL workspace value follows the organization\'s ceiling (ORGANIZATION_CEILING)', () => {
        const caps = resolveTurnCaps({ organization: org(5, 4), workspace: ws(null, null) });
        expect(caps.delegationsPerTurn).toEqual({ value: 5, basis: 'ORGANIZATION_CEILING', ceiling: 5, workspace: null });
        expect(caps.toolCallsPerTurn).toEqual({ value: 4, basis: 'ORGANIZATION_CEILING', ceiling: 4, workspace: null });
    });

    it('a workspace narrows below the ceiling (WORKSPACE)', () => {
        const caps = resolveTurnCaps({ organization: org(5, 4), workspace: ws(0, 2) });
        expect(caps.delegationsPerTurn).toEqual({ value: 0, basis: 'WORKSPACE', ceiling: 5, workspace: 0 });
        expect(caps.toolCallsPerTurn).toEqual({ value: 2, basis: 'WORKSPACE', ceiling: 4, workspace: 2 });
    });

    it('a workspace value above a ceiling the organization LOWERED is narrowed by it, and kept as stored', () => {
        // The workspace stored 3 and 4; the organization then lowered both to 1.
        const caps = resolveTurnCaps({ organization: org(1, 1), workspace: ws(3, 4) });
        expect(caps.delegationsPerTurn).toEqual({ value: 1, basis: 'ORGANIZATION_CEILING', ceiling: 1, workspace: 3 });
        expect(caps.toolCallsPerTurn).toEqual({ value: 1, basis: 'ORGANIZATION_CEILING', ceiling: 1, workspace: 4 });
    });

    it('raising the ceiling again lets the workspace\'s own value apply again', () => {
        const caps = resolveTurnCaps({ organization: org(10, 10), workspace: ws(3, 4) });
        expect(caps.delegationsPerTurn.value).toBe(3);
        expect(caps.toolCallsPerTurn.value).toBe(4);
        expect(caps.toolCallsPerTurn.basis).toBe('WORKSPACE');
    });

    it('a workspace with no organization takes the product defaults as its ceiling (NO_ORGANIZATION)', () => {
        const caps = resolveTurnCaps({ organization: null, workspace: ws(null, null) });
        expect(caps.delegationsPerTurn).toEqual({ value: 3, basis: 'NO_ORGANIZATION', ceiling: 3, workspace: null });
        expect(caps.toolCallsPerTurn).toEqual({ value: 1, basis: 'NO_ORGANIZATION', ceiling: 1, workspace: null });
        // ...and may still narrow under it.
        expect(resolveTurnCaps({ organization: null, workspace: ws(1, null) }).delegationsPerTurn)
            .toEqual({ value: 1, basis: 'WORKSPACE', ceiling: 3, workspace: 1 });
        // A value above the product default narrows nothing.
        expect(resolveTurnCaps({ organization: null, workspace: ws(7, 7) }).toolCallsPerTurn.value).toBe(1);
    });

    it('an ABSENT settings row narrows nothing', () => {
        const caps = resolveTurnCaps({ organization: org(2, 3), workspace: null });
        expect(caps.delegationsPerTurn).toEqual({ value: 2, basis: 'ORGANIZATION_CEILING', ceiling: 2, workspace: null });
        expect(caps.toolCallsPerTurn).toEqual({ value: 3, basis: 'ORGANIZATION_CEILING', ceiling: 3, workspace: null });
    });

    it('a stored 3 between the two deploys reads as a narrowing to 3: exactly today\'s value', () => {
        expect(resolveTurnCaps({ organization: org(3, 1), workspace: ws(3, null) }).delegationsPerTurn.value).toBe(3);
    });

    it('a value no writer can store never widens: a negative narrows nothing, a ceiling past the top is the top', () => {
        expect(resolveTurnCaps({ organization: org(5, 5), workspace: ws(-1, -4) }).delegationsPerTurn.value).toBe(0);
        expect(resolveTurnCaps({ organization: org(5, 5), workspace: ws(-1, -4) }).toolCallsPerTurn.value).toBe(1);
        expect(resolveTurnCaps({ organization: org(50, 50), workspace: null }).toolCallsPerTurn.value).toBe(10);
        expect(resolveTurnCaps({ organization: org(Number.NaN, 0), workspace: null }).delegationsPerTurn.value).toBe(3);
        expect(resolveTurnCaps({ organization: org(3, 0), workspace: null }).toolCallsPerTurn.value).toBe(1);
    });

    it('holds the ranges the CHECKs hold: delegations 0..10, tool calls 1..10, whole numbers', () => {
        expect([0, 10].every((v) => isPermittedTurnCap('delegationsPerTurn', v))).toBe(true);
        expect([-1, 11, 1.5].some((v) => isPermittedTurnCap('delegationsPerTurn', v))).toBe(false);
        expect([1, 10].every((v) => isPermittedTurnCap('toolCallsPerTurn', v))).toBe(true);
        expect([0, 11, '2'].some((v) => isPermittedTurnCap('toolCallsPerTurn', v))).toBe(false);
    });
});

describe('the tool-call admission', () => {
    it('admits up to the cap, and the refusal names the cap and the count', () => {
        expect(evaluateToolCallsPerTurn({ cap: 2, madeThisTurn: 1 }).allowed).toBe(true);
        const refused = evaluateToolCallsPerTurn({ cap: 2, madeThisTurn: 2 });
        expect(refused).toEqual({ allowed: false, cap: 2, madeThisTurn: 2 });
        expect(toolCallsPerTurnRefusalMessage(refused)).toBe(
            'tool_calls_per_turn_exceeded: this turn has already made 2 tool calls, the most your organization '
            + 'allows in one turn (2). Continue with the results you have; a later turn may call tools again.',
        );
    });

    it('a cap that is not a whole number at or above one reads as one: never unlimited', () => {
        expect(evaluateToolCallsPerTurn({ cap: Number.NaN, madeThisTurn: 1 }).allowed).toBe(false);
        expect(evaluateToolCallsPerTurn({ cap: 0, madeThisTurn: 1 }).allowed).toBe(false);
        expect(evaluateToolCallsPerTurn({ cap: 1, madeThisTurn: -5 }).madeThisTurn).toBe(0);
    });
});

describe('readTurnCaps', () => {
    it('reads the tenant row ONCE, by tenant id, selecting the organization\'s two columns and the settings\' two', async () => {
        mockFindUnique.mockResolvedValue({
            organization: { agentMaxSubagentsPerTurn: 4, agentMaxToolCallsPerTurn: 3 },
            securitySettings: { agentMaxSubagentsPerTurn: null, agentMaxToolCallsPerTurn: 2 },
        });
        const caps = await readTurnCaps('t1', 'r1');
        expect(mockFindUnique).toHaveBeenCalledTimes(1);
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { id: 't1' },
            select: {
                organization: { select: { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true } },
                securitySettings: { select: { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true } },
            },
        });
        expect(caps.delegationsPerTurn).toEqual({ value: 4, basis: 'ORGANIZATION_CEILING', ceiling: 4, workspace: null });
        expect(caps.toolCallsPerTurn).toEqual({ value: 2, basis: 'WORKSPACE', ceiling: 3, workspace: 2 });
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('a workspace with no organization and no settings row reads as the product defaults', async () => {
        mockFindUnique.mockResolvedValue({ organization: null, securitySettings: null });
        const caps = await readTurnCaps('t1', undefined);
        expect([caps.delegationsPerTurn.value, caps.toolCallsPerTurn.value]).toEqual([3, 1]);
        expect(caps.delegationsPerTurn.basis).toBe('NO_ORGANIZATION');
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('a failed read allows NO delegation and ONE tool call per turn — the narrowest of both — and logs it', async () => {
        mockFindUnique.mockRejectedValue(new Error('connection reset'));
        const caps = await readTurnCaps('t-narrow', 'req-9');

        expect(caps.delegationsPerTurn).toEqual({ value: 0, basis: 'FAILED_READ', ceiling: 0, workspace: null });
        expect(caps.toolCallsPerTurn).toEqual({ value: 1, basis: 'FAILED_READ', ceiling: 1, workspace: null });
        expect(FAILED_READ_FAN_OUT_CAP).toBe(0);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
            'turn-caps: settings read failed, allowing no delegation and one tool call per turn',
            expect.objectContaining({
                tenantId: 't-narrow',
                requestId: 'req-9',
                delegationsPerTurn: 0,
                toolCallsPerTurn: 1,
                error: 'connection reset',
            }),
        );
    });

    it('never throws, whatever the read throws', async () => {
        mockFindUnique.mockRejectedValue('not even an Error');
        const caps = await readTurnCaps('t1', undefined);
        expect(caps.delegationsPerTurn.value).toBe(0);
        expect(caps.toolCallsPerTurn.value).toBe(1);
    });
});
