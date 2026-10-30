/**
 * THE LOCAL AI GATEWAY RULE HAS ONE DEFINITION, AND BOTH SUBSYSTEMS READ IT.
 *
 * #4545 was fixed inline in #4556: a tenant's `aiLocalBaseUrl` is honoured only
 * when it names the gateway the deployment serves. Correct, and it left the
 * repository with TWO copies of that rule — the risk-suggestion factory's new
 * one and `resolveFlueModel`'s existing `LOCAL_GATEWAY_NOT_SERVED`.
 *
 * Two copies is how the hole arose in the first place: Flue had the rule, the
 * factory next door did not, and nothing anywhere could tell you the two
 * disagreed. A drifted copy disagrees in the direction that grants access.
 *
 * So this suite does NOT re-test the behaviour — `risk-local-gateway-tenant-url`
 * covers the dial and the credential, and `ai-residency-enforcement` covers the
 * provider choice. It tests the property those two cannot: that there is one
 * rule, that both callers get the same answer from it, and the cases the
 * shared rule pins which neither caller's own suite states.
 */


// Mutable, as the other suites in this area do it: the rule reads `env` at CALL
// time, so a case can vary the deployment's gateway without re-importing.
const mutableEnv: Record<string, string | undefined> = {
    AI_LOCAL_BASE_URL: 'http://gateway.internal:11434/v1',
    AI_LOCAL_MODEL: 'llama-3.1-70b',
    AGENT_FLUE_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_API_KEY: 'sk-test', // pragma: allowlist secret -- synthetic test input
};
jest.mock('@/env', () => ({ env: mutableEnv }));

afterEach(() => {
    mutableEnv.AI_LOCAL_BASE_URL = 'http://gateway.internal:11434/v1';
});

// Imports sit BELOW the mock on purpose. `jest.mock` is hoisted above
// everything, but its factory runs when the mocked module is first required
// — which happens as these imports execute. With the imports above
// `mutableEnv`, the factory reads it in the temporal dead zone and the whole
// suite fails to load with "Cannot access 'mutableEnv' before initialization".
import { resolveLocalGateway, LOCAL_GATEWAY_REFUSAL_MESSAGE } from '@/lib/ai/local-gateway';
import { resolveFlueModel } from '@/lib/agentic/flue/model-selection';

const DEPLOYMENT = 'http://gateway.internal:11434/v1';

describe('the one rule', () => {
    it('honours a tenant address that names the served gateway, and returns the DEPLOYMENT value', () => {
        // Returning the deployment's own string, never the tenant's, even when
        // the two are equal: no caller can come to depend on the tenant value
        // flowing through, so narrowing the rule later cannot silently change
        // what is dialled.
        expect(resolveLocalGateway(DEPLOYMENT)).toEqual({ served: true, baseUrl: DEPLOYMENT });
        expect(resolveLocalGateway(null)).toEqual({ served: true, baseUrl: DEPLOYMENT });
    });

    it('refuses any other address as NOT_SERVED, including one differing only by a trailing slash', () => {
        // Compared RAW, deliberately. A looser comparison admits more strings,
        // and every string it newly admits is one an `admin.manage` holder typed.
        for (const addr of ['http://169.254.169.254/v1', `${DEPLOYMENT}/`, DEPLOYMENT.toUpperCase()]) {
            expect(resolveLocalGateway(addr)).toEqual({ served: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' });
        }
    });

    it('says NOT_SERVED rather than NOT_CONFIGURED when a tenant names a gateway and the deployment has none', () => {
        // The ordering matters for the operator: told "not configured" they
        // would set AI_LOCAL_BASE_URL, when the honest answer is that the value
        // they are looking at is not one this deployment can serve.
        mutableEnv.AI_LOCAL_BASE_URL = undefined;
        expect(resolveLocalGateway('http://tenant-gw:9000')).toEqual({ served: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' });
        expect(resolveLocalGateway(null)).toEqual({ served: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' });
    });

    it('names a reason for every refusal, so no caller has to invent the sentence', () => {
        for (const reason of ['LOCAL_GATEWAY_NOT_CONFIGURED', 'LOCAL_GATEWAY_NOT_SERVED'] as const) {
            expect(LOCAL_GATEWAY_REFUSAL_MESSAGE[reason]).toMatch(/\S/);
        }
        // #4556's exact sentences, kept verbatim so this refactor changes no
        // log line — see the constant's docblock.
        expect(LOCAL_GATEWAY_REFUSAL_MESSAGE.LOCAL_GATEWAY_NOT_SERVED).toBe(
            'Tenant local AI gateway is not one this deployment serves',
        );
    });
});

describe('both callers read it, so they cannot drift apart', () => {
    it('Flue maps the shared refusals onto its own, with no second comparison of its own', () => {
        // Flue REFUSES the run where the risk factory falls back to templates —
        // a reasoning loop has no template substitute. Different outcome, same
        // decision, and the decision is made in one place.
        expect(resolveFlueModel({ residency: 'LOCAL_ONLY', localBaseUrl: 'http://tenant-gw:9000' })).toEqual({
            ok: false,
            reason: 'LOCAL_GATEWAY_NOT_SERVED',
        });
        expect(resolveFlueModel({ residency: 'LOCAL_ONLY', localBaseUrl: DEPLOYMENT }).ok).toBe(true);
    });

    it('agrees with the shared rule on every address, rather than happening to match on the ones we thought of', () => {
        // The guard that matters: a table, so a future divergence shows up as a
        // disagreement rather than as a case nobody wrote.
        for (const addr of [null, undefined, DEPLOYMENT, `${DEPLOYMENT}/`, 'http://tenant-gw:9000', '']) {
            const shared = resolveLocalGateway(addr);
            const flue = resolveFlueModel({ residency: 'LOCAL_ONLY', localBaseUrl: addr });
            expect([addr, flue.ok]).toEqual([addr, shared.served]);
        }
    });
});
