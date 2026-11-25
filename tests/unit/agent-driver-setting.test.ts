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
/**
 * The TEXT read the usecase does now (#4224), in the shape
 * `SELECT "agentDriver"::text` returns: a row array, empty when there is no
 * settings row. Driven off the same `row` fixture, so every case below keeps
 * its meaning.
 *
 * Worth knowing what this double CANNOT express, because it is why #4224
 * survived: a real Prisma client meeting a stored value its enum was not
 * generated with fails the whole read, and `findUnique` above returned the
 * string happily — so `row = { agentDriver: 'PROPOSE' }` passed here while the
 * same value answered 500 in production. The reachability of that path is
 * proved against a real database in
 * `tests/integration/agent-driver-unknown-stored-mode.test.ts`.
 */
const queryRaw = jest.fn(async (): Promise<unknown> => (row ? [row] : []));
/**
 * The workspace's ENABLED `anthropic-workspace` connections (Step 5d), as the
 * engine setting reads them: none unless a test sets some.
 */
let workspaceConnections: Array<{ id: string }> = [];
const connectionFindMany = jest.fn(async (_args: unknown): Promise<unknown> => workspaceConnections);
const mockDb = {
    tenantSecuritySettings: { findUnique, upsert },
    integrationConnection: { findMany: connectionFindMany },
    $queryRaw: queryRaw,
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const logEvent = jest.fn(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

const envBag: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: new Proxy({}, { get: (_t, k: string) => envBag[k] }) }));
// The workspace's organization row (#4557). `null` — no organization — unless a
// test sets one, so every env-only case reads exactly as it did before.
const orgRow: { value: { agentProfilesEnabled: boolean; agentToolRunnerEnabled: boolean } | null } = { value: null };
// The workspace's own Managed Agents toggle (#5964): off unless a test sets it.
const workspaceToggle = { value: false };
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: jest.fn(async () => ({ organization: orgRow.value })) },
        tenantSecuritySettings: { findFirst: jest.fn(async () => ({ managedAgentsEnabled: workspaceToggle.value })) },
    },
}));

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
    orgRow.value = null;
    workspaceToggle.value = false;
    jest.clearAllMocks();
    row = { agentDriver: 'STATIC' };
    for (const k of Object.keys(envBag)) delete envBag[k];
    mockDefinitions = [];
    workspaceConnections = [];
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

describe('the Tool Runner engine (Step 2c)', () => {
    it('is written, and recorded as a grant with its own switch beside Flue\'s', async () => {
        envBag.AGENT_DRIVER_TOOL_RUNNER = '1';
        row = { agentDriver: 'STATIC' };
        await setAgentDriverSetting(ctx, 'TOOL_RUNNER');
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: { agentDriver: 'TOOL_RUNNER' } }),
        );
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                detailsJson: expect.objectContaining({ operation: 'grant' }),
                metadata: expect.objectContaining({
                    to: 'TOOL_RUNNER',
                    toolRunnerEnvEnabled: true,
                    toolRunnerImplemented: DRIVER_IMPLEMENTED['tool-runner'],
                }),
            }),
        );
    });

    it('reports its own switch and build flag, separate from Flue\'s', async () => {
        envBag.AGENT_DRIVER_TOOL_RUNNER = '1';
        const view = await getAgentDriverSetting(ctx);
        expect(view.envEnabled).toBe(false);
        expect(view.toolRunner).toEqual({
            envEnabled: true,
            implemented: DRIVER_IMPLEMENTED['tool-runner'],
            basis: 'DEPLOYMENT_ON',
        });
    });

    describe('with AGENT_DRIVER_TOOL_RUNNER unset, the organization decides (#4557)', () => {
        it('available when the organization turned it on, saying so', async () => {
            orgRow.value = { agentProfilesEnabled: false, agentToolRunnerEnabled: true };
            const view = await getAgentDriverSetting(ctx);
            expect(view.toolRunner).toMatchObject({ envEnabled: true, basis: 'ORGANIZATION_ON' });
        });

        it('not available while the organization has not, saying who holds it', async () => {
            orgRow.value = { agentProfilesEnabled: false, agentToolRunnerEnabled: false };
            row = { agentDriver: 'TOOL_RUNNER' };
            const view = await getAgentDriverSetting(ctx);
            expect(view.toolRunner).toMatchObject({ envEnabled: false, basis: 'ORGANIZATION_OFF' });
            expect(view.effective).toEqual({ driver: 'static', reason: 'ENV_DISABLED' });
        });

        it('a workspace with no organization stays off, as before', async () => {
            orgRow.value = null;
            const view = await getAgentDriverSetting(ctx);
            expect(view.toolRunner).toMatchObject({ envEnabled: false, basis: 'NO_ORGANIZATION' });
        });

        it('the deployment\'s 0 vetoes an organization that turned it on', async () => {
            envBag.AGENT_DRIVER_TOOL_RUNNER = '0';
            orgRow.value = { agentProfilesEnabled: true, agentToolRunnerEnabled: true };
            const view = await getAgentDriverSetting(ctx);
            expect(view.toolRunner).toMatchObject({ envEnabled: false, basis: 'DEPLOYMENT_OFF' });
        });
    });

    it('reads static, naming why, when the profile surface is off for the workspace', async () => {
        envBag.AGENT_DRIVER_TOOL_RUNNER = '1';
        row = { agentDriver: 'TOOL_RUNNER' };
        const view = await getAgentDriverSetting(ctx);
        // With the build flag still off this is DRIVER_NOT_IMPLEMENTED; once it
        // is on, nothing in a workspace without profiles asks for the engine.
        expect(view.effective).toEqual({
            driver: 'static',
            reason: DRIVER_IMPLEMENTED['tool-runner'] ? 'NO_WORKFLOW_REQUESTS_IT' : 'DRIVER_NOT_IMPLEMENTED',
        });
    });

    it('is in force where the profile surface is on for the workspace', async () => {
        envBag.AGENT_DRIVER_TOOL_RUNNER = '1';
        envBag.AGENT_PROFILES_TENANTS = ctx.tenantSlug ?? '';
        row = { agentDriver: 'TOOL_RUNNER' };
        const view = await getAgentDriverSetting(ctx);
        expect(view.effective).toEqual(
            DRIVER_IMPLEMENTED['tool-runner']
                ? { driver: 'tool-runner', reason: null }
                : { driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' },
        );
    });
});

describe('the Managed Agents engine (Step 5d)', () => {
    async function refusalOf(p: Promise<unknown>): Promise<{ status?: number; reason?: string }> {
        try {
            await p;
        } catch (err) {
            const e = err as { status?: number; details?: { reason?: string } };
            return { status: e.status, reason: e.details?.reason };
        }
        throw new Error('expected a refusal');
    }

    it('cannot be chosen without a connected workspace, by name, and nothing is written', async () => {
        workspaceConnections = [];
        envBag.AGENT_MANAGED_AGENTS = '1';
        expect(await refusalOf(setAgentDriverSetting(ctx, 'MANAGED_AGENTS'))).toEqual({
            status: 409,
            reason: 'MANAGED_AGENTS_NO_WORKSPACE',
        });
        expect(upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('cannot be chosen with two enabled workspaces, because a run never chooses between them', async () => {
        workspaceConnections = [{ id: 'c1' }, { id: 'c2' }];
        envBag.AGENT_MANAGED_AGENTS = '1';
        expect(await refusalOf(setAgentDriverSetting(ctx, 'MANAGED_AGENTS'))).toEqual({
            status: 409,
            reason: 'MANAGED_AGENTS_AMBIGUOUS_WORKSPACE',
        });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('asks only about ENABLED connections of the workspace provider, one past the answer', async () => {
        await getAgentDriverSetting(ctx);
        expect(connectionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: ctx.tenantId, provider: 'anthropic-workspace', isEnabled: true },
                take: 2,
            }),
        );
    });

    it('is written with exactly one connected workspace, recorded as a grant with its terms', async () => {
        workspaceConnections = [{ id: 'c1' }];
        envBag.AGENT_MANAGED_AGENTS = '1';
        await setAgentDriverSetting(ctx, 'MANAGED_AGENTS');
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { agentDriver: 'MANAGED_AGENTS' } }));
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                detailsJson: expect.objectContaining({ operation: 'grant' }),
                metadata: expect.objectContaining({
                    to: 'MANAGED_AGENTS',
                    managedAgentsEnvEnabled: true,
                    managedAgentsWorkspace: 'CONNECTED',
                }),
            }),
        );
    });

    it('moving AWAY never needs a workspace: the narrow stays instant', async () => {
        row = { agentDriver: 'MANAGED_AGENTS' };
        workspaceConnections = [];
        await setAgentDriverSetting(ctx, 'STATIC');
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { agentDriver: 'STATIC' } }));
    });

    it('reports its own switch, build flag and workspace', async () => {
        workspaceConnections = [{ id: 'c1' }];
        envBag.AGENT_MANAGED_AGENTS = '1';
        const view = await getAgentDriverSetting(ctx);
        expect(view.managedAgents).toEqual({
            envEnabled: true,
            basis: 'DEPLOYMENT_ON',
            implemented: DRIVER_IMPLEMENTED['managed-agents'],
            workspace: 'CONNECTED',
            // Step 6b: its own workspace wins, so no hosted term is named.
            hostedRefusal: null,
        });
    });

    it('with no connection of its own, names the hosted term that failed: hosting is not active (Step 6b)', async () => {
        workspaceConnections = [];
        envBag.AGENT_MANAGED_AGENTS = '1';
        const view = await getAgentDriverSetting(ctx);
        expect(view.managedAgents).toMatchObject({ workspace: 'NONE', hostedRefusal: 'HOSTED_NOT_ACTIVE' });
    });

    it('is in force for a workspace that chose it, with its switch on and profiles on', async () => {
        // The setting's read passes the engine's own switch to the gate: before
        // Step 5d it did not, and reported ENV_DISABLED while runs used it.
        workspaceConnections = [{ id: 'c1' }];
        envBag.AGENT_MANAGED_AGENTS = '1';
        envBag.AGENT_PROFILES_TENANTS = ctx.tenantSlug ?? '';
        row = { agentDriver: 'MANAGED_AGENTS' };
        const view = await getAgentDriverSetting(ctx);
        expect(view.effective).toEqual(
            DRIVER_IMPLEMENTED['managed-agents']
                ? { driver: 'managed-agents', reason: null }
                : { driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' },
        );
    });

    describe('it is not chosen while its switch is off (#5964, owner decision 2026-11-25)', () => {
        it.each([
            ['the workspace has not turned it on', undefined, false, 'WORKSPACE_OFF'],
            ['the operator vetoed it, over a workspace that turned it on', '0', true, 'DEPLOYMENT_OFF'],
        ] as const)('refused with MANAGED_AGENTS_OFF when %s, and nothing is written', async (_label, variable, toggle, basis) => {
            workspaceConnections = [{ id: 'c1' }];
            workspaceToggle.value = toggle;
            if (variable !== undefined) envBag.AGENT_MANAGED_AGENTS = variable;
            const refused = await setAgentDriverSetting(ctx, 'MANAGED_AGENTS').then(
                () => null,
                (err: { status?: number; details?: unknown }) => ({ status: err.status, details: err.details }),
            );
            expect(refused).toEqual({ status: 409, details: { reason: 'MANAGED_AGENTS_OFF', basis } });
            expect(upsert).not.toHaveBeenCalled();
            expect(logEvent).not.toHaveBeenCalled();
        });

        it('allowed while the workspace has it on', async () => {
            workspaceConnections = [{ id: 'c1' }];
            workspaceToggle.value = true;
            await setAgentDriverSetting(ctx, 'MANAGED_AGENTS');
            expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { agentDriver: 'MANAGED_AGENTS' } }));
        });

        it.each(['STATIC', 'FLUE', 'TOOL_RUNNER'] as const)('moving from it to %s is allowed while it is off', async (to) => {
            row = { agentDriver: 'MANAGED_AGENTS' };
            workspaceConnections = [{ id: 'c1' }];
            await setAgentDriverSetting(ctx, to);
            expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { agentDriver: to } }));
        });
    });

    describe('with AGENT_MANAGED_AGENTS unset, the workspace decides (#5964)', () => {
        it('on when its owner turned it on, saying so, and the engine is in force', async () => {
            workspaceToggle.value = true;
            workspaceConnections = [{ id: 'c1' }];
            envBag.AGENT_PROFILES_TENANTS = ctx.tenantSlug ?? '';
            row = { agentDriver: 'MANAGED_AGENTS' };
            const view = await getAgentDriverSetting(ctx);
            expect(view.managedAgents).toMatchObject({ envEnabled: true, basis: 'WORKSPACE_ON' });
            expect(view.effective).toEqual({ driver: 'managed-agents', reason: null });
        });

        it('off while its owner has not, naming the workspace as who holds it', async () => {
            workspaceConnections = [{ id: 'c1' }];
            envBag.AGENT_PROFILES_TENANTS = ctx.tenantSlug ?? '';
            row = { agentDriver: 'MANAGED_AGENTS' };
            const view = await getAgentDriverSetting(ctx);
            expect(view.managedAgents).toMatchObject({ envEnabled: false, basis: 'WORKSPACE_OFF' });
            expect(view.effective).toEqual({ driver: 'static', reason: 'ENV_DISABLED' });
        });

        it('the operator\'s 0 vetoes a workspace that turned it on', async () => {
            workspaceToggle.value = true;
            envBag.AGENT_MANAGED_AGENTS = '0';
            row = { agentDriver: 'MANAGED_AGENTS' };
            const view = await getAgentDriverSetting(ctx);
            expect(view.managedAgents).toMatchObject({ envEnabled: false, basis: 'DEPLOYMENT_OFF' });
        });

        it('records the basis beside the switch when the engine choice changes', async () => {
            workspaceToggle.value = true;
            workspaceConnections = [{ id: 'c1' }];
            await setAgentDriverSetting(ctx, 'MANAGED_AGENTS');
            expect(logEvent).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({
                    metadata: expect.objectContaining({ managedAgentsEnvEnabled: true, managedAgentsBasis: 'WORKSPACE_ON' }),
                }),
            );
        });
    });

    it('reads static, naming why, when the profile surface is off for the workspace', async () => {
        envBag.AGENT_MANAGED_AGENTS = '1';
        row = { agentDriver: 'MANAGED_AGENTS' };
        const view = await getAgentDriverSetting(ctx);
        expect(view.effective).toEqual({
            driver: 'static',
            reason: DRIVER_IMPLEMENTED['managed-agents'] ? 'NO_WORKFLOW_REQUESTS_IT' : 'DRIVER_NOT_IMPLEMENTED',
        });
    });
});
