/**
 * A run summary the PRODUCT wrote reads in the reader's language.
 *
 * The diagnostic workflow's summary is a fixed sentence built from three
 * counts ("Posture snapshot — 3 controls, …"). It was shown as stored, so the
 * runs list read English on a Bulgarian page. The stored record stays as the
 * run wrote it; the runs pages re-word it from its counts, and leave every
 * other summary (an agent's own words) exactly as written.
 */
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { localizedRunSummary, type WorkflowSummaryTranslator } from '@/lib/agentic/workflow-labels';
import type { WorkflowContext } from '@/lib/agentic/workflow-types';
import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

/** A translator rooted at `agentWorkflows` in one catalogue. */
function translator(catalog: { agentWorkflows: Record<string, Record<string, string>> }): WorkflowSummaryTranslator {
    return (key, values) => {
        const [workflow, field] = key.split('.');
        const template = catalog.agentWorkflows[workflow]?.[field];
        if (typeof template !== 'string') throw new Error(`no message ${key}`);
        return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in values ? String(values[name]) : m));
    };
}

/** What the diagnostic run itself stores, from its own synthesis step. */
function storedDiagnosticSummary(stats: { controls: number; risks: number; openTasks: number }): string {
    const def = getWorkflowDefinition('diagnostic');
    const step = def?.steps.find((s) => s.kind === 'SYNTHESIS');
    if (!step || step.kind !== 'SYNTHESIS') throw new Error('the diagnostic workflow has no synthesis step');
    const ctx = { outputs: { posture: { stats } } } as unknown as WorkflowContext;
    return step.synthesize(ctx).text;
}

describe('a diagnostic run summary', () => {
    const stored = storedDiagnosticSummary({ controls: 12, risks: 7, openTasks: 3 });

    it('reads in Bulgarian, with its counts and no English left', () => {
        const shown = localizedRunSummary('diagnostic', stored, translator(bg));
        expect(shown).not.toBe(stored);
        expect(shown).toContain('12');
        expect(shown).toContain('7');
        expect(shown).toContain('3');
        expect(shown).not.toMatch(/[A-Za-z]/);
        expect(shown).not.toMatch(/\{\w+\}/);
    });

    it('reads in English exactly as the run wrote it (the record and the catalogue agree)', () => {
        expect(localizedRunSummary('diagnostic', stored, translator(en))).toBe(stored);
    });
});

describe('every other summary', () => {
    const t = translator(bg);

    it("an agent's own words are shown as written", () => {
        const words = 'Posture snapshot — 12 controls, 7 risks, 3 open tasks.';
        expect(localizedRunSummary('posture-review', words, t)).toBe(words);
    });

    it('a diagnostic summary of another shape is shown as stored', () => {
        expect(localizedRunSummary('diagnostic', 'Something else happened.', t)).toBe('Something else happened.');
    });

    it('no summary stays no summary', () => {
        expect(localizedRunSummary('diagnostic', null, t)).toBeNull();
    });
});
