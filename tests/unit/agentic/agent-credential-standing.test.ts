/**
 * #4879 — what an agent credential can do right now, in the order the agent
 * tools decide it. A key bound to a suspended or killed agent used to read
 * "Live" on `/admin/mcp`.
 */
import {
    agentCredentialStanding,
    agentTermsApply,
    type AgentCredentialFacts,
} from '@/lib/agentic/agent-credential-standing';
import { governedAgentIdOf, type AgentGateVerdict } from '@/lib/agentic/agent-registration-gate';

const NO_KILLS = { platform: false, tenant: false, agentIds: new Set<string>() };

function facts(over: Partial<AgentCredentialFacts> = {}): AgentCredentialFacts {
    return {
        live: true,
        agentId: 'agent-1',
        agent: { status: 'ACTIVE', riskTier: 'LOW' },
        enforcing: true,
        kills: NO_KILLS,
        ...over,
    };
}

describe('agentCredentialStanding', () => {
    it('a revoked or expired key does nothing, whatever its agent', () => {
        expect(agentCredentialStanding(facts({ live: false }))).toEqual({ kind: 'inactive' });
    });

    it('an assessed ACTIVE agent governs its key', () => {
        expect(agentCredentialStanding(facts())).toEqual({ kind: 'governed' });
    });

    it('an ACTIVE agent nobody has assessed reaches nothing', () => {
        expect(agentCredentialStanding(facts({ agent: { status: 'ACTIVE', riskTier: null } }))).toEqual({
            kind: 'stopped',
            reason: 'UNASSESSED',
        });
    });

    it('a suspended agent stops its key, enforcing or not', () => {
        for (const enforcing of [true, false]) {
            expect(
                agentCredentialStanding(facts({ enforcing, agent: { status: 'SUSPENDED', riskTier: 'LOW' } })),
            ).toEqual({ kind: 'stopped', reason: 'AGENT_SUSPENDED' });
        }
    });

    it('each kill scope stops a governed key', () => {
        expect(agentCredentialStanding(facts({ kills: { ...NO_KILLS, platform: true } }))).toEqual({
            kind: 'stopped',
            reason: 'KILL_PLATFORM',
        });
        expect(agentCredentialStanding(facts({ kills: { ...NO_KILLS, tenant: true } }))).toEqual({
            kind: 'stopped',
            reason: 'KILL_TENANT',
        });
        expect(
            agentCredentialStanding(facts({ kills: { ...NO_KILLS, agentIds: new Set(['agent-1']) } })),
        ).toEqual({ kind: 'stopped', reason: 'KILL_AGENT' });
    });

    it("another agent's kill does not stop this key", () => {
        expect(
            agentCredentialStanding(facts({ kills: { ...NO_KILLS, agentIds: new Set(['agent-2']) } })),
        ).toEqual({ kind: 'governed' });
    });

    describe('when the workspace requires registered agents', () => {
        it('refuses an unbound key, a removed agent, a draft and a retired agent', () => {
            expect(agentCredentialStanding(facts({ agentId: null, agent: null }))).toEqual({
                kind: 'stopped',
                reason: 'NOT_REGISTERED',
            });
            expect(agentCredentialStanding(facts({ agent: null }))).toEqual({
                kind: 'stopped',
                reason: 'AGENT_REMOVED',
            });
            expect(agentCredentialStanding(facts({ agent: { status: 'DRAFT', riskTier: null } }))).toEqual({
                kind: 'stopped',
                reason: 'AGENT_DRAFT',
            });
            expect(agentCredentialStanding(facts({ agent: { status: 'RETIRED', riskTier: 'LOW' } }))).toEqual({
                kind: 'stopped',
                reason: 'AGENT_RETIRED',
            });
        });

        it('names the registration refusal before a kill, as the tool boundary does', () => {
            expect(
                agentCredentialStanding(
                    facts({ agentId: null, agent: null, kills: { ...NO_KILLS, tenant: true } }),
                ),
            ).toEqual({ kind: 'stopped', reason: 'NOT_REGISTERED' });
        });
    });

    describe('when the workspace does not require registered agents', () => {
        const open = { enforcing: false } as const;

        it('an unbound key reaches the agent tools with no agent controls', () => {
            expect(agentCredentialStanding(facts({ ...open, agentId: null, agent: null }))).toEqual({
                kind: 'ungoverned',
                reason: 'NO_AGENT',
            });
        });

        it('a draft, retired or removed agent does not govern its key', () => {
            expect(
                agentCredentialStanding(facts({ ...open, agent: { status: 'DRAFT', riskTier: null } })),
            ).toEqual({ kind: 'ungoverned', reason: 'AGENT_DRAFT' });
            expect(
                agentCredentialStanding(facts({ ...open, agent: { status: 'RETIRED', riskTier: 'LOW' } })),
            ).toEqual({ kind: 'ungoverned', reason: 'AGENT_RETIRED' });
            expect(agentCredentialStanding(facts({ ...open, agent: null }))).toEqual({
                kind: 'ungoverned',
                reason: 'AGENT_REMOVED',
            });
        });

        it('a workspace or platform kill still stops an ungoverned key', () => {
            expect(
                agentCredentialStanding(
                    facts({ ...open, agentId: null, agent: null, kills: { ...NO_KILLS, tenant: true } }),
                ),
            ).toEqual({ kind: 'stopped', reason: 'KILL_TENANT' });
        });

        it("an agent's own kill does not reach a key that agent does not govern", () => {
            expect(
                agentCredentialStanding(
                    facts({
                        ...open,
                        agent: { status: 'DRAFT', riskTier: null },
                        kills: { ...NO_KILLS, agentIds: new Set(['agent-1']) },
                    }),
                ),
            ).toEqual({ kind: 'ungoverned', reason: 'AGENT_DRAFT' });
        });
    });
});

describe('agentTermsApply mirrors governedAgentIdOf', () => {
    it('ACTIVE and SUSPENDED govern; DRAFT, RETIRED and none do not', () => {
        expect(agentTermsApply({ status: 'ACTIVE', riskTier: null })).toBe(true);
        expect(agentTermsApply({ status: 'SUSPENDED', riskTier: null })).toBe(true);
        expect(agentTermsApply({ status: 'DRAFT', riskTier: null })).toBe(false);
        expect(agentTermsApply({ status: 'RETIRED', riskTier: null })).toBe(false);
        expect(agentTermsApply(null)).toBe(false);
    });

    it('agrees with the tool boundary for every status', () => {
        const standingOf = {
            ACTIVE: 'vouched',
            SUSPENDED: 'suspended',
            DRAFT: 'draft',
            RETIRED: 'retired',
        } as const;
        for (const [status, standing] of Object.entries(standingOf)) {
            const verdict: AgentGateVerdict = {
                enforcing: false,
                agentId: standing === 'vouched' ? 'agent-1' : null,
                subjectAgentId: 'agent-1',
                standing,
                autonomyLevel: 3,
                riskTier: 'LOW',
                reason: null,
            };
            expect(agentTermsApply({ status: status as keyof typeof standingOf, riskTier: 'LOW' })).toBe(
                governedAgentIdOf(verdict) !== null,
            );
        }
    });
});
