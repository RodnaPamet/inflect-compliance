/**
 * Unit tests for email notification templates.
 */
import {
    buildTaskAssignedEmail,
    buildEvidenceExpiringEmail,
    buildPolicyApprovalRequestedEmail,
    buildPolicyDecisionEmail,
    TASK_ASSIGNED_EMAIL_NAMESPACE,
    type TaskAssignedPayload,
} from '@/app-layer/notifications/templates';
import { workspaceTranslator, type WorkspaceTranslator } from '@/lib/i18n/workspace-text';

describe('Notification Templates', () => {
    describe('buildTaskAssignedEmail', () => {
        const payload = {
            taskTitle: 'Fix ISMS gap in access control',
            taskKey: 'TSK-42',
            taskType: 'AUDIT_FINDING',
            assigneeName: 'Alice Smith',
            assignerName: 'Bob Manager',
            tenantSlug: 'acme-corp',
        };
        // An English workspace — the language every workspace had before the
        // email followed the workspace's default language.
        let enT: WorkspaceTranslator;
        beforeAll(async () => {
            enT = await workspaceTranslator('en', TASK_ASSIGNED_EMAIL_NAMESPACE);
        });
        const build = (p: TaskAssignedPayload) => buildTaskAssignedEmail(p, enT);

        it('returns subject with task key and title', () => {
            const result = build(payload);
            expect(result.subject).toBe('Task assigned to you: [TSK-42] Fix ISMS gap in access control');
        });

        it('returns bodyText mentioning assignee name', () => {
            const result = build(payload);
            expect(result.bodyText).toContain('Hi Alice Smith');
        });

        it('returns bodyText mentioning task type', () => {
            const result = build(payload);
            expect(result.bodyText).toContain('audit_finding');
        });

        it('returns bodyText mentioning assigner', () => {
            const result = build(payload);
            expect(result.bodyText).toContain('by Bob Manager');
        });

        it('returns bodyHtml with styled content', () => {
            const result = build(payload);
            expect(result.bodyHtml).toContain('Task assigned to you');
            expect(result.bodyHtml).toContain('font-family');
        });

        it('handles missing taskKey gracefully', () => {
            const result = build({ ...payload, taskKey: null });
            expect(result.subject).toBe('Task assigned to you: Fix ISMS gap in access control');
        });

        it('handles missing assignerName gracefully', () => {
            const result = build({ ...payload, assignerName: undefined });
            expect(result.bodyText).not.toContain('by');
        });

        it('returns link to tenant tasks page', () => {
            const result = build(payload);
            expect(result.bodyText).toContain('/t/acme-corp/tasks');
        });
    });

    describe('buildEvidenceExpiringEmail', () => {
        const payload = {
            evidenceTitle: 'SOC 2 Report Q1',
            daysRemaining: 5,
            retentionUntil: '2026-03-22',
            controlName: 'AC-01 Access Control Policy',
            recipientName: 'Charlie',
            tenantSlug: 'acme-corp',
        };

        it('returns subject with urgency emoji for ≤7 days', () => {
            const result = buildEvidenceExpiringEmail(payload);
            expect(result.subject).toContain('⚠️');
            expect(result.subject).toContain('SOC 2 Report Q1');
        });

        it('returns subject without urgency emoji for >7 days', () => {
            const result = buildEvidenceExpiringEmail({ ...payload, daysRemaining: 15 });
            expect(result.subject).not.toContain('⚠️');
        });

        it('returns bodyText with control name', () => {
            const result = buildEvidenceExpiringEmail(payload);
            expect(result.bodyText).toContain('AC-01 Access Control Policy');
        });

        it('handles null controlName', () => {
            const result = buildEvidenceExpiringEmail({ ...payload, controlName: null });
            expect(result.bodyText).not.toContain('Control:');
        });

        it('returns bodyHtml', () => {
            const result = buildEvidenceExpiringEmail(payload);
            expect(result.bodyHtml).toContain('Evidence expiring soon');
        });
    });

    describe('buildPolicyApprovalRequestedEmail', () => {
        const payload = {
            policyTitle: 'Information Security Policy',
            requesterName: 'Alice',
            approverName: 'Bob Admin',
            versionNumber: 3,
            tenantSlug: 'acme-corp',
        };

        it('returns subject with policy title and version', () => {
            const result = buildPolicyApprovalRequestedEmail(payload);
            expect(result.subject).toBe('Policy approval requested: Information Security Policy (v3)');
        });

        it('returns bodyText mentioning approver', () => {
            const result = buildPolicyApprovalRequestedEmail(payload);
            expect(result.bodyText).toContain('Hi Bob Admin');
        });

        it('returns bodyText mentioning requester', () => {
            const result = buildPolicyApprovalRequestedEmail(payload);
            expect(result.bodyText).toContain('Alice');
        });

        it('returns bodyHtml', () => {
            const result = buildPolicyApprovalRequestedEmail(payload);
            expect(result.bodyHtml).toContain('Policy approval requested');
        });
    });

    describe('buildPolicyDecisionEmail', () => {
        it('returns approval email with ✅ emoji', () => {
            const result = buildPolicyDecisionEmail({
                policyTitle: 'Data Retention Policy',
                decision: 'APPROVED',
                deciderName: 'Bob',
                requesterName: 'Alice',
                tenantSlug: 'acme-corp',
            });
            expect(result.subject).toContain('✅');
            expect(result.subject).toContain('approved');
            expect(result.bodyText).toContain('approved');
        });

        it('returns rejection email with ❌ emoji', () => {
            const result = buildPolicyDecisionEmail({
                policyTitle: 'Data Retention Policy',
                decision: 'REJECTED',
                deciderName: 'Bob',
                requesterName: 'Alice',
                tenantSlug: 'acme-corp',
            });
            expect(result.subject).toContain('❌');
            expect(result.subject).toContain('rejected');
        });

        it('includes comment when provided', () => {
            const result = buildPolicyDecisionEmail({
                policyTitle: 'Data Retention Policy',
                decision: 'REJECTED',
                deciderName: 'Bob',
                requesterName: 'Alice',
                comment: 'Missing section on GDPR compliance',
                tenantSlug: 'acme-corp',
            });
            expect(result.bodyText).toContain('Missing section on GDPR compliance');
            expect(result.bodyHtml).toContain('Missing section on GDPR compliance');
        });

        it('omits comment section when null', () => {
            const result = buildPolicyDecisionEmail({
                policyTitle: 'Data Retention Policy',
                decision: 'APPROVED',
                deciderName: 'Bob',
                requesterName: 'Alice',
                comment: null,
                tenantSlug: 'acme-corp',
            });
            expect(result.bodyText).not.toContain('Comment:');
        });
    });
});
