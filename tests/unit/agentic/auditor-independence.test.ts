/**
 * The auditor independence RULE (#3675), pure: an auditor agent's owner holds
 * an ACTIVE, SECOND-line membership and owns no audited agent. The facts are
 * read by the usecase and the trigger; this file proves the judgement, and in
 * particular that a NULL line never satisfies it.
 */
import {
    AUDITOR_INDEPENDENCE_REASONS,
    evaluateAuditorIndependence,
    independenceFindingText,
    isAuditedAgent,
    type AuditorOwnerFacts,
} from '@/lib/agentic/auditor-independence';

const INDEPENDENT: AuditorOwnerFacts = {
    membershipStatus: 'ACTIVE',
    lineOfDefence: 'SECOND',
    auditedAgentIds: [],
};

describe('evaluateAuditorIndependence', () => {
    it('an ACTIVE second-line owner who owns no audited agent is independent', () => {
        expect(evaluateAuditorIndependence(INDEPENDENT)).toEqual({ independent: true });
    });

    it('a NULL line never satisfies the check', () => {
        const verdict = evaluateAuditorIndependence({ ...INDEPENDENT, lineOfDefence: null });
        expect(verdict).toEqual({
            independent: false,
            reasons: ['OWNER_LINE_UNDECLARED'],
            auditedAgentIds: [],
        });
    });

    it.each(['FIRST', 'THIRD'] as const)('a %s-line owner is refused', (line) => {
        const verdict = evaluateAuditorIndependence({ ...INDEPENDENT, lineOfDefence: line });
        expect(verdict).toMatchObject({ independent: false, reasons: ['OWNER_NOT_SECOND_LINE'] });
    });

    it('an owner who owns any audited agent is refused, and the agents are named', () => {
        const verdict = evaluateAuditorIndependence({ ...INDEPENDENT, auditedAgentIds: ['b', 'a'] });
        expect(verdict).toEqual({
            independent: false,
            reasons: ['OWNER_OWNS_AUDITED_AGENT'],
            auditedAgentIds: ['a', 'b'],
        });
    });

    it.each([null, 'DEACTIVATED', 'INVITED', 'REMOVED'])(
        'an owner whose membership is %s is refused, even with a SECOND line on the row',
        (membershipStatus) => {
            const verdict = evaluateAuditorIndependence({ ...INDEPENDENT, membershipStatus });
            expect(verdict).toMatchObject({ independent: false, reasons: ['OWNER_NOT_ACTIVE_MEMBER'] });
        },
    );

    it('reports every failing term, in check order', () => {
        const verdict = evaluateAuditorIndependence({
            membershipStatus: 'ACTIVE',
            lineOfDefence: 'FIRST',
            auditedAgentIds: ['x'],
        });
        expect(verdict).toMatchObject({ reasons: ['OWNER_NOT_SECOND_LINE', 'OWNER_OWNS_AUDITED_AGENT'] });
        const order = AUDITOR_INDEPENDENCE_REASONS;
        if (verdict.independent) throw new Error('expected a refusal');
        const positions = verdict.reasons.map((r) => order.indexOf(r));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
});

describe('isAuditedAgent', () => {
    const now = new Date();
    it.each(['DRAFT', 'ACTIVE', 'SUSPENDED'])('a non-auditor %s agent is audited', (status) => {
        expect(isAuditedAgent({ isAuditor: false, status, deletedAt: null })).toBe(true);
    });
    it('a RETIRED agent is not', () => {
        expect(isAuditedAgent({ isAuditor: false, status: 'RETIRED', deletedAt: null })).toBe(false);
    });
    it('a soft-deleted agent is not', () => {
        expect(isAuditedAgent({ isAuditor: false, status: 'ACTIVE', deletedAt: now })).toBe(false);
    });
    it('another auditor is not', () => {
        expect(isAuditedAgent({ isAuditor: true, status: 'ACTIVE', deletedAt: null })).toBe(false);
    });
});

describe('independenceFindingText', () => {
    it('names the agent and the codes, and bounds the audited-agent list', () => {
        const ids = Array.from({ length: 25 }, (_, i) => `agent-${String(i).padStart(2, '0')}`);
        const text = independenceFindingText({
            agentId: 'auditor-1',
            agentName: 'IAM auditor',
            reasons: ['OWNER_NOT_SECOND_LINE', 'OWNER_OWNS_AUDITED_AGENT'],
            auditedAgentIds: ids,
            trigger: 'OWNERSHIP_TRANSFER',
        });
        expect(text.title).toContain('IAM auditor');
        expect(text.description).toContain('auditor-1');
        expect(text.description).toContain('(OWNER_NOT_SECOND_LINE)');
        expect(text.description).toContain('(OWNER_OWNS_AUDITED_AGENT)');
        expect(text.description).toContain('agent-19');
        expect(text.description).not.toContain('agent-20');
        expect(text.description).toContain('and 5 more');
        expect(text.description).toContain('was not suspended');
    });
});
