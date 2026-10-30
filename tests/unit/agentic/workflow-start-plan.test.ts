/**
 * How the runs page starts each workflow (#4472) — one click, a start form
 * built from the definition's `requiredInput`, a link to the page that starts
 * it, or not here, with the reason.
 *
 * Seven of the ten Start buttons on `/agents/runs` could never start a run:
 * the page posted `{ workflowKey }` alone and those definitions declare
 * `requiredInput`, which admission refuses without. The planner is what stops a
 * button from being offered for a request the server will refuse, so its
 * census over the REAL registry is the assertion with teeth: a workflow that
 * declares input this page neither collects nor explains fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { PERIOD_LABEL } from '@/lib/agentic/audit-workpaper';
import {
    NOT_STARTED_HERE,
    NOT_STARTED_HERE_REASONS,
    OTHER_PAGE_REASONS,
    START_FIELDS,
    STARTED_ON_ANOTHER_PAGE,
    startFieldProblem,
    startPlanFor,
    type StartAbilities,
} from '@/lib/agentic/workflow-start-plan';

const EN = jest.requireActual('../../../messages/en.json') as Record<string, unknown>;
const BG = jest.requireActual('../../../messages/bg.json') as Record<string, unknown>;

const at = (catalogue: Record<string, unknown>, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        catalogue,
    );

const ALL: StartAbilities = { discoveredAgents: true, askPage: true, frameworks: true };
const NONE: StartAbilities = { discoveredAgents: false, askPage: false, frameworks: false };

const DEFS = listWorkflowDefinitions();
const plansFor = (abilities: StartAbilities) =>
    Object.fromEntries(DEFS.map((d) => [d.key, startPlanFor(d, abilities)]));
const plans = plansFor(ALL);
const byMode = (p: ReturnType<typeof plansFor>, mode: string) =>
    DEFS.filter((d) => p[d.key].mode === mode).map((d) => d.key).sort();

describe('every registered workflow has a start the server will admit, or an explanation', () => {
    it.each([
        ['every ability', ALL],
        ['no ability', NONE],
    ] as const)('no workflow that declares input is offered a one-click start, with %s', (_label, abilities) => {
        // The defect itself: a one-click start sends no input, and every
        // definition with `requiredInput` refuses that at admission.
        const p = plansFor(abilities);
        const oneClickWithInput = DEFS.filter(
            (d) => (d.requiredInput ?? []).length > 0 && p[d.key].mode === 'ONE_CLICK',
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

    it('classifies today’s registry as the owner’s decisions describe, for a caller who may read everything', () => {
        expect(byMode(plans, 'ONE_CLICK')).toEqual(['access-posture', 'diagnostic', 'posture-review']);
        expect(byMode(plans, 'FORM')).toEqual(
            ['audit-narrative', 'audit-prep', 'discovered-agent-review', 'framework-onboarding'],
        );
        expect(byMode(plans, 'ON_ANOTHER_PAGE')).toEqual(['ad-hoc-question']);
        expect(byMode(plans, 'NOT_HERE')).toEqual(['agent-recertification-pack', 'sap-transaction-review']);
    });

    it('the two workflows this page never starts keep their own reasons', () => {
        for (const abilities of [ALL, NONE]) {
            expect(startPlanFor(DEFS.find((d) => d.key === 'agent-recertification-pack')!, abilities)).toEqual({
                mode: 'NOT_HERE',
                reason: 'ACCESS_REVIEW_PREPARATION',
            });
            expect(startPlanFor(DEFS.find((d) => d.key === 'sap-transaction-review')!, abilities)).toEqual({
                mode: 'NOT_HERE',
                reason: 'HOST_SYSTEM_FACTS',
            });
        }
    });

    it('a framework input is a framework picker wherever it appears', () => {
        for (const key of ['audit-prep', 'framework-onboarding']) {
            const plan = plans[key];
            expect(plan.mode).toBe('FORM');
            if (plan.mode === 'FORM') expect(plan.fields).toEqual([{ key: 'frameworkKey', spec: { kind: 'framework' } }]);
        }
    });

    it('NOT_STARTED_HERE and STARTED_ON_ANOTHER_PAGE name only registered workflows that declare input, once each', () => {
        // No stale entries: a workflow that stopped needing input, or was
        // removed, must leave the list rather than stay explained away.
        const byKey = new Map(DEFS.map((d) => [d.key, d]));
        const listed = [...Object.keys(NOT_STARTED_HERE), ...Object.keys(STARTED_ON_ANOTHER_PAGE)];
        expect(new Set(listed).size).toBe(listed.length);
        for (const key of listed) {
            expect({ key, declaresInput: (byKey.get(key)?.requiredInput ?? []).length > 0 }).toEqual({
                key,
                declaresInput: true,
            });
        }
    });
});

describe('a picker or a link is offered only to a caller who may use it', () => {
    const review = () => DEFS.find((d) => d.key === 'discovered-agent-review')!;
    const ask = () => DEFS.find((d) => d.key === 'ad-hoc-question')!;

    it('the discovered-agent review is a picker form for a caller who may list discovered agents', () => {
        expect(startPlanFor(review(), { ...NONE, discoveredAgents: true })).toEqual({
            mode: 'FORM',
            fields: [{ key: 'discoveredAgentId', spec: { kind: 'discoveredAgent' } }],
        });
    });

    it('and NOT_HERE, with the reason, for one who may not', () => {
        expect(startPlanFor(review(), { ...ALL, discoveredAgents: false })).toEqual({
            mode: 'NOT_HERE',
            reason: 'NEEDS_AGENT_INVENTORY',
        });
    });

    it('a framework workflow is a picker form only for a caller who may view frameworks (#4533)', () => {
        for (const key of ['audit-prep', 'framework-onboarding']) {
            const def = DEFS.find((d) => d.key === key)!;
            expect(startPlanFor(def, { ...NONE, frameworks: true })).toEqual({
                mode: 'FORM',
                fields: [{ key: 'frameworkKey', spec: { kind: 'framework' } }],
            });
            expect(startPlanFor(def, { ...ALL, frameworks: false })).toEqual({
                mode: 'NOT_HERE',
                reason: 'NEEDS_FRAMEWORK_ACCESS',
            });
        }
    });

    it('the ad-hoc question links to the Ask page for a person it admits, and only them', () => {
        expect(startPlanFor(ask(), { ...NONE, askPage: true })).toEqual({ mode: 'ON_ANOTHER_PAGE', path: '/agents/ask' });
        expect(startPlanFor(ask(), { ...ALL, askPage: false })).toEqual({ mode: 'NOT_HERE', reason: 'NEEDS_ASK_ACCESS' });
    });

    it('the Ask page’s reason is told to everyone as is: it is not a run start', () => {
        expect([...OTHER_PAGE_REASONS]).toEqual(['NEEDS_ASK_ACCESS']);
    });

    it('every other page a workflow is started from is a real page', () => {
        // A link to a route with no page is a 404 the runs page would offer.
        const appDir = path.resolve(__dirname, '../../../src/app/t/[tenantSlug]/(app)');
        for (const { path: route } of Object.values(STARTED_ON_ANOTHER_PAGE)) {
            expect({ route, page: fs.existsSync(path.join(appDir, route, 'page.tsx')) }).toEqual({ route, page: true });
        }
    });
});

describe('the planner fails closed', () => {
    it('an input nobody classified is NOT_HERE, never a guessed text box', () => {
        expect(startPlanFor({ key: 'x', requiredInput: ['frameworkKey', 'someInternalId'] }, ALL)).toEqual({
            mode: 'NOT_HERE',
            reason: 'UNCLASSIFIED_INPUT',
        });
    });

    it('does not resolve an input name off the prototype', () => {
        expect(startPlanFor({ key: 'x', requiredInput: ['toString'] }, ALL)).toEqual({
            mode: 'NOT_HERE',
            reason: 'UNCLASSIFIED_INPUT',
        });
        expect(startPlanFor({ key: 'constructor', requiredInput: ['frameworkKey'] }, ALL).mode).toBe('FORM');
    });

    it('absent and empty requiredInput are both one click', () => {
        expect(startPlanFor({ key: 'x' }, NONE)).toEqual({ mode: 'ONE_CLICK' });
        expect(startPlanFor({ key: 'x', requiredInput: [] }, NONE)).toEqual({ mode: 'ONE_CLICK' });
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
