/**
 * GAP-18 — Plan-entitlement evaluation + enforcement tests.
 *
 * Covers four behaviours the entitlement layer is responsible for:
 *
 *   1. SaaS vs self-hosted mode decision (`getBillingMode`).
 *   2. Effective-plan resolution per tenant under each mode
 *      (`getEffectivePlan`).
 *   3. Per-plan limit lookup (`getLimit`).
 *   4. Pre-mutation gate (`assertWithinLimit`):
 *        - throws `forbidden(plan_limit_exceeded: …)` at the cap,
 *        - lets the call through under the cap,
 *        - never throws under ENTERPRISE / SELFHOSTED.
 *
 * The mode decision is read at module load, so each test's mode
 * scenario is exercised by setting `STRIPE_SECRET_KEY` and then
 * `jest.resetModules()` + dynamic-importing the entitlements
 * module fresh.
 */

const ORIGINAL_STRIPE = process.env.STRIPE_SECRET_KEY;

// Helper: import a fresh module instance after env mutation.
async function loadEntitlements(stripeKey: string | undefined) {
    if (stripeKey === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
    } else {
        process.env.STRIPE_SECRET_KEY = stripeKey;
    }
    jest.resetModules();
    return await import('@/lib/billing/entitlements');
}

afterAll(() => {
    if (ORIGINAL_STRIPE === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
    } else {
        process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE;
    }
});

describe('getBillingMode', () => {
    it('returns SELFHOSTED when STRIPE_SECRET_KEY is unset', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getBillingMode()).toBe('SELFHOSTED');
    });

    it('returns SAAS when STRIPE_SECRET_KEY is set', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        expect(mod.getBillingMode()).toBe('SAAS');
    });

    it('treats empty STRIPE_SECRET_KEY as unset (still SELFHOSTED)', async () => {
        const mod = await loadEntitlements('');
        expect(mod.getBillingMode()).toBe('SELFHOSTED');
    });
});

describe('getLimit', () => {
    it('returns 10 controls for FREE', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('FREE', 'control')).toBe(10);
    });
    it('returns 100 controls for PRO and TRIAL', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('PRO', 'control')).toBe(100);
        expect(mod.getLimit('TRIAL', 'control')).toBe(100);
    });
    it('returns null (unlimited) for ENTERPRISE', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('ENTERPRISE', 'control')).toBeNull();
    });
});

// ─── Mocks for plan resolution + count ──────────────────────────
//
// `getEffectivePlan` and `assertWithinLimit` both depend on the
// shared db-context wrapper. We mock `runInTenantContext` to
// hand the inner callback a stub `db` whose shape covers just
// `billingAccount.findUnique` and `control.count`.

jest.mock('@/lib/db-context', () => {
    const stub = {
        billingAccount: {
            findUnique: jest.fn(),
        },
        control: {
            count: jest.fn(),
        },
    };
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runInTenantContext: jest.fn(async (_ctx: unknown, fn: any) => fn(stub)),
        __stub: stub,
    };
});

import { makeRequestContext } from '../../helpers/make-context';

describe('getEffectivePlan', () => {
    it('returns ENTERPRISE under SELFHOSTED mode regardless of stored plan', async () => {
        const mod = await loadEntitlements(undefined);
        // Even if a BillingAccount row exists with FREE, self-hosted
        // ignores it. Set a return value the function should NOT use.
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('ENTERPRISE');
        // Importantly, in SELFHOSTED the DB MUST NOT be queried.
        expect(dbCtx.__stub.billingAccount.findUnique).not.toHaveBeenCalled();
    });

    it('reads BillingAccount.plan under SAAS mode', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'PRO' });

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('PRO');
        expect(dbCtx.__stub.billingAccount.findUnique).toHaveBeenCalledTimes(1);
    });

    it('treats SaaS tenant with no BillingAccount row as FREE', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue(null);

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('FREE');
    });
});

describe('assertWithinLimit — control', () => {
    it('SELFHOSTED: passes regardless of count (no DB count query)', async () => {
        const mod = await loadEntitlements(undefined);
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        // Even if there are millions of rows, ENTERPRISE is unlimited.
        dbCtx.__stub.control.count.mockResolvedValue(9_999_999);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).resolves.toBeUndefined();
        // Unlimited path — count not even queried.
        expect(dbCtx.__stub.control.count).not.toHaveBeenCalled();
    });

    it('SAAS FREE: passes when current < 10', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.control.count.mockResolvedValue(9);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).resolves.toBeUndefined();
    });

    it('SAAS FREE: throws plan_limit_exceeded at exactly 10', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.control.count.mockResolvedValue(10);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).rejects.toThrow(/plan_limit_exceeded/);
    });

    it('SAAS FREE: throws above 10', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.control.count.mockResolvedValue(42);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).rejects.toThrow(/FREE plan allows 10 control/);
    });

    describe('a bulk create passes the rows it will write (#4795)', () => {
        async function freeAt(current: number) {
            const mod = await loadEntitlements('sk_test_dummy');
            const dbCtx = (await import('@/lib/db-context')) as unknown as {
                __stub: {
                    billingAccount: {
                        findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                    };
                    control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
                };
            };
            dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
            dbCtx.__stub.control.count.mockResolvedValue(current);
            return { mod, dbCtx };
        }

        it('passes when the rows fit exactly', async () => {
            const { mod } = await freeAt(7);
            await expect(
                mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control', 3),
            ).resolves.toBeUndefined();
        });

        it('refuses a batch that would step past the limit, though one more would fit', async () => {
            const { mod } = await freeAt(8);
            await expect(
                mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control', 1),
            ).resolves.toBeUndefined();
            await expect(
                mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control', 3),
            ).rejects.toThrow(/plan_limit_exceeded: FREE plan allows 10 control\(s\); tenant currently has 8\./);
        });

        it('writing nothing is never refused, and reads nothing', async () => {
            const { mod, dbCtx } = await freeAt(10);
            await expect(
                mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control', 0),
            ).resolves.toBeUndefined();
            expect(dbCtx.__stub.billingAccount.findUnique).not.toHaveBeenCalled();
            expect(dbCtx.__stub.control.count).not.toHaveBeenCalled();
        });
    });

    it('SAAS PRO: passes at 50 (below 100)', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'PRO' });
        dbCtx.__stub.control.count.mockResolvedValue(50);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).resolves.toBeUndefined();
    });

    it('SAAS ENTERPRISE: passes at any count (unlimited)', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'ENTERPRISE' });
        // The count helper would skip when limit is null; assert it
        // never gets called rather than mocking a value.

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control'),
        ).resolves.toBeUndefined();
        expect(dbCtx.__stub.control.count).not.toHaveBeenCalled();
    });

    it('error message includes plan, limit, and current count for billing-UI parsing', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                control: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.control.count.mockResolvedValue(13);

        try {
            await mod.assertWithinLimit(makeRequestContext('ADMIN'), 'control');
            fail('expected throw');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('plan_limit_exceeded');
            expect(msg).toContain('FREE');
            expect(msg).toContain('10');
            expect(msg).toContain('13');
        }
    });
});
