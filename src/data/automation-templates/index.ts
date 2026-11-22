/**
 * Pre-built automation rule templates (Automation Epic 8).
 *
 * Archer ships out-of-the-box workflow content packs; these are IC's
 * equivalent starter rules. A template is a partial rule the user imports as
 * a DRAFT and customises before enabling.
 *
 * Modelled as a typed TS module rather than YAML files: same data, but no
 * runtime filesystem read (Next-bundle-safe), compile-time-checked against
 * the action-config shapes, and trivially importable by both the API loader
 * and a test.
 *
 * NO `{{...}}` TOKENS (#5176). The templates used to carry recipient and text
 * tokens (`{{risk.ownerId}}`, `{{task.title}}`) on the promise that action
 * handlers would resolve them; none does. A NOTIFY_USER rule whose only
 * recipient was a literal token passed readiness, enabled, and "succeeded"
 * notifying nobody. A NOTIFY template now ships with NO recipients, so
 * readiness reports the action incomplete until a person picks them, and its
 * text says nothing a token would have filled in.
 *
 * EVERY TRIGGER IS ONE SOMETHING EMITS, AND EVERY ACTION ONE THAT CAN SUCCEED
 * (#5122, #5175, #5177). `ISSUE_CREATED` has no emitter; `HIGH` is not a
 * RiskStatus; and an UPDATE_STATUS on a Control driven by a test-run event
 * addresses a Control with a test-run id. Templates built on those are gone or
 * retargeted, and a unit test holds the rest to the event and status enums.
 */
import type { AutomationActionType } from '@prisma/client';

export type TemplateTag = 'risk' | 'control' | 'task' | 'notify' | 'webhook';

export interface AutomationTemplate {
    id: string;
    name: string;
    description: string;
    trigger: string;
    /** Recursive FilterGroup or null. */
    filter: Record<string, unknown> | null;
    actionType: AutomationActionType;
    actionConfig: Record<string, unknown>;
    tags: TemplateTag[];
}

export const AUTOMATION_TEMPLATES: ReadonlyArray<AutomationTemplate> = [
    {
        id: 'tpl_risk_owner_notify',
        name: 'Notify when a risk is accepted',
        description: 'Fires when a risk moves to ACCEPTED. Choose who is told before enabling it.',
        trigger: 'RISK_STATUS_CHANGED',
        filter: { logic: 'AND', conditions: [{ field: 'toStatus', operator: 'eq', value: 'ACCEPTED' }] },
        actionType: 'NOTIFY_USER',
        actionConfig: { userIds: [], message: 'A risk was accepted.' },
        tags: ['risk', 'notify'],
    },
    {
        id: 'tpl_failed_test_task',
        name: 'Create remediation task on failed test run',
        description: 'Fires on TEST_RUN_FAILED and opens a remediation task.',
        trigger: 'TEST_RUN_FAILED',
        filter: null,
        actionType: 'CREATE_TASK',
        actionConfig: { title: 'Remediate a failed control test', priority: 'P2' },
        tags: ['control', 'task'],
    },
    {
        id: 'tpl_overdue_task_escalate',
        name: 'Notify when a task is blocked',
        description: 'Fires when a task moves to BLOCKED. Choose who is told before enabling it.',
        trigger: 'TASK_STATUS_CHANGED',
        filter: { logic: 'AND', conditions: [{ field: 'toStatus', operator: 'eq', value: 'BLOCKED' }] },
        actionType: 'NOTIFY_USER',
        actionConfig: { userIds: [], message: 'A task is blocked.' },
        tags: ['task', 'notify'],
    },
    {
        id: 'tpl_slack_finding_webhook',
        name: 'Push to Slack on a failed control test',
        description: 'Fires on TEST_RUN_FAILED and POSTs to a Slack incoming webhook.',
        trigger: 'TEST_RUN_FAILED',
        filter: null,
        actionType: 'WEBHOOK',
        actionConfig: { url: 'https://hooks.slack.com/services/REPLACE/ME', method: 'POST' },
        tags: ['control', 'webhook'],
    },
    {
        id: 'tpl_risk_created_task',
        name: 'Open assessment task on new risk',
        description: 'Fires on RISK_CREATED and opens an assessment task.',
        trigger: 'RISK_CREATED',
        filter: null,
        actionType: 'CREATE_TASK',
        actionConfig: { title: 'Assess a new risk', priority: 'P3' },
        tags: ['risk', 'task'],
    },
    {
        id: 'tpl_high_risk_notify_webhook',
        name: 'Webhook on high-score risk',
        description: 'Fires on RISK_CREATED with score > 15 and calls a webhook.',
        trigger: 'RISK_CREATED',
        filter: { logic: 'AND', conditions: [{ field: 'score', operator: 'gt', value: 15 }] },
        actionType: 'WEBHOOK',
        actionConfig: { url: 'https://example.com/hooks/high-risk', method: 'POST' },
        tags: ['risk', 'webhook'],
    },
];

export function getTemplateById(id: string): AutomationTemplate | undefined {
    return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
