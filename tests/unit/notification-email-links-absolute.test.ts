/**
 * Email links open from a mail client (#4130).
 *
 * A relative href such as `/t/acme/tasks` resolves against nothing in an email
 * client, so the button does not open the page. Every notification template
 * and digest built those, and nothing made them absolute before sending. They
 * now go through `appLink`, against `APP_URL` — the source the vendor-assessment
 * emails, the only ones that worked, already used.
 *
 * Every link the bodies carry is collected and asserted absolute, rather than
 * one sample per template: a single relative link left in a body is the bug.
 * The overdue escalation's options are asserted too — it offered a force-close
 * that does not exist.
 */
jest.mock('@/env', () => ({ env: { APP_URL: 'https://app.example.test/' } }));

import {
    buildAccessReviewOverdueEscalationEmail,
    buildAccessReviewReminderEmail,
    buildEvidenceExpiringEmail,
    buildExceptionExpiringEmail,
    buildPolicyApprovalRequestedEmail,
    buildPolicyDecisionEmail,
    buildTaskAssignedEmail,
    type EmailTemplateResult,
} from '@/app-layer/notifications/templates';
import {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
    buildVendorRenewalDigestEmail,
} from '@/app-layer/notifications/digest-templates';
import type { DueItem } from '@/app-layer/jobs/types';

const ORIGIN = 'https://app.example.test';

/** Every href in the HTML body and every in-app path in the text body. */
function linksOf(email: EmailTemplateResult): { hrefs: string[]; textPaths: string[] } {
    const hrefs = [...email.bodyHtml.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    // A path into the app in the text body, absolute or not: what precedes `/t/`.
    const textPaths = [...email.bodyText.matchAll(/(\S*)\/t\/[\w-]+\/\S*/g)].map((m) => m[0]);
    return { hrefs, textPaths };
}

function expectAllAbsolute(email: EmailTemplateResult) {
    const { hrefs, textPaths } = linksOf(email);
    // The population is real: every one of these bodies links somewhere.
    expect(hrefs.length).toBeGreaterThan(0);
    expect(textPaths.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith(`${ORIGIN}/t/acme/`)).toBe(true);
    for (const path of textPaths) expect(path.startsWith(`${ORIGIN}/t/acme/`)).toBe(true);
}

const item = (over: Partial<DueItem> = {}): DueItem => ({
    entityType: 'CONTROL',
    entityId: 'c-1',
    tenantId: 'tenant-1',
    name: 'Access control',
    reason: 'Review overdue',
    urgency: 'OVERDUE',
    dueDate: '2026-10-01T00:00:00.000Z',
    daysRemaining: -3,
    ...over,
});

const overdue = (over: Partial<Parameters<typeof buildAccessReviewOverdueEscalationEmail>[0]> = {}) =>
    buildAccessReviewOverdueEscalationEmail({
        adminName: 'Ada',
        campaignName: 'Q4',
        daysOverdue: 9,
        pendingDecisions: 2,
        totalDecisions: 5,
        tenantSlug: 'acme',
        accessReviewId: 'ar-1',
        reviewerName: 'Rev',
        reviewerEmail: 'rev@x.test',
        ...over,
    });

describe('every in-app link in an email body is absolute against APP_URL', () => {
    it.each([
        ['task assigned', () => buildTaskAssignedEmail({ taskTitle: 'T', taskType: 'TASK', assigneeName: 'A', tenantSlug: 'acme' })],
        ['evidence expiring', () => buildEvidenceExpiringEmail({ evidenceTitle: 'E', daysRemaining: 5, retentionUntil: '2026-11-01', recipientName: 'A', tenantSlug: 'acme' })],
        ['policy approval requested', () => buildPolicyApprovalRequestedEmail({ policyTitle: 'P', requesterName: 'R', approverName: 'A', tenantSlug: 'acme' })],
        ['policy decision', () => buildPolicyDecisionEmail({ policyTitle: 'P', decision: 'APPROVED', deciderName: 'D', requesterName: 'R', tenantSlug: 'acme' })],
        ['access review reminder', () => buildAccessReviewReminderEmail({ reviewerName: 'R', campaignName: 'Q4', daysUntilDue: 1, pendingDecisions: 2, totalDecisions: 5, tenantSlug: 'acme', accessReviewId: 'ar-1' })],
        ['access review overdue', () => overdue()],
        ['exception expiring', () => buildExceptionExpiringEmail({ recipientName: 'A', controlName: 'C', daysRemaining: 7, expiresAtIso: '2026-11-01T00:00:00.000Z', tenantSlug: 'acme', exceptionId: 'ex-1', controlId: 'c-1' })],
        ['deadline digest', () => buildDeadlineDigestEmail({ recipientName: 'A', tenantSlug: 'acme', items: [item()], audience: 'OWNER' })],
        ['evidence expiry digest', () => buildEvidenceExpiryDigestEmail({ recipientName: 'A', tenantSlug: 'acme', items: [item({ entityType: 'EVIDENCE' })], audience: 'OWNER' })],
        ['vendor renewal digest', () => buildVendorRenewalDigestEmail({ recipientName: 'A', tenantSlug: 'acme', items: [item({ entityType: 'VENDOR' })], audience: 'OWNER' })],
    ] as const)('%s', (_label, build) => {
        expectAllAbsolute(build());
    });

    it('the access-review links open that campaign', () => {
        const email = overdue();
        expect(linksOf(email).hrefs).toEqual([`${ORIGIN}/t/acme/access-reviews/ar-1`]);
    });
});

describe('the overdue escalation offers only what an admin can do', () => {
    it('never offers a force-close; offers the reassignment the campaign page now makes', () => {
        const email = overdue();
        expect(email.bodyText).not.toMatch(/force-close/i);
        expect(email.bodyHtml).not.toMatch(/force-close/i);
        expect(email.bodyText).not.toMatch(/skip pending verdicts/i);
        expect(email.bodyHtml).not.toMatch(/skip pending verdicts/i);
        expect(email.bodyText).toContain('Change the reviewer, or the due date, on the campaign page.');
        expect(email.bodyHtml).toContain('Change the reviewer, or the due date, on the campaign page.');
    });

    it('leaves the reassignment out for a campaign the page cannot reassign', () => {
        const email = overdue({ canReassign: false });
        expect(email.bodyText).not.toContain('Change the reviewer');
        expect(email.bodyHtml).not.toContain('Change the reviewer');
        expect(email.bodyText).toContain('Record the pending decisions yourself');
    });
});
