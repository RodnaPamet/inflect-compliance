/**
 * The approval-requirement composition — every term, and every absence.
 *
 * `proposal-review-tiering.test.ts` proves the rule is ENFORCED against a real
 * database. This proves it is COMPOSED correctly, over the input space that
 * integration test cannot reach cheaply: a card that cannot be read, a pin that
 * predates pinning, a proposal with no agent, an agent named but not resolvable.
 *
 * Each case is stated as "what would be MORE PERMISSIVE than the alternative",
 * because that is the only direction a mistake here matters in.
 */
import {
    approvalsRequiredFor,
    resolveApprovalRequirement,
    UNKNOWN_REQUIREMENT_APPROVALS,
    type ApprovalTierInputs,
} from '@/lib/agentic/approval-tiering';

/** An agent that narrows nothing: well-assessed, attended, ordinary. */
const PERMISSIVE_AGENT = { riskTier: 'LOW' as const, autonomyLevel: 3 };

const inputs = (over: Partial<ApprovalTierInputs> = {}): ApprovalTierInputs => ({
    agent: PERMISSIVE_AGENT,
    agentNamed: true,
    pinState: 'PINNED',
    pinnedRung: 'AUTO_APPROVAL',
    viaApiKey: true,
    ...over,
});

describe('the ladder maps to a number of humans', () => {
    it('only the strictest rung costs two', () => {
        expect(approvalsRequiredFor('SECOND_APPROVER')).toBe(2);
        expect(approvalsRequiredFor('SINGLE_APPROVER')).toBe(1);
        // ONE, not zero. Nothing in the product auto-approves; mapping this to
        // zero would ship the permission before the mechanism.
        expect(approvalsRequiredFor('AUTO_APPROVAL')).toBe(1);
    });
});

describe('the answer is the STRICTEST term, never a precedence order', () => {
    it('a permissive card cannot un-say a HIGH risk tier', () => {
        // The card is operator-editable. If it won, a tenant could score an
        // agent HIGH and then delete the assessment's only consequence.
        const result = resolveApprovalRequirement(
            inputs({ pinnedRung: 'AUTO_APPROVAL', agent: { riskTier: 'HIGH', autonomyLevel: 3 } }),
        );
        expect(result).toEqual({
            rung: 'SECOND_APPROVER',
            requiredApprovals: 2,
            decidedBy: 'RISK_TIER',
            ownerMayApprove: false,
        });
    });

    it('a deliberately narrowed card is honoured over a LOW tier', () => {
        // The mirror. If the tier won, the one direction the card ladder lets an
        // operator move freely would have no effect.
        const result = resolveApprovalRequirement(inputs({ pinnedRung: 'SECOND_APPROVER' }));
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('POLICY_CARD');
    });

    it('an agent registered to run UNATTENDED needs two whatever else says', () => {
        const result = resolveApprovalRequirement(
            inputs({ agent: { riskTier: 'LOW', autonomyLevel: 5 } }),
        );
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('AUTONOMY_LEVEL');
    });

    it('and when nothing narrows, one human is enough', () => {
        // The paired positive: without it every assertion above is satisfied by
        // a function that returns 2 unconditionally.
        const result = resolveApprovalRequirement(inputs());
        expect(result).toEqual({
            rung: 'AUTO_APPROVAL',
            requiredApprovals: 1,
            decidedBy: 'POLICY_CARD',
            ownerMayApprove: true,
        });
    });
});

describe('every absence fails toward the expensive answer', () => {
    it('an UNSCORED agent needs two — never the friendliest treatment', () => {
        const result = resolveApprovalRequirement(
            inputs({ agent: { riskTier: null, autonomyLevel: 3 } }),
        );
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('RISK_TIER');
    });

    it('an UNPINNED row needs two — we do not know what governed it', () => {
        const result = resolveApprovalRequirement(
            inputs({ pinState: 'UNPINNED', pinnedRung: null }),
        );
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('UNKNOWN_POLICY_CARD_PIN');
    });

    it('a pin naming a version that cannot be READ needs two — broken policy, not absent policy', () => {
        const result = resolveApprovalRequirement(inputs({ pinnedRung: null }));
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('POLICY_CARD');
    });

    it('NO CARD caps at one approver and can never reach auto-approval', () => {
        // The required direction, stated exactly: an agent with no card must not
        // end up MORE permissive than one with a card. The loosest card yields
        // AUTO_APPROVAL; absence yields SINGLE_APPROVER, which is stricter.
        const result = resolveApprovalRequirement(
            inputs({ pinState: 'NO_CARD', pinnedRung: null }),
        );
        expect(result.rung).toBe('SINGLE_APPROVER');
        expect(result.decidedBy).toBe('NO_POLICY_CARD');
    });

    it('a machine principal the register does not know needs two', () => {
        // Only producible with the agent registration gate OFF. If turning that
        // gate off also DOWNGRADED the approval requirement, the gate would be a
        // lever for widening authority.
        const result = resolveApprovalRequirement(
            inputs({ agent: null, agentNamed: false, viaApiKey: true }),
        );
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('UNREGISTERED_MACHINE_PRINCIPAL');
    });

    it('a row NAMING an agent the register cannot produce needs two', () => {
        // The third null: "there is no agent" and "the agent here is
        // unresolvable" are different states, and only the first is benign.
        const result = resolveApprovalRequirement(
            inputs({ agent: null, agentNamed: true, viaApiKey: false }),
        );
        expect(result.requiredApprovals).toBe(2);
        expect(result.decidedBy).toBe('UNREGISTERED_MACHINE_PRINCIPAL');
    });

    it('but a human at a keyboard still only needs one', () => {
        // No agent means none of the agent terms have an input, and there is no
        // registered owner to exclude. One human must still approve.
        const result = resolveApprovalRequirement(
            inputs({ agent: null, agentNamed: false, viaApiKey: false }),
        );
        expect(result).toEqual({
            rung: 'SINGLE_APPROVER',
            requiredApprovals: 1,
            decidedBy: 'HUMAN_AUTHOR',
            ownerMayApprove: true,
        });
    });

    it('and a requirement nobody computed reads as two', () => {
        expect(UNKNOWN_REQUIREMENT_APPROVALS).toBe(2);
    });
});

describe('the owner exclusion tracks the count, not the tier directly', () => {
    it.each([
        ['SECOND_APPROVER', false],
        ['SINGLE_APPROVER', true],
        ['AUTO_APPROVAL', true],
    ] as const)('rung %s ⇒ ownerMayApprove %s', (rung, expected) => {
        expect(resolveApprovalRequirement(inputs({ pinnedRung: rung })).ownerMayApprove).toBe(
            expected,
        );
    });
});
