/**
 * Edit round-trip: opening a rule in the builder and saving with no changes
 * must PRESERVE its config (a no-op). Regression guard for the data-loss bug
 * where edit mode never hydrated from the rule and Save PUT blank defaults over
 * the stored config.
 *
 * Tests the pure seam: `buildRulePayload(detailToBuilderState(detail))` must
 * reproduce the detail's config for every action type + filter/sla/schedule/chain.
 */
import {
    detailToBuilderState,
    buildRulePayload,
    type RuleDetail,
} from '@/components/processes/RuleBuilderModal';
import { matchesFilter } from '@/app-layer/automation/filters';
import type { AutomationDomainEvent } from '@/app-layer/automation/event-contracts';
import type { AutomationTriggerFilter } from '@/app-layer/automation/types';

const cases: Array<{ name: string; detail: RuleDetail }> = [
    {
        name: 'NOTIFY_USER + OR filter + sla + breach + chain + else',
        detail: {
            name: 'Notify owner',
            description: null,
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            triggerFilterJson: {
                logic: 'OR',
                conditions: [
                    { field: 'severity', operator: 'in', value: ['HIGH', 'CRITICAL'] },
                    { field: 'title', operator: 'contains', value: 'breach' },
                ],
            },
            actionConfigJson: { userIds: ['u1', 'u2'], message: 'Heads up', linkUrl: 'https://x/y' },
            slaWindowMinutes: 30,
            slaBreachActionType: 'NOTIFY_USER',
            slaBreachConfigJson: { userIds: ['u3'], message: 'Escalate' },
            scheduleConfigJson: null,
            nextRuleId: 'r2',
            nextRuleDelay: 15,
            elseRuleId: 'r3',
        },
    },
    {
        name: 'CREATE_TASK with severity/priority/assignee',
        detail: {
            name: 'Open follow-up',
            description: null,
            triggerEvent: 'CONTROL_FAILED',
            actionType: 'CREATE_TASK',
            triggerFilterJson: null,
            actionConfigJson: { title: 'Investigate', severity: 'HIGH', priority: 'P1', assigneeUserId: 'u9' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'UPDATE_STATUS',
        detail: {
            name: 'Auto-close',
            description: null,
            triggerEvent: 'RISK_MITIGATED',
            actionType: 'UPDATE_STATUS',
            triggerFilterJson: { logic: 'AND', conditions: [{ field: 'status', operator: 'eq', value: 'MITIGATED' }] },
            actionConfigJson: { entityType: 'Risk', field: 'status', toStatus: 'CLOSED' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'WEBHOOK',
        detail: {
            name: 'Ping SIEM',
            description: null,
            triggerEvent: 'INCIDENT_CREATED',
            actionType: 'WEBHOOK',
            triggerFilterJson: null,
            actionConfigJson: { url: 'https://siem.example.com/hook', method: 'PUT' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'WEBHOOK with headers + HMAC secretRef (PR2 superset)',
        detail: {
            name: 'Signed webhook',
            description: null,
            triggerEvent: 'INCIDENT_CREATED',
            actionType: 'WEBHOOK',
            triggerFilterJson: null,
            actionConfigJson: {
                url: 'https://siem.example.com/hook',
                method: 'POST',
                headers: { 'X-Api-Key': 'abc123', 'X-Source': 'inflect' },
                secretRef: 'WEBHOOK_HMAC',
            },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'CREATE_TASK with link-to-entity (PR2 superset)',
        detail: {
            name: 'Linked follow-up',
            description: null,
            triggerEvent: 'RISK_CREATED',
            actionType: 'CREATE_TASK',
            triggerFilterJson: null,
            actionConfigJson: { title: 'Review', linkEntityType: 'Risk', linkEntityIdField: 'entityId' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'INVOKE_SUBFLOW (PR2 superset)',
        detail: {
            name: 'Escalation sub-flow',
            description: null,
            triggerEvent: 'RISK_CREATED',
            actionType: 'INVOKE_SUBFLOW',
            triggerFilterJson: null,
            actionConfigJson: { targetGroupId: 'grp-escalation' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
    {
        name: 'SCHEDULE trigger with schedule config',
        detail: {
            name: 'Evidence reminder',
            description: null,
            triggerEvent: 'SCHEDULE',
            actionType: 'NOTIFY_USER',
            triggerFilterJson: null,
            actionConfigJson: { userIds: ['u1'], message: 'Due soon' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: { kind: 'DATE_RELATIVE', target: 'Evidence', offsetDays: 7 },
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        },
    },
];

describe('rule-builder edit round-trip (save with no changes is a no-op)', () => {
    it.each(cases)('$name preserves config', ({ detail }) => {
        const payload = buildRulePayload(detailToBuilderState(detail));
        expect(payload.name).toBe(detail.name);
        expect(payload.triggerEvent).toBe(detail.triggerEvent);
        expect(payload.actionType).toBe(detail.actionType);
        expect(payload.triggerFilter).toEqual(detail.triggerFilterJson);
        expect(payload.actionConfig).toEqual(detail.actionConfigJson);
        expect(payload.slaWindowMinutes).toBe(detail.slaWindowMinutes);
        expect(payload.slaBreachActionType).toBe(detail.slaBreachActionType);
        expect(payload.slaBreachConfig).toEqual(detail.slaBreachConfigJson);
        expect(payload.scheduleConfig).toEqual(detail.scheduleConfigJson);
        expect(payload.nextRuleId).toBe(detail.nextRuleId);
        expect(payload.nextRuleDelay).toBe(detail.nextRuleDelay);
        expect(payload.elseRuleId).toBe(detail.elseRuleId);
    });
});

// ─── Bug 1: editing must never wipe a filter the tabular builder can't
// author (nested groups, legacy flat maps). Bug 2: a typed eq/neq filter
// still matches after the round-trip. ────────────────────────────────────
function ruleWithFilter(triggerFilterJson: RuleDetail['triggerFilterJson']): RuleDetail {
    return {
        name: 'Filtered rule',
        description: null,
        triggerEvent: 'RISK_CREATED',
        actionType: 'NOTIFY_USER',
        triggerFilterJson,
        actionConfigJson: { userIds: ['u1'], message: 'x' },
        slaWindowMinutes: null,
        slaBreachActionType: null,
        slaBreachConfigJson: null,
        scheduleConfigJson: null,
        nextRuleId: null,
        nextRuleDelay: null,
        elseRuleId: null,
    };
}

function eventWithData(data: Record<string, unknown>): AutomationDomainEvent {
    return {
        event: 'RISK_CREATED',
        tenantId: 't',
        entityType: 'Risk',
        entityId: 'r-1',
        actorUserId: null,
        emittedAt: new Date(),
        data,
    } as unknown as AutomationDomainEvent;
}

describe('edit preserves filters regardless of authoring source', () => {
    it('canvas/API nested-group filter survives a no-op edit verbatim', () => {
        const nested: AutomationTriggerFilter = {
            logic: 'AND',
            conditions: [
                { field: 'score', operator: 'gt', value: 10 },
                {
                    logic: 'OR',
                    conditions: [
                        { field: 'category', operator: 'eq', value: 'SEC' },
                        { field: 'category', operator: 'eq', value: 'COMP' },
                    ],
                },
            ],
        };
        const payload = buildRulePayload(detailToBuilderState(ruleWithFilter(nested)));
        // Never nulled, never flattened — passed through byte-for-byte.
        expect(payload.triggerFilter).toEqual(nested);
        // And it still evaluates: score>10 AND category in {SEC,COMP}.
        expect(matchesFilter(eventWithData({ score: 18, category: 'SEC' }), payload.triggerFilter)).toBe(true);
        expect(matchesFilter(eventWithData({ score: 5, category: 'SEC' }), payload.triggerFilter)).toBe(false);
    });

    it('legacy flat-map filter is not nulled and still matches after an edit', () => {
        const legacy: AutomationTriggerFilter = { category: 'SEC', score: 5 };
        const payload = buildRulePayload(detailToBuilderState(ruleWithFilter(legacy)));
        // The builder hydrates a legacy map into editable eq rows, so it
        // round-trips to an evaluator-equivalent FilterGroup — NOT null.
        expect(payload.triggerFilter).not.toBeNull();
        expect(matchesFilter(eventWithData({ category: 'SEC', score: 5 }), payload.triggerFilter)).toBe(true);
        expect(matchesFilter(eventWithData({ category: 'COMP', score: 5 }), payload.triggerFilter)).toBe(false);
    });

    it('typed `score eq 5` still matches {score: 5} after an edit', () => {
        const eqFilter: AutomationTriggerFilter = {
            logic: 'AND',
            conditions: [{ field: 'score', operator: 'eq', value: 5 }],
        };
        const payload = buildRulePayload(detailToBuilderState(ruleWithFilter(eqFilter)));
        expect(payload.triggerFilter).not.toBeNull();
        expect(matchesFilter(eventWithData({ score: 5 }), payload.triggerFilter)).toBe(true);
        expect(matchesFilter(eventWithData({ score: 6 }), payload.triggerFilter)).toBe(false);
    });
});

describe('description round-trips and can be cleared', () => {
    function ruleWithDescription(description: string | null): RuleDetail {
        return {
            name: 'r',
            description,
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            triggerFilterJson: null,
            actionConfigJson: { userIds: ['u1'], message: 'm' },
            slaWindowMinutes: null,
            slaBreachActionType: null,
            slaBreachConfigJson: null,
            scheduleConfigJson: null,
            nextRuleId: null,
            nextRuleDelay: null,
            elseRuleId: null,
        };
    }

    it('a template-set description survives a no-op edit', () => {
        // Templates (src/data/automation-templates) always set one, so this is
        // the common case — a no-op save must not wipe it.
        const payload = buildRulePayload(
            detailToBuilderState(ruleWithDescription('Fires on RISK_STATUS_CHANGED to HIGH.')),
        );
        expect(payload.description).toBe('Fires on RISK_STATUS_CHANGED to HIGH.');
    });

    it('emptying the field sends null — the payload is what CLEARS it', () => {
        // The bug: `description` was absent from the payload entirely, and the
        // repository skips undefined, so a description could never be removed.
        const state = detailToBuilderState(ruleWithDescription('set by a template'));
        const payload = buildRulePayload({ ...state, description: '   ' });
        expect(payload).toHaveProperty('description');
        expect(payload.description).toBeNull();
    });

    it('a rule with no description round-trips as null, not the string "null"', () => {
        const payload = buildRulePayload(detailToBuilderState(ruleWithDescription(null)));
        expect(payload.description).toBeNull();
    });
});

describe('SLA breach recipients are discarded with the window — visibly', () => {
    const withBreach: RuleDetail = {
        name: 'r',
        description: null,
        triggerEvent: 'RISK_CREATED',
        actionType: 'NOTIFY_USER',
        triggerFilterJson: null,
        actionConfigJson: { userIds: ['u1'], message: 'm' },
        slaWindowMinutes: 30,
        slaBreachActionType: 'NOTIFY_USER',
        slaBreachConfigJson: { userIds: ['u3', 'u4'], message: 'Escalate' },
        scheduleConfigJson: null,
        nextRuleId: null,
        nextRuleDelay: null,
        elseRuleId: null,
    };

    it('clearing the window nulls the breach config in the payload', () => {
        const state = detailToBuilderState(withBreach);
        const payload = buildRulePayload({ ...state, slaWindowMinutes: '' });
        expect(payload.slaWindowMinutes).toBeNull();
        expect(payload.slaBreachConfig).toBeNull();
        expect(payload.slaBreachActionType).toBeNull();
    });

    it('the recipients stay in builder state, so the warning can be shown and the loss undone', () => {
        // This is what makes the modal's InlineNotice both accurate and
        // actionable: the list is not gone until save, so re-entering a window
        // restores it verbatim.
        const state = detailToBuilderState(withBreach);
        const cleared = { ...state, slaWindowMinutes: '' };
        expect(cleared.slaBreach.userIds).toEqual(['u3', 'u4']);

        const restored = buildRulePayload({ ...cleared, slaWindowMinutes: '30' });
        expect(restored.slaBreachConfig).toEqual({ userIds: ['u3', 'u4'], message: 'Escalate' });
    });
});
