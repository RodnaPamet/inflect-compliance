/**
 * Agent Pay 1.4 (#5333; owner decisions of 2026-11-20) — the pure rule a pack
 * uses to propose WITHDRAWING a spending envelope, and how it rides the plan
 * and the closing evidence without moving anything filed before it.
 */
import {
    RecertificationEvidenceSchema,
    SPENDING_WITHDRAWAL_GROUNDS,
    agentCampaignEvidenceBytes,
    buildAgentCampaignEvidence,
    observationWindow,
    planAgentReviewPacks,
    spendingWithdrawalsFor,
    type AgentCampaignEvidenceRows,
    type SpendingAuthorityEvidence,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';
import { checkedPlan } from '@/app-layer/usecases/access-review-agent';

const WINDOW = observationWindow(new Date('2026-11-20T00:00:00.000Z'));
const DECLARED_AT = '2026-10-01T00:00:00.000Z';

function envelope(over: Partial<SpendingAuthorityEvidence> = {}): SpendingAuthorityEvidence {
    return {
        rail: 'AGENT_PAY_TOKEN',
        status: 'REVIEWED',
        unreviewed: false,
        perTransactionLimitMinor: '5000',
        periodBudgetMinor: '50000',
        budgetPeriod: 'MONTH',
        currency: 'EUR',
        merchantDomainCount: 1,
        merchantCategoryCodeCount: 0,
        merchantScopeUnrestricted: false,
        expiresAt: '2027-01-01T00:00:00.000Z',
        expiredAtWindowEnd: false,
        tokenRequestor: 'Example Agent Platform',
        consentedByUserId: 'u-consent',
        declaredByUserId: 'u-declarer',
        declaredAt: DECLARED_AT,
        reviewedByUserId: 'u-reviewer',
        reviewedAt: '2026-10-02T00:00:00.000Z',
        suspensionRequestedAt: null,
        withdrawnAt: null,
        ...over,
    };
}

function subject(spendingAuthority: SpendingAuthorityEvidence[] | undefined): SubjectEvidence {
    return {
        decisionId: 'dec-1',
        agentId: 'ag-1',
        grants: [],
        grantsTruncated: false,
        otherProposals: {},
        cardVersions: { since: null, currentVersion: 1, versions: [] },
        timeBoundedGrants: [],
        guardFlags: {},
        breaker: null,
        killEngagements: [],
        harness: { level: null, previousLevel: null, drift: 'NOT_SCANNED', lastSeenAt: null },
        ...(spendingAuthority === undefined ? {} : { spendingAuthority }),
    };
}

const evidence = (subjects: SubjectEvidence[]) => ({
    accessReviewId: 'ar-1',
    page: 0,
    pageSize: 2,
    total: subjects.length,
    window: { start: WINDOW.start.toISOString(), end: WINDOW.end.toISOString() },
    subjects,
});

describe('the grounds a pack proposes a withdrawal on', () => {
    it('are the three the owner decided, and no fourth (the harness ground waits on a decision)', () => {
        expect([...SPENDING_WITHDRAWAL_GROUNDS]).toEqual(['EXPIRED_BY_WINDOW_END', 'SUSPENDED_AFTER_KILL', 'NEVER_REVIEWED']);
    });

    it('a reviewed, live envelope proposes nothing', () => {
        expect(spendingWithdrawalsFor(subject([envelope()]))).toEqual([]);
    });

    it('(a) an envelope lapsed by the window’s end', () => {
        expect(spendingWithdrawalsFor(subject([envelope({ expiredAtWindowEnd: true })]))).toEqual([
            { rail: 'AGENT_PAY_TOKEN', declaredAt: DECLARED_AT, grounds: ['EXPIRED_BY_WINDOW_END'] },
        ]);
    });

    it('(b) an envelope still suspension-requested after a kill', () => {
        expect(spendingWithdrawalsFor(subject([
            envelope({ status: 'SUSPENDED_REQUESTED', suspensionRequestedAt: '2026-11-01T00:00:00.000Z' }),
        ]))).toEqual([{ rail: 'AGENT_PAY_TOKEN', declaredAt: DECLARED_AT, grounds: ['SUSPENDED_AFTER_KILL'] }]);
    });

    it('(c) an envelope nobody else has reviewed', () => {
        expect(spendingWithdrawalsFor(subject([
            envelope({ status: 'DECLARED', unreviewed: true, reviewedAt: null, reviewedByUserId: null }),
        ]))).toEqual([{ rail: 'AGENT_PAY_TOKEN', declaredAt: DECLARED_AT, grounds: ['NEVER_REVIEWED'] }]);
    });

    it('records every ground that holds, in one proposal per rail, in rail order', () => {
        const all = envelope({
            rail: 'OTHER', status: 'SUSPENDED_REQUESTED', expiredAtWindowEnd: true,
            reviewedAt: null, reviewedByUserId: null, suspensionRequestedAt: '2026-11-01T00:00:00.000Z',
        });
        const ap4m = envelope({ rail: 'AP4M', expiredAtWindowEnd: true });
        expect(spendingWithdrawalsFor(subject([all, ap4m]))).toEqual([
            { rail: 'AP4M', declaredAt: DECLARED_AT, grounds: ['EXPIRED_BY_WINDOW_END'] },
            { rail: 'OTHER', declaredAt: DECLARED_AT, grounds: ['EXPIRED_BY_WINDOW_END', 'SUSPENDED_AFTER_KILL', 'NEVER_REVIEWED'] },
        ]);
    });

    it('a withdrawn envelope proposes nothing, whatever else is true of it', () => {
        expect(spendingWithdrawalsFor(subject([
            envelope({ status: 'WITHDRAWN', expiredAtWindowEnd: true, withdrawnAt: '2026-11-01T00:00:00.000Z' }),
        ]))).toEqual([]);
    });

    it('never proposes a lower limit: a proposal names a rail, a declaration and grounds, and nothing else', () => {
        const [w] = spendingWithdrawalsFor(subject([envelope({ expiredAtWindowEnd: true })]))!;
        expect(Object.keys(w).sort()).toEqual(['declaredAt', 'grounds', 'rail']);
    });
});

describe('the plan carries the withdrawals, and an older plan still re-derives', () => {
    it('evidence without a spending section plans no key at all, so a run recorded before it is accepted', () => {
        const ev = evidence([subject(undefined)]);
        const plan = planAgentReviewPacks(ev);
        expect('spendingWithdrawals' in plan.packs[0]).toBe(false);
        const recorded = JSON.parse(JSON.stringify(plan));
        expect(checkedPlan(RecertificationEvidenceSchema.parse(ev), recorded)).toEqual(recorded);
    });

    it('evidence with the section plans the list, `[]` when it proposes nothing', () => {
        expect(planAgentReviewPacks(evidence([subject([envelope()])])).packs[0].spendingWithdrawals).toEqual([]);
    });

    it('refuses a recorded plan that dropped a withdrawal its evidence implies', () => {
        const ev = evidence([subject([envelope({ expiredAtWindowEnd: true })])]);
        const recorded = JSON.parse(JSON.stringify(planAgentReviewPacks(ev)));
        recorded.packs[0].spendingWithdrawals = [];
        expect(() => checkedPlan(RecertificationEvidenceSchema.parse(ev), recorded)).toThrow(/PACK_PLAN_MISMATCH/);
    });

    it('refuses a recorded plan proposing a ground outside the vocabulary', () => {
        const ev = evidence([subject([envelope({ expiredAtWindowEnd: true })])]);
        const recorded = JSON.parse(JSON.stringify(planAgentReviewPacks(ev)));
        recorded.packs[0].spendingWithdrawals[0].grounds = ['REDUCE_LIMIT'];
        expect(() => checkedPlan(RecertificationEvidenceSchema.parse(ev), recorded)).toThrow(/PACK_PLAN_MISMATCH/);
    });
});

describe('the closing evidence', () => {
    const at = new Date('2026-11-20T12:00:00.000Z');
    const rows = (withdrawals?: AgentCampaignEvidenceRows['spendingWithdrawals']): AgentCampaignEvidenceRows => ({
        campaign: {
            id: 'ar-1', tenantId: 't-1', name: 'n', periodStartAt: null, periodEndAt: null, reviewerUserId: 'u-r',
            createdByUserId: 'u-o', createdAt: at, closedAt: at, closedByUserId: 'u-o', snapshotTruncated: false,
            preparerAgentId: 'ag-p', crossPreparerAgentId: null,
        },
        subjects: [{
            decisionId: 'dec-1', subjectRef: 'agent:ag-1', subjectAgentId: 'ag-1', subjectOwnerUserId: 'u-ow',
            snapshotJson: {}, decision: 'CONFIRM', decidedAt: at, decidedByUserId: 'u-r', notes: null,
        }],
        packs: [],
        narrowings: [],
        ...(withdrawals === undefined ? {} : { spendingWithdrawals: withdrawals }),
        samples: [],
        obligations: [],
    });

    it('a campaign with no withdrawals builds to the same bytes as before they existed', () => {
        expect(agentCampaignEvidenceBytes(buildAgentCampaignEvidence(rows([]))))
            .toBe(agentCampaignEvidenceBytes(buildAgentCampaignEvidence(rows(undefined))));
        expect(agentCampaignEvidenceBytes(buildAgentCampaignEvidence(rows([])))).not.toContain('spendingWithdrawals');
    });

    it('carries a subject’s withdrawals, sorted, with ISO dates', () => {
        const doc = buildAgentCampaignEvidence(rows([{
            id: 'w-1', decisionId: 'dec-1', rail: 'AP4M', declaredAt: at, statusAtPack: 'DECLARED', expiresAt: at,
            grounds: ['NEVER_REVIEWED', 'EXPIRED_BY_WINDOW_END'], outcome: 'ACCEPTED', decidedAt: at,
            decidedByUserId: 'u-r', executedAt: at, executionResult: 'ENVELOPE_WITHDRAWN', ownerTaskId: 'task-1',
        }]));
        expect(doc.subjects[0]).toMatchObject({
            spendingWithdrawals: [{
                id: 'w-1', rail: 'AP4M', declaredAt: at.toISOString(), grounds: ['EXPIRED_BY_WINDOW_END', 'NEVER_REVIEWED'],
                outcome: 'ACCEPTED', executionResult: 'ENVELOPE_WITHDRAWN', ownerTaskId: 'task-1',
            }],
        });
    });
});
