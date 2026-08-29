/**
 * Gate 4 — plan entitlement on the AI feature gate.
 *
 * BEHAVIOURAL. `AI_RISK_PLAN_REQUIRED` used to be accepted and then
 * silently ignored: `checkPlanEntitlement` returned `{ allowed: true }`
 * unconditionally behind a TODO whose blocker (billing) had shipped. An
 * operator who set the var to gate AI by plan got an unconditional ALLOW
 * — the wrong default for an entitlement check.
 *
 * These tests drive the REAL plan resolution (`getEffectivePlan` in
 * `@/lib/billing/entitlements`), stubbing only the DB round-trip, so the
 * two documented billing modes are exercised rather than asserted:
 *
 *   • SAAS       (`STRIPE_SECRET_KEY` set)   — plan from `BillingAccount.plan`
 *   • SELFHOSTED (`STRIPE_SECRET_KEY` unset) — always ENTERPRISE, no DB read
 *
 * Both `AI_RISK_PLAN_REQUIRED` (gate) and `STRIPE_SECRET_KEY` (mode) are
 * read once at module load, so every case sets env then re-requires the
 * module graph under a reset registry.
 */
import type { RequestContext } from '@/app-layer/types';

/** The DB seam under `getEffectivePlan`. Replaced per-case. */
let billingAccountRow: { plan: string } | null = null;
/** Counts resolver DB hits — proves SELFHOSTED short-circuits before one. */
let dbReads = 0;
/** When set, `runInTenantContext` throws it (DB down). */
let dbError: Error | null = null;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => {
            if (dbError) throw dbError;
            return fn({
                billingAccount: {
                    findUnique: async () => {
                        dbReads += 1;
                        return billingAccountRow;
                    },
                },
            });
        },
    ),
}));

const adminCtx = {
    userId: 'u1',
    tenantId: 't1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as unknown as RequestContext;

const readerCtx = {
    userId: 'u1',
    tenantId: 't1',
    role: 'READER',
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
} as unknown as RequestContext;

type Gate = typeof import('@/app-layer/ai/risk-assessment/feature-gate');

const ENV_KEYS = ['AI_RISK_PLAN_REQUIRED', 'STRIPE_SECRET_KEY'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    billingAccountRow = null;
    dbReads = 0;
    dbError = null;
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k] as string;
    }
    jest.resetModules();
});

/** Load a fresh gate (and a fresh billing module beneath it) under this env. */
function loadGate(overrides: Partial<Record<EnvKey, string | undefined>>): Gate {
    for (const k of ENV_KEYS) {
        const v = overrides[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    jest.resetModules();
    return require('@/app-layer/ai/risk-assessment/feature-gate') as Gate;
}

describe('SaaS mode — the gate actually enforces the configured plan', () => {
    it('REFUSES a tenant on a plan below the required tier', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'FREE' };

        const result = await gate.checkFeatureGateWithPlan(adminCtx, 'risk');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/PRO/);
        expect(dbReads).toBe(1);

        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).rejects.toThrow(/PRO/);
    });

    it('REFUSES a SaaS tenant with no BillingAccount row (resolves FREE)', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = null;

        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).rejects.toThrow(/PRO/);
    });

    it('ALLOWS a tenant on exactly the required tier', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'PRO' };

        expect((await gate.checkFeatureGateWithPlan(adminCtx, 'risk')).allowed).toBe(true);
        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).resolves.toBeUndefined();
    });

    it('ALLOWS a tenant on a tier above the requirement', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'ENTERPRISE' };

        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).resolves.toBeUndefined();
    });

    it('applies to every AI feature, not just risk', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'enterprise', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'TRIAL' };

        for (const feature of ['risk', 'assistant', 'questionnaire'] as const) {
            await expect(gate.enforceFeatureGate(adminCtx, feature)).rejects.toThrow(/ENTERPRISE/);
        }
    });

    it('still reports the flag/role refusal first — plan is the LAST gate', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'FREE' };

        const result = await gate.checkFeatureGateWithPlan(readerCtx, 'risk');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/Editor or Admin/);
        // A caller denied on role must not cost a billing lookup.
        expect(dbReads).toBe(0);
    });
});

describe('self-hosted mode is unaffected', () => {
    it('ALLOWS every tenant even at the highest required tier, with no DB read', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'enterprise', STRIPE_SECRET_KEY: undefined });
        // A stale FREE row must NOT be consulted in self-hosted mode.
        billingAccountRow = { plan: 'FREE' };

        expect((await gate.checkFeatureGateWithPlan(adminCtx, 'risk')).allowed).toBe(true);
        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).resolves.toBeUndefined();
        expect(dbReads).toBe(0);
    });

    it('an empty STRIPE_SECRET_KEY is self-hosted too', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: '' });
        billingAccountRow = { plan: 'FREE' };

        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).resolves.toBeUndefined();
        expect(dbReads).toBe(0);
    });
});

describe('opting out (the default) costs nothing', () => {
    it('no AI_RISK_PLAN_REQUIRED — allowed with no plan resolution at all', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: undefined, STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'FREE' };

        expect((await gate.checkFeatureGateWithPlan(adminCtx, 'risk')).allowed).toBe(true);
        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).resolves.toBeUndefined();
        expect(dbReads).toBe(0);
    });
});

describe('fail-closed', () => {
    it('REFUSES when the required plan names nothing we recognise (operator typo)', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'platinum', STRIPE_SECRET_KEY: 'sk_test_x' });
        billingAccountRow = { plan: 'ENTERPRISE' };

        const result = await gate.checkFeatureGateWithPlan(adminCtx, 'risk');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/misconfigured/i);
        expect(dbReads).toBe(0);
    });

    it('REFUSES when the plan cannot be resolved (DB down)', async () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        dbError = new Error('connection refused');

        const result = await gate.checkFeatureGateWithPlan(adminCtx, 'risk');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/could not be verified/i);
        await expect(gate.enforceFeatureGate(adminCtx, 'risk')).rejects.toThrow();
    });
});

describe('a forgotten `await` can never weaken the gate', () => {
    it('the flag/role refusal still throws SYNCHRONOUSLY', () => {
        const gate = loadGate({ AI_RISK_PLAN_REQUIRED: 'pro', STRIPE_SECRET_KEY: 'sk_test_x' });
        // Deliberately not awaited — this is the pre-existing enforcement,
        // and it must survive a caller that treats the gate as synchronous.
        expect(() => gate.enforceFeatureGate(readerCtx, 'risk')).toThrow(/Editor or Admin/);
    });
});
