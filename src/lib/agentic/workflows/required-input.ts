import type { WorkflowContext } from '../workflow-types';

/**
 * Read a run input that the definition declared in `requiredInput` (#3600).
 *
 * ── WHY THIS THROWS RATHER THAN SUBSTITUTING ──────────────────────────────
 *
 * It replaces two separately-maintained copies of
 *
 *     typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : ''
 *
 * one in `audit-prep.ts` and one in `framework-onboarding.ts`. That fallback
 * satisfied the declared `string` return and was the entire defect: it turned
 * "the caller did not say which framework" into `''`, a value the tools
 * downstream disagree about. `find_coverage_gaps` declares
 * `z.string().min(1)` and rejected it; `get_framework_status` declares
 * `.optional()` and read falsy as a supported mode, returning the
 * installable-framework catalogue rather than the per-framework readout. So
 * step 0 was recorded DONE having answered a different question, and step 1
 * crashed. Seven production runs, 2026-07-02 to 2026-09-19, every one of them
 * this. Two copies of a defect is how it outlived four changes to the code
 * around it.
 *
 * ── AND WHY IT IS NOT THE REAL GATE ───────────────────────────────────────
 *
 * `assertRequiredInputPresent` refuses at admission, before the run row
 * exists, which is where a caller gets a usable error. By the time a step's
 * `args` callback runs, the only way to be here without the value is a
 * definition that reads a key it never declared — a bug in the definition, not
 * in the request. So this throws plainly instead of reporting nicely.
 *
 * NOTHING PREVENTS THE MISMATCH SHIPPING (#3650). This named a guard,
 * `workflow-required-input-is-declared`, as what does, and it has never existed — so a definition reading an undeclared key
 * fails at RUNTIME here rather than in CI, which is the opposite of what the
 * sentence promised.
 */
export function requiredString(ctx: WorkflowContext, key: string): string {
    const v = ctx.input[key];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(
            `Workflow input "${key}" is required and was not supplied. ` +
                `Declare it in the definition's requiredInput so the run is ` +
                `refused at admission rather than failing here.`,
        );
    }
    return v;
}
