/**
 * Canned-workflows coverage ratchet (Epic Agentic 1B).
 *
 * The framework-onboarding + audit-prep workflows are DECLARATIVE definitions
 * the engine runs — no bespoke orchestration. This guard locks:
 *   - both workflows are registered and are pure declarative definitions (the
 *     def files don't import the engine or call usecases);
 *   - every READ/PROPOSE step names a REAL MCP tool (a typo can't ship);
 *   - every PROPOSE step uses a propose tool → the approval queue (no direct
 *     commit);
 *   - every workflow that PROPOSES a write has ≥1 HUMAN_CHECKPOINT before it
 *     completes (no fully-autonomous mutation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getWorkflowDefinition, listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { selectRunDriver } from '@/lib/agentic/drivers';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** Comments MASKED at the read seam (#2246) — assertions bind to code, not prose. */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));
const PROPOSE_TOOL_NAMES = new Set(PROPOSE_TOOLS.map((t) => t.name));

const CANNED = ['framework-onboarding', 'audit-prep'];

describe('Canned workflows — registration + declarative shape', () => {
    it('framework-onboarding + audit-prep are registered', () => {
        for (const key of CANNED) {
            const def = getWorkflowDefinition(key);
            expect(def).toBeDefined();
            expect(Array.isArray(def!.steps)).toBe(true);
            expect(def!.steps.length).toBeGreaterThan(0);
        }
    });

    it('the workflow def files are pure data (no engine / usecase imports)', () => {
        for (const file of ['framework-onboarding.ts', 'audit-prep.ts']) {
            const src = read(`src/lib/agentic/workflows/${file}`);
            expect(src).not.toMatch(/from ['"]@\/app-layer\/usecases/);
            expect(src).not.toMatch(/from ['"]@\/lib\/mcp/);
            expect(src).not.toMatch(/runProposeTool|runReadTool|createAgentProposal/);
        }
    });
});

describe('Canned workflows — every step names a real tool', () => {
    it('READ steps use real read tools; PROPOSE steps use real propose tools', () => {
        const offenders: string[] = [];
        for (const def of listWorkflowDefinitions()) {
            for (const step of def.steps) {
                if (step.kind === 'READ' && !READ_TOOL_NAMES.has(step.tool)) {
                    offenders.push(`${def.key}: unknown read tool ${step.tool}`);
                }
                if (step.kind === 'PROPOSE' && !PROPOSE_TOOL_NAMES.has(step.tool)) {
                    offenders.push(`${def.key}: unknown propose tool ${step.tool}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('Canned workflows — human-in-the-loop before any write completes', () => {
    it('every workflow with a PROPOSE step has ≥1 HUMAN_CHECKPOINT (no autonomous write)', () => {
        for (const def of listWorkflowDefinitions()) {
            const proposeIdxs = def.steps.map((s, i) => (s.kind === 'PROPOSE' ? i : -1)).filter((i) => i >= 0);
            if (proposeIdxs.length === 0) continue; // pure-read workflow (e.g. diagnostic) needs none
            const checkpointIdxs = def.steps.map((s, i) => (s.kind === 'HUMAN_CHECKPOINT' ? i : -1)).filter((i) => i >= 0);
            expect(checkpointIdxs.length).toBeGreaterThanOrEqual(1);
            // A checkpoint must gate BEFORE the run completes: the last step is
            // not a PROPOSE with no checkpoint after it.
            const lastPropose = Math.max(...proposeIdxs);
            const hasCheckpointAfterAPropose = checkpointIdxs.some((c) => c > Math.min(...proposeIdxs));
            expect(hasCheckpointAfterAPropose).toBe(true);
            expect(lastPropose).toBeLessThan(def.steps.length - 1); // never the final step
        }
    });

    it('the two canned write-workflows each end with a SYNTHESIS after a checkpoint', () => {
        for (const key of CANNED) {
            const def = getWorkflowDefinition(key)!;
            const last = def.steps[def.steps.length - 1];
            expect(last.kind).toBe('SYNTHESIS');
            expect(def.steps.some((s) => s.kind === 'HUMAN_CHECKPOINT')).toBe(true);
        }
    });
});

/**
 * WHICH ENGINE THE SHIPPED WORKFLOWS ASK FOR.
 *
 * `selectRunDriver` intersects the definition's request with what the
 * deployment permits, so a registry in which NO definition asks for flue makes
 * the Flue engine unreachable — the operator switch, the tenant toggle and
 * `DRIVER_IMPLEMENTED.flue` can all be on and every run still executes on the
 * static engine. That was the state of this repo until `posture-review`, and
 * it is invisible from any of the three switches.
 *
 * So the claim is asserted through `selectRunDriver` rather than by reading
 * `def.driver`: reading the field would pass on a definition the selector
 * could still never choose.
 */
describe('the Flue engine is reachable from the shipped registry', () => {
    const asksForFlue = listWorkflowDefinitions().filter((d) => d.driver === 'flue');

    it('at least one shipped definition asks for it, and the selector chooses it', () => {
        expect(asksForFlue.map((d) => d.key)).not.toEqual([]);
        for (const def of asksForFlue) {
            expect(selectRunDriver(def, 'flue').driver).toBe('flue');
        }
    });

    it('a definition that asks for flue still resolves to static where it is not permitted', () => {
        // The other direction, and the one that makes the request safe to
        // ship: a definition is configuration, not an authority. Every
        // deployment that has not enabled Flue runs these on the static
        // engine.
        for (const def of asksForFlue) {
            expect(selectRunDriver(def, 'static').driver).toBe('static');
        }
    });

    it('the workflows that do NOT ask are untouched by the request', () => {
        // Adding the engine must not have re-pointed a workflow anyone already
        // depends on. Flue does not walk the declared steps, so flagging an
        // existing definition would change what it does.
        const untouched = listWorkflowDefinitions()
            .filter((d) => d.driver !== 'flue')
            .map((d) => d.key)
            .sort();
        expect(untouched).toEqual(['audit-prep', 'diagnostic', 'framework-onboarding']);
    });

    it('every flue-requesting workflow is READ-ONLY', () => {
        // The first engine to execute a production run cannot queue a
        // proposal. A PROPOSE step here would also need a parking mechanism
        // the Flue path does not take from the step list — see the header of
        // `workflows/posture-review.ts`.
        for (const def of asksForFlue) {
            expect(def.steps.filter((s) => s.kind === 'PROPOSE')).toEqual([]);
        }
    });
});
