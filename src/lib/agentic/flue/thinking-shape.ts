/**
 * Which thinking shape a Claude model takes (#3666).
 *
 * Its own module, with no imports, so the skill recorder
 * (`scripts/skills-evaluate.ts`) can ask the same question the runtime's
 * provider asks without loading the agent runtime to do it. The record is
 * meant to show how the model behaves as the runtime calls it, and two copies
 * of this rule would drift apart in exactly the case that matters: the day a
 * model moves from one shape to the other.
 */

/**
 * The Claude models that take a thinking BUDGET rather than adaptive thinking:
 * every generation before 4.6. A closed set — no model released from now on
 * joins it.
 *
 * pi 0.83 chooses the thinking shape from `compat.forceAdaptiveThinking` and
 * from nothing else, and this runtime asks for reasoning on every request:
 * Flue's default level is `medium`, and its compaction asks for `high`. Left
 * unset, every request carries `thinking: { type: "enabled", budget_tokens }`.
 * That is right for Haiku 4.5, and an HTTP 400 on `claude-sonnet-5-5` and on
 * every other current model, which refuse a budget outright. So adaptive is
 * the default and this list is the exception, the direction that stays right
 * as models are released.
 */
const BUDGET_THINKING_MODEL = /^claude-(?:3|(?:opus|sonnet|haiku)-4-5|opus-4-1|(?:opus|sonnet)-4-(?:0|\d{8}))(?![0-9])/;

/** Does pi have to send adaptive thinking for this external model id? */
export function takesAdaptiveThinking(modelId: string): boolean {
    return !BUDGET_THINKING_MODEL.test(modelId);
}
