/**
 * The tenant's half of the agentic-driver gate, and the fact that it can now
 * be written at all.
 *
 * ── THE DEFECT THIS FILE IS ABOUT ───────────────────────────────────────────
 *
 * `TenantSecuritySettings.agentDriver` had a reader — `resolveDriverForTenant`,
 * on every agentic run — and no writer anywhere in `src/`. A column read on the
 * hot path and written by nothing is not a switch; it is a constant wearing a
 * switch's name, and every tenant sat at the migration's `@default(STATIC)`
 * with no product surface able to move one.
 *
 * ── THE CLAIM THAT MATTERS MOST ─────────────────────────────────────────────
 *
 * Not "the write happens" — "the read tells the truth about what will happen".
 * The gate ANDs three terms and this usecase owns one of them. A tenant set to
 * FLUE in a deployment whose `AGENT_DRIVER_FLUE` is off runs on the STATIC
 * engine, and a settings surface reporting only the stored mode would show
 * FLUE while every run went elsewhere. So `effective` is asserted against the
 * combinations, not just the storage.
 */
type SettingsRow = { agentDriver: string | null } | null;
let row: SettingsRow = { agentDriver: 'STATIC' };

const upsert = jest.fn(async (_args: unknown): Promise<unknown> => ({}));
const findUnique = jest.fn(async (_args: unknown): Promise<unknown> => row);
const mockDb = { tenantSecuritySettings: { findUnique, upsert } };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const logEvent = jest.fn(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

const envBag: { AGENT_DRIVER_FLUE?: string } = {};
jest.mock('@/env', () => ({ env: new Proxy({}, { get: (_t, k: string) => envBag[k as 'AGENT_DRIVER_FLUE'] }) }));

jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/**
 * THE REGISTRY IS MOCKED, AND IT DID NOT USED TO BE.
 *
 * This file's subject is the GATE — that `narrowToWhatAWorkflowAsksFor`
 * resolves both ways — and its negative arm is "no definition asks". Driving
 * that arm through the REAL registry made it reachable only while nothing
 * shipped asked, so the day one did (`posture-review`) this test went red
 * having found no defect: the premise had been retired, not violated.
 *
 * What SHIPS is a different claim and has its own home.
 * `tests/guardrails/canned-workflows-coverage.test.ts` asserts through
 * `selectRunDriver` that a shipped definition actually reaches the engine —
 * which is the claim that would have to fail for the engine to be unreachable
 * again, and it fails there rather than here.
 *
 * So both arms are driven by one knob, and neither depends on the registry's
 * contents. The name must start with `mock` — `babel-plugin-jest-hoist`
 * refuses any other out-of-scope binding inside a hoisted factory.
 */
let mockDefinitions: Array<{ driver?: string }> = [];
jest.mock('@/lib/agentic/workflow-registry', () => ({
    listWorkflowDefinitions: () => mockDefinitions,
}));

import {
    getAgentDriverSetting,
    setAgentDriverSetting,
} from '@/app-layer/usecases/agent-driver-setting';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';

import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER');

beforeEach(() => {
    jest.clearAllMocks();
    row = { agentDriver: 'STATIC' };
    delete envBag.AGENT_DRIVER_FLUE;
    mockDefinitions = [];
});

describe('what the tenant has asked for', () => {
    it('writes the mode, and upserts so a tenant with no settings row can be enabled', async () => {
        // The upsert is the half that matters for a FIRST enablement: the
        // tenants nobody has configured anything for are exactly the ones with
        // no settings row, and an `update` alone would throw P2025 on them.
        await setAgentDriverSetting(ctx, 'FLUE');

        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, agentDriver: 'FLUE' },
                update: { agentDriver: 'FLUE' },
            }),
        );
    });

    it('narrows back to STATIC with no cooldown — it is the kill switch', async () => {
        // A dwell on the way DOWN is how a safety control becomes the incident.
        row = { agentDriver: 'FLUE' };
        await setAgentDriverSetting(ctx, 'STATIC');
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: { agentDriver: 'STATIC' } }),
        );
    });

    it('refuses a mode the resolver does not recognise', async () => {
        await expect(setAgentDriverSetting(ctx, 'TURBO' as never)).rejects.toThrow(
            /Unknown agent driver mode/,
        );
        expect(upsert).not.toHaveBeenCalled();
    });
});

describe('what a run would ACTUALLY execute on', () => {
    it('reports STATIC when the tenant asked for FLUE and the operator switch is off', async () => {
        // The case the whole `effective` field exists for. Reporting `mode`
        // alone here would tell an operator their tenant is on Flue while
        // every run goes to the static engine.
        row = { agentDriver: 'FLUE' };
        const out = await getAgentDriverSetting(ctx);

        expect(out.mode).toBe('FLUE');
        expect(out.effective.driver).toBe('static');
        expect(out.envEnabled).toBe(false);
        // And the reason names WHICH term refused, so the operator knows to go
        // and set the env var rather than re-clicking the toggle.
        expect(out.effective.reason).toBe('ENV_DISABLED');
    });

    it('reports STATIC when no workflow asks for the engine, however the switches are set', async () => {
        // THE FOURTH TERM, and the one that had no name until it was added.
        // `selectRunDriver` resolves flue only when the DEFINITION asks for
        // it, so a registry in which none does leaves every run on the static
        // engine with the env var on, the tenant opted in and the build
        // implemented.
        //
        // Reporting `flue` with `reason: null` here told an operator the
        // configured driver was IN FORCE. It was permitted, which is a
        // different fact, and the difference is every run they were looking at.
        mockDefinitions = [{ driver: 'static' }, {}];
        envBag.AGENT_DRIVER_FLUE = '1';
        row = { agentDriver: 'FLUE' };

        const out = await getAgentDriverSetting(ctx);

        expect(out).toMatchObject({ mode: 'FLUE', envEnabled: true, implemented: true });
        expect(out.effective).toEqual({
            driver: 'static',
            reason: 'NO_WORKFLOW_REQUESTS_IT',
        });
    });

    it('reports flue only when ALL FOUR terms say so', async () => {
        // FOUR, not three — and the build flag is asserted against
        // `DRIVER_IMPLEMENTED.flue` rather than against today's value of it.
        // A literal `'flue'` here would be a test of what this build happens
        // to be, green today and red the morning the flag flips (or the other
        // way round); reading the constant makes this a test of the
        // CONJUNCTION, which is the thing that has to stay true either side of
        // that change.
        //
        // The FOURTH term first: a definition that asks for the engine.
        // Without one `selectRunDriver` can never choose flue, and the test
        // above pins that case.
        mockDefinitions = [{ driver: 'static' }, { driver: 'flue' }];
        envBag.AGENT_DRIVER_FLUE = '1';
        row = { agentDriver: 'FLUE' };

        const out = await getAgentDriverSetting(ctx);

        expect(out).toMatchObject({ mode: 'FLUE', envEnabled: true, implemented: DRIVER_IMPLEMENTED.flue });
        expect(out.effective.driver).toBe(DRIVER_IMPLEMENTED.flue ? 'flue' : 'static');
        // And whichever way that goes, the surface says WHY. A tenant that has
        // asked, in a deployment that has switched on, still running static
        // because the build has no implementation is the one state an operator
        // cannot diagnose from the toggle alone.
        if (!DRIVER_IMPLEMENTED.flue) expect(out.effective.reason).toBe('DRIVER_NOT_IMPLEMENTED');
    });

    it('the env switch alone does not enable a tenant that has not asked', async () => {
        // The other direction of the AND, and the one a positive-only test
        // would miss: turning the deployment switch on must not move a single
        // tenant that never opted in.
        envBag.AGENT_DRIVER_FLUE = '1';
        row = { agentDriver: 'STATIC' };
        const out = await getAgentDriverSetting(ctx);
        expect(out.effective.driver).toBe('static');
    });

    it('an absent settings row reads STATIC rather than throwing', async () => {
        row = null;
        await expect(getAgentDriverSetting(ctx)).resolves.toMatchObject({ mode: 'STATIC' });
    });

    it('an unrecognised stored value reads STATIC, as the run path coerces it', async () => {
        // The same coercion `resolveDriverForTenant` applies. Reading it any
        // other way here would make this surface disagree with the run path
        // about the same stored byte.
        row = { agentDriver: 'PROPOSE' };
        await expect(getAgentDriverSetting(ctx)).resolves.toMatchObject({ mode: 'STATIC' });
    });
});

describe('the decision leaves a trail an access review can read', () => {
    it('writes an audit row in the access category, naming both ends of the move', async () => {
        row = { agentDriver: 'STATIC' };
        await setAgentDriverSetting(ctx, 'FLUE');

        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'AGENT_DRIVER_MODE_CHANGED',
                entityType: 'Tenant',
                entityId: ctx.tenantId,
                detailsJson: expect.objectContaining({ category: 'access', operation: 'grant' }),
                metadata: expect.objectContaining({ from: 'STATIC', to: 'FLUE' }),
            }),
        );
    });

    it('records the OTHER key\'s state at the moment of the decision', async () => {
        // Without it the trail cannot tell "switched to FLUE and ran on Flue"
        // from "switched to FLUE and kept running static because the
        // deployment switch was off" — two very different sets of runs, and
        // the distinction is unrecoverable after the env var next changes.
        row = { agentDriver: 'STATIC' };
        await setAgentDriverSetting(ctx, 'FLUE');
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ metadata: expect.objectContaining({ envEnabled: false }) }),
        );
    });

    it('a narrow is recorded as a revoke, not a grant', async () => {
        row = { agentDriver: 'FLUE' };
        await setAgentDriverSetting(ctx, 'STATIC');
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                detailsJson: expect.objectContaining({ operation: 'revoke' }),
            }),
        );
    });
});
