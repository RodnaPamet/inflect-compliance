/**
 * A FAILED step loses its tool name, and the timeline must not lose it too.
 *
 * The static driver's failure path calls `recordStep` with a status and an
 * error output and NOTHING ELSE — no `toolCalled`. So a READ or PROPOSE that
 * threw lands in the ledger with a NULL tool, and a chip reading the column
 * alone renders blank on exactly the steps an operator opened the page to
 * inspect, while the successful steps that need it least are the only ones that
 * show it.
 *
 * That asymmetry is invisible in the happy path, which is why it gets a test of
 * its own rather than a line in a rendered fixture.
 */
import { resolveStepTool } from '@/lib/agentic/run-step-view';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import type { WorkflowStepDef } from '@/lib/agentic/workflow-types';

const READ: WorkflowStepDef = { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' };
const CHECKPOINT: WorkflowStepDef = { kind: 'HUMAN_CHECKPOINT', label: 'review' };

describe('which tool a recorded step shows', () => {
    it('prefers the RECORDED tool — it is what actually ran', () => {
        // Not merely "returns a string": the declared value is deliberately
        // different, so a implementation that read the definition first would
        // pass a weaker assertion and fail this one.
        expect(resolveStepTool('list_risks', READ)).toBe('list_risks');
    });

    it('falls back to the DECLARED tool when the step recorded none', () => {
        // The failure case. This is the whole reason the helper exists.
        expect(resolveStepTool(null, READ)).toBe('get_compliance_posture');
    });

    it('returns null for a kind that legitimately has no tool', () => {
        // SYNTHESIS is a function over context; HUMAN_CHECKPOINT is a pause.
        // Rendering an empty chip for these would invent a missing value.
        expect(resolveStepTool(null, CHECKPOINT)).toBeNull();
    });

    it('returns null when the definition is gone entirely', () => {
        // A run outlives its definition: `getWorkflowDefinition` returns
        // undefined for a workflow key that has since been unregistered, and
        // an old run still has to render.
        expect(resolveStepTool(null, undefined)).toBeNull();
    });

    it('still prefers the recorded tool when the definition is gone', () => {
        expect(resolveStepTool('list_risks', undefined)).toBe('list_risks');
    });

    it('the fallback is reachable for REAL shipped workflows, not just fixtures', () => {
        // The denominator. Every assertion above is satisfied by a helper that
        // works only on hand-written objects; this asserts the shipped
        // definitions actually carry `tool` on the kinds that have one, so the
        // fallback has something to fall back TO in production.
        const withTools = listWorkflowDefinitions()
            .flatMap((d) => d.steps)
            .filter((s) => 'tool' in s && typeof s.tool === 'string');

        expect(withTools.length).toBeGreaterThan(0);
        for (const step of withTools) {
            expect(resolveStepTool(null, step)).toBe((step as { tool: string }).tool);
        }
    });
});
