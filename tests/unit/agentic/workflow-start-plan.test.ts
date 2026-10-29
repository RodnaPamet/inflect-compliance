/**
 * How the runs page starts each workflow (#4472) — one click, a start form
 * built from the definition's `requiredInput`, or not here, with the reason.
 *
 * Seven of the ten Start buttons on `/agents/runs` could never start a run:
 * the page posted `{ workflowKey }` alone and those definitions declare
 * `requiredInput`, which admission refuses without. The planner is what stops a
 * button from being offered for a request the server will refuse, so its
 * census over the REAL registry is the assertion with teeth: a workflow that
 * declares input this page neither collects nor explains fails here.
 */
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { PERIOD_LABEL } from '@/lib/agentic/audit-workpaper';
import {
    NOT_STARTED_HERE,
    NOT_STARTED_HERE_REASONS,
    START_FIELDS,
    startFieldProblem,
    startPlanFor,
} from '@/lib/agentic/workflow-start-plan';

const EN = jest.requireActual('../../../messages/en.json') as Record<string, unknown>;
const BG = jest.requireActual('../../../messages/bg.json') as Record<string, unknown>;

const at = (catalogue: Record<string, unknown>, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        catalogue,
    );

const DEFS = listWorkflowDefinitions();
const plans = Object.fromEntries(DEFS.map((d) => [d.key, startPlanFor(d)]));

describe('every registered workflow has a start the server will admit, or an explanation', () => {
    it('no workflow that declares input is offered a one-click start', () => {
        // The defect itself: a one-click start sends no input, and every
        // definition with `requiredInput` refuses that at admission.
        const oneClickWithInput = DEFS.filter(
            (d) => (d.requiredInput ?? []).length > 0 && plans[d.key].mode === 'ONE_CLICK',
        ).map((d) => d.key);
        expect(oneClickWithInput).toEqual([]);
    });

    it('a form collects EXACTLY the declared inputs, in their declared order', () => {
        for (const d of DEFS) {
            const plan = plans[d.key];
            if (plan.mode !== 'FORM') continue;
            expect({ key: d.key, fields: plan.fields.map((f) => f.key) }).toEqual({
                key: d.key,
                fields: [...(d.requiredInput ?? [])],
            });
        }
    });

    it('nothing in the registry falls through to UNCLASSIFIED_INPUT', () => {
        // The fail-closed branch exists for a definition added later. Today
        // every declared input is either collected or explained by name.
        const unclassified = DEFS.filter((d) => {
            const plan = plans[d.key];
            return plan.mode === 'NOT_HERE' && plan.reason === 'UNCLASSIFIED_INPUT';
        }).map((d) => d.key);
        expect(unclassified).toEqual([]);
    });

    it('classifies today’s registry as the owner’s decision describes', () => {
        const byMode = (mode: string) => DEFS.filter((d) => plans[d.key].mode === mode).map((d) => d.key).sort();
        expect(byMode('ONE_CLICK')).toEqual(['access-posture', 'diagnostic', 'posture-review']);
        expect(byMode('FORM')).toEqual(['audit-narrative', 'audit-prep', 'framework-onboarding']);
        expect(byMode('NOT_HERE')).toEqual(
            ['ad-hoc-question', 'agent-recertification-pack', 'discovered-agent-review', 'sap-transaction-review'],
        );
    });

    it('a framework input is a framework picker wherever it appears', () => {
        for (const key of ['audit-prep', 'framework-onboarding']) {
            const plan = plans[key];
            expect(plan.mode).toBe('FORM');
            if (plan.mode === 'FORM') expect(plan.fields).toEqual([{ key: 'frameworkKey', spec: { kind: 'framework' } }]);
        }
    });

    it('NOT_STARTED_HERE names only registered workflows that declare input', () => {
        // No stale entries: a workflow that stopped needing input, or was
        // removed, must leave the list rather than stay explained away.
        const byKey = new Map(DEFS.map((d) => [d.key, d]));
        for (const key of Object.keys(NOT_STARTED_HERE)) {
            expect({ key, declaresInput: (byKey.get(key)?.requiredInput ?? []).length > 0 }).toEqual({
                key,
                declaresInput: true,
            });
        }
    });
});

describe('the planner fails closed', () => {
    it('an input nobody classified is NOT_HERE, never a guessed text box', () => {
        expect(startPlanFor({ key: 'x', requiredInput: ['frameworkKey', 'someInternalId'] })).toEqual({
            mode: 'NOT_HERE',
            reason: 'UNCLASSIFIED_INPUT',
        });
    });

    it('does not resolve an input name off the prototype', () => {
        expect(startPlanFor({ key: 'x', requiredInput: ['toString'] })).toEqual({
            mode: 'NOT_HERE',
            reason: 'UNCLASSIFIED_INPUT',
        });
    });

    it('absent and empty requiredInput are both one click', () => {
        expect(startPlanFor({ key: 'x' })).toEqual({ mode: 'ONE_CLICK' });
        expect(startPlanFor({ key: 'x', requiredInput: [] })).toEqual({ mode: 'ONE_CLICK' });
    });
});

describe('the form’s own check', () => {
    const period = START_FIELDS.periodLabel;

    it('refuses what admission refuses: blank, including whitespace', () => {
        expect(startFieldProblem(START_FIELDS.frameworkKey, undefined)).toBe('REQUIRED');
        expect(startFieldProblem(START_FIELDS.frameworkKey, '   ')).toBe('REQUIRED');
        expect(startFieldProblem(period, '')).toBe('REQUIRED');
    });

    it('holds the period to the format the narrative’s first step validates', () => {
        expect(startFieldProblem(period, '2026-Q3')).toBeNull();
        expect(startFieldProblem(period, ' 2026-09 ')).toBeNull();
        expect(startFieldProblem(period, 'Q3 2026')).toBe('FORMAT');
        expect(startFieldProblem(period, '2026-13')).toBe('FORMAT');
    });

    it('the period pattern is a faithful copy of PERIOD_LABEL', () => {
        // The client cannot import the source (it reaches `node:crypto`), so
        // the copy is held equal here.
        expect(period.kind).toBe('text');
        if (period.kind === 'text') expect(period.pattern).toBe(PERIOD_LABEL.source);
    });
});

describe('every string the form and the reasons need exists in both catalogues', () => {
    it.each([
        ['en', EN],
        ['bg', BG],
    ] as const)('%s', (_locale, catalogue) => {
        const missing: string[] = [];
        const need = (key: string) => {
            if (typeof at(catalogue, key) !== 'string') missing.push(key);
        };
        for (const [key, spec] of Object.entries(START_FIELDS)) {
            need(`agents.runs.startForm.field.${key}.label`);
            need(`agents.runs.startForm.field.${key}.hint`);
            if (spec.kind === 'text' && spec.pattern) need(`agents.runs.startForm.field.${key}.invalid`);
        }
        for (const reason of NOT_STARTED_HERE_REASONS) need(`agents.runs.notHere.${reason}`);
        expect(missing).toEqual([]);
    });
});
