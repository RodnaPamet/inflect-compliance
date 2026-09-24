import { dataScopeForToolCall } from '@/lib/mcp/tool-data-scope';
import type { AgentDataAccessScope } from '@prisma/client';
import type { WorkflowStepDef } from './workflow-types';

/**
 * Which tool to show against a recorded step.
 *
 * ── WHY THIS IS NOT JUST `step.toolCalled` ──────────────────────────────────
 *
 * The static driver's failure path records the step with NO `toolCalled` — it
 * calls `recordStep` with only a status and an error output. So a READ or
 * PROPOSE that threw lands in the ledger with a NULL tool, and a timeline chip
 * reading the column alone is blank on exactly the steps an operator opened the
 * page to inspect. The successful steps, which need it least, are the only ones
 * that show it.
 *
 * The definition still knows. The driver executes `def.steps[seq]`, so `seq`
 * indexes back into the same array, and a declared READ or PROPOSE carries its
 * `tool` whether or not the attempt got far enough to record one.
 *
 * ── THE ORDER IS THE POINT ──────────────────────────────────────────────────
 *
 * The RECORDED value wins whenever it exists, because it is what actually ran;
 * the declared one is a statement of intent and could in principle differ from
 * it. The fallback fills a hole, it does not override an observation — which is
 * the same rule `WorkflowRun.driver` follows against the tenant's configuration
 * one surface up.
 *
 * Returns `null` for the kinds that legitimately have no tool — SYNTHESIS is a
 * function over accumulated context and HUMAN_CHECKPOINT is a pause — so the
 * caller renders nothing rather than an empty chip.
 */
export function resolveStepTool(
    recorded: string | null,
    declared: WorkflowStepDef | undefined,
): string | null {
    if (recorded) return recorded;
    if (declared && 'tool' in declared && typeof declared.tool === 'string') {
        return declared.tool;
    }
    return null;
}

/**
 * The definition entry a recorded step may borrow from — or `undefined` when
 * borrowing would be a lie.
 *
 * ── THE PREMISE THAT ONLY HOLDS FOR ONE ENGINE ──────────────────────────────
 *
 * `resolveStepTool` above is justified by "the driver executes
 * `def.steps[seq]`, so `seq` indexes back into the same array". That is true
 * of the STATIC driver, whose loop is literally
 * `for (let seq = fromSeq; seq < def.steps.length; seq++)`.
 *
 * It is false of the Flue driver. There `seq` is a running counter of steps
 * RECORDED — `let seq = fromSeq; … seq++` — incremented once per tool call and
 * once per model call. It has no relationship to the definition's array at
 * all.
 *
 * So `def.steps[s.seq]` on a Flue run reads an unrelated declared step, and
 * the timeline then shows a MODEL_CALL wearing another step's label, another
 * step's tool name, and — because the data rung is derived from that tool —
 * a data-access claim about content it never touched. On a governance surface
 * that is worse than showing nothing: it is a specific false statement about
 * what an agent did.
 *
 * ── THE RULE, STATED AS THE THING THAT IS ACTUALLY TRUE ─────────────────────
 *
 * A definition can only speak for the kinds a definition can DECLARE. The two
 * record-only kinds are facts an engine reports about what it did, and no
 * hand-written step array contains them — so for those, there is nothing to
 * borrow and the answer is the recorded columns alone.
 *
 * Keyed on the KIND rather than on the run's driver on purpose: the driver is
 * a property of the run, and a run could in principle carry steps of both
 * shapes. The kind is a property of the step, which is the thing being
 * rendered.
 */
export function declaredStepFor(
    steps: readonly WorkflowStepDef[] | undefined,
    seq: number,
    kind: string,
): WorkflowStepDef | undefined {
    if (kind === 'MODEL_CALL' || kind === 'TOOL_CALL') return undefined;
    return steps?.[seq];
}

/**
 * The data rung a recorded step actually REACHED.
 *
 * Argument-aware on purpose. `baseDataScopeForTool` answers the MINIMUM — its
 * own docstring says "the rung a tool call reaches AT LEAST — its base, with
 * no argument raising it" — and the run timeline used it, while the seam that
 * ENFORCES the rung uses `dataScopeForToolCall(name, args)`. The two disagree
 * exactly where an argument raises the rung, and the timeline showed the lower
 * number.
 *
 * Not hypothetical on shipped workflows: `get_framework_status` is
 * READ_METADATA at base and READ_TENANT_DATA when called with `frameworkKey`,
 * and framework-onboarding threads that key into it. The run touched tenant
 * data; the reviewer was told it read catalogue metadata.
 *
 * `inputJson` is where BOTH engines record the tool's own arguments — the
 * static driver writes `input: args`, the Flue driver `input: context.data` —
 * so one reading serves both. Unparseable or absent args contribute no term,
 * which `dataScopeForToolCall` resolves to the base: the answer this surface
 * gave before, so a malformed blob degrades to the old behaviour rather than
 * to a wrong one.
 *
 * Null when the step names no tool. A synthesis or a checkpoint reaches no
 * tenant data by construction, and a chip reading "NONE" would imply a rung
 * was evaluated when none was.
 */
export function stepDataScope(
    tool: string | null,
    inputJson: string | null,
): AgentDataAccessScope | null {
    if (!tool) return null;
    let args: unknown = null;
    if (inputJson) {
        try {
            args = JSON.parse(inputJson);
        } catch {
            args = null;
        }
    }
    return dataScopeForToolCall(tool, args);
}

/**
 * What a recorded step may CLAIM about itself: its tool, and its label.
 *
 * The two lines this replaces were each protected and their COMPOSITION was
 * not. `declaredStepFor` is pinned by its own tests, `resolveStepTool` by its
 * own, and the run-detail page joined them — so the join was the one part of
 * #2774 with no executing assertion over it.
 *
 * #2774: Flue steps inherited an unrelated step's tool and rung, because the
 * projection indexed `def.steps[s.seq]` and a Flue `seq` counts steps RECORDED
 * rather than indexing the definition. A MODEL_CALL wore another step's tool
 * name and a data-access claim about content it never touched — on a
 * governance surface, a specific false statement about what an agent did.
 *
 * Reverting the call site to `def?.steps?.[seq]` reintroduces exactly that,
 * and every test stayed green: the unit tests still exercised the two
 * functions, and the rendered timeline supplies `tool` and `label` as
 * FIXTURES, so it pins the client's rendering of whatever the server decided.
 * `kind` is the term that makes the difference, which is why it is a parameter
 * here rather than something a caller may forget to pass.
 */
export function stepDeclaration(
    defSteps: readonly WorkflowStepDef[] | undefined,
    seq: number,
    kind: string,
    toolCalled: string | null,
): { tool: string | null; label: string | null } {
    const declared = declaredStepFor(defSteps, seq, kind);
    return {
        tool: resolveStepTool(toolCalled, declared),
        label: declared?.label ?? null,
    };
}
