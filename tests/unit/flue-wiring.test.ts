/**
 * WHICH OF THE SIX TERMS BLOCKS A FLUE RUN.
 *
 * ── WHY THIS IS A TEST AND NOT A RENDER DETAIL ──────────────────────────────
 *
 * Five of six satisfied behaves EXACTLY like none: every run executes on the
 * static engine and succeeds. So "which term blocks" is the only output of
 * this subsystem an operator can act on, and it is computed once, server-side,
 * from the same calls the run path makes.
 *
 * The conjunction is NOT mocked. `getAgentDriverSetting` runs for real here —
 * env, stored mode, build flag and the workflow term all go through
 * `resolveAgentDriver` + `narrowToWhatAWorkflowAsksFor` — so this asserts the
 * terms as the runtime resolves them rather than as a fixture restates them.
 * Only the two COUNTS and the registry contents are supplied.
 */
type SettingsRow = { agentDriver: string | null } | null;
let row: SettingsRow = { agentDriver: 'FLUE' };
let agentCount = 1;
let keyCount = 1;

const registeredAgentCount = jest.fn(async (_args: unknown) => agentCount);
const tenantApiKeyCount = jest.fn(async (_args: unknown) => keyCount);
const mockDb = {
    tenantSecuritySettings: { findUnique: jest.fn(async () => row) },
    registeredAgent: { count: registeredAgentCount },
    tenantApiKey: { count: tenantApiKeyCount },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const envBag: { AGENT_DRIVER_FLUE?: string } = {};
jest.mock('@/env', () => ({ env: new Proxy({}, { get: (_t, k: string) => envBag[k as 'AGENT_DRIVER_FLUE'] }) }));

jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/**
 * The registry, so the WORKFLOW term is a knob rather than a reading of what
 * happens to ship. `mock`-prefixed because `babel-plugin-jest-hoist` refuses
 * any other out-of-scope binding inside a hoisted factory.
 */
let mockDefinitions: Array<{ driver?: string }> = [{ driver: 'flue' }];
jest.mock('@/lib/agentic/workflow-registry', () => ({
    listWorkflowDefinitions: () => mockDefinitions,
}));

import { getFlueWiringState, FLUE_WIRING_TERMS } from '@/app-layer/usecases/flue-wiring';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';

import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER');

/** Everything satisfied. Each test then breaks exactly one term. */
beforeEach(() => {
    jest.clearAllMocks();
    row = { agentDriver: 'FLUE' };
    envBag.AGENT_DRIVER_FLUE = '1';
    agentCount = 1;
    keyCount = 1;
    mockDefinitions = [{ driver: 'flue' }];
});

const satisfiedOf = async () => {
    const s = await getFlueWiringState(ctx);
    return Object.fromEntries(s.terms.map((t) => [t.key, t.satisfied]));
};

describe('every term, and the one that blocks', () => {
    it('reports ready only when all six agree', async () => {
        const state = await getFlueWiringState(ctx);

        // Asserted against the build flag rather than a literal, so this stays
        // a test of the CONJUNCTION either side of that flag flipping.
        expect(state.ready).toBe(DRIVER_IMPLEMENTED.flue);
        if (DRIVER_IMPLEMENTED.flue) {
            expect(state.blockedOn).toBeNull();
            expect(state.effective).toEqual({ driver: 'flue', reason: null });
        }
    });

    it('covers every term exactly once, in the order an operator satisfies them', async () => {
        // The denominator. A term silently dropped from the payload is a term
        // an operator can never be told about, and the card renders what it
        // is given — so the census lives here.
        const state = await getFlueWiringState(ctx);
        expect(state.terms.map((t) => t.key)).toEqual([...FLUE_WIRING_TERMS]);
    });

    it.each([
        ['ENV', () => { delete envBag.AGENT_DRIVER_FLUE; }],
        ['TENANT', () => { row = { agentDriver: 'STATIC' }; }],
        ['WORKFLOW', () => { mockDefinitions = [{ driver: 'static' }, {}]; }],
        ['REGISTERED_AGENT', () => { agentCount = 0; }],
        ['BOUND_KEY', () => { keyCount = 0; }],
    ])('breaking %s alone leaves that term unsatisfied and the run static', async (key, breakIt) => {
        breakIt();

        const state = await getFlueWiringState(ctx);
        const satisfied = Object.fromEntries(state.terms.map((t) => [t.key, t.satisfied]));

        expect(satisfied[key]).toBe(false);
        expect(state.ready).toBe(false);
        // And every OTHER term is still satisfied — so a single broken term
        // cannot be reported as several, which is what a checklist is for.
        expect(
            state.terms.filter((t) => t.key !== key && !t.satisfied && t.key !== 'BUILD').map((t) => t.key),
        ).toEqual([]);
    });

    it('blockedOn names the FIRST unsatisfied term, not an arbitrary one', async () => {
        delete envBag.AGENT_DRIVER_FLUE;
        agentCount = 0;

        const state = await getFlueWiringState(ctx);

        // Two are broken; ENV comes first in the order, and an operator works
        // down the list. Reporting the later one would send them to a screen
        // that cannot help while the deployment still refuses.
        expect(state.blockedOn).toBe('ENV');
    });

    it('a key bound to an UNVOUCHED agent is not counted', async () => {
        // The subtle one, and it is asserted on the QUERY because that is
        // where the rule lives. `evaluateAgentRegistration` maps every
        // non-ACTIVE status to a standing that refuses and reads an UNSCORED
        // tier as DENY_CEILING, so a key bound to a DRAFT agent satisfies
        // nothing. Counting bound keys without the agent term would tick the
        // last box while every run refused.
        await getFlueWiringState(ctx);

        const where = (tenantApiKeyCount.mock.calls[0][0] as { where: Record<string, unknown> }).where;
        expect(where.agent).toEqual({ is: { status: 'ACTIVE', riskTier: { not: null }, deletedAt: null } });
        expect(where.revokedAt).toBeNull();
    });

    it('counts only agents that are ACTIVE and risk-assessed', async () => {
        await getFlueWiringState(ctx);

        expect((registeredAgentCount.mock.calls[0][0] as { where: unknown }).where).toEqual({
            status: 'ACTIVE',
            riskTier: { not: null },
            deletedAt: null,
        });
    });

    it('reports the counts it counted, so the card can say how many', async () => {
        agentCount = 3;
        keyCount = 2;

        const state = await getFlueWiringState(ctx);

        expect(state.terms.find((t) => t.key === 'REGISTERED_AGENT')?.count).toBe(3);
        expect(state.terms.find((t) => t.key === 'BOUND_KEY')?.count).toBe(2);
    });

    it('marks the terms an admin cannot fix from inside the product', async () => {
        const state = await getFlueWiringState(ctx);
        const operatorTerms = state.terms.filter((t) => t.actor === 'operator').map((t) => t.key);

        // ENV and BUILD are properties of the deployment; WORKFLOW is a
        // property of the shipped registry. None can be changed by a tenant
        // admin, and a checklist that invited one to try would be a dead end.
        expect(operatorTerms).toEqual(['ENV', 'BUILD', 'WORKFLOW']);
    });

    it('is satisfied by the WORKFLOW term the gate itself reads', async () => {
        // Not a re-implementation: `getFlueWiringState` calls
        // `someWorkflowRequestsFlue`, the same function
        // `narrowToWhatAWorkflowAsksFor` calls. Swapping the registry moves
        // BOTH the term and the effective driver, which a second copy of the
        // rule would not do.
        mockDefinitions = [{ driver: 'static' }];

        const state = await getFlueWiringState(ctx);

        expect((await satisfiedOf()).WORKFLOW).toBe(false);
        expect(state.effective).toEqual({ driver: 'static', reason: 'NO_WORKFLOW_REQUESTS_IT' });
    });
});
