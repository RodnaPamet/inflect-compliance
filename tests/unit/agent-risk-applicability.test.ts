/**
 * Which agentic risks apply to an agent — the derivation, one case per row of
 * the rule table.
 *
 * The failure this file exists to catch is the one that looks healthiest: a
 * derivation that is CONSTANT-TRUE (or constant-false) still produces a
 * percentage, still fills every list, and reads exactly like a working
 * readout. So the assertions here are about the two gates FIRING and about
 * everything else staying in scope — not about the shape of the return value.
 *
 * The fail-closed direction is asserted three separate ways, because each has
 * its own plausible-wrong alternative:
 *
 *  • an UNKNOWN code applies. OWASP renumbering the list, or a tenant
 *    installing an edition this build has never seen, must not quietly excuse
 *    a risk from the readout.
 *  • the LEGACY PLACEHOLDER applies to everything. Its zero tool grants mean
 *    "nobody granted anything to a synthetic row", not "this agent can call
 *    nothing" — the row the migration inserts is worst-case on every exposure
 *    axis, and gating it on its own emptiness would exempt the one agent
 *    nobody has looked at.
 *  • the two gates are INDEPENDENT. Merging them into one "is this agent
 *    exposed at all" term would be the tidier code and the wrong answer.
 */
import {
    agentRiskApplicability,
    APPLIES,
    GATED_RISK_TITLES,
    type AgentExposureProfile,
} from '@/app-layer/services/agent-risk-applicability';

const ALL_CODES = [
    'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
    'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
];

/** The ordinary agent: autonomy 3, holds a tool, not the migration's stand-in. */
const profile = (overrides: Partial<AgentExposureProfile> = {}): AgentExposureProfile => ({
    autonomyLevel: 3,
    toolGrantCount: 1,
    isLegacyPlaceholder: false,
    registrationEnforced: true,
    ...overrides,
});

describe('ASI02 — the exemption needs its own precondition', () => {
    // The gate rests on the grant list being a deny-by-default allowlist. It is
    // only consulted for a credential bound to a live ACTIVE agent: otherwise
    // `grantedTools` is null and `isToolExposed` returns TRUE for every tool
    // (src/lib/mcp/auth.ts, src/lib/mcp/authorize.ts). So in a tenant that has
    // switched the register off, zero grants deny nothing and exempting ASI02
    // would excuse a risk that genuinely applies.
    it('is OUT of scope with no grants when the register is enforced', () => {
        expect(
            agentRiskApplicability('ASI02', profile({ toolGrantCount: 0, registrationEnforced: true })),
        ).toStrictEqual({ applicable: false, basis: 'NO_TOOL_GRANTS' });
    });

    it('stays IN scope with no grants when the register is NOT enforced', () => {
        expect(
            agentRiskApplicability('ASI02', profile({ toolGrantCount: 0, registrationEnforced: false })),
        ).toStrictEqual(APPLIES);
    });

    it('is IN scope with a grant, enforced or not', () => {
        for (const enforced of [true, false]) {
            expect(
                agentRiskApplicability(
                    'ASI02',
                    profile({ toolGrantCount: 1, registrationEnforced: enforced }),
                ),
            ).toStrictEqual(APPLIES);
        }
    });

    it('does not leak the precondition into ASI08 — autonomy is its own term', () => {
        // A non-enforcing tenant must not put ASI08 back in scope: rung 0
        // denies every capability class regardless of the register switch.
        expect(
            agentRiskApplicability(
                'ASI08',
                profile({ autonomyLevel: 0, registrationEnforced: false }),
            ),
        ).toStrictEqual({ applicable: false, basis: 'SUGGEST_ONLY' });
    });
});

describe('agentRiskApplicability — the eight universal risks', () => {
    // Everything except the two gated codes, asserted against the SAME
    // worst-case-for-exemption profile: no tools, no autonomy. If any of these
    // ever starts reading a column, this is where it shows up.
    const universal = ALL_CODES.filter((c) => c !== 'ASI02' && c !== 'ASI08');

    it.each(universal)('%s applies even at autonomy 0 with no tool grants', (code) => {
        expect(
            agentRiskApplicability(code, profile({ autonomyLevel: 0, toolGrantCount: 0 })),
        ).toEqual(APPLIES);
    });

    it('ASI01 applies to an agent that reaches no tenant data — caller input is a channel', () => {
        expect(agentRiskApplicability('ASI01', profile({ toolGrantCount: 0 }))).toEqual(APPLIES);
    });

    it('ASI03 applies to a freshly registered agent with no credentials yet', () => {
        // Do NOT gate identity abuse on an empty key list: the agent with no
        // key is the one you most want in scope, not the one you excuse.
        expect(agentRiskApplicability('ASI03', profile())).toEqual(APPLIES);
    });

    it('ASI09 applies MORE at autonomy 0, not less — a suggestion is what gets rubber-stamped', () => {
        expect(agentRiskApplicability('ASI09', profile({ autonomyLevel: 0 }))).toEqual(APPLIES);
    });
});

describe('agentRiskApplicability — ASI02 is gated on tool grants', () => {
    it('is out of scope for an agent nobody has granted a tool to', () => {
        expect(agentRiskApplicability('ASI02', profile({ toolGrantCount: 0 }))).toEqual({
            applicable: false,
            basis: 'NO_TOOL_GRANTS',
        });
    });

    it('is back in scope on the FIRST grant', () => {
        expect(agentRiskApplicability('ASI02', profile({ toolGrantCount: 1 }))).toEqual(APPLIES);
    });

    it('stays in scope for an autonomy-0 agent that holds a grant', () => {
        // The two gates are deliberately not merged. An agent that suggests
        // only still has an authorised-tool surface the moment somebody grants
        // it one, whatever rung it sits on.
        expect(
            agentRiskApplicability('ASI02', profile({ autonomyLevel: 0, toolGrantCount: 2 })),
        ).toEqual(APPLIES);
    });
});

describe('agentRiskApplicability — ASI08 is gated on autonomy', () => {
    it('is out of scope at autonomy 0 — no automated action to cascade through', () => {
        expect(agentRiskApplicability('ASI08', profile({ autonomyLevel: 0 }))).toEqual({
            applicable: false,
            basis: 'SUGGEST_ONLY',
        });
    });

    it('is in scope at autonomy 1, the lowest rung any capability class requires', () => {
        expect(agentRiskApplicability('ASI08', profile({ autonomyLevel: 1 }))).toEqual(APPLIES);
    });

    it('stays in scope for a tool-less agent above rung 0', () => {
        // Grants are the ASI02 term, autonomy is the ASI08 term. An
        // orchestrating agent with no grants can still chain to other agents.
        expect(
            agentRiskApplicability('ASI08', profile({ autonomyLevel: 3, toolGrantCount: 0 })),
        ).toEqual(APPLIES);
    });
});

describe('agentRiskApplicability — fail-closed', () => {
    it.each(['ASI11', 'ASI0', 'asi02', '', 'TOOL_MISUSE'])(
        'treats the unknown code %p as IN scope',
        (code) => {
            expect(
                agentRiskApplicability(code, profile({ autonomyLevel: 0, toolGrantCount: 0 })),
            ).toEqual(APPLIES);
        },
    );

    it.each(ALL_CODES)('applies %s to the legacy placeholder, both gates overridden', (code) => {
        // The migration inserts it at autonomy 6 / EXTERNAL_EGRESS / TERMINAL
        // with zero grants. The zero is an artefact of it being synthetic, and
        // reading it as a capability claim would exempt the worst row in the
        // register from two risks.
        expect(
            agentRiskApplicability(
                code,
                profile({ autonomyLevel: 0, toolGrantCount: 0, isLegacyPlaceholder: true }),
            ),
        ).toEqual(APPLIES);
    });

    it('names a basis on exactly the risks it puts out of scope, and never otherwise', () => {
        const p = profile({ autonomyLevel: 0, toolGrantCount: 0 });
        const out = ALL_CODES.filter((c) => !agentRiskApplicability(c, p).applicable);
        expect(out).toEqual(['ASI02', 'ASI08']);
        for (const code of ALL_CODES) {
            const result = agentRiskApplicability(code, p);
            expect(result.basis === null).toBe(result.applicable);
        }
    });
});

describe('GATED_RISK_TITLES', () => {
    it('names exactly the two codes the rule gates', () => {
        // Drift here and the guard test in tests/guardrails/ is checking the
        // wrong pair against the catalogue — the rule and its ratchet must
        // agree on which codes carry an editorial dependency.
        expect(Object.keys(GATED_RISK_TITLES).sort()).toEqual(['ASI02', 'ASI08']);
    });
});
