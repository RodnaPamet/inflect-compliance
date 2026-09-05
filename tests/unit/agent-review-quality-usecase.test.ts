/**
 * The review-quality SEAM — what it reads, what it refuses to read, and when it
 * writes an alert.
 *
 * The arithmetic is proved in `automation-bias-metrics.test.ts` against a
 * hand-computed fixture. This file proves the four things that live only here,
 * each of which would leave the numbers looking perfectly plausible while being
 * about the wrong population:
 *
 *   1. PENDING proposals never enter the denominator. An approval rate that
 *      divided by "every proposal ever" would fall whenever the queue grew,
 *      which is the opposite of the signal.
 *   2. The approval rung is read from the version the proposal PINNED, not from
 *      the agent's card as it stands today. Those are different claims and only
 *      the first is evidence — the card is append-only precisely so the old one
 *      is still readable.
 *   3. The alert is written when a pattern is outstanding, and SUPPRESSED when
 *      an identical one already stands. A pull detector without a dedupe writes
 *      a row per page refresh into a hash-chained log that is never erased.
 *   4. The window is bounded at the usecase, so an HTTP caller and any future
 *      scheduled caller are refused by the same code.
 */
import { makeRequestContext } from '../helpers/make-context';

const findManyAgentProposal = jest.fn();
const findManyCard = jest.fn();
const findManyVersion = jest.fn();
const findManyAuditLog = jest.fn();
const appendAuditEntry = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn({
                agentProposal: { findMany: findManyAgentProposal },
                agentPolicyCard: { findMany: findManyCard },
                agentPolicyCardVersion: { findMany: findManyVersion },
                auditLog: { findMany: findManyAuditLog },
            }),
    ),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (input: unknown) => appendAuditEntry(input),
}));

import {
    computeAgentReviewQuality,
    MAX_WINDOW_DAYS,
    REVIEW_BIAS_AUDIT_ACTION,
} from '@/app-layer/usecases/agent-review-quality';

const ctx = makeRequestContext('ADMIN');

/** Ten approvals five seconds apart, three seconds after each was proposed. */
function stampRows(count = 10) {
    const base = Date.now() - 60 * 60 * 1000;
    return Array.from({ length: count }, (_, i) => ({
        id: `p-${i}`,
        agentId: 'agent-1',
        reviewedByUserId: 'u-stamp',
        reviewedAt: new Date(base + i * 5_000),
        createdAt: new Date(base + i * 5_000 - 3_000),
        status: 'ACCEPTED',
        policyCardVersion: 1,
    }));
}

beforeEach(() => {
    jest.clearAllMocks();
    findManyAgentProposal.mockResolvedValue([]);
    findManyCard.mockResolvedValue([]);
    findManyVersion.mockResolvedValue([]);
    findManyAuditLog.mockResolvedValue([]);
    appendAuditEntry.mockResolvedValue(undefined);
});

describe('what the report is computed over', () => {
    it('reads only DECIDED proposals that carry a reviewer, inside the window', () => {
        return computeAgentReviewQuality(ctx, { windowDays: 30 }).then(() => {
            const where = findManyAgentProposal.mock.calls[0][0].where;
            expect(where.tenantId).toBe(ctx.tenantId);
            // PENDING is absent — the point. QUARANTINED too: it was never
            // handed to a human, so it says nothing about human review.
            expect(where.status).toEqual({ in: ['ACCEPTED', 'EDITED', 'REJECTED'] });
            expect(where.reviewedByUserId).toEqual({ not: null });
            expect(where.reviewedAt.gte).toBeInstanceOf(Date);
            // 30 days back, to the minute.
            const ageDays = (Date.now() - where.reviewedAt.gte.getTime()) / 86_400_000;
            expect(ageDays).toBeGreaterThan(29.9);
            expect(ageDays).toBeLessThan(30.1);
        });
    });

    it('is bounded, and says so when the bound bit', async () => {
        const take = findManyAgentProposal.mock.calls.length;
        expect(take).toBe(0); // nothing read yet
        const report = await computeAgentReviewQuality(ctx, {});
        expect(findManyAgentProposal.mock.calls[0][0].take).toBe(5000);
        // An empty tenant is a legible answer, not an error, and not truncated.
        expect(report.decided).toBe(0);
        expect(report.truncated).toBe(false);
    });

    it('refuses a window outside 1..MAX_WINDOW_DAYS rather than clamping it', async () => {
        // Clamping would answer a question nobody asked and label it with the
        // one they did.
        await expect(computeAgentReviewQuality(ctx, { windowDays: 0 })).rejects.toThrow(
            /windowDays/,
        );
        await expect(
            computeAgentReviewQuality(ctx, { windowDays: MAX_WINDOW_DAYS + 1 }),
        ).rejects.toThrow(/windowDays/);
        await expect(computeAgentReviewQuality(ctx, { windowDays: 1.5 })).rejects.toThrow(
            /windowDays/,
        );
        expect(findManyAgentProposal).not.toHaveBeenCalled();
    });
});

describe('the approval rung comes from the version the proposal pinned', () => {
    it('reads version 1 when the row pins 1, even though the card has moved to 2', async () => {
        findManyAgentProposal.mockResolvedValue(stampRows(2));
        findManyCard.mockResolvedValue([{ id: 'card-1', agentId: 'agent-1' }]);
        findManyVersion.mockResolvedValue([
            { cardId: 'card-1', version: 1, approvalRung: 'SECOND_APPROVER' },
            { cardId: 'card-1', version: 2, approvalRung: 'AUTO_APPROVAL' },
        ]);

        const report = await computeAgentReviewQuality(ctx, { alert: false });
        const agent = report.agents.find((a) => a.agentId === 'agent-1');
        // Both rows pin version 1. Reading the CURRENT card would have
        // reconstructed today's rules wearing an old version number.
        expect(agent?.rungCounts).toEqual({ SECOND_APPROVER: 2 });
        expect(agent?.secondApproverDeclared).toBe(2);
    });

    it('leaves the rung unknown when nothing pinned one, rather than defaulting', async () => {
        findManyAgentProposal.mockResolvedValue(
            stampRows(2).map((r) => ({ ...r, policyCardVersion: null })),
        );
        findManyCard.mockResolvedValue([{ id: 'card-1', agentId: 'agent-1' }]);
        findManyVersion.mockResolvedValue([]);

        const report = await computeAgentReviewQuality(ctx, { alert: false });
        expect(report.agents[0].rungCounts).toEqual({ UNPINNED: 2 });
        expect(report.agents[0].secondApproverDeclared).toBe(0);
    });
});

describe('the alert', () => {
    it('is written once when a pattern is outstanding, with codes and counts only', async () => {
        findManyAgentProposal.mockResolvedValue(stampRows());

        const report = await computeAgentReviewQuality(ctx, {});
        expect(report.alerted).toBe(true);
        expect(appendAuditEntry).toHaveBeenCalledTimes(1);

        const row = appendAuditEntry.mock.calls[0][0];
        expect(row.action).toBe(REVIEW_BIAS_AUDIT_ACTION);
        expect(row.tenantId).toBe(ctx.tenantId);
        expect(row.detailsJson.category).toBe('access');
        expect(row.detailsJson.signalCodes).toBe(
            'BULK_APPROVAL_BURST,FAST_MEDIAN_REVIEW,IMPLAUSIBLY_FAST_DECISION,NEVER_REJECTED',
        );
        expect(row.detailsJson.decidedInWindow).toBe(10);
        expect(row.metadataJson.signalsDigest).toMatch(/^[0-9a-f]{64}$/);

        // Nothing on the row is content. Every value is a code, an id or a
        // number — the contract that makes it safe in a plaintext,
        // hash-chained, never-erased store.
        for (const value of Object.values(row.detailsJson)) {
            expect(['string', 'number']).toContain(typeof value);
        }
    });

    it('is suppressed when an identical finding already stands', async () => {
        findManyAgentProposal.mockResolvedValue(stampRows());
        // First pass, to learn the digest this population produces.
        const first = await computeAgentReviewQuality(ctx, {});
        const digest = appendAuditEntry.mock.calls[0][0].metadataJson.signalsDigest;
        expect(first.alerted).toBe(true);

        appendAuditEntry.mockClear();
        findManyAuditLog.mockResolvedValue([{ metadataJson: { signalsDigest: digest } }]);

        const second = await computeAgentReviewQuality(ctx, {});
        expect(second.alerted).toBe(false);
        expect(appendAuditEntry).not.toHaveBeenCalled();
        // …and the report itself is unchanged. Suppressing the alert must not
        // suppress the finding.
        expect(second.signals).toEqual(first.signals);
    });

    it('is not written when nothing fired', async () => {
        findManyAgentProposal.mockResolvedValue([]);
        const report = await computeAgentReviewQuality(ctx, {});
        expect(report.signals).toEqual([]);
        expect(report.alerted).toBe(false);
        expect(appendAuditEntry).not.toHaveBeenCalled();
        // The dedupe read is skipped too — no query for an alert nobody sends.
        expect(findManyAuditLog).not.toHaveBeenCalled();
    });

    it('can be turned off for a caller that only wants the numbers', async () => {
        findManyAgentProposal.mockResolvedValue(stampRows());
        const report = await computeAgentReviewQuality(ctx, { alert: false });
        expect(report.signals.length).toBeGreaterThan(0);
        expect(report.alerted).toBe(false);
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });
});

describe('the thresholds travel with the report', () => {
    it('so a surface never has to hard-code the number it is comparing against', async () => {
        const report = await computeAgentReviewQuality(ctx, {});
        expect(report.thresholds).toEqual({
            minReportableSample: 10,
            bulkApprovalThreshold: 5,
            bulkApprovalWindowMs: 60_000,
            implausibleDecisionSeconds: 5,
            fastMedianSeconds: 30,
        });
        expect(report.windowDays).toBe(90);
    });
});
