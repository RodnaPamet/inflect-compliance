/**
 * The residency gate on the typed-intent layer.
 *
 * The operator's phrase routinely names a person, so WHERE it may be sent is
 * the whole question here. These tests set the permissive case wherever they
 * can — a local gateway configured, a model named, a key present — and assert
 * that the gate still refuses everything but a `LOCAL_ONLY` tenant on the
 * deployment's own gateway.
 */

const mutableEnv: Record<string, string | undefined> = {
    AI_LOCAL_BASE_URL: 'http://laya.internal:8080',
    AI_LOCAL_MODEL: 'deployment-default-model',
    // Present on purpose: an external credential existing must not make the
    // intent layer reachable for an EXTERNAL tenant.
    ANTHROPIC_API_KEY: 'anthropic-test-key', // pragma: allowlist secret
    ANTHROPIC_MODEL: 'claude-test',
};
jest.mock('@/env', () => ({ env: mutableEnv }));

const mockDb = {
    tenantSecuritySettings: { findUnique: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn(mockDb),
    ),
}));

const createLayaIntentChooser = jest.fn((_opts: Record<string, unknown>) => ({
    choose: jest.fn(),
}));
jest.mock('@/app-layer/ai/intent/laya-chooser', () => ({
    createLayaIntentChooser,
}));

import { intentChooserForTenant } from '@/app-layer/ai/intent/chooser-for-tenant';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

// The chooser requires an absolute ceiling — see `LayaChooserOptions.deadlineAt`.
const DEADLINE = 1_700_000_000_000;

function settings(over: Record<string, unknown> | null) {
    mockDb.tenantSecuritySettings.findUnique.mockResolvedValue(over);
}

beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.AI_LOCAL_BASE_URL = 'http://laya.internal:8080';
    mutableEnv.AI_LOCAL_MODEL = 'deployment-default-model';
});

describe('intentChooserForTenant', () => {
    it('builds a chooser for a LOCAL_ONLY tenant on the deployment gateway', async () => {
        settings({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null, aiLocalModel: null });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out.ok).toBe(true);
        expect(createLayaIntentChooser).toHaveBeenCalledTimes(1);
        expect(createLayaIntentChooser).toHaveBeenCalledWith(
            expect.objectContaining({
                baseUrl: 'http://laya.internal:8080',
                model: 'deployment-default-model',
            }),
        );
    });

    it('refuses an EXTERNAL tenant even with an external credential present', async () => {
        settings({ aiResidency: 'EXTERNAL', aiLocalBaseUrl: null, aiLocalModel: null });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out).toEqual({ ok: false, reason: 'RESIDENCY_NOT_LOCAL_ONLY' });
        expect(createLayaIntentChooser).not.toHaveBeenCalled();
    });

    it('refuses a tenant with no settings row at all', async () => {
        // An absent row reads as EXTERNAL — the same default the settings
        // usecase applies. A tenant that never chose a posture must not get a
        // local model call by accident.
        settings(null);
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out).toEqual({ ok: false, reason: 'RESIDENCY_NOT_LOCAL_ONLY' });
        expect(createLayaIntentChooser).not.toHaveBeenCalled();
    });

    it('refuses a gateway this deployment does not serve, rather than dialling it', async () => {
        // THE invariant this module exists for. A tenant admin can type any
        // host into `aiLocalBaseUrl`; the provider is built at boot from
        // AI_LOCAL_BASE_URL alone, so honouring the column would send the
        // phrase somewhere the deployment operator never nominated.
        //
        // This is also WHY there is no separate "dials the deployment URL, not
        // the column" test below: the only configuration in which the two
        // differ is refused outright here, so no reachable input can dial the
        // column's value.
        settings({
            aiResidency: 'LOCAL_ONLY',
            aiLocalBaseUrl: 'http://attacker.example:9999',
            aiLocalModel: null,
        });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out).toEqual({ ok: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' });
        expect(createLayaIntentChooser).not.toHaveBeenCalled();
    });

    it('refuses when no local gateway is configured anywhere', async () => {
        mutableEnv.AI_LOCAL_BASE_URL = undefined;
        settings({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null, aiLocalModel: null });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out).toEqual({ ok: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' });
        expect(createLayaIntentChooser).not.toHaveBeenCalled();
    });

    it('refuses when a gateway is configured but no model is named', async () => {
        mutableEnv.AI_LOCAL_MODEL = undefined;
        settings({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null, aiLocalModel: null });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out).toEqual({ ok: false, reason: 'LOCAL_MODEL_NOT_CONFIGURED' });
        expect(createLayaIntentChooser).not.toHaveBeenCalled();
    });

    it('carries a per-tenant model override, which unlike the gateway does serve', async () => {
        settings({
            aiResidency: 'LOCAL_ONLY',
            aiLocalBaseUrl: 'http://laya.internal:8080',
            aiLocalModel: 'tenant-chosen/model-with-slash',
        });
        const out = await intentChooserForTenant(ctx, { deadlineAt: DEADLINE });
        expect(out.ok).toBe(true);
        // The model may contain a slash, so the specifier is split on the
        // known provider prefix rather than on the separator.
        expect(createLayaIntentChooser).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'tenant-chosen/model-with-slash' }),
        );
    });

    it("passes the caller's budget through as the absolute ceiling", async () => {
        // There is no "omitted" case to test: `deadlineAt` is REQUIRED by
        // `LayaChooserOptions` precisely so no layer invents a ceiling for a
        // request whose deadline it cannot see.
        settings({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null, aiLocalModel: null });
        await intentChooserForTenant(ctx, { deadlineAt: 1_234 });
        expect(createLayaIntentChooser).toHaveBeenCalledWith(
            expect.objectContaining({ deadlineAt: 1_234 }),
        );
    });
});
