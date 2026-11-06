/**
 * Which rule a step on an automation canvas configures
 * (`src/lib/processes/canvas-rule-wiring.ts`), what a rule still needs before
 * it can run (`rule-readiness.ts`), and what a canvas save keeps
 * (`prepareCanvasNodesForSave`).
 */
import { fedRuleIds, type WiringEdge, type WiringNode } from '@/lib/processes/canvas-rule-wiring';
import {
    RULE_OWNING_KINDS as SERVER_OWNING,
    prepareCanvasNodesForSave,
    stubRuleName,
} from '@/app-layer/services/canvas-rule-sync';
import { RULE_OWNING_KINDS as CLIENT_OWNING } from '@/lib/processes/canvas-rule-wiring';
import {
    UNSET_TRIGGER_EVENT,
    readinessRefusal,
    ruleReadinessProblems,
} from '@/app-layer/automation/rule-readiness';

const n = (nodeKey: string, nodeType: string, ruleId: string | null = null): WiringNode => ({
    nodeKey,
    nodeType,
    ruleId,
});
const e = (sourceKey: string, targetKey: string): WiringEdge => ({ sourceKey, targetKey });

describe('fedRuleIds', () => {
    it('a Trigger wired straight to an Action sets that Action\'s rule', () => {
        expect(fedRuleIds('t', [n('t', 'trigger'), n('a', 'action', 'r1')], [e('t', 'a')])).toEqual({
            ruleIds: ['r1'],
            unsavedOwners: 0,
        });
    });

    it('follows a path through Condition and SLA steps', () => {
        const nodes = [n('t', 'trigger'), n('c', 'condition'), n('s', 'slaGate'), n('a', 'agent', 'r9')];
        expect(fedRuleIds('t', nodes, [e('t', 'c'), e('c', 's'), e('s', 'a')]).ruleIds).toEqual(['r9']);
    });

    it('a Trigger that fans out sets every rule it reaches, once each', () => {
        const nodes = [n('t', 'trigger'), n('a1', 'action', 'r1'), n('a2', 'action', 'r2'), n('c', 'condition')];
        const edges = [e('t', 'a1'), e('t', 'c'), e('c', 'a2'), e('c', 'a1')];
        expect(fedRuleIds('t', nodes, edges).ruleIds).toEqual(['r1', 'r2']);
    });

    it('stops at an Action: what comes after it is another rule\'s business', () => {
        const nodes = [n('t', 'trigger'), n('a1', 'action', 'r1'), n('a2', 'action', 'r2')];
        expect(fedRuleIds('t', nodes, [e('t', 'a1'), e('a1', 'a2')]).ruleIds).toEqual(['r1']);
    });

    it('stops at a step that is not part of a rule', () => {
        const nodes = [n('t', 'trigger'), n('p', 'processStep'), n('a', 'action', 'r1')];
        expect(fedRuleIds('t', nodes, [e('t', 'p'), e('p', 'a')]).ruleIds).toEqual([]);
    });

    it('counts an Action that has no rule yet, so the panel can say to save', () => {
        expect(fedRuleIds('t', [n('t', 'trigger'), n('a', 'action')], [e('t', 'a')])).toEqual({
            ruleIds: [],
            unsavedOwners: 1,
        });
    });

    it('a loop on the canvas ends', () => {
        const nodes = [n('t', 'trigger'), n('c1', 'condition'), n('c2', 'condition')];
        expect(fedRuleIds('t', nodes, [e('t', 'c1'), e('c1', 'c2'), e('c2', 'c1')]).ruleIds).toEqual([]);
    });

    it('the server and the canvas agree on which kinds own a rule', () => {
        expect([...SERVER_OWNING]).toEqual([...CLIENT_OWNING]);
    });
});

describe('ruleReadinessProblems', () => {
    const complete = {
        triggerEvent: 'RISK_CREATED',
        actionType: 'NOTIFY_USER',
        actionConfigJson: { userIds: ['u1'], message: 'hi' },
    };

    it('a complete rule needs nothing', () => {
        expect(ruleReadinessProblems(complete)).toEqual([]);
    });

    it('a canvas stub needs its trigger and its action', () => {
        expect(
            ruleReadinessProblems({ triggerEvent: UNSET_TRIGGER_EVENT, actionType: 'NOTIFY_USER', actionConfigJson: { userIds: [], message: '' } }),
        ).toEqual(['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE']);
    });

    it('an Agent stub needs its agent', () => {
        expect(ruleReadinessProblems({ ...complete, actionType: 'INVOKE_AGENT', actionConfigJson: {} })).toEqual([
            'ACTION_INCOMPLETE',
        ]);
    });

    it('a SCHEDULE trigger needs a schedule', () => {
        expect(ruleReadinessProblems({ ...complete, triggerEvent: 'SCHEDULE' })).toEqual(['SCHEDULE_NOT_SET']);
        expect(
            ruleReadinessProblems({ ...complete, triggerEvent: 'SCHEDULE', scheduleConfigJson: { kind: 'DATE_RELATIVE' } }),
        ).toEqual([]);
    });

    it('the unset trigger is not an event anything emits', () => {
        expect(ruleReadinessProblems({ ...complete, triggerEvent: UNSET_TRIGGER_EVENT })).toEqual(['TRIGGER_NOT_SET']);
    });

    it('the refusal names each problem', () => {
        expect(readinessRefusal(['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE'])).toBe(
            'This rule cannot be enabled yet: choose the event that triggers it, and complete its action settings.',
        );
    });
});

describe('stubRuleName', () => {
    it('names the rule after the step', () => {
        expect(stubRuleName({ nodeKey: 'node-1', label: 'Notify the risk owner' })).toBe('Notify the risk owner');
    });

    it('falls back to the key for a step with no label', () => {
        expect(stubRuleName({ nodeKey: 'node-1', label: '   ' })).toBe('Canvas rule · node-1');
    });

    it('fits the rule schema\'s 200-character limit', () => {
        expect(stubRuleName({ nodeKey: 'k', label: 'x'.repeat(500) })).toHaveLength(200);
    });
});

describe('prepareCanvasNodesForSave', () => {
    const db = (stored: Array<{ nodeKey: string; dataJson: unknown }>) =>
        ({ processNode: { findMany: jest.fn().mockResolvedValue(stored) } }) as never;
    const ctx = { tenantId: 't1' } as never;

    it('an Action step saved without its rule keeps the one stored for it', async () => {
        // The defect: the open canvas never had the id the sync created, the
        // next save sent the step without one, and the sync made another rule.
        const out = await prepareCanvasNodesForSave(
            db([{ nodeKey: 'a1', dataJson: { ruleId: 'r1' } }]),
            ctx,
            'map-1',
            [{ nodeKey: 'a1', nodeType: 'action', dataJson: { color: 'blue' } }],
        );
        expect(out[0]!.dataJson).toEqual({ color: 'blue', ruleId: 'r1' });
    });

    it('takes only the link stored for the SAME step', async () => {
        const out = await prepareCanvasNodesForSave(
            db([{ nodeKey: 'other', dataJson: { ruleId: 'r1' } }]),
            ctx,
            'map-1',
            [{ nodeKey: 'a1', nodeType: 'action', dataJson: null }],
        );
        expect(out[0]!.dataJson).toBeNull();
    });

    it('a step that arrives with its own link keeps it', async () => {
        const out = await prepareCanvasNodesForSave(
            db([{ nodeKey: 'a1', dataJson: { ruleId: 'r-old' } }]),
            ctx,
            'map-1',
            [{ nodeKey: 'a1', nodeType: 'action', dataJson: { ruleId: 'r-new' } }],
        );
        expect(out[0]!.dataJson).toEqual({ ruleId: 'r-new' });
    });

    it('drops the display-only rule fields the load merged in', async () => {
        const out = await prepareCanvasNodesForSave(db([]), ctx, 'map-1', [
            {
                nodeKey: 'a1',
                nodeType: 'action',
                dataJson: { ruleId: 'r1', ruleStatus: 'ENABLED', executionCount: 4, ruleSubtitle: 'x' },
            },
        ]);
        expect(out[0]!.dataJson).toEqual({ ruleId: 'r1' });
    });
});
