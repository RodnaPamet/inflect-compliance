/**
 * Is a rule complete enough to run?
 *
 * A canvas step creates its rule as a DRAFT the moment the map is saved, long
 * before anybody has chosen what should trigger it or what it should do. The
 * stub used to carry `RISK_CREATED` as a placeholder trigger and an empty
 * action, and nothing stopped it being enabled like that: it would then fire on
 * every new risk and fail, or worse, fire on an event nobody chose.
 *
 * So a rule now says what it is missing, and enabling one that is missing
 * anything is refused with the same reasons. The reasons travel with the rule
 * (`readiness` on every rule the usecases return), so the canvas and the Rules
 * tab show them from the server's answer rather than re-deriving it in the
 * browser, which could not import the action schemas anyway.
 */
import { isKnownAutomationEvent } from './events';
import { ACTION_CONFIG_BY_TYPE } from '../schemas/automation.schemas';

/**
 * The trigger of a rule nobody has given one yet.
 *
 * Not an event in the catalogue, so the dispatcher, which matches rules by
 * event name, can never select it: an unconfigured rule cannot fire even if
 * something enabled it around the usecase.
 */
export const UNSET_TRIGGER_EVENT = 'UNSET';

export type RuleReadinessProblem =
    /** No trigger event chosen, or one the catalogue does not know. */
    | 'TRIGGER_NOT_SET'
    /** A SCHEDULE trigger with no schedule. */
    | 'SCHEDULE_NOT_SET'
    /** The action's settings are missing a required field. */
    | 'ACTION_INCOMPLETE';

interface RuleLike {
    triggerEvent: string;
    actionType: string;
    actionConfigJson: unknown;
    scheduleConfigJson?: unknown;
}

export function ruleReadinessProblems(rule: RuleLike): RuleReadinessProblem[] {
    const problems: RuleReadinessProblem[] = [];
    if (!isKnownAutomationEvent(rule.triggerEvent)) problems.push('TRIGGER_NOT_SET');
    else if (rule.triggerEvent === 'SCHEDULE' && !rule.scheduleConfigJson) problems.push('SCHEDULE_NOT_SET');
    const schema = ACTION_CONFIG_BY_TYPE[rule.actionType as keyof typeof ACTION_CONFIG_BY_TYPE];
    if (!schema || !schema.safeParse(rule.actionConfigJson ?? {}).success) problems.push('ACTION_INCOMPLETE');
    return problems;
}

const PROBLEM_SENTENCE: Record<RuleReadinessProblem, string> = {
    TRIGGER_NOT_SET: 'choose the event that triggers it',
    SCHEDULE_NOT_SET: 'set its schedule',
    ACTION_INCOMPLETE: 'complete its action settings',
};

/** The refusal's message, in the order the problems were found. */
export function readinessRefusal(problems: RuleReadinessProblem[]): string {
    return `This rule cannot be enabled yet: ${problems.map((p) => PROBLEM_SENTENCE[p]).join(', and ')}.`;
}
