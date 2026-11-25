/**
 * WHAT A HOSTED SESSION COST IN TIME (#4173, owner decision 4 of 2026-11-25):
 * `src/lib/agentic/managed-agents/session-usage.ts`.
 *
 *   • The figure is `usage.active_seconds`, the field the SDK names as what a
 *     session's runtime is priced on, and it is optional in the SDK's type: an
 *     absent, negative or non-finite figure, or a session still running, is
 *     UNKNOWN, never zero.
 *   • An unknown read writes nothing (the session stays counted unmetered),
 *     and a write that fails never throws into the settle.
 *
 * The behaviour over a real database and a faux workspace is in
 * `tests/integration/hosted-managed-agents-engine-run.test.ts`.
 */
const mockExecuteRaw = jest.fn();
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: { $executeRaw: typeof mockExecuteRaw }) => unknown) => fn({ $executeRaw: mockExecuteRaw })),
}));
const mockRecord = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({ recordHostedSessionUsage: (...a: unknown[]) => mockRecord(...a) }));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { BetaManagedAgentsSessionUsage } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';

import { meterHostedSession, sessionUsageFrom } from '@/lib/agentic/managed-agents/session-usage';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't-usage' });

beforeEach(() => {
    mockExecuteRaw.mockReset();
    mockRecord.mockReset();
});

describe('sessionUsageFrom: the priced seconds, or why they are unknown', () => {
    it('reads `usage.active_seconds`, the SDK\'s own name for the priced duration', () => {
        // Typed against the SDK, so a renamed field fails to compile here.
        const usage: BetaManagedAgentsSessionUsage = { active_seconds: 42.25, input_tokens: 10, output_tokens: 5 };
        expect(sessionUsageFrom({ status: 'idle', usage })).toEqual({ ok: true, activeSeconds: 42.25 });
        expect(sessionUsageFrom({ status: 'terminated', usage: { active_seconds: 0 } })).toEqual({ ok: true, activeSeconds: 0 });
    });

    it.each([
        ['no usage member', { status: 'idle' }, 'NOT_REPORTED'],
        ['usage without active_seconds', { status: 'idle', usage: { input_tokens: 3 } }, 'NOT_REPORTED'],
        ['a null figure', { status: 'idle', usage: { active_seconds: null } }, 'NOT_REPORTED'],
        ['a string figure', { status: 'idle', usage: { active_seconds: '12' } }, 'NOT_REPORTED'],
        ['a negative figure', { status: 'idle', usage: { active_seconds: -1 } }, 'NOT_REPORTED'],
        ['a non-finite figure', { status: 'idle', usage: { active_seconds: Number.POSITIVE_INFINITY } }, 'NOT_REPORTED'],
        ['a session still running', { status: 'running', usage: { active_seconds: 9 } }, 'STILL_RUNNING'],
        ['a session rescheduling', { status: 'rescheduling', usage: { active_seconds: 9 } }, 'STILL_RUNNING'],
    ] as const)('%s is unknown, never zero', (_label, session, reason) => {
        expect(sessionUsageFrom(session)).toEqual({ ok: false, reason });
    });
});

describe('meterHostedSession: never blocks the settle', () => {
    it('a known figure is written once, conditioned on a hosted run, and observed', async () => {
        mockExecuteRaw.mockResolvedValue(1);
        await meterHostedSession(ctx, 'run-1', { ok: true, activeSeconds: 7.5 });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
        const sql = (mockExecuteRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
        expect(sql).toMatch(/"hostedManagedAgents" = true/);
        expect(sql).toMatch(/COALESCE\("hostedSessionSeconds", 0\)/);
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'METERED', activeSeconds: 7.5 });
    });

    it('an unknown read writes nothing: the session stays counted unmetered', async () => {
        await meterHostedSession(ctx, 'run-1', { ok: false, reason: 'READ_FAILED' });
        expect(mockExecuteRaw).not.toHaveBeenCalled();
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'READ_FAILED' });
    });

    it('a write that throws is counted and swallowed', async () => {
        mockExecuteRaw.mockRejectedValue(new Error('connection reset'));
        await expect(meterHostedSession(ctx, 'run-1', { ok: true, activeSeconds: 3 })).resolves.toBeUndefined();
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'RECORD_FAILED' });
    });

    it('a write that matched no hosted run observes no seconds', async () => {
        mockExecuteRaw.mockResolvedValue(0);
        await meterHostedSession(ctx, 'run-1', { ok: true, activeSeconds: 3 });
        expect(mockRecord).toHaveBeenCalledWith({ outcome: 'RECORD_FAILED', activeSeconds: undefined });
    });
});
