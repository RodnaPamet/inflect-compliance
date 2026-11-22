/**
 * Automation Epic 8 — template content validity.
 *
 * Every shipped template must be a valid, importable rule: its
 * (actionType, actionConfig) pair and trigger filter must pass the same
 * schema the create API enforces, so "Use template" can never produce an
 * invalid DRAFT.
 */
import { RiskStatus, TaskStatus } from '@prisma/client';
import { AUTOMATION_TEMPLATES, getTemplateById } from '@/data/automation-templates';
import { CreateAutomationRuleSchema } from '@/app-layer/schemas/automation.schemas';
import { isKnownAutomationEvent } from '@/app-layer/automation/events';
import { ruleReadinessProblems } from '@/app-layer/automation/rule-readiness';

/**
 * Catalogued events nothing emits. A template on one of these imports fine and
 * never fires (#5122). Kept as a list so a future emitter is a one-line change
 * here, not a template someone has to rediscover.
 */
const EVENTS_WITH_NO_EMITTER = new Set(['ISSUE_CREATED', 'ISSUE_STATUS_CHANGED']);

/** The status a `toStatus` filter compares against, per status-change event. */
const STATUS_VALUES_BY_EVENT: Record<string, ReadonlySet<string>> = {
    RISK_STATUS_CHANGED: new Set(Object.values(RiskStatus)),
    TASK_STATUS_CHANGED: new Set(Object.values(TaskStatus)),
};

describe('automation templates', () => {
    it('ships templates with unique ids', () => {
        expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
        const ids = new Set(AUTOMATION_TEMPLATES.map((t) => t.id));
        expect(ids.size).toBe(AUTOMATION_TEMPLATES.length);
    });

    it('every template trigger is a known catalog event', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            expect(isKnownAutomationEvent(t.trigger)).toBe(true);
        }
    });

    it('every template is a valid importable rule, apart from the recipients a person must choose', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            // A NOTIFY template ships with NO recipients (#5176), so the strict
            // create schema — which wants at least one — is asked with a
            // stand-in, and readiness (below) is what holds the empty list.
            const actionConfig =
                t.actionType === 'NOTIFY_USER' ? { ...t.actionConfig, userIds: ['someone'] } : t.actionConfig;
            const res = CreateAutomationRuleSchema.safeParse({
                name: t.name,
                description: t.description,
                triggerEvent: t.trigger,
                triggerFilter: t.filter,
                actionType: t.actionType,
                actionConfig,
                status: 'DRAFT',
            });
            if (!res.success) {
                throw new Error(`Template ${t.id} invalid: ${JSON.stringify(res.error.issues)}`);
            }
            expect(res.success).toBe(true);
        }
    });

    it('carries no {{...}} token, which nothing resolves (#5176)', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            expect(JSON.stringify(t)).not.toContain('{{');
        }
    });

    it('a NOTIFY template cannot be enabled until a person picks recipients (#5176)', () => {
        // It used to carry a literal `{{risk.ownerId}}` recipient: it passed
        // readiness, enabled, and "succeeded" notifying nobody.
        for (const t of AUTOMATION_TEMPLATES) {
            const problems = ruleReadinessProblems({
                triggerEvent: t.trigger,
                actionType: t.actionType,
                actionConfigJson: t.actionConfig,
            });
            if (t.actionType === 'NOTIFY_USER') expect(problems).toEqual(['ACTION_INCOMPLETE']);
            else expect(problems).toEqual([]);
        }
    });

    it('fires on an event something emits (#5122)', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            expect(EVENTS_WITH_NO_EMITTER.has(t.trigger)).toBe(false);
        }
    });

    it('filters a status change on a status the entity actually has (#5175)', () => {
        // `toStatus: 'HIGH'` on RISK_STATUS_CHANGED could never match.
        for (const t of AUTOMATION_TEMPLATES) {
            const allowed = STATUS_VALUES_BY_EVENT[t.trigger];
            if (!allowed || !t.filter) continue;
            const conditions = (t.filter as { conditions?: Array<{ field: string; value: unknown }> }).conditions ?? [];
            for (const c of conditions.filter((c) => c.field === 'toStatus')) {
                expect(allowed.has(String(c.value))).toBe(true);
            }
        }
    });

    it('sets no status from an event about a different entity (#5177)', () => {
        // UPDATE_STATUS writes `event.entityId`. Driven by a TEST_RUN_* event,
        // that id is a test run's, so a Control target matched nothing — and
        // IN_REVIEW was not a Control status either.
        for (const t of AUTOMATION_TEMPLATES) {
            if (t.actionType !== 'UPDATE_STATUS') continue;
            const target = (t.actionConfig as { entityType?: string }).entityType;
            expect(t.trigger.startsWith(`${(target ?? '').toUpperCase()}_`)).toBe(true);
        }
    });

    it('getTemplateById resolves a known id and undefined otherwise', () => {
        expect(getTemplateById(AUTOMATION_TEMPLATES[0].id)).toBeDefined();
        expect(getTemplateById('nope')).toBeUndefined();
    });
});
