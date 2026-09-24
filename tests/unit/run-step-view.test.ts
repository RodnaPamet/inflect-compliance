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
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AgentDataAccessScope } from '@prisma/client';

import { declaredStepFor, resolveStepTool, stepDataScope, stepDeclaration } from '@/lib/agentic/run-step-view';
import { baseDataScopeForTool } from '@/lib/mcp/tool-data-scope';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import type { WorkflowStepDef } from '@/lib/agentic/workflow-types';

const READ: WorkflowStepDef = { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' };
const CHECKPOINT: WorkflowStepDef = { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' };

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

/**
 * The data-rung chip renders `t('runs.detail.scope.' + scope)`, so EVERY
 * member of the enum needs a key in EVERY locale.
 *
 * ── WHY THIS IS NOT COVERED BY THE i18n RATCHET ─────────────────────────────
 *
 * That ratchet finds hardcoded UI strings — text that never reached the
 * catalogue. This is the opposite shape: the call is correctly translated and
 * the KEY is missing, which next-intl renders as the raw key or an error
 * depending on configuration. It fails only for the enum member nobody has
 * produced yet, which is exactly the one a reviewer will not click.
 *
 * Read off the Prisma enum rather than a restated list, so a sixth rung fails
 * here rather than rendering `runs.detail.scope.WHATEVER_IT_IS` to an
 * assessor.
 */
describe('every data rung the chip can show has a translation', () => {
    const ROOT = path.resolve(__dirname, '../..');
    const load = (loc: string) =>
        JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${loc}.json`), 'utf8')) as Record<
            string,
            never
        >;

    const members = Object.values(AgentDataAccessScope);

    it('read a real enum, not an empty one', () => {
        // Every assertion below is satisfied by zero members.
        expect(members.length).toBeGreaterThanOrEqual(5);
    });

    for (const loc of ['en', 'bg']) {
        it(`${loc} has a key for every rung`, () => {
            const scope = (load(loc) as unknown as {
                agents: { runs: { detail: { scope?: Record<string, string> } } };
            }).agents.runs.detail.scope;
            const missing = members.filter((m) => !scope?.[m]);
            expect({ locale: loc, missing }).toEqual({ locale: loc, missing: [] });
        });
    }

    it('and the chip only appears for a step that names a tool', () => {
        // The page passes `scope: tool ? baseDataScopeForTool(tool) : null`.
        // A checkpoint reaches no tenant data by construction, so a rung
        // there would claim an evaluation that never happened — the null is
        // the assertion, not an oversight.
        expect(resolveStepTool(null, CHECKPOINT)).toBeNull();
        // And a real tool does resolve to a rung, so the chip is reachable.
        expect(members).toContain(baseDataScopeForTool('get_compliance_posture'));
    });
});

/**
 * A RECORD-ONLY STEP BORROWS NOTHING FROM THE DEFINITION.
 *
 * Found by an adversarial audit of Phase 1. `resolveStepTool` is justified by
 * "the driver executes `def.steps[seq]`, so `seq` indexes back into the same
 * array" — true of the static engine, whose loop is
 * `for (let seq = fromSeq; seq < def.steps.length; seq++)`, and false of the
 * Flue engine, where `seq` counts steps RECORDED and indexes nothing.
 *
 * The consequence was a specific false statement on a governance surface: a
 * MODEL_CALL rendered with an unrelated declared step's label, its tool name,
 * and a data-access rung derived from that wrong tool — a claim about content
 * the model never touched.
 */
describe('which definition entry a recorded step may borrow from', () => {
    const DEF: WorkflowStepDef[] = [READ, CHECKPOINT, READ];

    it('gives a declarable kind its own entry, as before', () => {
        expect(declaredStepFor(DEF, 0, 'READ')).toBe(DEF[0]);
        expect(declaredStepFor(DEF, 1, 'HUMAN_CHECKPOINT')).toBe(DEF[1]);
    });

    it('gives a MODEL_CALL nothing, even where an entry exists at that index', () => {
        // The defect precisely: index 0 HAS a declared READ with a tool, and
        // the old code would have handed it to a model call.
        expect(declaredStepFor(DEF, 0, 'MODEL_CALL')).toBeUndefined();
    });

    it('gives a TOOL_CALL nothing — its tool comes from the column it recorded', () => {
        expect(declaredStepFor(DEF, 2, 'TOOL_CALL')).toBeUndefined();
    });

    it('so a Flue step cannot inherit a tool it never called', () => {
        // The end-to-end shape, through the function the page actually uses.
        // Without the kind rule this returns `get_compliance_posture` — a tool
        // the model call never invoked — and the page then derives a data rung
        // from it.
        const declared = declaredStepFor(DEF, 0, 'MODEL_CALL');
        expect(resolveStepTool(null, declared)).toBeNull();
    });

    it('and a static step still recovers its tool after a failure', () => {
        // The control. The fallback exists because the static failure path
        // records no `toolCalled`; narrowing it by kind must not take that
        // away, or the fix trades one blank chip for another.
        const declared = declaredStepFor(DEF, 0, 'READ');
        expect(resolveStepTool(null, declared)).toBe('get_compliance_posture');
    });

    it('is safe when there is no definition at all', () => {
        expect(declaredStepFor(undefined, 0, 'READ')).toBeUndefined();
    });
});

describe('stepDataScope — the rung a step REACHED, not its floor', () => {
    // The timeline used `baseDataScopeForTool`, whose own docstring defines it
    // as the MINIMUM. The seam that ENFORCES the rung is argument-aware
    // (`dataScopeForToolCall` in authorize.ts), so the two disagreed exactly
    // where an argument raises it — and the surface showed the lower number.
    //
    // On a governance surface, under-reporting what an agent reached is the
    // one error that matters.

    it('reports READ_TENANT_DATA when the raising argument was recorded', () => {
        // `get_framework_status` is READ_METADATA at base and
        // READ_TENANT_DATA with `frameworkKey`. framework-onboarding threads
        // that key into it, so this is the shipped workflow, not an edge case.
        expect(
            stepDataScope('get_framework_status', JSON.stringify({ frameworkKey: 'soc2' })),
        ).toBe('READ_TENANT_DATA');
    });

    it('reports the base rung when the argument is absent', () => {
        // The positive control in the other direction: without the key the
        // same tool really does only read the installable catalogue, and
        // reporting TENANT_DATA there would over-report.
        expect(stepDataScope('get_framework_status', JSON.stringify({ limit: 50 }))).toBe(
            'READ_METADATA',
        );
    });

    it('degrades to the base rung on an unparseable payload', () => {
        // Not to null and not to the maximum: unreadable args are exactly the
        // old behaviour, which is the safe direction for a display.
        expect(stepDataScope('get_framework_status', 'not json')).toBe('READ_METADATA');
        expect(stepDataScope('get_framework_status', null)).toBe('READ_METADATA');
    });

    it('answers null for a step that named no tool', () => {
        // A synthesis or a checkpoint reaches no tenant data by construction,
        // and a chip reading "NONE" would imply a rung was evaluated.
        expect(stepDataScope(null, JSON.stringify({ frameworkKey: 'soc2' }))).toBeNull();
    });
});

describe('stepDeclaration — the JOIN, which is the part #2774 lived in', () => {
    // Its own fixture: `DEF` above is scoped to the describe that owns it.
    const JOIN_DEF: WorkflowStepDef[] = [READ, CHECKPOINT, READ];
    // `declaredStepFor` and `resolveStepTool` were each pinned and their
    // COMPOSITION was not, so the run-detail page could be reverted to
    // `def?.steps?.[seq]` with every test still green: the unit tests exercise
    // the two functions, and the rendered timeline supplies `tool` and `label`
    // as fixtures — it pins the client's rendering of whatever the server
    // decided.

    it('a MODEL_CALL claims NO tool and NO label, whatever sits at that index', () => {
        // THE #2774 CASE. A Flue `seq` counts steps RECORDED and indexes
        // nothing, so the definition's step 0 is not this step's declaration.
        // Indexing it made a MODEL_CALL wear another step's tool name and a
        // data-access claim about content it never touched.
        expect(stepDeclaration(JOIN_DEF, 0, 'MODEL_CALL', null)).toEqual({
            tool: null,
            label: null,
        });
    });

    it('a TOOL_CALL names the tool the COLUMN recorded, not the definition’s', () => {
        expect(stepDeclaration(JOIN_DEF, 0, 'TOOL_CALL', 'list_risks')).toEqual({
            tool: 'list_risks',
            label: null,
        });
    });

    it('a static step still takes its declaration from the definition', () => {
        // The positive control. Without it the assertions above would pass
        // under an implementation that returned nulls for everything, and the
        // static engine's timeline would silently lose its labels.
        const out = stepDeclaration(JOIN_DEF, 0, 'READ', null);
        expect(out.tool).toBe('get_compliance_posture');
        expect(out.label).toBe('posture');
    });

    it('a failed static step falls back to the declaration for its tool', () => {
        // `resolveStepTool`'s rule: the column first, the definition only for
        // the hole a failed step leaves.
        expect(stepDeclaration(JOIN_DEF, 0, 'READ', null).tool).toBe('get_compliance_posture');
    });
});
