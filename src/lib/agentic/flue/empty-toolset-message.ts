/**
 * WHAT A RUN SAYS WHEN IT COULD REACH NO TOOLS AT ALL.
 *
 * A LEAF MODULE WITH NO IMPORTS, and that is the whole reason it exists
 * separately from `execute.ts` where it was declared (#3869).
 *
 * `execute.ts` imports `@flue/runtime`, an ESM-only OPTIONAL dependency that
 * is not installed in the node and jsdom Jest projects — which is why the
 * `flue` project is separate and carries its own `--experimental-vm-modules`
 * flag. So any app-layer module importing this constant from there drags that
 * whole graph in, and every test touching it fails to LOAD with
 * `Cannot find module '@flue/runtime'` rather than failing an assertion.
 *
 * The alternative was copying the sentence into the reader that needed it. That
 * is the worse trade every time: this string is compared against stored rows
 * (`WorkflowRun.errorMessage`) to decide whether a past run reached no tools,
 * so two copies would drift and the comparison would start answering NO for
 * runs that had the problem — silently, since nothing fails when a string
 * comparison stops matching.
 *
 * One sentence naming the cause and the remedy, in the vocabulary
 * `driver-plan.ts` uses for every other operator-actionable gap. It lands in
 * `WorkflowRun.errorMessage`, which the run list and run detail render, so a
 * bare code would be something to go and look up while a run sits there
 * looking successful.
 */
export const EMPTY_TOOLSET_MESSAGE =
    'flue_no_tools_granted: this agent holds no MCP tool grants, so the run had ' +
    'nothing to read and its conclusion is based on no data. Grant the tools the ' +
    "workflow declares on the agent's Tools tab, then run it again.";
