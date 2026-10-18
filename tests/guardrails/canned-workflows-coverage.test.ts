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
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

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
        // `agent-recertification-pack` (#3674) is NEW and static from birth —
        // its usecase reads the recorded READ step back — not a re-pointed one.
        expect(untouched).toEqual(['agent-recertification-pack', 'audit-prep', 'diagnostic', 'framework-onboarding']);
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

/**
 * A WORKFLOW MAY NOT INVENT A VALUE FOR AN INPUT IT WAS NOT GIVEN (#3600).
 *
 * ## The defect
 *
 * `audit-prep` and `framework-onboarding` each carried their own copy of
 *
 *     typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : ''
 *
 * The fallback satisfies the declared `string`, so nothing refused it, and `''`
 * is the one value the two tools downstream disagree about:
 * `find_coverage_gaps` declares `z.string().min(1)` and rejects it, while
 * `get_framework_status` declares `.optional()` and reads falsy as a SUPPORTED
 * mode, returning the installable-framework catalogue rather than the
 * per-framework readout. Step 0 answered a different question and was recorded
 * DONE; step 1 then died in a validator. Seven production runs, 2026-07-02 to
 * 2026-09-19, every one of them this.
 *
 * The crash is the lucky part. Had both tools been `.optional()` those runs
 * would have COMPLETED and produced an audit-readiness pack computed against
 * the wrong scope, with nothing in the record looking wrong.
 *
 * ## Why it lives here rather than in its own file
 *
 * `no-epic-named-ratchets` caps the number of guard files on purpose, and the
 * question it forces has a real answer: this file already reads definition
 * SOURCE through `read()` and already holds definitions to properties the
 * engine depends on. It also already imports `listWorkflowDefinitions`, which
 * is a better population than any directory glob — `diagnosticWorkflow` is
 * declared inline in the registry, so a guard scoped to `workflows/` would have
 * covered 4 of the 5 definitions that ship.
 */
describe('Canned workflows — a missing input is refused, never invented', () => {
    /**
     * A `ctx.input` read whose fallback is an EMPTY value of the right type.
     * Covers the ternary the defect used and the `??` / `||` spellings of the
     * same idea. The window is bounded so an unrelated `''` further down the
     * line cannot be read as this read's fallback.
     */
    const EMPTY_FALLBACK = /ctx\.input[^;\n]{0,140}?(\?\?|\|\||:)\s*(''|""|``|\[\s*\]|\{\s*\})/;

    /** Keys a definition's source actually reads, however the read is spelled. */
    const keysRead = (code: string): string[] => {
        const keys = new Set<string>();
        for (const m of code.matchAll(/ctx\.input\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
        for (const m of code.matchAll(/ctx\.input\[\s*['"]([^'"]+)['"]\s*\]/g)) keys.add(m[1]);
        for (const m of code.matchAll(/requiredString\(\s*ctx\s*,\s*['"]([^'"]+)['"]\s*\)/g)) keys.add(m[1]);
        return [...keys].sort();
    };

    /**
     * Every registered definition paired with the source that declares it.
     *
     * The population comes from the REGISTRY, so a definition added anywhere is
     * in scope. Pairing is by the `key: '<k>'` literal, which is how each
     * definition names itself.
     */
    const defSources = listWorkflowDefinitions().map((def) => {
        const candidates = [
            `src/lib/agentic/workflows/${def.key}.ts`,
            'src/lib/agentic/workflow-registry.ts',
        ];
        const rel = candidates.find((c) => {
            try {
                return read(c).includes(`key: '${def.key}'`);
            } catch {
                return false;
            }
        });
        return { def, rel, code: rel ? read(rel) : '' };
    });

    it('locates the source of every registered definition', () => {
        // Without this the checks below would silently skip a definition whose
        // file moved — passing because they read an empty string.
        expect(defSources.filter((d) => !d.rel).map((d) => d.def.key)).toEqual([]);
        expect(defSources.length).toBeGreaterThanOrEqual(5);
    });

    it('substitutes no empty value for a `ctx.input` read', () => {
        const offenders = defSources
            .filter((d) => EMPTY_FALLBACK.test(d.code))
            .map((d) => d.def.key);
        expect(offenders).toEqual([]);
    });

    it('the detector fires on the code that actually shipped — positive control', () => {
        // Without this, the assertion above cannot be told apart from a regex
        // that matches nothing.
        expect(
            EMPTY_FALLBACK.test(
                "const k = typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : '';",
            ),
        ).toBe(true);
        expect(EMPTY_FALLBACK.test("const k = ctx.input.frameworkKey ?? '';")).toBe(true);
        expect(EMPTY_FALLBACK.test('const k = ctx.input.frameworkKey || "";')).toBe(true);
        expect(EMPTY_FALLBACK.test('const a = ctx.input.items ?? [];')).toBe(true);
        // And not on the sanctioned reader, nor an unrelated empty default.
        expect(EMPTY_FALLBACK.test("const k = requiredString(ctx, 'frameworkKey');")).toBe(false);
        expect(EMPTY_FALLBACK.test("const unrelated = somethingElse ?? '';")).toBe(false);
    });

    it('declares exactly the input keys it reads, in both directions', () => {
        const mismatches = defSources
            .map((d) => ({
                key: d.def.key,
                read: keysRead(d.code),
                declared: [...(d.def.requiredInput ?? [])].sort(),
            }))
            .filter((d) => d.read.join(',') !== d.declared.join(','))
            .map((d) => `${d.key}: reads [${d.read}] declares [${d.declared}]`);

        // Both directions. A key read but not declared is the defect class — the
        // admission gate does not know to require it, so the run starts and
        // fails downstream. A key declared but not read refuses runs for an
        // input nothing uses.
        expect(mismatches).toEqual([]);
    });

    it('at least two definitions read an input, so the pairing is not vacuous', () => {
        const withInputs = defSources.filter((d) => keysRead(d.code).length > 0);
        expect(withInputs.length).toBeGreaterThanOrEqual(2);
    });

    describe('and the declaration is enforced, not merely declared', () => {
        const usecase = read('src/app-layer/usecases/workflow-runs.ts');
        const body = functionBodyOf(usecase, 'startWorkflowRun');

        it('startWorkflowRun calls the admission gate', () => {
            // `requiredInput` is inert unless something reads it. This is the
            // difference between a declaration and a rule.
            expect(body).toContain('assertRequiredInputPresent(');
        });

        it('calls it BEFORE the run row is written', () => {
            // The usecase states the rule in its own prose: a refusal after the
            // row exists "leaves a RUNNING run nothing will ever advance ... a
            // refusal wearing the costume of an outage". A missing input refused
            // late is the FAILED variant of that — a row that burned tokens and
            // died in a tool validator two steps on.
            const gateAt = body.indexOf('assertRequiredInputPresent(');
            const rowAt = body.indexOf('createSealedRun(');
            expect(gateAt).toBeGreaterThanOrEqual(0);
            expect(rowAt).toBeGreaterThanOrEqual(0);
            expect(gateAt).toBeLessThan(rowAt);
        });
    });
});
