/**
 * The shared AI refusals carry a `details.reason` (#5764).
 *
 * The AI feature gate, the AI rate limiter and the AI Guard refused with an
 * English sentence only, so a page could not word the refusal in the reader's
 * language: the vendor assessment pre-fill showed every one of them as
 * "Extraction failed". Each now names its reason in `details`, which the API
 * envelope carries; the message is unchanged, because callers parse it.
 */
import type { RequestContext } from '@/app-layer/types';
import { AppError, toApiErrorResponse } from '@/lib/errors/types';
import { assertGuardAllowed, type GuardOutcome } from '@/app-layer/ai/guard';
import {
    checkRateLimit,
    recordGeneration,
    _resetForTesting,
    LIMITS,
} from '@/app-layer/ai/risk-assessment/rate-limiter';

const findUnique = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique } }),
}));

const ctx = {
    userId: 'u1',
    tenantId: 't1',
    requestId: 'r1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as unknown as RequestContext;

/** Load a fresh gate under an env snapshot — the flags are module constants. */
function loadGate(env: Record<string, string>) {
    let mod!: typeof import('@/app-layer/ai/risk-assessment/feature-gate');
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    jest.isolateModules(() => {
        mod = require('@/app-layer/ai/risk-assessment/feature-gate');
    });
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return mod;
}

const ALL_ON = {
    AI_RISK_ENABLED: 'true',
    AI_RISK_SUGGESTIONS_ENABLED: 'true',
    AI_ASSISTANT_ENABLED: 'true',
    AI_QUESTIONNAIRE_ENABLED: 'true',
};

async function refusalOf(run: () => unknown): Promise<AppError> {
    try {
        await run();
    } catch (e) {
        // By shape, not `instanceof`: `loadGate` loads the gate in an isolated
        // module registry, whose error classes are not this file's.
        expect(typeof (e as AppError).status).toBe('number');
        return e as AppError;
    }
    throw new Error('expected a refusal');
}

function reasonOf(err: AppError): unknown {
    return (err.details as { reason?: unknown } | undefined)?.reason;
}

beforeEach(() => {
    findUnique.mockReset();
    _resetForTesting();
});

describe('the AI feature gate names its refusal', () => {
    it('AI_DISABLED when the deployment switch is off', async () => {
        const gate = loadGate({ ...ALL_ON, AI_RISK_ENABLED: 'false' });
        const err = await refusalOf(() => gate.enforceFeatureGate(ctx, 'risk'));
        expect(err.status).toBe(403);
        expect(reasonOf(err)).toBe('AI_DISABLED');
    });

    it('AI_ROLE_REQUIRED for a caller without the write tier', async () => {
        const gate = loadGate(ALL_ON);
        const reader = { ...ctx, permissions: { ...ctx.permissions, canWrite: false } } as RequestContext;
        expect(reasonOf(await refusalOf(() => gate.enforceFeatureGate(reader, 'risk')))).toBe('AI_ROLE_REQUIRED');
    });

    it('AI_TURNED_OFF_FOR_WORKSPACE when the workspace turned AI off', async () => {
        findUnique.mockResolvedValue({ aiEnabled: false, aiRiskSuggestionsEnabled: true });
        const gate = loadGate(ALL_ON);
        expect(reasonOf(await refusalOf(() => gate.enforceFeatureGate(ctx, 'risk')))).toBe(
            'AI_TURNED_OFF_FOR_WORKSPACE',
        );
    });

    it('AI_AVAILABILITY_UNCONFIRMED when the workspace settings cannot be read', async () => {
        findUnique.mockRejectedValue(new Error('connection terminated'));
        const gate = loadGate(ALL_ON);
        expect(reasonOf(await refusalOf(() => gate.enforceFeatureGate(ctx, 'risk')))).toBe(
            'AI_AVAILABILITY_UNCONFIRMED',
        );
    });
});

describe('the AI rate limiter names its refusal', () => {
    it('AI_TOO_MANY_REQUESTS for the per-minute burst', async () => {
        for (let i = 0; i < LIMITS.USER_PER_MINUTE_LIMIT; i++) await recordGeneration('t1', 'u1');
        const err = await refusalOf(() => checkRateLimit('t1', 'u1'));
        expect(err.status).toBe(429);
        expect(reasonOf(err)).toBe('AI_TOO_MANY_REQUESTS');
    });

    it('AI_DAILY_LIMIT_REACHED, with when it resets, for the daily quota', async () => {
        for (let i = 0; i < LIMITS.TENANT_DAILY_QUOTA; i++) await recordGeneration('t1', `u-${i}`);
        const err = await refusalOf(() => checkRateLimit('t1', 'u-new'));
        expect(err.status).toBe(429);
        expect(err.details).toMatchObject({ reason: 'AI_DAILY_LIMIT_REACHED', limit: LIMITS.TENANT_DAILY_QUOTA });
        expect((err.details as { resetInMinutes: number }).resetInMinutes).toBeGreaterThanOrEqual(1);
    });
});

describe('the AI Guard names its block', () => {
    it('AI_GUARD_BLOCKED, keeping the message prefix callers parse', async () => {
        const outcome = {
            verdict: 'malicious',
            ruleIds: ['inj.1'],
            mode: 'strict',
            action: 'block',
            blocked: true,
            reviewRequired: true,
            source: 'vendor-doc',
            direction: 'input',
        } as unknown as GuardOutcome;
        const err = await refusalOf(() => assertGuardAllowed(outcome));
        expect(err.status).toBe(403);
        expect(err.message.startsWith('ai_guard_blocked:')).toBe(true);
        expect(reasonOf(err)).toBe('AI_GUARD_BLOCKED');
        // The envelope a page reads carries it.
        expect(toApiErrorResponse(err).payload.error.details).toEqual({ reason: 'AI_GUARD_BLOCKED' });
    });
});
